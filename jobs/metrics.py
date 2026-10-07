"""Pull her results from the stats connections (BUILD_PLAN.md sections 3 step 8, 6, phase 8).

Spec (worker/jobs/metrics.ts buildSpec):
  posts       [{id, platform, url, posted_at}]  dashboard posts that went out, to match by link
  instagram   {access_token, user_id} | null    Instagram API with Instagram Login (refreshed by the Worker)
  youtube     {access_token, channel_id} | null  Google token (refreshed by the Worker)
  max_videos  int

Result: {"videos": [...], "accounts": [...], "errors": [{provider, kind}], "providers": [...],
"metrics": []}. Each video carries post_id when its link matches a dashboard post; the Worker
stores the numbers in platform_videos and metrics and recomputes the learned posting slots.
Numbers and ids only in logs (section 13).
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Any

from common import Job, log, run

IG = "https://graph.instagram.com/v21.0"
YT = "https://www.googleapis.com/youtube/v3"
YTA = "https://youtubeanalytics.googleapis.com/v2/reports"


class ProviderError(Exception):
    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind  # expired | rate_limit | failed


def get_json(url: str, token: str | None = None) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        if e.code == 401 or '"code":190' in body.replace(" ", ""):
            raise ProviderError("expired") from e
        if e.code == 429 or "quotaExceeded" in body or "rateLimit" in body or '"code":4,' in body.replace(" ", ""):
            raise ProviderError("rate_limit") from e
        raise ProviderError("failed") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise ProviderError("failed") from e


def norm_link(url: str | None) -> str:
    if not url:
        return ""
    u = urllib.parse.urlsplit(url.strip())
    return f"{u.netloc.lower().removeprefix('www.')}{u.path.rstrip('/')}"


def yt_id(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"(?:shorts/|v=|youtu\.be/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


def iso8601_seconds(s: str | None) -> float | None:
    return float(s) if s not in (None, "") else None


# ---------- Instagram ----------

def instagram(cfg: dict[str, Any], posts: list[dict[str, Any]], max_videos: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tok = cfg["access_token"]
    q = urllib.parse.urlencode
    me = get_json(f"{IG}/me?{q({'fields': 'user_id,username,followers_count,media_count', 'access_token': tok})}")
    by_link = {norm_link(p["url"]): p["id"] for p in posts if p["platform"] == "instagram"}
    videos: list[dict[str, Any]] = []
    url = f"{IG}/me/media?{q({'fields': 'id,permalink,timestamp,media_type,media_product_type,like_count,comments_count,caption', 'limit': 50, 'access_token': tok})}"
    while url and len(videos) < max_videos:
        page = get_json(url)
        for m in page.get("data") or []:
            if m.get("media_type") != "VIDEO" and m.get("media_product_type") != "REELS":
                continue
            stats = {"views": 0, "likes": m.get("like_count") or 0, "comments": m.get("comments_count") or 0, "shares": 0, "saved": 0, "ig_reels_avg_watch_time": None}
            for metrics in ("views,likes,comments,shares,saved,ig_reels_avg_watch_time", "views,likes,comments,shares,saved", "reach,likes,comments,shares,saved"):
                try:
                    ins = get_json(f"{IG}/{m['id']}/insights?{q({'metric': metrics, 'access_token': tok})}")
                    for row in ins.get("data") or []:
                        vals = row.get("values") or [{}]
                        name = "views" if row.get("name") == "reach" and "views" not in metrics else row.get("name")
                        stats[name] = vals[0].get("value", 0)
                    break
                except ProviderError as e:
                    if e.kind != "failed":
                        raise
            watch = stats.get("ig_reels_avg_watch_time")
            videos.append({
                "platform": "instagram",
                "external_id": m["id"],
                "url": m.get("permalink"),
                "title": (m.get("caption") or "")[:120] or None,
                "posted_at": m.get("timestamp"),
                "views": int(stats.get("views") or 0),
                "likes": int(stats.get("likes") or 0),
                "comments": int(stats.get("comments") or 0),
                "shares": int(stats.get("shares") or 0),
                "saves": int(stats.get("saved") or 0),
                "avg_watch_s": (float(watch) / 1000.0) if watch else None,  # reported in milliseconds
                "post_id": by_link.get(norm_link(m.get("permalink"))),
            })
        url = (page.get("paging") or {}).get("next")
    recent = sorted(videos, key=lambda v: v["posted_at"] or "", reverse=True)[:30]
    account = {"platform": "instagram", "followers": int(me.get("followers_count") or 0), "avg_views": int(sum(v["views"] for v in recent) / len(recent)) if recent else 0}
    log("metrics.instagram", videos=len(videos), matched=sum(1 for v in videos if v["post_id"]))
    return videos, account


# ---------- YouTube ----------

def youtube(cfg: dict[str, Any], posts: list[dict[str, Any]], max_videos: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tok = cfg["access_token"]
    q = urllib.parse.urlencode
    ch = get_json(f"{YT}/channels?{q({'part': 'statistics,contentDetails', 'mine': 'true'})}", tok)
    item = (ch.get("items") or [{}])[0]
    uploads = ((item.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
    followers = int((item.get("statistics") or {}).get("subscriberCount") or 0)
    ids: list[str] = []
    token = None
    while uploads and len(ids) < max_videos:
        params = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50}
        if token:
            params["pageToken"] = token
        page = get_json(f"{YT}/playlistItems?{q(params)}", tok)
        ids += [i["contentDetails"]["videoId"] for i in page.get("items") or []]
        token = page.get("nextPageToken")
        if not token:
            break
    ids = ids[:max_videos]
    by_id = {yt_id(p["url"]): p["id"] for p in posts if p["platform"] == "youtube" and yt_id(p["url"])}
    videos: list[dict[str, Any]] = []
    for i in range(0, len(ids), 50):
        batch = ids[i : i + 50]
        data = get_json(f"{YT}/videos?{q({'part': 'statistics,snippet', 'id': ','.join(batch)})}", tok)
        for v in data.get("items") or []:
            st = v.get("statistics") or {}
            videos.append({
                "platform": "youtube",
                "external_id": v["id"],
                "url": f"https://youtube.com/shorts/{v['id']}",
                "title": ((v.get("snippet") or {}).get("title") or "")[:120] or None,
                "posted_at": (v.get("snippet") or {}).get("publishedAt"),
                "views": int(st.get("viewCount") or 0),
                "likes": int(st.get("likeCount") or 0),
                "comments": int(st.get("commentCount") or 0),
                "shares": 0,
                "saves": 0,
                "avg_watch_s": None,
                "post_id": by_id.get(v["id"]),
            })
    # Average view duration and shares from YouTube Analytics (best effort).
    if videos:
        try:
            for i in range(0, len(videos), 100):
                chunk = videos[i : i + 100]
                rep = get_json(f"{YTA}?{q({'ids': 'channel==MINE', 'startDate': '2015-01-01', 'endDate': date.today().isoformat(), 'metrics': 'averageViewDuration,shares', 'dimensions': 'video', 'filters': 'video==' + ','.join(v['external_id'] for v in chunk), 'maxResults': 200})}", tok)
                rows = {r[0]: r for r in rep.get("rows") or []}
                for v in chunk:
                    r = rows.get(v["external_id"])
                    if r:
                        v["avg_watch_s"] = iso8601_seconds(r[1])
                        v["shares"] = int(r[2] or 0)
        except ProviderError as e:
            if e.kind == "expired":
                raise
            log("metrics.youtube.analytics_skipped", kind=e.kind)
    recent = sorted(videos, key=lambda v: v["posted_at"] or "", reverse=True)[:30]
    account = {"platform": "youtube", "followers": followers, "avg_views": int(sum(v["views"] for v in recent) / len(recent)) if recent else 0}
    log("metrics.youtube", videos=len(videos), matched=sum(1 for v in videos if v["post_id"]))
    return videos, account


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    posts = spec.get("posts") or []
    max_videos = int(spec.get("max_videos") or 60)
    out: dict[str, Any] = {"videos": [], "accounts": [], "errors": [], "providers": [], "metrics": []}
    plan = [("meta", spec.get("instagram"), instagram), ("google", spec.get("youtube"), youtube)]
    for i, (provider, cfg, fn) in enumerate(plan):
        job.progress("reading stats", i, len(plan))
        if not cfg:
            continue
        try:
            videos, account = fn(cfg, posts, max_videos)
            out["videos"] += videos
            out["accounts"].append(account)
            out["providers"].append(provider)
        except ProviderError as e:
            out["errors"].append({"provider": provider, "kind": e.kind})
            log("metrics.provider", provider=provider, ok=False, kind=e.kind)
    job.progress("reading stats", len(plan), len(plan))
    log("metrics.done", videos=len(out["videos"]), errors=len(out["errors"]))
    return out


if __name__ == "__main__":
    run(main)
