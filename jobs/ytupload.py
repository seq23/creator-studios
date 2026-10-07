"""Upload one approved full video to her own YouTube channel (owner decision, 26 Sep 2026).

The Worker decides everything (worker/lib/youtubeDirect.ts): the file, the title, description with
chapters, tags, category, and the status part (private + publishAt when it goes public later, or her
chosen privacy at once). This job only moves the bytes, because a Worker must not stream gigabytes:

  1. reads the video through the Worker (signed, resumable download; the job holds no storage keys)
  2. asks the Worker for a short-lived access token (POST /api/jobs/:id/youtube-token); the
     refresh token never leaves the Worker, and a 401 mid-upload asks for a fresh one
  3. videos.insert with YouTube's resumable upload protocol: one session, 8 MB chunks (a multiple
     of 256 KB); 308 answers carry the Range YouTube holds; a dropped connection or a 5xx asks
     YouTube where it got to (Content-Range: bytes */size) and carries on from there
  4. thumbnails.set with her chosen thumbnail; a channel not verified for custom thumbnails (403)
     is a plain note for her, never a failed upload
  5. tells the Worker what happened as an `outcome`, which reads the video back and compares

YouTube's answers are named, never swallowed: quotaExceeded -> "quota" (tomorrow),
uploadLimitExceeded -> "upload_limit", a refused sign-in -> "revoked", invalidPublishAt -> sent
again as private with no time (the Worker names the fix). Logs: step names and counts only.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from common import WORK, Job, log, run

INSERT_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
THUMB_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"
CHUNK_UNIT = 256 * 1024
MAX_STALLS = 8


class YouTubeError(Exception):
    """A named answer from YouTube: http status + the first errors[].reason."""

    def __init__(self, http: int, reason: str | None):
        super().__init__(f"youtube {http} {reason or ''}".strip())
        self.http = http
        self.reason = reason


def reason_of(raw: bytes) -> str | None:
    try:
        body = json.loads(raw.decode() or "{}")
    except ValueError:
        return None
    err = body.get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict):
        errors = err.get("errors") or []
        if errors and isinstance(errors[0], dict):
            return errors[0].get("reason")
        return err.get("status")
    return None


def kind_of(http: int, reason: str | None, thumbnail: bool = False) -> str:
    """The same names as classifyError in worker/domain/youtubeDirect.ts."""
    r = reason or ""
    if r in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"):
        return "quota"
    if r == "uploadLimitExceeded":
        return "upload_limit"
    if r in ("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "PERMISSION_DENIED"):
        return "scope"
    if http == 401 or r in ("authError", "invalid_grant", "unauthorized_client"):
        return "revoked"
    if r == "invalidPublishAt":
        return "publish_at"
    if thumbnail and http == 403:
        return "thumb_verify"
    if http in (0, 408, 429) or http >= 500:
        return "retry"
    return "other"


class Uploader:
    """The resumable upload, with the token and the HTTP opener injectable for tests."""

    def __init__(self, token: Callable[[], str], insert_url: str = INSERT_URL, thumb_url: str = THUMB_URL, sleep: Callable[[float], None] = time.sleep):
        self._token_fn = token
        self._token = token()
        self.insert_url = insert_url
        self.thumb_url = thumb_url
        self.sleep = sleep
        self.resumed = 0

    def _refresh(self) -> None:
        self._token = self._token_fn()

    def _open(self, req: urllib.request.Request, timeout: float = 300):
        req.add_header("Authorization", f"Bearer {self._token}")
        return urllib.request.urlopen(req, timeout=timeout)

    def start(self, metadata: dict[str, Any], size: int, content_type: str) -> str:
        """Open the upload session; returns the session URL YouTube hands back."""
        q = urllib.parse.urlencode({"uploadType": "resumable", "part": "snippet,status"})
        body = json.dumps(metadata).encode()
        for attempt in range(4):
            req = urllib.request.Request(f"{self.insert_url}?{q}", data=body, method="POST", headers={
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Length": str(size),
                "X-Upload-Content-Type": content_type,
            })
            try:
                with self._open(req, timeout=60) as res:
                    loc = res.headers.get("Location")
                    if not loc:
                        raise YouTubeError(res.status, "no_session")
                    return loc
            except urllib.error.HTTPError as e:
                reason = reason_of(e.read())
                kind = kind_of(e.code, reason)
                if kind == "revoked" and attempt == 0:
                    self._refresh()
                    continue
                if kind == "retry":
                    log("yt.start.retry", status=e.code, attempt=attempt)
                    self.sleep(2 ** attempt)
                    continue
                raise YouTubeError(e.code, reason) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                log("yt.start.retry", attempt=attempt)
                self.sleep(2 ** attempt)
        raise YouTubeError(0, "network")

    def _where(self, session: str, size: int) -> tuple[int, dict[str, Any] | None]:
        """Ask YouTube how much it holds: (next byte, the finished video or None)."""
        req = urllib.request.Request(session, data=b"", method="PUT", headers={"Content-Range": f"bytes */{size}", "Content-Length": "0"})
        try:
            with self._open(req, timeout=60) as res:
                return size, json.loads(res.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            if e.code == 308:
                rng = e.headers.get("Range")
                return (int(rng.split("-")[1]) + 1 if rng else 0), None
            reason = reason_of(e.read())
            if kind_of(e.code, reason) == "revoked":
                self._refresh()
                return self._where(session, size)
            if e.code == 404:
                raise YouTubeError(404, "session_expired") from None
            raise YouTubeError(e.code, reason) from None

    def send(self, session: str, path: Path, size: int, chunk: int, progress: Callable[[int], None] | None = None) -> dict[str, Any]:
        """Send the file in chunks; returns the video resource YouTube answers with at the end."""
        chunk = max(CHUNK_UNIT, chunk // CHUNK_UNIT * CHUNK_UNIT)
        offset = 0
        stalls = 0
        with path.open("rb") as f:
            while True:
                f.seek(offset)
                data = f.read(chunk)
                end = offset + len(data) - 1
                req = urllib.request.Request(session, data=data, method="PUT", headers={
                    "Content-Length": str(len(data)),
                    "Content-Range": f"bytes {offset}-{end}/{size}" if data else f"bytes */{size}",
                })
                try:
                    with self._open(req) as res:
                        return json.loads(res.read().decode() or "{}")
                except urllib.error.HTTPError as e:
                    if e.code == 308:
                        rng = e.headers.get("Range")
                        offset = int(rng.split("-")[1]) + 1 if rng else 0
                        stalls = 0
                        if progress:
                            progress(offset)
                        continue
                    reason = reason_of(e.read())
                    kind = kind_of(e.code, reason)
                    if kind not in ("retry", "revoked"):
                        raise YouTubeError(e.code, reason) from None
                    if kind == "revoked":
                        self._refresh()
                    log("yt.chunk.retry", status=e.code, kind=kind)
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    log("yt.chunk.dropped")
                stalls += 1
                if stalls > MAX_STALLS:
                    raise YouTubeError(0, "network")
                self.sleep(min(60, 2 ** stalls))
                offset, done = self._where(session, size)
                self.resumed += 1
                log("yt.resume", resumed=self.resumed)
                if done is not None:
                    return done

    def thumbnail(self, video_id: str, image: bytes) -> str:
        """Her chosen thumbnail: 'set', 'needs_verify' (channel not verified) or 'failed'."""
        q = urllib.parse.urlencode({"videoId": video_id})
        for attempt in range(3):
            req = urllib.request.Request(f"{self.thumb_url}?{q}", data=image, method="POST", headers={"Content-Type": "image/jpeg", "Content-Length": str(len(image))})
            try:
                with self._open(req, timeout=120):
                    return "set"
            except urllib.error.HTTPError as e:
                kind = kind_of(e.code, reason_of(e.read()), thumbnail=True)
                if kind == "thumb_verify":
                    return "needs_verify"
                if kind == "revoked" and attempt == 0:
                    self._refresh()
                    continue
                if kind != "retry":
                    log("yt.thumbnail.refused", status=e.code, kind=kind)
                    return "failed"
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            self.sleep(2 ** attempt)
        return "failed"


def upload(uploader: Uploader, spec: dict[str, Any], video: Path, thumb: bytes | None, progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """The whole upload for one spec. Returns the outcome the Worker reads."""
    size = video.stat().st_size
    meta = {"snippet": spec["metadata"]["snippet"], "status": spec["metadata"]["status"]}
    rejected = False
    try:
        try:
            session = uploader.start(meta, size, spec.get("content_type") or "video/mp4")
        except YouTubeError as e:
            if kind_of(e.http, e.reason) != "publish_at":
                raise
            # The time was refused: it goes up safely private with no time; the Worker names the fix.
            log("yt.publish_at_rejected")
            rejected = True
            session = uploader.start({**meta, "status": spec["fallback_status"]}, size, spec.get("content_type") or "video/mp4")
        video_res = uploader.send(session, video, size, int(spec.get("chunk_bytes") or 8 * 1024 * 1024), progress)
    except YouTubeError as e:
        kind = kind_of(e.http, e.reason)
        outcome = kind if kind in ("quota", "upload_limit", "revoked", "scope") else "failed"
        log("yt.upload.failed", status=e.http, kind=kind)
        return {"outcome": outcome, "http": e.http, "reason": (e.reason or "")[:40], "resumed": uploader.resumed}
    vid = video_res.get("id")
    if not vid:
        return {"outcome": "failed", "http": 200, "reason": "no_id", "resumed": uploader.resumed}
    log("yt.uploaded", bytes=size, resumed=uploader.resumed)
    thumbnail = uploader.thumbnail(vid, thumb) if thumb else "none"
    log("yt.thumbnail", result=thumbnail)
    return {"outcome": "uploaded", "video_id": vid, "thumbnail": thumbnail, "publish_at_rejected": rejected, "resumed": uploader.resumed}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    video = WORK / "yt" / "video.mp4"
    job.progress("download", 0, 3)
    job.download_input(spec["video_key"], video)
    thumb = job.read_input_bytes(spec["thumb_key"]) if spec.get("thumb_key") else None

    def token() -> str:
        try:
            got = job._call("POST", "/youtube-token", json.dumps({"purpose": "upload"}))
        except urllib.error.HTTPError as e:
            # 409 from the Worker = Google refused her sign-in (the light is already red there).
            log("yt.token.refused", status=e.code)
            raise YouTubeError(401, "invalid_grant") from None
        t = got.get("access_token")
        if not t:
            raise YouTubeError(401, "invalid_grant")
        return t

    try:
        uploader = Uploader(token)
    except YouTubeError:
        return {"outcome": "revoked", "http": 400, "reason": "invalid_grant"}
    job.progress("upload", 1, 3)
    size = video.stat().st_size
    last = [0]

    def progress(sent: int) -> None:
        pct = int(sent * 100 / max(1, size))
        if pct >= last[0] + 10:
            last[0] = pct
            job.progress("upload", 1, 3)
            log("yt.progress", pct=pct)

    result = upload(uploader, spec, video, thumb, progress)
    job.progress("done", 3, 3)
    video.unlink(missing_ok=True)
    return result


if __name__ == "__main__":
    run(main)
