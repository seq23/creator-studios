"""SEEING the footage the way an editor does (owner's studio fix, 23 Oct 2026).

On top of the shot sheet (jobs/see.py) this adds, per shot and per upload:
  * a STAGE: arrival (before) · prep · team (people working) · process · finished · detail · hero;
  * the HERO of each event: the most polished, steady, finished view (file names with new / final /
    after are the owner's polished heroes); a clip always ends on one;
  * a per-second SHARPNESS and STEADINESS track (blurry or shaky seconds are never used);
  * a perceptual hash per shot, so the same picture is never counted (or shown) twice;
  * EVENT groups (EXIF / file date, else the file names): photos of different events never mix;
  * whether a photo came from a camera (EXIF Make/Model); one without is an AI picture.
Photos are first-class: cut.py turns each into a slow-pan video, and from here on it is a shot like
any other. Measuring needs only ffmpeg (no numpy). No business words here.
"""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from see import UNSURE, Shot, ShotSheet  # noqa: E402

STAGES = ("arrival", "prep", "team", "process", "finished", "detail", "hero")
HERO_WORDS = ("new", "final", "after", "finished", "done", "reveal")
PREP_WORDS = ("unload", "unpack", "supplies", "materials", "boxes", "laying out", "getting ready", "prep", "setting out", "loading", "tools", "gathering", "sorting")
DETAIL_WORDS = ("close-up", "close up", "closeup", "detail", "up close", "macro")
CAMERA_PREFIXES = {"img", "pxl", "dsc", "dscn", "vid", "mov", "photo", "image", "video", "screenshot", "snapchat", "signal", "whatsapp", "trim", "clip"}
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif", ".gif", ".bmp", ".tif", ".tiff")
# Per-second quality: at or above this a second may be used (sharp AND steady enough).
GOOD = 0.5
QW, QH = 108, 192  # the measuring frame (gray)


# ---------------------------------------------------------------- what kind of file

def is_photo(asset: dict[str, Any]) -> bool:
    mime = str(asset.get("mime_type") or "").lower()
    if mime.startswith("image/"):
        return True
    if mime.startswith("video/"):
        return False
    return file_name(asset).lower().endswith(PHOTO_EXT)


def file_name(asset: dict[str, Any]) -> str:
    for k in ("file_name", "name", "original_name"):
        if asset.get(k):
            return str(asset[k])
    return str(asset.get("r2_key") or "").rsplit("/", 1)[-1]


def name_is_hero(name: str) -> bool:
    """The owner's rule: new / final / after in a file name = the polished hero."""
    stem = re.sub(r"\.[a-z0-9]+$", "", (name or "").lower())
    return any(re.search(rf"(^|[^a-z]){w}([^a-z]|$)", stem) for w in HERO_WORDS)


# ---------------------------------------------------------------- per-second quality

def _frames(video: Path, duration: float, fps: float = 2.0) -> list[bytes]:
    try:
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={fps},scale={QW}:{QH},format=gray", "-f", "rawvideo", "-"],
            capture_output=True, check=True, timeout=600,
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []
    n = QW * QH
    return [out[i : i + n] for i in range(0, len(out) - n + 1, n)]


def blur_amount(f: bytes, w: int = QW, h: int = QH) -> float:
    """Crete et al. no-reference blur, 0 = sharp .. 1 = blurred: how much of the frame's own
    neighbour-to-neighbour variation survives a 1x7 box blur (an in-focus frame loses most of it).
    Content-independent: a plain wall in focus is not "blurry". A featureless frame returns 1."""
    df = dv = 0
    for y in range(2, h - 2, 3):
        row = f[y * w : (y + 1) * w]
        pref = [0]
        for v in row:
            pref.append(pref[-1] + v)
        bl = [(pref[min(w, x + 4)] - pref[max(0, x - 3)]) / (min(w, x + 4) - max(0, x - 3)) for x in range(w)]
        for x in range(1, w):
            d1 = abs(row[x] - row[x - 1])
            d2 = abs(bl[x] - bl[x - 1])
            df += d1
            dv += max(0.0, d1 - d2)
    if df < w * 0.08 * (h / 3):
        return 1.0  # nothing in the frame to be sharp (a blank or near-blank frame)
    return max(0.0, min(1.0, (df - dv) / df))


