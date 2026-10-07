"""Cut a dump into vertical clips (BUILD_PLAN.md section 8). OWNED BY: phase 4.

Pipeline per dump (every stage reports progress; logs carry counts only):
  1. download each uploaded video (streamed from R2 through the Worker, signed)
  2. normalize: constant 30 fps, yuv420p, long side <= 1920, 48 kHz stereo audio (silent track
     added when a video has none)
  3. transcribe with faster-whisper (word timestamps, CPU); "none" when it is not installed
  4. pick moments: an OpenRouter free model reads transcript + dump notes + Brand Profile +
     Research Brief and proposes 2-3x the weekly need; a deterministic fallback (silence-based
     segmentation + longest speech runs) runs when there is no key or the model fails
  5. cut with ffmpeg into one of the recipes (talking_head, hook_first, story, montage; Door B:
     recycle = new first 2 seconds, new subtitle style, trimmed dead air, new caption)
  6. render each clip in a Look (jobs/looks.py, jobs/looks.json): clip k takes the Worker's
     rotation[k] (her enabled Looks, varied per dump), so a dump's clips never all look alike.
     A Look sets the captions (clean / karaoke / boxed / none, word-level ASS burned with libass,
     soft subtitles when this ffmpeg has none), the hook at the top, the layout (face-follow 9:16
     crop from MediaPipe's face centre or cropdetect + centre; a blurred fill; a reaction inset;
     or a grid of the dump's other moments with one voice cell), punch-in, a progress bar,
     crossfades, a warm grade, her end card and a music bed from her own songs; loudness to
     -14 LUFS; cover frame. A job whose spec says mode "rerender" makes one clip again in the
     Look she picked in Review.
  7. caption, hashtags, hook + alternative hook; score 0..1 from speech density, hook
     strength and length fit
  8. upload clips/<dump_id>/<clip_id>.mp4 and .jpg, then call back with the clip list

The result shape is checked by the Worker (worker/jobs/cut.ts parseCutResult) and pinned by
tests/unit/cut-result.test.ts against tests/unit/fixtures/cut-result.sample.json, which
jobs/selftest_cut.py regenerates from a real local run.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import WORK, Job, download_input, json_object_in, log, openrouter_content, run, upload_output  # noqa: E402
import looks as L  # noqa: E402

OUT_W, OUT_H = 1080, 1920
FPS = 30
RECIPE_ORDER = ["talking_head", "hook_first", "story", "montage"]
DEFAULT_RECIPES = {
    "talking_head": {"minS": 20, "maxS": 45},
    "hook_first": {"minS": 15, "maxS": 60},
    "story": {"minS": 45, "maxS": 90},
    "montage": {"minS": 15, "maxS": 45},
    "recycle": {"minS": 15, "maxS": 90},
}
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")
ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


class NoUsableMoments(Exception):
    """Nothing in the dump could become a clip (too short, silent and empty)."""


# ---------------------------------------------------------------- small helpers

def new_clip_id() -> str:
    return "clp_" + "".join(secrets.choice(ALPHABET) for _ in range(16))


def sh(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    """Run a tool quietly. Output is captured, never printed (it can contain paths)."""
    return subprocess.run(args, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout, check=True)


def ffmpeg(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    return sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], cwd=cwd, timeout=timeout)


def probe(path: Path) -> dict[str, Any]:
    out = sh(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]).stdout
    data = json.loads(out or "{}")
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    dur = float(data.get("format", {}).get("duration") or (v or {}).get("duration") or 0)
    w, h = int((v or {}).get("width") or 0), int((v or {}).get("height") or 0)
    rot = 0
    for sd in (v or {}).get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if abs(rot) in (90, 270):
        w, h = h, w
    return {"duration": dur, "width": w, "height": h, "has_audio": a is not None, "has_video": v is not None}


_FILTERS: set[str] | None = None


def ffmpeg_has_filter(name: str) -> bool:
    global _FILTERS
    if _FILTERS is None:
        out = sh(["ffmpeg", "-hide_banner", "-filters"]).stdout
        _FILTERS = {parts[1] for parts in (line.split() for line in out.splitlines()) if len(parts) >= 3}
    return name in _FILTERS


def even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


# ---------------------------------------------------------------- heavy tools

def ensure_heavy() -> dict[str, bool]:
    """With JOB_HEAVY=1 (set by job-cut.yml) install faster-whisper and, if it installs within a
    minute, MediaPipe. Locally nothing is installed; whatever is importable is used."""
    if os.environ.get("JOB_HEAVY") == "1":
        pip = [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check"]
        try:
            sh([*pip, "faster-whisper>=1.0,<2"], timeout=900)
            log("heavy.whisper", ok=True)
        except Exception:  # noqa: BLE001
            log("heavy.whisper", ok=False)
        try:
            sh([*pip, "mediapipe>=0.10,<0.11"], timeout=60)
            log("heavy.mediapipe", ok=True)
        except Exception:  # noqa: BLE001
            log("heavy.mediapipe", ok=False)
    return {"whisper": _importable("faster_whisper"), "mediapipe": _importable("mediapipe") and _importable("cv2")}


def _importable(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- media stages

def normalize(src: Path, dst: Path, window: tuple[float, float] | None = None) -> dict[str, Any]:
    """Constant 30 fps, yuv420p, long side <= 1920, 48 kHz stereo. `window` (start, end) keeps only
    that stretch (a single-clip re-render never re-encodes a whole long video)."""
    info = probe(src)
    if not info["has_video"] or info["duration"] <= 0:
        raise NoUsableMoments("no video stream")
    scale = "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'"
    args = ["-ss", f"{window[0]:.3f}", "-t", f"{window[1] - window[0]:.3f}", "-i", str(src)] if window else ["-i", str(src)]
    if not info["has_audio"]:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest"]
    args += [
        "-map", "0:v:0", "-map", "0:a:0" if info["has_audio"] else "1:a:0",
        "-vf", f"{scale},fps={FPS},format=yuv420p,setsar=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
        "-movflags", "+faststart", str(dst),
    ]
    ffmpeg(args)
    out = probe(dst)
    out["had_audio"] = info["has_audio"]
    return out


def extract_wav(src: Path, dst: Path) -> None:
    ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(dst)])


def speech_runs(wav: Path, duration: float, noise_db: int = -35, min_silence: float = 0.4) -> list[tuple[float, float]]:
    """Non-silent stretches from ffmpeg silencedetect: the deterministic picker's raw material."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(wav), "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True, text=True, timeout=900,
    )
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in proc.stderr.splitlines():
        m = re.search(r"silence_start: (-?[\d.]+)", line)
        if m:
            start = max(0.0, float(m.group(1)))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    if start is not None:
        silences.append((start, duration))
    runs: list[tuple[float, float]] = []
    t = 0.0
    for s, e in silences:
        if s - t >= 0.3:
            runs.append((round(t, 2), round(s, 2)))
        t = e
    if duration - t >= 0.3:
        runs.append((round(t, 2), round(duration, 2)))
    return runs


Word = L.Word  # one word type for transcripts and captions (jobs/looks.py)


