"""The ytupload job (jobs/ytupload.py) against a fake YouTube on localhost that speaks the resumable
upload protocol and answers with YouTube's real error bodies (shared/youtube-errors.json):
chunks and 308 + Range, a dropped connection resumed where YouTube got to, a 503 mid-upload, quota
exceeded, a refused sign-in, a refused publish time (sent again as private), the channel not
verified for custom thumbnails, and YouTube's own upload limit. The bytes YouTube ends up with are
compared with the file. Run: python3 -m unittest discover -s jobs/tests
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ytupload  # noqa: E402

ERRORS = json.loads((Path(__file__).resolve().parents[2] / "shared" / "youtube-errors.json").read_text())


class FakeYouTube:
    """State for one test: what to refuse, and what arrived."""

    def __init__(self) -> None:
        self.inits: list[dict] = []
        self.received = bytearray()
        self.size = 0
        self.fail_init: list[str] = []  # fixture names answered to the next session starts, in order
        self.drop_chunk: set[int] = set()  # chunk numbers whose connection is dropped mid-way (once)
        self.error_chunk: dict[int, str] = {}  # chunk number -> fixture answered (once)
        self.thumb_error: str | None = None
        self.thumbs: list[int] = []
        self.chunks = 0
        self.status_queries = 0
        self.tokens: list[str] = []


def handler_for(yt: FakeYouTube):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a) -> None:  # quiet
            pass

        def _send(self, code: int, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
            self.send_response(code)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _fixture(self, name: str) -> None:
            f = ERRORS[name]
            self._send(f["http"], json.dumps(f["body"]).encode(), {"Content-Type": "application/json"})

        def do_POST(self) -> None:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n)
            yt.tokens.append(self.headers.get("Authorization", ""))
            if self.path.startswith("/upload/videos"):
                if yt.fail_init:
                    return self._fixture(yt.fail_init.pop(0))
                yt.inits.append(json.loads(body))
                yt.size = int(self.headers["X-Upload-Content-Length"])
                return self._send(200, b"", {"Location": f"http://127.0.0.1:{self.server.server_port}/session/1"})
            if self.path.startswith("/upload/thumbnails"):
                if yt.thumb_error:
                    return self._fixture(yt.thumb_error)
                yt.thumbs.append(len(body))
                return self._send(200, b'{"items":[]}')
            self._send(404)

        def do_PUT(self) -> None:
            n = int(self.headers.get("Content-Length") or 0)
            rng = self.headers.get("Content-Range", "")
            yt.tokens.append(self.headers.get("Authorization", ""))
            if rng.startswith("bytes */"):
                yt.status_queries += 1
                self.rfile.read(n)
                return self._done() if len(yt.received) == yt.size else self._308()
            yt.chunks += 1
            k = yt.chunks
            if k in yt.drop_chunk:
                yt.drop_chunk.discard(k)
                # half the chunk arrives, then the connection dies with no answer
                half = self.rfile.read(n // 2)
                start = int(rng.split(" ")[1].split("-")[0])
                if start == len(yt.received):
                    yt.received.extend(half[: (n // 2) // (256 * 1024) * (256 * 1024)])
                self.close_connection = True
                self.connection.close()
                return
            data = self.rfile.read(n)
            if k in yt.error_chunk:
                return self._fixture(yt.error_chunk.pop(k))
            start = int(rng.split(" ")[1].split("-")[0])
            if start != len(yt.received):
                return self._send(400, b'{"error":{"code":400,"errors":[{"reason":"badContentRange"}]}}')
            yt.received.extend(data)
            return self._done() if len(yt.received) == yt.size else self._308()

        def _308(self) -> None:
            h = {"Range": f"bytes=0-{len(yt.received) - 1}"} if yt.received else {}
            self._send(308, b"", h)

        def _done(self) -> None:
            self._send(200, json.dumps({"id": "AbCdEfGhIjK", "status": {"uploadStatus": "uploaded"}}).encode(), {"Content-Type": "application/json"})

    return H


class UploadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.yt = FakeYouTube()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.yt))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{self.srv.server_port}"
        self.tmp = Path(tempfile.mkdtemp())
        self.video = self.tmp / "v.mp4"
        self.video.write_bytes(os.urandom(256 * 1024 * 5 + 1234))  # 5 chunks and a bit
        self.token_calls = 0
        self.revoke_after: int | None = None

        def token() -> str:
            self.token_calls += 1
            if self.revoke_after is not None and self.token_calls > self.revoke_after:
                raise ytupload.YouTubeError(401, "invalid_grant")
            return f"tok{self.token_calls}"

        self.token = token
        self.base = base

    def tearDown(self) -> None:
        self.srv.shutdown()

    def uploader(self) -> ytupload.Uploader:
        return ytupload.Uploader(self.token, insert_url=f"{self.base}/upload/videos", thumb_url=f"{self.base}/upload/thumbnails", sleep=lambda s: None)

    def spec(self, publish_at: str | None = "2026-10-03T15:00:00Z") -> dict:
        status = {"privacyStatus": "private", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False}
        if publish_at:
            status["publishAt"] = publish_at
        return {
            "metadata": {"snippet": {"title": "TEST", "description": "d", "tags": ["t"], "categoryId": "26"}, "status": status},
            "fallback_status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False},
            "content_type": "video/mp4",
            "chunk_bytes": 256 * 1024,
        }

    def test_uploads_in_chunks_with_the_status_part_and_thumbnail(self) -> None:
        r = ytupload.upload(self.uploader(), self.spec(), self.video, b"jpegbytes")
        self.assertEqual(r["outcome"], "uploaded")
        self.assertEqual(r["video_id"], "AbCdEfGhIjK")
        self.assertEqual(r["thumbnail"], "set")
        self.assertFalse(r["publish_at_rejected"])
        self.assertEqual(bytes(self.yt.received), self.video.read_bytes())
        self.assertEqual(self.yt.chunks, 6)
        st = self.yt.inits[0]["status"]
        self.assertEqual((st["privacyStatus"], st["publishAt"], st["selfDeclaredMadeForKids"]), ("private", "2026-10-03T15:00:00Z", False))
        self.assertEqual(self.yt.thumbs, [len(b"jpegbytes")])
        self.assertTrue(all(t.startswith("Bearer tok") for t in self.yt.tokens))

    def test_dropped_connection_resumes_where_youtube_got_to(self) -> None:
        self.yt.drop_chunk = {2}
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual(r["outcome"], "uploaded")
        self.assertEqual(r["resumed"], 1)
        self.assertGreaterEqual(self.yt.status_queries, 1)
        self.assertEqual(bytes(self.yt.received), self.video.read_bytes())
        self.assertEqual(r["thumbnail"], "none")

    def test_backend_error_mid_upload_resumes(self) -> None:
        self.yt.error_chunk = {3: "backend_error"}
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual((r["outcome"], r["resumed"]), ("uploaded", 1))
        self.assertEqual(bytes(self.yt.received), self.video.read_bytes())

    def test_expired_access_token_mid_upload_asks_the_worker_again(self) -> None:
        self.yt.error_chunk = {2: "access_token_invalid"}
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual(r["outcome"], "uploaded")
        self.assertEqual(self.token_calls, 2)
        self.assertIn("Bearer tok2", self.yt.tokens)

    def test_quota_exceeded_is_named(self) -> None:
        self.yt.fail_init = ["quota_exceeded"]
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual((r["outcome"], r["http"], r["reason"]), ("quota", 403, "quotaExceeded"))
        self.assertEqual(self.yt.received, bytearray())

    def test_upload_limit_is_named(self) -> None:
        self.yt.fail_init = ["upload_limit"]
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual(r["outcome"], "upload_limit")

    def test_revoked_sign_in_is_named(self) -> None:
        self.revoke_after = 1
        self.yt.fail_init = ["access_token_invalid"]
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual(r["outcome"], "revoked")

    def test_refused_publish_time_goes_up_private_with_no_time(self) -> None:
        self.yt.fail_init = ["publish_at_rejected"]
        r = ytupload.upload(self.uploader(), self.spec(), self.video, None)
        self.assertEqual(r["outcome"], "uploaded")
        self.assertTrue(r["publish_at_rejected"])
        self.assertEqual(len(self.yt.inits), 1)
        self.assertNotIn("publishAt", self.yt.inits[0]["status"])
        self.assertEqual(self.yt.inits[0]["status"]["privacyStatus"], "private")

    def test_thumbnail_on_an_unverified_channel_is_a_note_not_a_failure(self) -> None:
        self.yt.thumb_error = "thumbnail_not_verified"
        r = ytupload.upload(self.uploader(), self.spec(), self.video, b"jpeg")
        self.assertEqual((r["outcome"], r["thumbnail"]), ("uploaded", "needs_verify"))

    def test_kinds_match_the_worker_for_every_fixture(self) -> None:
        for name, f in ERRORS.items():
            if name.startswith("_"):
                continue
            with self.subTest(name):
                reason = ytupload.reason_of(json.dumps(f["body"]).encode())
                self.assertEqual(ytupload.kind_of(f["http"], reason, bool(f.get("thumbnail"))), f["kind"])


class NoRefreshToken(unittest.TestCase):
    def test_the_job_never_mentions_a_refresh_token(self) -> None:
        src = (Path(__file__).resolve().parents[1] / "ytupload.py").read_text()
        self.assertNotIn("refresh_token", src)
        self.assertIn("/youtube-token", src)


if __name__ == "__main__":
    unittest.main()