# A moved picture must match clearly better than the unmoved one (cost at most this share of it) to
# count as a measured shift. A walk-in, a fast pan or a dim, grainy room matches about as badly at
# every offset, and the "best" offset is then noise at the edge of the search: reading that as a
# jump marked whole handheld reveal videos as shake (23 Oct 2026, every second of a 35 s walk-through).
SHIFT_SURE = 0.7


def shift(a: bytes, b: bytes, w: int = QW, h: int = QH, r: int = 6) -> float | None:
    """How far the whole picture moved between two frames (px of the measuring frame), or None when
    no offset inside the search matches clearly better than none (motion the search cannot measure)."""
    best, bd = 0.0, None
    d0 = None
    pts = [(x, y) for y in range(r + 2, h - r - 2, 4) for x in range(r + 2, w - r - 2, 4)]
    for dy in range(-r, r + 1, 2):
        for dx in range(-r, r + 1, 2):
            d = sum(abs(a[y * w + x] - b[(y + dy) * w + x + dx]) for x, y in pts)
            if dx == 0 and dy == 0:
                d0 = d
            if bd is None or d < bd:
                bd, best = d, (dx * dx + dy * dy) ** 0.5
    if best and d0 and bd is not None and bd > SHIFT_SURE * d0:
        return None
    return best


def motion(a: bytes, b: bytes) -> float:
    step = 3
    return sum(abs(a[i] - b[i]) for i in range(0, len(a), step)) / max(1, len(a) // step)


def frame_scores(frames: list[bytes]) -> list[tuple[float, float]]:
    """(sharp 0..1, steady 0..1) per frame. Sharp from the blur measure; steady from how much the
    whole picture jumps between samples (half a second apart)."""
    out = []
    shifts = [shift(frames[i - 1], frames[i]) if i else 0.0 for i in range(len(frames))]
    if len(shifts) > 1:
        shifts[0] = shifts[1]
    for i, f in enumerate(frames):
        b = blur_amount(f)
        sharp = 1.0 - max(0.0, min(1.0, (b - 0.35) / 0.35))
        cur, prev = shifts[i], (shifts[i - 1] if i else 0.0)
        if cur is None:
            # Motion the search cannot measure (a walk-in, a fast pan): never called shake on its
            # own; real shake smears the frame, and the sharpness above catches that.
            steady = 1.0
        else:
            jit = abs(cur - prev) if prev is not None else 0.0
            # A smooth pan or walk-in moves steadily (kept); a jittery, jumping picture is shake.
            steady = 1.0 - max(0.0, min(1.0, (2.0 * jit + 0.5 * cur - 2.5) / 5.0))
        out.append((sharp, steady))
    return out


def quality_track(video: Path, duration: float) -> list[float]:
    """One number per second, 0..1: how sharp AND steady that second is. Empty when unmeasurable
    (every second is then treated as usable, as before)."""
    frames = _frames(video, duration)
    if not frames:
        return []
    sc = frame_scores(frames)
    secs = max(1, int(duration + 0.999))
    out = []
    for s in range(secs):
        got = sc[2 * s : 2 * s + 2] or sc[-1:]
        out.append(round(min(sum(a for a, _ in got) / len(got), sum(b for _, b in got) / len(got)), 3))
    return out


def span_quality(track: list[float], s: float, e: float) -> float:
    if not track:
        return 1.0
    a, b = max(0, int(s)), max(int(s) + 1, int(e + 0.999))
    vals = track[a:b] or track[-1:]
    return min(vals)


def best_window(track: list[float], s: float, e: float, length: float) -> tuple[float, float] | None:
    """The sharpest, steadiest `length` seconds inside [s, e], or None when every such window has a
    blurry or shaky second."""
    length = min(length, e - s)
    if length <= 0:
        return None
    if not track:
        return (s, s + length)
    best, bq = None, -1.0
    t = s
    while t + length <= e + 1e-6:
        q = span_quality(track, t, t + length)
        if q > bq:
            best, bq = (round(t, 2), round(t + length, 2)), q
        t += 0.5
    return best if bq >= GOOD else None


# ---------------------------------------------------------------- the same picture twice

def dhash_bytes(gray9x8: bytes) -> int:
    h = 0
    for y in range(8):
        for x in range(8):
            h = (h << 1) | (1 if gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1] else 0)
    return h


def frame_hash(video: Path, t: float) -> int | None:
    try:
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t):.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "-"],
            capture_output=True, check=True, timeout=60,
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None
    return dhash_bytes(out[:72]) if len(out) >= 72 else None