@dataclass
class Transcript:
    words: list[Word] = field(default_factory=list)
    segments: list[tuple[float, float, str]] = field(default_factory=list)
    engine: str = "none"

    def words_in(self, s: float, e: float) -> list[Word]:
        return [w for w in self.words if w.start >= s - 0.05 and w.end <= e + 0.05]

    def text_in(self, s: float, e: float) -> str:
        return " ".join(w.text for w in self.words_in(s, e)).strip()


_WHISPER = None


def transcribe(wav: Path, available: bool) -> Transcript:
    global _WHISPER
    if not available:
        return Transcript(engine="none")
    try:
        from faster_whisper import WhisperModel  # type: ignore

        if _WHISPER is None:
            _WHISPER = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8")
        segs, _info = _WHISPER.transcribe(str(wav), word_timestamps=True, vad_filter=True)
        t = Transcript(engine="faster-whisper")
        for seg in segs:
            t.segments.append((float(seg.start), float(seg.end), seg.text.strip()))
            for w in seg.words or []:
                txt = w.word.strip()
                if txt:
                    t.words.append(Word(float(w.start), float(w.end), txt))
        return t
    except Exception:  # noqa: BLE001
        log("transcribe.failed")
        return Transcript(engine="none")


# ---------------------------------------------------------------- moment picking

@dataclass
class Moment:
    asset_id: str
    recipe: str
    start: float
    end: float
    parts: list[tuple[float, float]]
    hook: str = ""
    hook_alt: str = ""
    caption: str = ""
    hashtags: list[str] = field(default_factory=list)
    hook_strength: float | None = None


def coverage(runs: list[tuple[float, float]], s: float, e: float) -> float:
    if e <= s:
        return 0.0
    got = sum(max(0.0, min(e, b) - max(s, a)) for a, b in runs)
    return got / (e - s)


def snap_end(runs: list[tuple[float, float]], start: float, lo: float, hi: float, target: float, duration: float) -> float:
    """End the cut at a pause (the end of a speech run) near the target length."""
    hi = min(hi, duration)
    cands = [b for _a, b in runs if lo <= b <= hi]
    if cands:
        return min(cands, key=lambda b: abs(b - target))
    return max(lo, min(target, hi))


def windows(runs: list[tuple[float, float]], duration: float, min_s: float, max_s: float, count: int, prefer_speech: bool = True) -> list[tuple[float, float, float]]:
    """Best non-overlapping windows (start, end, speech coverage), highest coverage first."""
    if count <= 0 or duration < 3:
        return []
    if duration < min_s:
        return [(0.0, round(duration, 2), coverage(runs, 0, duration))]
    target = (min_s + max_s) / 2
    starts = sorted({round(a, 2) for a, _b in runs} | {float(x) for x in range(0, int(max(1, duration - min_s)) + 1, 5)})
    cands = []
    for st in starts:
        if st + min_s > duration:
            continue
        en = snap_end(runs, st, st + min_s, st + max_s, st + target, duration)
        if en - st < min_s - 0.01:
            continue
        cov = coverage(runs, st, en)
        cands.append((st, round(en, 2), cov))
    cands.sort(key=lambda w: (w[2] if prefer_speech else 1 - w[2]), reverse=True)
    chosen: list[tuple[float, float, float]] = []
    for w in cands:
        if all(min(w[1], c[1]) - max(w[0], c[0]) < 0.3 * (w[1] - w[0]) for c in chosen):
            chosen.append(w)
        if len(chosen) >= count:
            break
    return chosen


def best_line(runs: list[tuple[float, float]], transcript: Transcript, s: float, e: float, max_len: float, skip_first: float = 0.0) -> tuple[float, float] | None:
    """The strongest short line inside [s, e): most words (or longest speech run) not at the very start."""
    best = None
    best_score = -1.0
    for a, b in runs:
        a2, b2 = max(a, s + skip_first), min(b, e)
        if b2 - a2 < 0.8:
            continue
        b2 = min(b2, a2 + max_len)
        score = len(transcript.words_in(a2, b2)) + (b2 - a2) * 0.1
        if score > best_score:
            best, best_score = (round(a2, 2), round(b2, 2)), score
    return best


def first_sentence(text: str, max_words: int = 9) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    sent = re.split(r"(?<=[.!?])\s", text)[0]
    words = sent.split()
    out = " ".join(words[:max_words])
    return out.rstrip(",;:") + ("…" if len(words) > max_words else "")


def brief_hooks(brief: Any) -> list[str]:
    try:
        return [first_sentence(str(c.get("text", "")), 9) for c in (brief or {}).get("hooks", []) if c.get("text")]
    except Exception:  # noqa: BLE001
        return []


def theme_tags(profile: dict[str, str] | None, brief: Any) -> list[str]:
    raw: list[str] = []
    if profile:
        raw += re.split(r"[\n,;•·/]+", profile.get("themes", ""))
    try:
        raw += [str(t.get("title", "")) for t in (brief or {}).get("themes", [])]
    except Exception:  # noqa: BLE001
        pass
    tags: list[str] = []
    for r in raw:
        words = re.findall(r"[A-Za-z0-9]+", r)[:3]
        if not words:
            continue
        tag = "#" + "".join(w.lower() for w in words)
        if 3 <= len(tag) <= 30 and tag not in tags:
            tags.append(tag)
    return tags[:5] or ["#creator"]


def cta_line(profile: dict[str, str] | None) -> str:
    if not profile:
        return ""
    lines = [l.strip(" -•\t") for l in profile.get("ctas", "").splitlines() if l.strip(" -•\t")]
    return lines[0][:80] if lines else ""


GENERIC_HOOKS = {
    "talking_head": ["Real talk for a second", "Here's what nobody tells you"],
    "hook_first": ["Wait for this part", "You need to hear this"],
    "story": ["Story time", "So this happened"],
    "montage": ["A little look at my week", "Come along with me"],
    "recycle": ["Round two, because you asked", "Still one of my favorites"],
}


def fill_copy(m: Moment, transcript: Transcript, spec: dict[str, Any], i: int) -> None:
    """Deterministic hook / alt hook / caption / hashtags when the model did not provide them."""
    hooks = brief_hooks(spec.get("brief"))
    said = first_sentence(transcript.text_in(m.start, m.end))
    generic = GENERIC_HOOKS.get(m.recipe, GENERIC_HOOKS["talking_head"])
    if not m.hook:
        m.hook = said or (hooks[i % len(hooks)] if hooks else generic[0])
    if not m.hook_alt:
        alt = hooks[(i + 1) % len(hooks)] if hooks else generic[1]
        m.hook_alt = alt if alt != m.hook else generic[1]
    if not m.caption:
        cta = cta_line(spec.get("brand_profile"))
        base = first_sentence(transcript.text_in(m.start, m.end), 25) or m.hook
        base = base.rstrip("….!?,;: ")
        base = base[:1].upper() + base[1:]
        if m.recipe == "recycle":
            base = f"{base} (a favorite, back again)"
        m.caption = f"{base}. {cta}" if cta else f"{base}."
    if not m.hashtags:
        m.hashtags = theme_tags(spec.get("brand_profile"), spec.get("brief"))


def hook_strength(text: str) -> float:
    t = text.lower()
    s = 0.5
    if "?" in t:
        s += 0.1
    if re.search(r"\d", t):
        s += 0.1
    if re.search(r"\b(you|your)\b", t):
        s += 0.1
    if 0 < len(t.split()) <= 8:
        s += 0.1
    return min(0.9, s)