def hamming(a: int | None, b: int | None) -> int:
    if a is None or b is None:
        return 64
    return bin(a ^ b).count("1")


SAME_PICTURE = 10  # of 64 bits


def same_picture(a: int | None, b: int | None) -> bool:
    return hamming(a, b) <= SAME_PICTURE


# ---------------------------------------------------------------- dates, events, camera

DATE_RE = re.compile(r"(20\d{2})[-_.]?([01]\d)[-_.]?([0-3]\d)")


def date_from_name(name: str) -> str | None:
    m = DATE_RE.search(name or "")
    if not m:
        return None
    y, mo, d = m.groups()
    if not (1 <= int(mo) <= 12 and 1 <= int(d) <= 31):
        return None
    return f"{y}-{mo}-{d}"


def media_date(path: Path) -> str | None:
    """creation_time from the container (videos) or EXIF DateTimeOriginal (photos)."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=creation_time:stream_tags=creation_time", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, timeout=30).stdout
        m = DATE_RE.search(out or "")
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    exif = read_exif(path)
    if exif.get("date"):
        return exif["date"]
    return None


def read_exif(path: Path) -> dict[str, Any]:
    """{'camera': bool, 'date': 'YYYY-MM-DD' | None}; camera None when it cannot be read."""
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(path) as im:
            ex = im.getexif()
            make, model = ex.get(0x010F), ex.get(0x0110)
            dt = ex.get(0x9003) or ex.get(0x0132)
            try:
                dt = dt or ex.get_ifd(0x8769).get(0x9003)
            except Exception:  # noqa: BLE001
                pass
            d = DATE_RE.search(str(dt or ""))
            return {"camera": bool(str(make or "").strip() or str(model or "").strip()), "date": f"{d.group(1)}-{d.group(2)}-{d.group(3)}" if d else None}
    except Exception:  # noqa: BLE001
        return {"camera": None, "date": None}


def name_prefix(name: str) -> str | None:
    stem = re.sub(r"\.[a-z0-9]+$", "", (name or "").lower())
    m = re.match(r"([a-z]+(?:[-_ ][a-z]+)*)", stem)
    p = m.group(1).replace("_", "-").replace(" ", "-") if m else ""
    p = re.sub(r"-?(new|final|after|before|edit|copy)$", "", p).strip("-")
    return p if p and p.split("-")[0] not in CAMERA_PREFIXES and len(p) >= 3 else None


def event_groups(items: list[dict[str, Any]]) -> dict[str, str]:
    """{asset_id: event id}. Same calendar day = same event; with no dates at all, a shared file-name
    prefix ("smith-party-03.jpg"). Undated uploads join the one dated event when there is only one;
    with several events an undated upload stays on its own (never mixed into a story)."""
    dated: dict[str, list[str]] = {}
    undated = []
    for it in items:
        d = it.get("date")
        if d:
            dated.setdefault(d, []).append(it["id"])
        else:
            undated.append(it["id"])
    out: dict[str, str] = {}
    if dated:
        for i, d in enumerate(sorted(dated)):
            for aid in dated[d]:
                out[aid] = f"e{i + 1}"
        for j, aid in enumerate(undated):
            out[aid] = "e1" if len(dated) == 1 else f"u{j + 1}"
        return out
    # No dates: a file-name prefix counts as an event name only when two or more files share it
    # ("smith-party-01", "smith-party-02"); a one-off descriptive name ("prep.mp4") is not an event.
    prefixes = {it["id"]: name_prefix(it.get("name") or "") for it in items}
    shared = sorted({p for p in prefixes.values() if p and sum(1 for q in prefixes.values() if q == p) >= 2})
    if len(shared) >= 2:
        loose = 0
        for it in items:
            p = prefixes[it["id"]]
            if p in shared:
                out[it["id"]] = f"e{shared.index(p) + 1}"
            else:
                loose += 1
                out[it["id"]] = f"u{loose}"
        return out
    return {it["id"]: "e1" for it in items}


# ---------------------------------------------------------------- stages and heroes

@dataclass
class Look:
    """One usable shot as the planner sees it."""

    asset_id: str
    shot: Shot
    stage: str
    event: str
    photo: bool = False
    quality: float = 1.0
    hash: int | None = None
    name_hero: bool = False
    hero_rank: int = 0  # 1 = the event's best hero, 0 = not a hero
    key: str = field(default="")

    @property
    def start(self) -> float:
        return self.shot.start

    @property
    def end(self) -> float:
        return self.shot.end

    @property
    def length(self) -> float:
        return self.shot.length


def stage_of(shot: Shot, name_hero: bool = False) -> str:
    """A shot's stage from the sheet (the vision model's own stage when it gave one)."""
    given = getattr(shot, "stage", "") or ""
    if given in STAGES:
        return given
    what = f"{shot.what} {shot.subject}".lower()
    if shot.state == "before":
        return "arrival"
    if shot.people == "working":
        return "team"
    if shot.state == "in_progress":
        return "prep" if any(w in what for w in PREP_WORDS) else "process"
    if shot.state == "after" or (name_hero and shot.state in (UNSURE, "n/a") and shot.people == "none"):
        return "detail" if any(w in what for w in DETAIL_WORDS) else "finished"
    if any(w in what for w in PREP_WORDS):
        return "prep"
    return ""


def hero_score(lk: Look) -> float:
    s = lk.shot
    return (3.0 if lk.name_hero else 0.0) + (1.0 if lk.stage == "finished" else 0.6 if lk.stage == "detail" else 0.0) + lk.quality + (0.5 if s.steady else 0.0) + (0.5 if s.sharp else 0.0) + (0.4 if lk.photo else 0.0) + min(1.0, lk.length / 6.0) * 0.5


def pick_heroes(looks: list[Look], per_event: int = 3) -> None:
    """Mark each event's heroes (rank 1 = best): finished / detail views, steady and sharp, distinct
    pictures. An event with no finished view takes its best steady non-before shot, so a clip from
    it still ends on its most polished picture."""
    by_event: dict[str, list[Look]] = {}
    for lk in looks:
        by_event.setdefault(lk.event, []).append(lk)
    for ev, group in by_event.items():
        cands = [lk for lk in group if (lk.stage in ("finished", "detail") or lk.name_hero) and lk.quality >= GOOD and lk.length >= 1.0]
        if not cands:
            cands = [lk for lk in group if lk.stage not in ("arrival",) and lk.quality >= GOOD and lk.shot.people != "to_camera" and lk.length >= 1.0]
        chosen: list[Look] = []
        for lk in sorted(cands, key=hero_score, reverse=True):
            if any(same_picture(lk.hash, c.hash) for c in chosen):
                continue
            chosen.append(lk)
            if len(chosen) >= per_event:
                break
        for i, lk in enumerate(chosen):
            lk.hero_rank = i + 1


def build_looks(sheets: dict[str, ShotSheet], info: dict[str, dict[str, Any]]) -> list[Look]:
    """Every usable shot of the dump as a Look. `info[asset_id]` carries photo, event, name_hero,
    track (per-second quality) and hashes {(start, end): hash}."""
    out: list[Look] = []
    for aid, sh in sheets.items():
        meta = info.get(aid, {})
        for s in sh.shots:
            if s.privacy or s.length < 0.8:
                continue
            track = meta.get("track") or []
            if track:
                # The per-second track decides: the best 2 s inside the shot (blurry seconds are cut around).
                w = best_window(track, s.start, s.end, min(2.0, s.length))
                q = span_quality(track, w[0], w[1]) if w else min(span_quality(track, s.start, s.end), GOOD - 0.01)
            else:
                # No track: the model's own sharp / steady words.
                q = 1.0 if (s.sharp and s.steady) else 0.34
            lk = Look(aid, s, stage_of(s, bool(meta.get("name_hero"))), meta.get("event", "e1"), bool(meta.get("photo")), q, (meta.get("hashes") or {}).get((s.start, s.end)), bool(meta.get("name_hero")))
            lk.key = f"{aid}@{s.start:.2f}"
            out.append(lk)
    pick_heroes(out)
    for lk in out:
        if lk.hero_rank:
            lk.stage = "hero"
    return out


def asset_roles(looks: list[Look]) -> dict[str, str]:
    """{asset_id: stage} for the dump report: an upload's most telling stage (hero wins)."""
    order = {s: i for i, s in enumerate(("hero", "finished", "detail", "team", "process", "prep", "arrival"))}
    roles: dict[str, str] = {}
    for lk in looks:
        if not lk.stage:
            continue
        cur = roles.get(lk.asset_id)
        if cur is None or order[lk.stage] < order[cur]:
            roles[lk.asset_id] = lk.stage
    return roles