def fallback_moments(asset: dict[str, Any], duration: float, runs: list[tuple[float, float]], transcript: Transcript, recipes: dict[str, Any], quota: int, door: str, allowed: list[str] | None = None) -> list[Moment]:
    """Silence-based segmentation + longest speech runs. Always yields something for footage >= 3 s."""
    aid = asset["id"]
    out: list[Moment] = []
    if door == "recycle":
        b = recipes["recycle"]
        body_s = runs[0][0] if runs else 0.0
        body_e = runs[-1][1] if runs else duration
        if body_e - body_s < 3:
            body_s, body_e = 0.0, duration
        wins = [(body_s, body_e, 1.0)] if body_e - body_s <= b["maxS"] - 2 else windows(runs, duration, 45, b["maxS"] - 2, max(1, quota))
        for s, e, _c in wins[: max(1, quota)]:
            line = best_line(runs, transcript, s, e, 2.0, skip_first=3.0)
            parts = [line, (s, e)] if line and (e - s) > 5 else [(s, e)]
            out.append(Moment(aid, "recycle", round(s, 2), round(e, 2), parts))
        return out

    speechy = coverage(runs, 0, duration) >= 0.35
    order = RECIPE_ORDER if speechy else ["montage", "talking_head", "hook_first", "story"]
    # Her clip length (worker/domain/steer.ts recipesAllowed): only the recipes that reach it.
    if allowed:
        order = [r for r in order if r in allowed] or order
    per = max(1, math.ceil(quota / len(order)))
    for r in order:
        if len(out) >= quota:
            break
        b = recipes[r]
        max_s = b["maxS"] - 3 if r == "hook_first" else b["maxS"]
        for s, e, _c in windows(runs, duration, b["minS"], max_s, per, prefer_speech=(r != "montage")):
            parts = [(s, e)]
            if r == "hook_first":
                line = best_line(runs, transcript, s, e, 3.0, skip_first=2.0)
                if not line:
                    continue
                parts = [line, (s, e)]
            out.append(Moment(aid, r, round(s, 2), round(e, 2), parts))
            if len(out) >= quota:
                break
    if not out and duration >= 3:
        out.append(Moment(aid, "montage", 0.0, round(min(duration, recipes["montage"]["maxS"]), 2), [(0.0, round(min(duration, recipes["montage"]["maxS"]), 2))]))
    return out


def llm_moments(asset: dict[str, Any], duration: float, transcript: Transcript, spec: dict[str, Any], quota: int, runs: list[tuple[float, float]]) -> list[Moment] | None:
    """Ask the free OpenRouter model for moments. None means "use the fallback"."""
    # The studio's own key, from its signed spec (each studio pays for its own AI); env only for local runs.
    key = spec.get("llm_key") or os.environ.get("OPENROUTER_API_KEY")
    if not key or not transcript.segments:
        return None
    recipes = spec["recipes"]
    door = spec["door"]
    lines = "\n".join(f"[{s:.1f}-{e:.1f}] {t}" for s, e, t in transcript.segments)[:24000]
    st = steer_of(spec, asset)
    allowed = ["recycle"] if door == "recycle" else ([r for r in RECIPE_ORDER if r in (st.get("allowed_recipes") or RECIPE_ORDER)] or RECIPE_ORDER)
    system = (
        "You pick short vertical-video moments for one creator. Follow her Brand Profile exactly; never pick anything on her "
        "off-limits list. Answer with JSON only: {\"moments\":[{\"start\":s,\"end\":s,\"recipe\":r,\"hook\":str,\"hook_alt\":str,"
        "\"caption\":str,\"hashtags\":[str],\"hook_strength\":0..1}]}. hook and hook_alt are on-screen text, max 8 words each. "
        "caption max 150 characters in her voice with one call to action. 3-5 hashtags."
    )
    user = json.dumps(
        {
            "recipes": {r: recipes[r] for r in allowed},
            "how_many": quota,
            "video_seconds": round(duration, 1),
            "dump_notes": spec.get("notes", ""),
            "file_note": asset.get("file_note") or "",
            "must_include": st.get("include") or [],
            "leave_out": st.get("avoid") or [],
            "brand_profile": spec.get("brand_profile") or {},
            "research_brief": {k: (spec.get("brief") or {}).get(k) for k in ("hooks", "cut_styles", "themes")},
            "transcript": lines,
        }
    )
    payload = {"model": OPENROUTER_MODEL, "max_tokens": 2500, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    for attempt in range(2):
        try:
            text, _ = openrouter_content(key, payload, timeout=120, usable=json_object_in)
            m = re.search(r"\{.*\}", text, re.S)
            items = json.loads(m.group(0) if m else text).get("moments", [])
            out: list[Moment] = []
            for it in items:
                r = str(it.get("recipe", ""))
                if r not in allowed:
                    continue
                b = recipes[r]
                s = max(0.0, float(it.get("start", 0)))
                e = min(duration, float(it.get("end", 0)))
                max_s = b["maxS"] - 3 if r == "hook_first" else b["maxS"]
                if e - s > max_s:
                    e = s + max_s
                if e - s < min(b["minS"], duration) - 1 or e - s < 3:
                    continue
                parts = [(round(s, 2), round(e, 2))]
                if r in ("hook_first", "recycle"):
                    line = best_line(runs, transcript, s, e, 3.0 if r == "hook_first" else 2.0, skip_first=2.0)
                    if line:
                        parts = [line, parts[0]]
                    elif r == "hook_first":
                        continue
                hs = it.get("hook_strength")
                out.append(
                    Moment(
                        asset["id"], r, round(s, 2), round(e, 2), parts,
                        hook=str(it.get("hook", ""))[:120], hook_alt=str(it.get("hook_alt", ""))[:120], caption=str(it.get("caption", ""))[:300],
                        hashtags=[str(h) for h in (it.get("hashtags") or [])][:6],
                        hook_strength=float(hs) if isinstance(hs, (int, float)) else None,
                    )
                )
                if len(out) >= quota:
                    break
            log("pick.model", ok=True, moments=len(out))
            return out or None
        except Exception:  # noqa: BLE001
            log("pick.model", ok=False, attempt=attempt)
            time.sleep(3)
    return None


# ---------------------------------------------------------------- framing (9:16)

def detect_bars(src: Path, duration: float) -> tuple[int, int, int, int] | None:
    """cropdetect over a few seconds in the middle: the picture area without black bars."""
    ss = max(0.0, duration / 2 - 2)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-ss", f"{ss:.2f}", "-t", "4", "-i", str(src), "-vf", "cropdetect=24:2:0", "-f", "null", "-"],
        capture_output=True, text=True, timeout=300,
    )
    found = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", proc.stderr)
    if not found:
        return None
    w, h, x, y = map(int, found[-1])
    return (w, h, x, y) if w > 0 and h > 0 else None


FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
FACE_MODEL = Path(os.environ.get("FACE_MODEL_PATH", str(WORK / "blaze_face_short_range.tflite")))
_DETECTOR: Any = None


def face_detector(available: bool) -> Any:
    """MediaPipe Tasks face detector (the legacy mp.solutions API is gone from 0.10.2x+).
    The short-range model suits phone selfie footage. None when anything is missing."""
    global _DETECTOR
    if _DETECTOR is not None or not available:
        return _DETECTOR
    _stage = "import"
    try:
        import mediapipe as mp  # type: ignore
        from mediapipe.tasks.python import BaseOptions, vision  # type: ignore

        _stage = "model"
        if not FACE_MODEL.exists():
            FACE_MODEL.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(FACE_MODEL_URL, timeout=60) as res:
                FACE_MODEL.write_bytes(res.read())
        _stage = "create"
        opts = vision.FaceDetectorOptions(base_options=BaseOptions(model_asset_path=str(FACE_MODEL)), min_detection_confidence=0.5)
        _DETECTOR = (mp, vision.FaceDetector.create_from_options(opts))
    except Exception as e:  # noqa: BLE001
        missing = re.search(r"lib[\w.+-]+\.so[\d.]*", str(e))  # a system library name, never content
        log("face.detector.unavailable", err=type(e).__name__, where=_stage, lib=missing.group(0) if missing else None)
        _DETECTOR = False
    return _DETECTOR


def face_center(src: Path, s: float, e: float, available: bool) -> float | None:
    """Median horizontal face centre (0..1) across the clip, sampled every 0.5 s; None when
    the detector is unavailable or no face is found (then the centre crop is used)."""
    d = face_detector(available)
    if not d:
        return None
    try:
        import cv2  # type: ignore

        mp, det = d
        cap = cv2.VideoCapture(str(src))
        xs: list[float] = []
        t = s
        while t < e and len(xs) < 120:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                break
            h, w = frame.shape[:2]
            res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
            if res.detections:
                bb = max(res.detections, key=lambda x: x.bounding_box.width).bounding_box
                xs.append((bb.origin_x + bb.width / 2) / max(1, w))
            t += 0.5
        cap.release()
        if not xs:
            return None
        xs.sort()
        return min(1.0, max(0.0, xs[len(xs) // 2]))
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- render (Looks, jobs/looks.py)

def clip_words(transcript: Transcript, parts: list[tuple[float, float]]) -> list[Word]:
    """Source-time words mapped onto the clip timeline (parts are concatenated in order)."""
    out: list[Word] = []
    offset = 0.0
    for s, e in parts:
        for w in transcript.words_in(s, e):
            out.append(Word(round(w.start - s + offset, 3), round(w.end - s + offset, 3), w.text))
        offset += e - s
    return out


@dataclass
class Source:
    """A normalized video the renderer can cut from, with what it knows about it."""

    path: Path
    info: dict[str, Any]
    transcript: Transcript
    runs: list[tuple[float, float]]
    bars: tuple[int, int, int, int] | None = None
    faces: dict[tuple[float, float], float | None] = field(default_factory=dict)

    def seg(self, s: float, e: float, mediapipe: bool, zoom: float = 1.0) -> L.Seg:
        key = (round(s, 1), round(e, 1))
        if key not in self.faces:
            self.faces[key] = face_center(self.path, s, e, mediapipe)
        return L.Seg(self.path, round(s, 3), round(e, 3), self.info["width"], self.info["height"], self.bars, self.faces[key], zoom)

    def window(self, s: float, length: float) -> tuple[float, float]:
        """A stretch of `length` seconds starting near `s`, kept inside the video."""
        d = self.info["duration"]
        if length >= d:
            return 0.0, d
        s = min(max(0.0, s), d - length)
        return s, s + length


def words_on_timeline(src: Source, parts: list[tuple[float, float]], opts: dict[str, Any]) -> list[Word]:
    segs = [L.Seg(src.path, s, e, 0, 0) for s, e in parts]
    return L.timeline_words([src.transcript.words_in(s, e) for s, e in parts], segs, opts)


def inset_for(src: Source, m: "Moment", mediapipe: bool) -> L.Seg:
    """The reaction beat for a pip Look: the strongest short line inside the moment."""
    line = best_line(src.runs, src.transcript, m.start, m.end, 3.0, skip_first=2.0)
    if not line:
        a = m.start + (m.end - m.start) * 0.6
        line = (round(a, 2), round(min(m.end, a + 2.5), 2))
    return src.seg(line[0], line[1], mediapipe)


def grid_cells(k: int, m: "Moment", src: Source, others: list[tuple[str, "Moment", Source]], n: int, mediapipe: bool) -> tuple[list[L.Seg], dict[str, Any]]:
    """Cells for a grid Look: this moment first, then the dump's other moments (clip k+1, k+2 …,
    each a same-length stretch of its own video), then this moment closer (zooms) when the dump
    has fewer moments than cells. The voice is the cell with the clearest speech."""
    length = m.end - m.start
    cells = [src.seg(m.start, m.end, mediapipe)]
    layout: list[dict[str, Any]] = [{"kind": "self"}]
    speech = [coverage(src.runs, m.start, m.end)]
    for j in range(len(others)):
        if len(cells) >= n:
            break
        cid, om, osrc = others[(k + j) % len(others)]
        s, e = osrc.window(om.start, length)
        cells.append(osrc.seg(s, e, mediapipe))
        layout.append({"kind": "clip", "clip_id": cid})
        speech.append(coverage(osrc.runs, s, e))
    zooms = [1.35, 1.7, 2.1]
    z = 0
    while len(cells) < n:
        cells.append(src.seg(m.start, m.end, mediapipe, zooms[z % len(zooms)]))
        layout.append({"kind": "zoom", "zoom": zooms[z % len(zooms)]})
        speech.append(speech[0] * 0.99)  # the same sound as cell 0: never preferred over it
        z += 1
    voice = max(range(len(speech)), key=lambda i: (speech[i], -i))
    return cells, {"cells": layout, "voice": voice}


def speech_share(src: "Source", stretches: list[tuple[float, float]]) -> float:
    """How much of a clip has her talking (0..1): her words' time when there is a transcript, else
    the non-silent stretches. The Worker voices over a clip automatically only under 15%
    (worker/domain/autoVoice.ts isSilentClip)."""
    total = sum(max(0.0, e - s) for s, e in stretches) or 1.0
    if src.transcript.words:
        spoken = sum(max(0.0, min(e, w.end) - max(s, w.start)) for s, e in stretches for w in src.transcript.words if w.end > s and w.start < e)
    else:
        spoken = sum(coverage(src.runs, s, e) * (e - s) for s, e in stretches)
    return round(min(1.0, spoken / total), 3)


def music_key(spec: dict[str, Any], k: int) -> str | None:
    """The song clip k gets (her uploads only, one per clip in turn), or None."""
    tracks = [t for t in (spec.get("music") or []) if isinstance(t, dict) and str(t.get("r2_key", "")).startswith("music/")]
    return str(tracks[k % len(tracks)]["r2_key"]) if tracks else None


def music_for(spec: dict[str, Any], k: int, work: Path, download: "Downloader", cache: dict[str, Path]) -> Path | None:
    """Her own uploaded songs only (Settings > Editing > My music), one per clip in turn."""
    tracks = [t for t in (spec.get("music") or []) if isinstance(t, dict) and str(t.get("r2_key", "")).startswith("music/")]
    if not tracks:
        return None
    key = str(tracks[k % len(tracks)]["r2_key"])
    if key not in cache:
        try:
            cache[key] = download(key, work / f"music_{len(cache)}")
        except Exception:  # noqa: BLE001
            log("cut.music.unavailable")
            return None
    return cache[key]


def render_moment(m: "Moment", src: Source, opts: dict[str, Any], brand: L.Branding, work: Path, clip_id: str, mediapipe: bool, *, cells: list[L.Seg] | None = None, voice: int = 0, voice_src: Source | None = None, music: Path | None = None) -> L.Rendered:
    parts = [src.seg(s, e, mediapipe) for s, e in m.parts]
    if cells:
        vs = voice_src or src
        c = cells[voice]
        words = [Word(round(w.start - c.start, 3), round(w.end - c.start, 3), w.text) for w in vs.transcript.words_in(c.start, c.end)]
    else:
        words = words_on_timeline(src, m.parts, opts)
    inset = inset_for(src, m, mediapipe) if opts["layout"] == "pip" else None
    return L.render_look(opts, parts, words, m.hook, brand, work, clip_id, cells=cells, voice=voice, inset=inset, music=music if opts.get("music") else None)




def score_moment(m: Moment, transcript: Transcript, runs: list[tuple[float, float]], recipes: dict[str, Any]) -> float:
    length = m.end - m.start
    if transcript.words:
        density = min(1.0, len(transcript.words_in(m.start, m.end)) / max(1.0, length) / 2.5)
    else:
        density = coverage(runs, m.start, m.end)
    if m.recipe == "montage":
        density = max(density, 0.5)
    hook = m.hook_strength if m.hook_strength is not None else hook_strength(m.hook)
    b = recipes.get(m.recipe, {"minS": 15, "maxS": 60})
    sweet = (b["minS"] + b["maxS"]) / 2
    fit = max(0.0, 1.0 - abs(length - sweet) / max(1.0, (b["maxS"] - b["minS"])))
    return round(max(0.0, min(1.0, 0.45 * density + 0.35 * hook + 0.2 * fit)), 3)


# ---------------------------------------------------------------- the whole dump


# ---------- whose video is this? (watermark check) ----------
# Phase 0 live test, 25 Sep 2026: downloaded TikToks of another creator went through the cutter
# and nothing noticed the burned-in "TikTok @handle" watermark. We OCR a few frames and report
# any platform watermark and the @handles near it; the Worker decides with her own handles
# (worker/domain/sourceCheck.ts). Without tesseract the check is skipped and says so in the log.
HANDLE_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9._]{1,29})")
# Eight frames, two OCR passes each. Staging, 25 Sep 2026: the plain pass read "TikTok" on a
# downloaded TikTok but no @handle (the white handle text sits on busy footage), so the note could
# not name whose video it was, and her own recycled TikToks would be held too. The second pass reads
# a preprocessed copy: doubled, grayscale, near-white text turned black on white.
WATERMARK_SAMPLES = (0.06, 0.18, 0.3, 0.42, 0.54, 0.66, 0.78, 0.92)
OCR_PREPROCESS = "scale=iw*2:ih*2,format=gray,lutyuv=y='if(gt(val,215),0,255)'"


# The handle sits right above or below the "TikTok" mark (the watermark moves between corners).
# tesseract often reads its "@" as "@ " or "©", or drops it (staging, 25 Sep 2026:
# "TikTok\n\n@ evahfourevah", "© evahfourevah", "TikTok\n\nevahfourevah"), and a low-resolution
# video gives misspellings ("trenasqirdenfairys" for texasgardenfairyx) and 2-letter noise. So: a
# line that is only "@ handle" counts, a bare word next to the mark counts from 4 characters, and
# every candidate is counted across the sampled frames: the watermark repeats, noise does not.
AT_LINE_RE = re.compile(r"^[@©®]\s*([A-Za-z0-9][A-Za-z0-9._]{2,29})\.?$")
NEXT_TO_MARK_RE = re.compile(r"^[@©®]?\s*([A-Za-z0-9][A-Za-z0-9._]{3,29})\.?$")


def parse_marks(texts: list[str]) -> dict[str, Any] | None:
    """OCR text of sampled frames -> {platform, handles} or None when no watermark is seen.

    TikTok stamps "TikTok" and "@handle" on every download. Instagram has no fixed watermark, so
    it counts only when "Instagram" and an @handle are on the same line (never a caption that
    just mentions Instagram). Handles come most-seen first; when one was read on two or more
    frames, the ones read only once (misreads, @mentions in captions) are dropped."""
    platform = None
    counts: dict[str, int] = {}
    order: list[str] = []

    def add(h: str) -> None:
        h = h.rstrip("._")
        if not h or h.lower() in ("tiktok", "instagram"):
            return
        if h not in counts:
            order.append(h)
        counts[h] = counts.get(h, 0) + 1

    for text in texts:
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        seen: set[str] = set()
        for i, line in enumerate(lines):
            low = line.lower()
            found = HANDLE_RE.findall(line)
            at = AT_LINE_RE.match(line)
            if at and not found:
                found = [at.group(1)]
            if "tiktok" in low.replace(" ", ""):
                platform = "tiktok"
                for j in (i - 1, i + 1):
                    near = NEXT_TO_MARK_RE.match(lines[j]) if 0 <= j < len(lines) and "tiktok" not in lines[j].lower() else None
                    if near and near.group(1) not in seen:
                        seen.add(near.group(1))
                        add(near.group(1))
            elif "instagram" in low and found and platform is None:
                platform = "instagram"
            for h in found:
                if h.rstrip("._") not in seen:
                    seen.add(h.rstrip("._"))
                    add(h)
    if not platform:
        return None
    ranked = sorted(order, key=lambda h: (-counts[h], order.index(h)))
    if ranked and counts[ranked[0]] >= 2:
        ranked = [h for h in ranked if counts[h] >= 2]
    return {"platform": platform, "handles": ranked[:10]}


def ocr_frames(norm: Path, duration: float, work: Path, tag: str) -> list[str]:
    """OCR text of the sampled frames: per frame the plain picture, then the preprocessed one."""
    texts: list[str] = []
    for k, f in enumerate(WATERMARK_SAMPLES):
        for variant, vf in (("plain", "scale=1080:-2"), ("ink", f"scale=1080:-2,{OCR_PREPROCESS}")):
            png = work / f"wm_{tag}_{k}_{variant}.png"
            try:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{max(0.0, duration * f):.2f}", "-i", str(norm), "-frames:v", "1", "-vf", vf, str(png)], check=True, timeout=60)
                out = subprocess.run(["tesseract", str(png), "stdout", "--psm", "11"], capture_output=True, text=True, timeout=60)
                texts.append(out.stdout)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                continue
            finally:
                png.unlink(missing_ok=True)
    return texts


def source_marks(norm: Path, duration: float, work: Path, asset_id: str) -> dict[str, Any] | None:
    if not shutil.which("tesseract"):
        log("cut.source_check.skipped", reason="no_tesseract")
        return None
    texts = ocr_frames(norm, duration, work, asset_id)
    mark = parse_marks(texts)
    log("cut.source_check", frames=len(texts), watermark=bool(mark), handles=len(mark["handles"]) if mark else 0)
    return {"asset_id": asset_id, **mark} if mark else None

# ---------------------------------------------------------------- her steering (worker/domain/steer.ts)

STOPWORDS = {"the", "and", "with", "where", "that", "this", "part", "bit", "about", "when", "from", "for", "was", "were", "are", "you", "your", "our", "into", "some", "any"}


def steer_of(spec: dict[str, Any], asset: dict[str, Any] | None) -> dict[str, Any]:
    """The controls for a video's clips: its own note's when it has one, else the dump's."""
    return ((asset or {}).get("steer") or spec.get("steer") or {})


def phrase_words(phrase: str) -> list[str]:
    words = re.findall(r"[a-z0-9']+", phrase.lower())
    strong = [w for w in words if len(w) >= 3 and w not in STOPWORDS]
    return strong or words


def mentions(words: list[str], phrase: str) -> bool:
    have = set(words)
    need = phrase_words(phrase)
    return bool(need) and all(w in have for w in need)


def heard_at(transcript: Transcript, phrase: str, window: int = 12) -> float | None:
    """When she said the phrase: every strong word of it within a dozen spoken words."""
    need = phrase_words(phrase)
    if not need:
        return None
    ws = [(w.start, re.sub(r"[^a-z0-9']", "", w.text.lower())) for w in transcript.words]
    for i, (t, w) in enumerate(ws):
        if w == need[0] and all(any(x == n for _t, x in ws[i : i + window]) for n in need):
            return t
    return None


def moment_words(transcript: Transcript, m: "Moment") -> list[str]:
    return [re.sub(r"[^a-z0-9']", "", w.text.lower()) for s, e in m.parts for w in transcript.words_in(s, e)]


def apply_steer(moments: list["Moment"], asset: dict[str, Any], transcript: Transcript, st: dict[str, Any], recipes: dict[str, Any], duration: float) -> tuple[list["Moment"], list[dict[str, str]]]:
    """Must include / leave out, from her chips and notes. A moment that mentions something to
    leave out is dropped; something to include that no moment has gets a moment of its own around
    where she said it. What cannot be done is reported, never skipped silently."""
    report: list[dict[str, str]] = []
    avoid = [str(x) for x in (st.get("avoid") or [])]
    include = [str(x) for x in (st.get("include") or [])]
    if not (avoid or include):
        return moments, report
    if not transcript.words:
        for x in include + avoid:
            report.append({"what": f'"{x}"', "why": "we couldn't make out the words in this video, so it couldn't be checked"})
        return moments, report
    for x in avoid:
        moments = [m for m in moments if not mentions(moment_words(transcript, m), x)]
    allowed = [r for r in RECIPE_ORDER if r in (st.get("allowed_recipes") or RECIPE_ORDER)] or RECIPE_ORDER
    for x in include:
        if any(mentions(moment_words(transcript, m), x) for m in moments):
            continue
        t = heard_at(transcript, x)
        if t is None:
            report.append({"what": f'"{x}"', "why": "we never heard it in these videos, so no clip could include it"})
            continue
        r = allowed[0]
        b = recipes[r]
        length = min(duration, (b["minS"] + b["maxS"]) / 2)
        s = max(0.0, min(t - 3.0, duration - length))
        m = Moment(asset["id"], r, round(s, 2), round(s + length, 2), [(round(s, 2), round(s + length, 2))])
        if any(mentions(moment_words(transcript, m), a) for a in avoid):
            report.append({"what": f'"{x}"', "why": "it is said right next to something you asked us to leave out, so it was left out too"})
            continue
        m.included = x  # type: ignore[attr-defined]
        moments.insert(0, m)
    log("cut.steer", avoid=len(avoid), include=len(include), reported=len(report))
    return moments, report


Uploader = Callable[[Path, str, str], None]
Downloader = Callable[[str, Path], Path]
Progress = Callable[[str, int, int], None]


def rotation_of(spec: dict[str, Any]) -> tuple[list[str], dict[str, dict[str, Any]]]:
    """The Worker sends the rotation (worker/domain/looks.ts rotationFor: her enabled Looks,
    shuffled per dump, singles and grids two to one) and each Look resolved with her Settings >
    Editing switches. A spec without them (older Worker) rotates every Look in file order."""
    rot = [r for r in (spec.get("rotation") or []) if r in L.LOOKS] or list(L.LOOK_IDS)
    sent = spec.get("looks") or {}
    return rot, {lid: L.look_options(lid, sent.get(lid)) for lid in set(rot)}


def cut_dump(spec: dict[str, Any], work: Path, download: Downloader, upload: Uploader, progress: Progress, heavy: dict[str, bool]) -> dict[str, Any]:
    work.mkdir(parents=True, exist_ok=True)
    assets = spec.get("assets") or []
    if not assets:
        raise NoUsableMoments("no assets")
    recipes = {**DEFAULT_RECIPES, **(spec.get("recipes") or {})}
    door = spec.get("door", "new")
    prefix = spec["output_prefix"]
    target = int((spec.get("target_clips") or {}).get("max") or 20)
    engine = {"transcript": "none", "picker": "fallback", "crop": "center", "subtitles": "none"}
    mediapipe = heavy.get("mediapipe", False)
    brand = L.branding_from(spec.get("branding"), work)
    rotation, look_opts = rotation_of(spec)
    for a in assets:  # a video's own note may ask for looks the dump doesn't
        for lid, o in ((a.get("steer") or {}).get("looks") or {}).items():
            if lid in L.LOOKS:
                look_opts.setdefault(f"{a['id']}:{lid}", L.look_options(lid, o))
    steer_report: list[dict[str, str]] = []

    # 1-2. download + normalize (+ whose video it is)
    prepared = []
    marks: list[dict[str, Any]] = []
    for i, a in enumerate(assets):
        progress("Getting your videos", i, len(assets))
        raw = download(a["r2_key"], work / f"raw_{i}")
        norm = work / f"norm_{i}.mp4"
        info = normalize(raw, norm)
        raw.unlink(missing_ok=True)
        wav = work / f"audio_{i}.wav"
        extract_wav(norm, wav)
        mark = source_marks(norm, info["duration"], work, a["id"])
        if mark:
            marks.append(mark)
        prepared.append((a, norm, info, wav))
    log("cut.prepared", assets=len(prepared))

    total_dur = sum(p[2]["duration"] for p in prepared) or 1.0
    moments: list[tuple[Moment, Source]] = []
    for i, (a, norm, info, wav) in enumerate(prepared):
        # 3. transcribe
        progress("Listening", i, len(prepared))
        tr = transcribe(wav, heavy.get("whisper", False))
        if tr.engine != "none":
            engine["transcript"] = tr.engine
        runs = speech_runs(wav, info["duration"])
        src = Source(norm, info, tr, runs, detect_bars(norm, info["duration"]))
        # 4. pick
        progress("Finding the best moments", i, len(prepared))
        st = steer_of(spec, a)
        a_recipes = {**recipes, **(st.get("recipes") or {})}
        quota = 2 if door == "recycle" else max(1, round(target * info["duration"] / total_dur))
        if (a.get("steer") or {}).get("count"):
            quota = int(a["steer"]["count"])
        picked = llm_moments(a, info["duration"], tr, spec, quota, runs)
        if picked:
            engine["picker"] = "openrouter"
        else:
            picked = fallback_moments(a, info["duration"], runs, tr, a_recipes, quota, door, st.get("allowed_recipes"))
        picked, told = apply_steer(picked, a, tr, st, a_recipes, info["duration"])
        steer_report.extend(told)
        for j, m in enumerate(picked):
            fill_copy(m, tr, spec, j)
            moments.append((m, src))
    if not moments:
        raise NoUsableMoments("no moments")
    # How many: her number, the moments she asked to include first, then the strongest.
    want = (spec.get("steer") or {}).get("count")
    if want and len(moments) > int(want):
        moments.sort(key=lambda ms: (0 if getattr(ms[0], "included", None) else 1, -score_moment(ms[0], ms[1].transcript, ms[1].runs, recipes)))
        moments = moments[: int(want)]
    elif want and len(moments) < int(want):
        steer_report.append({"what": f"{int(want)} clips", "why": f"we found {len(moments)} good moments in these videos, so {len(moments)} were made"})
    log("cut.picked", moments=len(moments))

    # 5-7. render: clip k takes rotation[k], so a dump's clips never all look alike
    ids = [new_clip_id() for _ in moments]
    music_cache: dict[str, Path] = {}
    clips: list[dict[str, Any]] = []
    looks_used: dict[str, int] = {}
    for k, (m, src) in enumerate(moments):
        progress("Cutting clips", k, len(moments))
        asset = next((x for x in assets if x["id"] == m.asset_id), None)
        a_steer = (asset or {}).get("steer") or {}
        rot = [r for r in (a_steer.get("rotation") or []) if r in L.LOOKS] or rotation
        look_id = rot[k % len(rot)]
        opts = look_opts.get(f"{m.asset_id}:{look_id}") or look_opts.get(look_id) or L.look_options(look_id)
        clip_id = ids[k]
        layout = None
        cells = None
        voice = 0
        voice_src = src
        try:
            if opts["layout"] == "grid":
                others = [(ids[x], om, osrc) for x, (om, osrc) in enumerate(moments) if x != k]
                cells, layout = grid_cells(k, m, src, others, len(L.cells_of(opts)), mediapipe)
                voice = layout["voice"]
                if voice > 0 and layout["cells"][voice]["kind"] == "clip":
                    voice_src = next(osrc for cid, _om, osrc in others if cid == layout["cells"][voice]["clip_id"])
            songs = {"music": a_steer["music"]} if "music" in a_steer else spec
            song = music_key(songs, k) if opts.get("music") else None
            r = render_moment(m, src, opts, brand, work, clip_id, mediapipe, cells=cells, voice=voice, voice_src=voice_src, music=music_for(songs, k, work, download, music_cache) if song else None)
        except subprocess.CalledProcessError:
            log("cut.render.failed", n=k, look=look_id)
            continue
        if any(s.cx is not None for s in (cells or [src.seg(m.parts[0][0], m.parts[0][1], mediapipe)])):
            engine["crop"] = "face"
        engine["subtitles"] = r.subtitles if engine["subtitles"] in ("none", "hook-only") else engine["subtitles"]
        looks_used[look_id] = looks_used.get(look_id, 0) + 1
        allowed = next((a.get("allowed_platforms") for a in assets if a["id"] == m.asset_id), None) or ["tiktok", "instagram", "youtube"]
        clips.append(
            {
                "id": clip_id,
                "asset_id": m.asset_id,
                "start_s": m.start,
                "end_s": m.end,
                "recipe": m.recipe,
                "hook_text": m.hook[:200],
                "hook_alt": (m.hook_alt or None) and m.hook_alt[:200],
                "caption": m.caption[:2200],
                "hashtags": m.hashtags,
                "platforms": allowed,
                "score": score_moment(m, src.transcript, src.runs, recipes),
                "r2_key": f"{prefix}{clip_id}.mp4",
                "cover_r2_key": f"{prefix}{clip_id}.jpg",
                "look": look_id,
                "parts": [[round(s, 2), round(e, 2)] for s, e in m.parts],
                "layout": layout,
                "music": song if r.music_used else None,
                "speech": speech_share(voice_src, [(cells[voice].start, cells[voice].end)] if cells else list(m.parts)),
                "_files": (r.mp4, r.cover),
            }
        )
    if not clips:
        raise NoUsableMoments("nothing rendered")

    # 8. upload
    for k, c in enumerate(clips):
        progress("Saving clips", k, len(clips))
        mp4, jpg = c.pop("_files")
        upload(mp4, c["r2_key"], "video/mp4")
        upload(jpg, c["cover_r2_key"], "image/jpeg")
    progress("Saving clips", len(clips), len(clips))
    log("cut.done", clips=len(clips), looks=len(looks_used), transcript=engine["transcript"], picker=engine["picker"], crop=engine["crop"], subtitles=engine["subtitles"])
    return {
        "clips": clips,
        "engine": engine,
        "assets": [{"id": a["id"], "duration_s": round(info["duration"], 2)} for a, _n, info, _w in prepared],
        "skipped": [{"asset_id": s["id"], "reason": s["reason"]} for s in spec.get("skipped_assets", [])],
        "source_marks": marks,
        "steer_report": steer_report,
    }


# ---------------------------------------------------------------- one clip, a new Look

def rerender_clip(spec: dict[str, Any], work: Path, download: Downloader, upload: Uploader, progress: Progress, heavy: dict[str, bool]) -> dict[str, Any]:
    """Re-render one clip in the Look she picked in Review (and, for a grid, the cells she picked).
    The Worker sends every source stretch; each source video is normalized only around the
    stretches it needs. The old file stays live until the Worker swaps in this one."""
    work.mkdir(parents=True, exist_ok=True)
    mediapipe = heavy.get("mediapipe", False)
    brand = L.branding_from(spec.get("branding"), work)
    look_id = str(spec.get("look_id") or "clean")
    opts = L.look_options(look_id, spec.get("look"))
    wanted: dict[str, list[tuple[float, float]]] = {}
    stretches = [*(spec.get("parts") or []), *(spec.get("cells") or []), *([spec["inset"]] if spec.get("inset") else [])]
    for p in stretches:
        wanted.setdefault(str(p["src"]), []).append((float(p["start"]), float(p["end"])))
    if not wanted:
        raise NoUsableMoments("nothing to render")
    sources: dict[str, tuple[Source, float]] = {}
    for i, (key, spans) in enumerate(wanted.items()):
        progress("Getting your videos", i, len(wanted))
        raw = download(key, work / f"src_{i}")
        lo = max(0.0, min(s for s, _e in spans) - 0.5)
        hi = max(e for _s, e in spans) + 0.5
        norm = work / f"norm_{i}.mp4"
        info = normalize(raw, norm, (lo, hi))
        raw.unlink(missing_ok=True)
        wav = work / f"audio_{i}.wav"
        extract_wav(norm, wav)
        progress("Listening", i, len(wanted))
        tr = transcribe(wav, heavy.get("whisper", False))
        sources[key] = (Source(norm, info, tr, speech_runs(wav, info["duration"]), detect_bars(norm, info["duration"])), lo)

    def seg(p: dict[str, Any]) -> tuple[L.Seg, Source]:
        src, lo = sources[str(p["src"])]
        s, e = float(p["start"]) - lo, float(p["end"]) - lo
        return src.seg(max(0.0, s), min(src.info["duration"], e), mediapipe, float(p.get("zoom") or 1.0)), src

    main_src, lo = sources[str(spec["parts"][0]["src"])]
    parts = [(float(p["start"]) - lo, float(p["end"]) - lo) for p in spec["parts"]]
    m = Moment(str(spec.get("asset_id") or ""), str(spec.get("recipe") or "talking_head"), parts[0][0], parts[-1][1], parts, hook=str(spec.get("hook_text") or ""))
    cells = None
    voice = int(spec.get("voice") or 0)
    voice_src = main_src
    if opts["layout"] == "grid":
        n = len(L.cells_of(opts))
        got = [seg(c) for c in (spec.get("cells") or [])][:n]
        if len(got) != n:
            raise NoUsableMoments("grid cells missing")
        cells = [g[0] for g in got]
        voice = min(max(0, voice), n - 1)
        voice_src = got[voice][1]
    progress("Cutting clips", 0, 1)
    song = music_key(spec, 0) if opts.get("music") else None
    r = render_moment(m, main_src, opts, brand, work, str(spec["clip_id"]), mediapipe, cells=cells, voice=voice, voice_src=voice_src, music=music_for(spec, 0, work, download, {}) if song else None)
    progress("Saving clips", 0, 1)
    upload(r.mp4, str(spec["output_key"]), "video/mp4")
    upload(r.cover, str(spec["output_cover_key"]), "image/jpeg")
    progress("Saving clips", 1, 1)
    log("cut.rerender.done", look=look_id, subtitles=r.subtitles)
    return {
        "rerender": {
            "clip_id": spec["clip_id"],
            "look": look_id,
            "r2_key": spec["output_key"],
            "cover_r2_key": spec["output_cover_key"],
            "duration_s": round(r.duration, 2),
            "voice": voice if cells else None,
            "music": song if r.music_used else None,
        },
        "engine": {"subtitles": r.subtitles},
    }


# ---------------------------------------------------------------- another editor's videos

IMPORT_MAX_BYTES = 1536 * 1024 * 1024


def fetch_url(url: str, dest: Path) -> Path:
    """Download a connected editor's finished video (an https link it gave us). Never logged."""
    if not url.startswith("https://"):
        raise NoUsableMoments("import link is not https")
    got = 0
    req = urllib.request.Request(url, headers={"User-Agent": "studio-import"})
    with urllib.request.urlopen(req, timeout=300) as res, open(dest, "wb") as out:
        while True:
            chunk = res.read(1024 * 1024)
            if not chunk:
                break
            got += len(chunk)
            if got > IMPORT_MAX_BYTES:
                raise NoUsableMoments("import too large")
            out.write(chunk)
    return dest


def recipe_for_length(seconds: float) -> str:
    """Mirror of worker/domain/editors.ts recipeForLength."""
    return "talking_head" if seconds <= 45 else "hook_first" if seconds <= 60 else "story"


def import_items(spec: dict[str, Any], work: Path, download: Downloader, upload: Uploader, progress: Progress, fetch: Callable[[str, Path], Path] = fetch_url) -> dict[str, Any]:
    """Videos made by another editor (her own edit from CapCut / InShot, or a connected editor's
    clips) become clips: each is measured with ffprobe, fitted to 1080x1920 without stretching
    (a tall video is scaled, anything else sits whole over a blurred copy of itself), loudness to
    -14 LUFS, a new cover. The Worker checks the answer (worker/jobs/cut_import.ts)."""
    work.mkdir(parents=True, exist_ok=True)
    items = spec.get("items") or []
    if not items:
        raise NoUsableMoments("nothing to import")
    blank = L.Branding(logo=None)
    done: list[dict[str, Any]] = []
    for i, it in enumerate(items):
        progress("Getting your videos", i, len(items))
        src = work / f"import_{i}"
        try:
            if "url" in it["src"]:
                fetch(str(it["src"]["url"]), src)
            else:
                download(str(it["src"]["key"]), src)
            raw = probe(src)
            if not raw["has_video"] or raw["duration"] <= 0:
                log("cut.import.unreadable", n=i)
                continue
            norm = work / f"import_norm_{i}.mp4"
            info = normalize(src, norm)
        except (subprocess.CalledProcessError, OSError, NoUsableMoments):
            log("cut.import.unreadable", n=i)
            continue
        finally:
            src.unlink(missing_ok=True)
        progress("Cutting clips", i, len(items))
        tall = abs(info["width"] / max(1, info["height"]) - 9 / 16) <= 0.03 * 9 / 16
        opts = L.look_options("clean", {"captions": "none", "hook": "none", "layout": "fill" if tall else "blur_fill", "end_card": False, "punch_in": False, "progress_bar": False, "crossfade": False, "grade": "none", "music": False})
        seg = L.Seg(norm, 0.0, round(info["duration"], 3), info["width"], info["height"])
        r = L.render_look(opts, [seg], [], "", blank, work, f"import_out_{i}")
        progress("Saving clips", i, len(items))
        upload(r.mp4, str(it["output_key"]), "video/mp4")
        upload(r.cover, str(it["output_cover_key"]), "image/jpeg")
        done.append({"item": it, "width": raw["width"], "height": raw["height"], "duration": round(r.duration, 2)})
    progress("Saving clips", len(items), len(items))
    log("cut.import.done", items=len(items), imported=len(done), replace=bool(spec.get("replace")))
    if spec.get("replace"):
        if not done:
            raise NoUsableMoments("the edit could not be read")
        d = done[0]
        return {"replaced": {"clip_id": d["item"]["clip_id"], "r2_key": d["item"]["output_key"], "cover_r2_key": d["item"]["output_cover_key"], "width": d["width"], "height": d["height"], "duration_s": d["duration"]}}
    if not done:
        raise NoUsableMoments("nothing imported")
    clips = []
    for k, d in enumerate(done):
        it = d["item"]
        title = str(it.get("title") or "").strip()[:200]
        clips.append({
            "id": it["clip_id"],
            "asset_id": it.get("asset_id") or "",
            "start_s": 0.0,
            "end_s": d["duration"],
            "recipe": recipe_for_length(d["duration"]),
            "hook_text": title or "A clip from your dump",
            "hook_alt": None,
            "caption": title,
            "hashtags": [],
            "platforms": it.get("platforms") or ["tiktok", "instagram", "youtube"],
            "score": round(max(0.5, 0.8 - 0.04 * k), 3),
            "r2_key": it["output_key"],
            "cover_r2_key": it["output_cover_key"],
            "look": None,
            "parts": [[0.0, d["duration"]]],
            "layout": None,
            "music": None,  # the editor's own audio; no song of hers is added
            "speech": None,  # not measured: never voiced over automatically
        })
    editor = str(spec.get("editor") or "editor")
    return {"clips": clips, "engine": {"transcript": editor, "picker": editor, "crop": editor, "subtitles": editor}}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    work = WORK / job.id
    heavy = ensure_heavy()
    log("cut.tools", whisper=heavy["whisper"], mediapipe=heavy["mediapipe"], libass=ffmpeg_has_filter("subtitles"), mode=spec.get("mode") or "dump")
    try:
        # NoUsableMoments reaches the Worker by its class name; plainFailure() words it for her.
        if spec.get("mode") == "rerender":
            return rerender_clip(spec, work, download_input, upload_output, job.progress, heavy)
        if spec.get("mode") == "import":
            return import_items(spec, work, download_input, upload_output, job.progress)
        return cut_dump(spec, work, download_input, upload_output, job.progress, heavy)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    run(main)
