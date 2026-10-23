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
from common import WORK, Job, download_input, log, run, upload_output  # noqa: E402
import looks as L  # noqa: E402
import plan as P  # noqa: E402  (layer 4: plan the story from the shot sheet)
import see as V  # noqa: E402  (layer 2: see the footage, a shot sheet per video)
import critic as C  # noqa: E402  (layer 6: check its own work, re-cut or hide)
import ai as A  # noqa: E402  (the model ladder; calls counted per provider)
import hear as H  # noqa: E402  (layer 3: talking to camera / chatter / music / silence)
import protect as PR  # noqa: E402  (layer 5: blur faces and house numbers, the never-list, real prices only)
import stages as ST  # noqa: E402  (studio fix: stages, heroes, sharp seconds, duplicates, events, photos)
import playbook as PB  # noqa: E402  (studio fix: the clip-type library + research playbook)
import clipmaker as CM  # noqa: E402  (studio fix: clips by type, hero endings, the real score, the words)
import script_clean as SCL  # noqa: E402  (studio fix: no reasoning, markdown or repeats in any words)
import copy
import dataclasses

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
            # av<16: newer PyAV (19.0.1 measured) refuses open(metadata_errors=...), which faster-whisper 1.2 passes, so
            # every transcript failed (7 Oct 2026, selftest "whisper_installed_but_no_transcript"; reproduced with av 19.0.1).
            sh([*pip, "faster-whisper>=1.0,<2", "av<16"], timeout=900)
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


PHOTO_SECONDS = 6.0


def photo_video(src: Path, dst: Path, seconds: float = PHOTO_SECONDS) -> dict[str, Any]:
    """A photo as a slow-pan video (studio fix: photos are first-class inputs to video clips): the
    picture fills 9:16 and moves a gentle 8 % zoom over `seconds`, with a silent track. From here on
    it is a shot like any other (seen, planned, cut, scored)."""
    frames = int(seconds * FPS)
    vf = (
        f"scale={OUT_W + 108}:{OUT_H + 192}:force_original_aspect_ratio=increase,crop={OUT_W + 108}:{OUT_H + 192},"
        f"zoompan=z='1+0.08*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={OUT_W}x{OUT_H}:fps={FPS},format=yuv420p,setsar=1"
    )
    ffmpeg([
        "-loop", "1", "-framerate", str(FPS), "-t", f"{seconds:.2f}", "-i", str(src),
        "-f", "lavfi", "-t", f"{seconds:.2f}", "-i", "anullsrc=r=48000:cl=stereo",
        "-map", "0:v:0", "-map", "1:a:0", "-vf", vf, "-frames:v", str(frames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
        "-shortest", "-movflags", "+faststart", str(dst),
    ])
    out = probe(dst)
    if not out["has_video"] or out["duration"] <= 0:
        raise NoUsableMoments("photo could not be read")
    out["had_audio"] = False
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
    # Studio intelligence (jobs/see.py, jobs/plan.py): the story shape, the service it shows, what is
    # on screen (the voice over may describe only that), and per part the video it comes from (a
    # before -> after clip joins shots of several videos; None = all from asset_id).
    shape: str | None = None
    service: str | None = None
    on_screen: str = ""
    part_assets: list[str] | None = None
    plan_score: float | None = None
    hidden_reason: str | None = None
    captions_off: bool = False
    # The shot sheet's state of each part (before / in_progress / after / n/a / unsure); None = nobody looked.
    part_states: list[str] | None = None
    recuts: int = 0
    # Studio fix (jobs/clipmaker.py): the clip type, its event, the hero it ends on, each part's stage
    # and shot, the voice-over script, and words_pending (no AI words came: nothing stock ships).
    clip_type: str = ""
    event_group: str = ""
    hero_asset_id: str = ""
    part_stages: list[str] | None = None
    part_keys: list[str] | None = None
    voice: str = ""
    words_pending: bool = False


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
            "change_request": spec.get("change_request") or "",
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
            text = or_text(key, payload, 120)
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


def mp_faces(available: bool) -> Any:
    """Faces in a picture as boxes, with the MediaPipe detector the crop uses (layer 5's face finder
    in the cut). None when the detector did not load (protect.py then tries the OpenCV finder)."""
    d = face_detector(available)
    if not d:
        return None
    mp, det = d

    def find(img: Any) -> list[tuple[int, int, int, int]]:
        """The whole frame, then 9 overlapping tiles: the short-range model misses a face that is
        small in a wide room shot, and finds it once the tile makes it bigger."""
        import numpy as np  # type: ignore

        full = np.ascontiguousarray(np.array(img.convert("RGB")))
        h, w = full.shape[:2]
        views = [(0, 0, full)]
        tw, th = int(w * 0.6), int(h * 0.42)
        for cx in (0, (w - tw) // 2, w - tw):
            for cy in (0, (h - th) // 2, h - th):
                views.append((cx, cy, np.ascontiguousarray(full[cy : cy + th, cx : cx + tw])))
        out = []
        for ox, oy, arr in views:
            res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=arr))
            for x in res.detections or []:
                bb = x.bounding_box
                out.append((ox + int(bb.origin_x), oy + int(bb.origin_y), ox + int(bb.origin_x + bb.width), oy + int(bb.origin_y + bb.height)))
        return out

    return find


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
    # Camera sound off (worker/domain/footage camera rules, the Dump chip / Settings): the clip plays
    # none of this video's own sound, nothing it said is transcribed, and it counts as having no talking.
    muted: bool = False

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
    if src.muted:
        return 0.0
    total = sum(max(0.0, e - s) for s, e in stretches) or 1.0
    if src.transcript.words:
        spoken = sum(max(0.0, min(e, w.end) - max(s, w.start)) for s, e in stretches for w in src.transcript.words if w.end > s and w.start < e)
    else:
        spoken = sum(coverage(src.runs, s, e) * (e - s) for s, e in stretches)
    return round(min(1.0, spoken / total), 3)


# ---------------------------------------------------------------- camera sound

CAMERA_MODES = ("auto", "keep", "off")
# Auto: under this share of the video covered by clear words, what the camera heard is background
# talk or room noise, not someone talking to the camera, so the sound is dropped.
TALK_SHARE_KEEP = 0.3


def camera_mode(spec: dict[str, Any], asset: dict[str, Any] | None) -> str:
    """Camera sound for a video: its own note's choice, else the dump's (chip > note > Settings)."""
    m = ((asset or {}).get("steer") or {}).get("camera") or spec.get("camera") or "keep"
    return m if m in CAMERA_MODES else "keep"


def camera_keep(mode: str, transcript: "Transcript", duration: float, talk_share: float | None = None) -> tuple[bool, str]:
    """Whether a video keeps its own sound, and why (a code for the log and the dump's line).
    off: never. keep: always. auto: only when clear talk covers enough of it; with no transcript
    (the speech tools are not installed) the sound is kept, since talk cannot be told from noise.
    talk_share (layer 3, jobs/hear.py): the share of the video that is talk TO THE CAMERA; chatter
    and music never keep the camera sound under Automatic."""
    if mode == "off":
        return False, "off"
    if mode != "auto":
        return True, "keep"
    if transcript.engine in ("none", "muted"):
        return True, "unmeasured"
    if talk_share is not None:
        return (True, "talking") if talk_share >= TALK_SHARE_KEEP else (False, "no_talk_to_camera")
    talk = sum(max(0.0, w.end - w.start) for w in transcript.words) / max(1.0, duration)
    return (True, "talking") if talk >= TALK_SHARE_KEEP else (False, "little_talk")


def avoid_overlap(m: "Moment", avoid: list[dict[str, Any]]) -> float:
    """How much of a moment is a stretch she asked for another version of (0..1)."""
    length = max(0.01, m.end - m.start)
    got = 0.0
    for w in avoid:
        if str(w.get("asset_id")) == m.asset_id:
            got += max(0.0, min(m.end, float(w.get("end", 0))) - max(m.start, float(w.get("start", 0))))
    return min(1.0, got / length)


def llm_copy(asset: dict[str, Any], spec: dict[str, Any], n: int) -> list[dict[str, Any]] | None:
    """Hooks and captions for clips with no sound of their own: from her notes and Brand Profile
    only (nothing was heard). None means the starter lines are used."""
    key = spec.get("llm_key") or os.environ.get("OPENROUTER_API_KEY")
    if not key or n <= 0:
        return None
    prof = spec.get("brand_profile") or {}
    system = (
        "You write on-screen hooks and captions for short vertical videos for one business or creator. The videos have no "
        "talking: write only from the notes and the Brand Profile; never invent prices, names, places or details that are not "
        "in them, and never write about a topic the notes do not name. Answer with JSON only: "
        "{\"items\":[{\"hook\":str,\"hook_alt\":str,\"caption\":str,\"hashtags\":[str]}]} with exactly how_many items, "
        "each different. hook and hook_alt are on-screen text, max 8 words each. caption max 150 characters in their voice "
        "with one call to action from their list. 3-5 hashtags."
    )
    user = json.dumps(
        {
            "how_many": n,
            "dump_notes": spec.get("notes", ""),
            "file_note": asset.get("file_note") or "",
            "change_request": spec.get("change_request") or "",
            "brand_profile": {k: prof.get(k, "") for k in ("who", "voice", "themes", "do_dont", "off_limits", "ctas")},
        }
    )
    payload = {"model": OPENROUTER_MODEL, "max_tokens": 1500, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    for attempt in range(2):
        try:
            text = or_text(key, payload, 90)
            m = re.search(r"\{.*\}", text, re.S)
            items = [it for it in json.loads(m.group(0) if m else text).get("items", []) if isinstance(it, dict) and str(it.get("hook", "")).strip()]
            log("copy.model", ok=True, items=len(items))
            return items or None
        except Exception:  # noqa: BLE001
            log("copy.model", ok=False, attempt=attempt)
            time.sleep(3)
    return None


MUSIC_DIR = Path(__file__).resolve().parent / "music"
LIBRARY = json.loads((MUSIC_DIR / "library.json").read_text(encoding="utf-8"))["tracks"]
LIBRARY_IDS = [t["id"] for t in LIBRARY]


def _song_keys(spec: dict[str, Any]) -> list[str]:
    """Her uploads ("music/…", streamed from storage) and built-in library tracks ("library/<id>",
    files in jobs/music, CC0: jobs/music/library.json), in the order the Worker sent them."""
    out = []
    for t in spec.get("music") or []:
        key = str((t or {}).get("r2_key", "")) if isinstance(t, dict) else ""
        if key.startswith("music/") or (key.startswith("library/") and key[8:] in LIBRARY_IDS):
            out.append(key)
    return out


def library_key(k: int) -> str:
    """A built-in track for clip k (one per clip in turn), so a clip with no sound of its own is never silent."""
    return f"library/{LIBRARY_IDS[k % len(LIBRARY_IDS)]}"


def music_key(spec: dict[str, Any], k: int, muted: bool = False) -> str | None:
    """The song clip k gets (her uploads, else the built-in library, one per clip in turn), or None.
    A clip with its camera sound off always gets one (never a silent clip)."""
    keys = _song_keys(spec)
    if keys:
        return keys[k % len(keys)]
    return library_key(k) if muted else None


def music_for(spec: dict[str, Any], k: int, work: Path, download: "Downloader", cache: dict[str, Path], muted: bool = False) -> Path | None:
    """The file for music_key: a library track from jobs/music, or her upload from storage."""
    key = music_key(spec, k, muted)
    if not key:
        return None
    if key.startswith("library/"):
        path = MUSIC_DIR / f"{key[8:]}.mp3"
        return path if path.exists() else None
    if key not in cache:
        try:
            cache[key] = download(key, work / f"music_{len(cache)}")
        except Exception:  # noqa: BLE001
            log("cut.music.unavailable")
            return None
    return cache[key]


def render_moment(m: "Moment", src: Source, opts: dict[str, Any], brand: L.Branding, work: Path, clip_id: str, mediapipe: bool, *, cells: list[L.Seg] | None = None, voice: int = 0, voice_src: Source | None = None, music: Path | None = None, srcs: dict[str, Source] | None = None, ending: L.Seg | None = None) -> L.Rendered:
    if cells and ending is not None:
        # A grid of the clip's own distinct shots, then its hero full frame (studio fix).
        return L.render_look(opts, [cells[0]], [], m.hook, brand, work, clip_id, cells=cells, voice=0, inset=None, music=music if opts.get("music") else None, ending=ending)
    if m.part_assets and srcs:
        # A planned clip joining shots of several videos (before -> after): each part from its own video.
        psrc = [srcs.get(a, src) for a in m.part_assets]
        parts = [ps.seg(s, e, mediapipe) for ps, (s, e) in zip(psrc, m.parts)]
        words = [] if opts.get("mute") or m.captions_off else L.timeline_words([ps.transcript.words_in(s, e) for ps, (s, e) in zip(psrc, m.parts)], parts, opts)
        return L.render_look(opts, parts, words, m.hook, brand, work, clip_id, cells=None, voice=0, inset=None, music=music if opts.get("music") else None)
    parts = [src.seg(s, e, mediapipe) for s, e in m.parts]
    if cells:
        vs = voice_src or src
        c = cells[voice]
        words = [Word(round(w.start - c.start, 3), round(w.end - c.start, 3), w.text) for w in vs.transcript.words_in(c.start, c.end)]
    else:
        words = words_on_timeline(src, m.parts, opts)
    if opts.get("mute") or m.captions_off:
        words = []  # camera sound off: no word captions from what the camera heard
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


# ---------------------------------------------------------------- see + plan glue (jobs/see.py, jobs/plan.py)

SHAPE_WORDS = {"transformation": "before and after", "walkthrough": "a walk-through", "talking": "talking to camera", "montage": "close-ups"}


def or_text(key: str | None, payload: dict[str, Any], timeout: float = 120) -> str:
    """A text answer from OpenRouter's free models within the job's budget (jobs/ai.py), counted
    per provider. Raises when none came (the callers fall back to their rules)."""
    text, _m = A.ask_openrouter(key, lambda model: {**payload, "model": model}, [str(payload.get("model") or OPENROUTER_MODEL)], "text", timeout=timeout)
    if text is None:
        raise RuntimeError("no answer")
    return text


def ask_text(key: str, payload: dict[str, Any]) -> str:
    return or_text(key, payload, 120)


def plan_moment(pl: "P.Plan") -> Moment:
    """A planned clip as a Moment: asset_id is the video of its last (reveal) shot; part_assets
    names each part's own video when they differ."""
    aid = pl.parts[-1].asset_id
    parts = [(p.start, p.end) for p in pl.parts]
    # Several videos, or one video's shots out of time order (a payoff flash, then the story): each part
    # is named with its video and the clip's length is the parts' sum.
    mixed = any(p.asset_id != aid for p in pl.parts) or not in_order(parts)
    start = pl.parts[-1].start if mixed else min(s for s, _e in parts)
    end = round(start + pl.length, 2) if mixed else max(e for _s, e in parts)
    m = Moment(aid, pl.recipe, round(start, 2), round(end, 2), parts, hook=pl.hook, hook_alt=pl.hook_alt, caption=pl.caption, hashtags=list(pl.hashtags))
    m.shape, m.service, m.on_screen, m.plan_score = pl.shape, pl.service, pl.on_screen, pl.score
    m.part_assets = [p.asset_id for p in pl.parts] if mixed else None
    m.part_states = [p.state for p in pl.parts]
    m.clip_type, m.event_group, m.hero_asset_id = pl.clip_type, pl.event_group, pl.hero_asset_id
    m.part_stages = [p.stage for p in pl.parts]
    m.part_keys = [p.key for p in pl.parts]
    m.voice, m.words_pending = pl.voice, pl.words_pending
    return m


def ground_speech_moment(m: Moment, sheet: "V.ShotSheet | None", src: Source, service: str | None, shape: str, services: list[str], profile: dict[str, Any], j: int) -> None:
    """A moment picked from the speech (or with nobody able to look): its words may say only what
    was said to the camera and what the sheet shows there; anything else becomes the neutral lines."""
    if (sheet is None or sheet.source == "none") and src.muted:
        # Nothing seen and nothing heard: only the neutral lines, never a guess from the notes.
        base = P.neutral_copy(P.Plan("unsure", None, [P.Part(m.asset_id, m.start, m.end, V.UNSURE, "")]), profile, services, j)
        m.hook, m.hook_alt, m.caption, m.hashtags = base["hook"], base["hook_alt"], base["caption"], base["hashtags"]
        m.shape, m.service, m.on_screen = None, None, ""
        return
    shots = [x for x in (sheet.shots if sheet else []) if x.end > m.start and x.start < m.end]
    on_screen = " · ".join(dict.fromkeys(x.what for x in shots if x.what))
    said = src.transcript.text_in(m.start, m.end)
    states = [x.state for x in shots]
    if sheet and sheet.source != "none":
        m.part_states = [(sheet.shot_at((s + e) / 2) or V.Shot(s, e)).state for s, e in m.parts]
    m.shape = "talking" if any(x.people == "to_camera" for x in shots) else ("montage" if sheet and sheet.source != "none" else None)
    m.service = service
    m.on_screen = on_screen[:400]
    pl = P.Plan(m.shape or "unsure", service, [P.Part(m.asset_id, m.start, m.end, st, "") for st in states] or [P.Part(m.asset_id, m.start, m.end, V.UNSURE, "")])
    g = P.Ground(service, services, f"{on_screen} {said}", "before" in states, "after" in states)
    base = P.neutral_copy(pl, profile, services, j)
    for k in ("hook", "hook_alt", "caption"):
        v = getattr(m, k) or ""
        if not P.grounded_ok(v, g)[0] or (not service and any(t in P.banned_tokens(None, services, f"{on_screen} {said}") for t in P.tokens(v))):
            setattr(m, k, base[k])
    own = {h.lower().lstrip("#") for h in P.profile_hashtags(profile)}
    m.hashtags = [h for h in m.hashtags if P.hashtag_ok(h, g, own)] or base["hashtags"]


def guard_moment(m: Moment, text_ok: Any, profile: dict[str, Any], services: list[str], j: int) -> None:
    """Layer 5 on a speech-picked moment: a line that breaks the studio's rules takes the neutral line."""
    pl = P.Plan(m.shape or "unsure", m.service, [P.Part(m.asset_id, m.start, m.end, V.UNSURE, "")])
    base = P.neutral_copy(pl, profile, services, j)
    for k in ("hook", "hook_alt", "caption"):
        if getattr(m, k) and not text_ok(getattr(m, k)):
            setattr(m, k, base[k] if text_ok(base[k]) else (P.NEUTRAL["unsure"][0][0] if k == "hook" else ("" if k == "hook_alt" else P.NEUTRAL["unsure"][2])))


# ---------------------------------------------------------------- the critic's glue (jobs/critic.py)

def part_owners(m: Moment) -> list[str]:
    return list(m.part_assets) if m.part_assets else [m.asset_id] * len(m.parts)


def clip_said(m: Moment, srcs: dict[str, Source]) -> str:
    """The words burned in as captions (none with the camera sound off or captions off)."""
    if m.captions_off:
        return ""
    out = []
    for a, (s, e) in zip(part_owners(m), m.parts):
        src = srcs.get(a)
        if src and not src.muted:
            out.append(src.transcript.text_in(s, e))
    return " ".join(x for x in out if x)[:600]


def shot_of(sheets: dict[str, "V.ShotSheet"], a: str, s: float, e: float) -> "V.Shot | None":
    sh = sheets.get(a)
    return sh.shot_at((s + e) / 2) if sh and sh.source != "none" else None


def moment_ground(m: Moment, srcs: dict[str, Source], services: list[str]) -> "P.Ground":
    states = m.part_states or []
    return P.Ground(m.service, services, f"{m.on_screen} {clip_said(m, srcs)}", "before" in states, "after" in states)


def critique_moment(m: Moment, rendered: Any, key: str | None, srcs: dict[str, Source], sheets: dict[str, "V.ShotSheet"], services: list[str], work: Path, name: str) -> "C.Verdict":
    said = clip_said(m, srcs)
    to_camera = any((shot_of(sheets, a, s, e) or V.Shot(s, e)).people == "to_camera" for a, (s, e) in zip(part_owners(m), m.parts))
    no_sheet = all(shot_of(sheets, a, s, e) is None for a, (s, e) in zip(part_owners(m), m.parts))
    rules = C.rules_check(m.hook, m.hook_alt, m.caption, moment_ground(m, srcs, services), m.part_states or [], m.shape, said, to_camera or no_sheet)
    if rules:
        return C.Verdict(False, rules, "rules")
    plan_text = [{"state": st, "what": (shot_of(sheets, a, s, e) or V.Shot(s, e)).what} for a, (s, e), st in zip(part_owners(m), m.parts, m.part_states or [V.UNSURE] * len(m.parts))]
    found = C.vision_check(key, rendered.mp4, rendered.duration, work, name, m.hook, m.caption, said, plan_text)
    if found is None:
        return C.Verdict(True, [], "rules")
    return C.Verdict(not found, found, "vision")


def critic_rules(m: Moment, srcs: dict[str, Source], sheets: dict[str, "V.ShotSheet"], services: list[str]) -> list[str]:
    """The critic checks that need no model (jobs/critic.py rules_check), for one clip."""
    said = clip_said(m, srcs)
    to_camera = any((shot_of(sheets, a, s, e) or V.Shot(s, e)).people == "to_camera" for a, (s, e) in zip(part_owners(m), m.parts))
    no_sheet = all(shot_of(sheets, a, s, e) is None for a, (s, e) in zip(part_owners(m), m.parts))
    return C.rules_check(m.hook, m.hook_alt, m.caption, moment_ground(m, srcs, services), m.part_states or [], m.shape, said, to_camera or no_sheet)


def critic_item(m: Moment, rendered: Any, srcs: dict[str, Source], sheets: dict[str, "V.ShotSheet"]) -> dict[str, Any]:
    """What the batched critic gets for one finished clip."""
    plan_text = [{"state": st, "what": (shot_of(sheets, a, s, e) or V.Shot(s, e)).what} for a, (s, e), st in zip(part_owners(m), m.parts, m.part_states or [V.UNSURE] * len(m.parts))]
    return {"mp4": rendered.mp4, "duration": rendered.duration, "hook": m.hook, "caption": m.caption, "said": clip_said(m, srcs), "plan_text": plan_text}


_ROUND = {"n": 0}


def critic_round(_pairs: Any) -> int:
    _ROUND["n"] += 1
    return _ROUND["n"]


def recut_batch(reqs: list[tuple[tuple[int, Moment], list[str], int]], key: str | None, srcs: dict[str, Source], sheets: dict[str, "V.ShotSheet"], services: list[str], profile: dict[str, Any], text_ok: Any = None, rules: dict[str, Any] | None = None, memory: dict[str, Any] | None = None) -> list[tuple[int, Moment] | None]:
    """A round's re-cuts together: the shots fixed per clip (no model), then ONE text call re-writes
    the words of every first re-cut (the reasons fed back); later attempts take the neutral lines."""
    out: list[tuple[int, Moment] | None] = []
    plans: list[tuple[int, Moment, "P.Plan", list[str]]] = []
    for (k, m), reasons, attempt in reqs:
        got = recut_moment(m, reasons, attempt, None, srcs, sheets, services, profile, write=False)
        if got is None:
            out.append(None)
            continue
        n, pl = got
        if attempt == 0 and key:
            plans.append((len(out), n, pl, reasons))
        out.append((k, n))
    if plans and key:
        P.write_copy(key, [pl for _i, _n, pl, _r in plans], profile, services, OPENROUTER_MODEL, ask_text, feedback={j: "; ".join(C.REASON_WORDS.get(r, r) for r in rs) for j, (_i, _n, _pl, rs) in enumerate(plans)}, guard=text_ok, rules=rules, memory=memory)
        for _i, n, pl, _r in plans:
            n.hook, n.hook_alt, n.caption, n.hashtags = pl.hook, pl.hook_alt, pl.caption, list(pl.hashtags)
    return out


def recut_moment(m: Moment, reasons: list[str], attempt: int, key: str | None, srcs: dict[str, Source], sheets: dict[str, "V.ShotSheet"], services: list[str], profile: dict[str, Any], write: bool = True) -> Any:
    """The clip again, with the critic's reasons acted on. None = it cannot be fixed (it is hidden).
    write=False returns (moment, plan) with the neutral words in place, for recut_batch to re-write."""
    n = copy.copy(m)
    owners, parts = part_owners(m), list(m.parts)
    states = list(m.part_states or [V.UNSURE] * len(parts))
    keep = list(range(len(parts)))
    if "privacy" in reasons:
        keep = [i for i in keep if (shot_of(sheets, owners[i], *parts[i]) or V.Shot(0, 0)).people not in ("others",) and not (shot_of(sheets, owners[i], *parts[i]) or V.Shot(0, 0)).privacy]
        if len(keep) == len(parts):
            return None  # nothing in the plan explains what the critic saw: hide it rather than guess
    if "before_as_finished" in reasons:
        keep = [i for i in keep if states[i] != "before"]
    if not keep:
        return None
    n.parts = [parts[i] for i in keep]
    n.part_states = [states[i] for i in keep]
    n.part_stages = [m.part_stages[i] for i in keep] if m.part_stages else None
    n.part_keys = [m.part_keys[i] for i in keep] if m.part_keys else None
    owners = [owners[i] for i in keep]
    if sum(e - s for s, e in n.parts) < 3:
        return None
    n.asset_id = owners[-1]
    n.part_assets = owners if len(set(owners)) > 1 or not in_order(n.parts) else None
    if n.part_assets:
        n.start = n.parts[-1][0]
        n.end = round(n.start + sum(e - s for s, e in n.parts), 2)
    else:
        n.start, n.end = min(s for s, _ in n.parts), max(e for _, e in n.parts)
    if m.shape == "transformation" and "before" not in n.part_states:
        n.shape = "montage"
    if "noise_captions" in reasons:
        n.captions_off = True
    whats = []
    for a, (s, e) in zip(owners, n.parts):
        w = (shot_of(sheets, a, s, e) or V.Shot(s, e)).what
        if w and w not in whats:
            whats.append(w)
    n.on_screen = " · ".join(whats)[:400]
    pl = P.Plan(n.shape or "unsure", n.service, [P.Part(a, s, e, st, (shot_of(sheets, a, s, e) or V.Shot(s, e)).what) for a, (s, e), st in zip(owners, n.parts, n.part_states)])
    if write and attempt == 0 and key:
        P.write_copy(key, [pl], profile, services, OPENROUTER_MODEL, ask_text, feedback={0: "; ".join(C.REASON_WORDS.get(r, r) for r in reasons)})
    else:
        base = P.neutral_copy(pl, profile, services, attempt)
        pl.hook, pl.hook_alt, pl.caption, pl.hashtags = base["hook"], base["hook_alt"], base["caption"], base["hashtags"]
    n.hook, n.hook_alt, n.caption, n.hashtags = pl.hook, pl.hook_alt, pl.caption, list(pl.hashtags)
    n.recuts = m.recuts + 1
    return n if write else (n, pl)


def mixed_speech(m: Moment, srcs: dict[str, Source]) -> float:
    """Talking share of a clip joining several videos: each part measured in its own video."""
    total = sum(e - s for s, e in m.parts) or 1.0
    got = sum(speech_share(srcs[a], [(s, e)]) * (e - s) for a, (s, e) in zip(m.part_assets or [], m.parts) if a in srcs)
    return round(min(1.0, got / total), 3)


def clip_score(m: Moment, src: Source, recipes: dict[str, Any]) -> float:
    return m.plan_score if m.plan_score is not None else score_moment(m, src.transcript, src.runs, recipes)


def moment_spans(m: Moment) -> list[tuple[str, float, float]]:
    return [(a, s, e) for a, (s, e) in zip(part_owners(m), m.parts)][:-1] or [(a, s, e) for a, (s, e) in zip(part_owners(m), m.parts)]


def shared_share(a: Moment, b: Moment) -> float:
    """How much of the shorter clip's body (its hero ending aside) is footage the other one also uses."""
    sa, sb = moment_spans(a), moment_spans(b)
    def length(xs: list[tuple[str, float, float]]) -> float:
        return sum(e - s for _a, s, e in xs) or 1e-6
    common = sum(max(0.0, min(e1, e2) - max(s1, s2)) for a1, s1, e1 in sa for a2, s2, e2 in sb if a1 == a2)
    return common / min(length(sa), length(sb))


def distinct_moments(moments: list[tuple[Moment, Source]]) -> list[tuple[Moment, Source]]:
    out: list[tuple[Moment, Source]] = []
    for m, src in moments:
        if any(shared_share(m, o) >= 0.5 for o, _s in out):
            log("cut.duplicate_dropped", clip_type=m.clip_type or "")
            continue
        out.append((m, src))
    return out


def in_order(parts: list[tuple[float, float]]) -> bool:
    return all(b[0] >= a[1] - 0.01 for a, b in zip(parts, parts[1:]))


def grid_body(m: Moment) -> list[int]:
    """The parts a grid may tile: the clip's own distinct shots, not its payoff flash or hero ending."""
    keys = m.part_keys or []
    stages = m.part_stages or []
    out, seen = [], set()
    for i in range(len(m.parts) - 1):
        k = keys[i] if i < len(keys) else ""
        if not k or (i < len(stages) and stages[i] == "flash") or k in seen:
            continue
        seen.add(k)
        out.append(i)
    return out


def look_fits(opts: dict[str, Any], m: Moment, distinct: int) -> bool:
    """Never a repeat in one frame: a grid or side-by-side only with at least as many distinct shots
    as cells (and a hero to end on); an inset (it replays a line) only on a talk-to-camera clip."""
    if opts["layout"] == "grid":
        return bool(m.hero_asset_id) and distinct >= len(L.cells_of(opts))
    if opts["layout"] == "pip":
        return m.clip_type == "talk_to_camera" and not m.part_assets
    return True


def grid_from_parts(m: Moment, idx: list[int], srcs: dict[str, Source], by_key: dict[str, "ST.Look"], mediapipe: bool) -> tuple[list[L.Seg], dict[str, Any], L.Seg]:
    """Cells = the clip's own distinct shots (each a few seconds of its own shot), then its hero."""
    owners = part_owners(m)
    keys = m.part_keys or [""] * len(m.parts)
    cells, lay = [], []
    for i in idx:
        s, e = m.parts[i]
        lk = by_key.get(keys[i])
        e2 = min(lk.end, s + 4.0) if lk else e
        cells.append(srcs[owners[i]].seg(s, max(e, e2), mediapipe))
        lay.append({"kind": "part", "asset_id": owners[i], "start": round(s, 2), "end": round(max(e, e2), 2)})
    hs, he = m.parts[-1]
    ending = srcs[owners[-1]].seg(hs, he, mediapipe)
    return cells, {"cells": lay, "voice": 0, "ending": {"asset_id": owners[-1], "start": round(hs, 2), "end": round(he, 2)}}, ending


def clip_body_keys(m: Moment) -> set[str]:
    keys, stages = m.part_keys or [], m.part_stages or []
    return {keys[i] for i in range(min(len(keys), len(m.parts)) - 1) if keys[i] and (i >= len(stages) or stages[i] != "flash")}


def score_facts(m: Moment, k: int, bodies: dict[int, set[str]], tracks: dict[str, list[float]], by_key: dict[str, "ST.Look"], rules_s: dict[str, Any], opts: dict[str, Any]) -> dict[str, Any]:
    """What the score reads about one finished clip (jobs/clipmaker.py score_clip)."""
    owners = part_owners(m)
    keys = m.part_keys or [""] * len(m.parts)
    stages = m.part_stages or [""] * len(m.parts)
    parts = [{"stage": stages[i] if i < len(stages) else "", "start": s, "end": e, "quality": ST.span_quality(tracks.get(owners[i], []), s, e), "key": keys[i] if i < len(keys) else ""} for i, (s, e) in enumerate(m.parts)]
    mine = clip_body_keys(m)
    overlap = max([CM._overlap(mine, b) for j, b in bodies.items() if j != k] or [0.0])
    repeats = False
    for i in range(len(parts)):
        for j in range(i):
            if parts[i]["key"] and parts[i]["key"] == parts[j]["key"] and parts[j]["stage"] != "flash" and parts[i]["start"] < parts[j]["end"] and parts[j]["start"] < parts[i]["end"]:
                repeats = True
            a, b = by_key.get(parts[i]["key"]), by_key.get(parts[j]["key"])
            if a and b and a.key != b.key and parts[j]["stage"] != "flash" and ST.same_picture(a.hash, b.hash):
                repeats = True
    return {
        "clip_type": m.clip_type or "finished_walkthrough", "parts": parts, "hook": m.hook, "caption": f"{m.caption} {rules_s['cta_link']}" if rules_s["cta_link"] else m.caption,
        "words_pending": m.words_pending, "cta_link": rules_s["cta_link"], "cta_phrases": rules_s["cta_phrases"], "end_card": bool(opts.get("end_card")),
        "overlap": overlap, "repeats": repeats,
    }


def improve_moment(m: Moment, tracks: dict[str, list[float]], pb: dict[str, Any]) -> Moment | None:
    """The one re-cut for a clip under the bar: blurry or shaky shots out, the template's length,
    the alternative hook when the hook is hard to read. None when nothing can be improved."""
    n = copy.copy(m)
    owners = part_owners(m)
    keep = [i for i, (s, e) in enumerate(m.parts) if i == len(m.parts) - 1 or ST.span_quality(tracks.get(owners[i], []), s, e) >= ST.GOOD]
    t = PB.template(pb, m.clip_type or "finished_walkthrough")
    while len(keep) > 2 and sum(m.parts[i][1] - m.parts[i][0] for i in keep) > t["length_s"][1]:
        keep.pop(-2)
    changed = len(keep) != len(m.parts)

    def pick(xs: list[Any] | None) -> list[Any] | None:
        return [xs[i] for i in keep] if xs else xs

    n.parts = [m.parts[i] for i in keep]
    n.part_states, n.part_stages, n.part_keys = pick(m.part_states), pick(m.part_stages), pick(m.part_keys)
    own = [owners[i] for i in keep]
    n.part_assets = own if len(set(own)) > 1 or not in_order(n.parts) else None
    n.asset_id = own[-1]
    if n.part_assets:
        n.start = n.parts[-1][0]
        n.end = round(n.start + sum(e - s for s, e in n.parts), 2)
    else:
        n.start, n.end = min(s for s, _ in n.parts), max(e for _, e in n.parts)
    if m.hook and not CM._readable_hook(m.hook) and CM._readable_hook(m.hook_alt):
        n.hook, n.hook_alt = m.hook_alt, m.hook
        changed = True
    if not changed or sum(e - s for s, e in n.parts) < 3:
        return None
    n.recuts = m.recuts + 1
    return n


def copy_extra(rules_s: dict[str, Any], pb: dict[str, Any], n: int) -> dict[str, Any]:
    """What the copy writer reads from the studio's rules and the playbook (studio fix)."""
    every = int(pb.get("send_line_every") or 3)
    return {
        "playbook": PB.prompt_lines(pb),
        **({"place_words": rules_s["place_words"]} if rules_s["place_words"] else {}),
        **({"cta_phrases": rules_s["cta_phrases"]} if rules_s["cta_phrases"] else {}),
        **({"no_prices": True} if not rules_s["prices"] else {}),
        "send_line_clips": [i for i in range(n) if i % every == 1],
    }


def add_hero_ending(m: Moment, looks: list["ST.Look"], tracks: dict[str, list[float]], hold: float, i: int) -> bool:
    """A speech-picked clip ends on its event's hero too (held >= 2 s), unless it already does."""
    part = CM.hero_ending_part(looks, m.event_group, tracks, hold, i)
    if part is None:
        return False
    owners = part_owners(m)
    if owners and owners[-1] == part.asset_id and m.parts[-1][0] < part.end and part.start < m.parts[-1][1]:
        # The clip's last stretch already runs through the hero shot: when its last `hold` seconds are
        # inside that shot and sharp, it already ends on the hero; else it is cut to end on the hero window.
        ls, le = m.parts[-1]
        hl = next((x for x in looks if x.key == part.key), None)
        tail_ok = hl is not None and hl.start - 0.01 <= le - hold and le <= hl.end + 0.01 and ST.span_quality(tracks.get(part.asset_id, []), le - hold, le) >= ST.GOOD
        if not tail_ok:
            if part.end - ls < hold:
                return False
            le = min(le, part.end)
        m.parts = [*m.parts[:-1], (ls, round(le, 2))]
        n = len(m.parts)
        m.part_stages = [*((m.part_stages or [""] * n)[: n - 1]), "hero"]
        m.part_keys = [*((m.part_keys or [""] * n)[: n - 1]), part.key]
        m.hero_asset_id = part.asset_id
        if m.part_assets:
            m.end = round(m.start + sum(e - s for s, e in m.parts), 2)
        else:
            m.start, m.end = min(s for s, _ in m.parts), max(e for _, e in m.parts)
        return True
    n_before = len(m.parts)
    m.parts = [*m.parts, (part.start, part.end)]
    owners = [*owners, part.asset_id]
    m.part_assets = owners if len(set(owners)) > 1 or not in_order(m.parts) else None
    m.part_states = [*(m.part_states or [V.UNSURE] * n_before), "after"]
    m.part_stages = [*(m.part_stages or [""] * n_before), "hero"]
    m.part_keys = [*(m.part_keys or [""] * n_before), part.key]
    m.hero_asset_id = part.asset_id
    if m.part_assets:
        m.asset_id = owners[-1]
        m.start = m.parts[-1][0]
        m.end = round(m.start + sum(e - s for s, e in m.parts), 2)
    else:
        m.start, m.end = min(s for s, _ in m.parts), max(e for _, e in m.parts)
    return True


def brand_for(spec: dict[str, Any], work: Path, download: "Downloader") -> L.Branding:
    """Her branding plus, from the studio's rules, the request link under the call to action, and the
    studio's own logo when the spec names one (spec.branding.logo_r2_key)."""
    sb = dict(spec.get("branding") or {})
    if sb.get("logo_r2_key"):
        try:
            sb["logo_path"] = str(download(str(sb["logo_r2_key"]), work / "studio_logo"))
        except Exception:  # noqa: BLE001  no logo is fine: the end still carries the call to action
            log("cut.logo.missing")
    rs = CM.studio_rules(spec, spec.get("brand_profile"))
    if rs["cta_link"] and not sb.get("link"):
        sb["link"] = rs["cta_link"]
    if rs["cta_phrases"] and spec.get("cta_turn") is not None:
        sb["cta"] = CM.cta_phrase(rs, int(spec.get("cta_turn") or 0))
    return L.branding_from(sb, work)


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
    # Studio fix: the studio's rules (clip target, bar, CTA, AI note, place words) and the playbook.
    rules_s = CM.studio_rules(spec, spec.get("brand_profile"))
    pb = PB.load(spec)
    target = rules_s["clip_target"]["max"]
    engine = {"transcript": "none", "picker": "fallback", "crop": "center", "subtitles": "none"}
    mediapipe = heavy.get("mediapipe", False)
    brand = brand_for(spec, work, download)
    rotation, look_opts = rotation_of(spec)
    for a in assets:  # a video's own note may ask for looks the dump doesn't
        for lid, o in ((a.get("steer") or {}).get("looks") or {}).items():
            if lid in L.LOOKS:
                look_opts.setdefault(f"{a['id']}:{lid}", L.look_options(lid, o))
    steer_report: list[dict[str, str]] = []
    camera: dict[str, str] = {}
    avoid_windows = [w for w in (spec.get("avoid_windows") or []) if isinstance(w, dict)]

    # 1-2. download + normalize (+ whose video it is)
    prepared = []
    marks: list[dict[str, Any]] = []
    meta: dict[str, dict[str, Any]] = {}  # studio fix: photo, file name, hero name, date, AI picture, track, hashes, event
    for i, a in enumerate(assets):
        progress("Getting your videos", i, len(assets))
        raw = download(a["r2_key"], work / f"raw_{i}")
        norm = work / f"norm_{i}.mp4"
        photo = ST.is_photo(a)
        name = ST.file_name(a)
        try:
            # Photos are first-class: each becomes a slow-pan shot (jobs/stages.py).
            exif = ST.read_exif(raw) if photo else {"camera": None, "date": None}
            info = photo_video(raw, norm) if photo else normalize(raw, norm)
        except (NoUsableMoments, subprocess.CalledProcessError):
            raw.unlink(missing_ok=True)
            if len(assets) == 1:
                raise
            log("cut.asset.unreadable", n=i, photo=photo)  # one unreadable upload never stops the rest
            continue
        from_camera = a["exif_camera"] if isinstance(a.get("exif_camera"), bool) else exif.get("camera")
        meta[a["id"]] = {"photo": photo, "name": name, "name_hero": ST.name_is_hero(name), "date": exif.get("date") or ST.media_date(raw) or ST.date_from_name(name), "ai_image": bool(photo and not from_camera)}
        raw.unlink(missing_ok=True)
        wav = work / f"audio_{i}.wav"
        extract_wav(norm, wav)
        mark = source_marks(norm, info["duration"], work, a["id"])
        if mark:
            marks.append(mark)
        prepared.append((a, norm, info, wav))
    if not prepared:
        raise NoUsableMoments("no readable uploads")
    log("cut.prepared", assets=len(prepared), photos=sum(1 for x in meta.values() if x["photo"]))

    total_dur = sum(p[2]["duration"] for p in prepared) or 1.0
    key = spec.get("llm_key") or os.environ.get("OPENROUTER_API_KEY")
    services = [str(x)[:60] for x in (spec.get("services") or []) if str(x).strip()][:12]
    override = spec.get("plan_override") if isinstance(spec.get("plan_override"), dict) else {}
    cached = spec.get("shot_sheets") if isinstance(spec.get("shot_sheets"), dict) else {}
    service_looks = P.service_looks(spec.get("brand_profile"), services)
    rules = PR.rules_from(spec)
    text_ok = PR.guard(rules, spec.get("brand_profile"))
    unsafe: set[str] = set()
    sheets: dict[str, V.ShotSheet] = {}
    srcs: dict[str, Source] = {}
    heard: dict[str, tuple[Transcript, list[tuple[float, float]], str]] = {}
    for i, (a, norm, info, wav) in enumerate(prepared):
        # 3. transcribe (what the camera heard; layer 3 decides below what of it is talk to the camera)
        progress("Listening", i, len(prepared))
        tr = transcribe(wav, heavy.get("whisper", False))
        if tr.engine != "none":
            engine["transcript"] = tr.engine
        heard[a["id"]] = (tr, speech_runs(wav, info["duration"]), camera_mode(spec, a))
    # 3b. SEE: the saved sheet, else up to 3 videos per free vision call, else the local model (jobs/see.py)
    progress("Looking at your videos", 0, len(prepared))
    sheets.update(V.see_videos(key, [{"asset_id": a["id"], "video": norm, "duration": info["duration"], "notes": " ".join(x for x in (spec.get("notes", ""), a.get("file_note") or "") if x)} for a, norm, info, _w in prepared], services, work, cached, service_looks))
    progress("Looking at your videos", len(prepared), len(prepared))
    sound_labels: dict[str, dict[str, float]] = {}
    for i, (a, norm, info, wav) in enumerate(prepared):
        tr, runs, mode = heard[a["id"]]
        sheet = sheets[a["id"]]
        # 3c. HEAR: talking to camera / chatter / music / silence (jobs/hear.py, layer 3)
        sounds = H.sound_segments(info["duration"], runs, tr.words, sheet.to_camera_windows(), sheet.source != "none")
        sound_labels[a["id"]] = H.summary(sounds)
        keep, why = camera_keep(mode, tr, info["duration"], H.share(sounds, "talking_to_camera", info["duration"]) if sheet.source != "none" else None)
        camera[a["id"]] = "kept" if keep else "off"
        log("cut.camera", n=i, keep=keep, why=why)
        log("hear.labels", n=i, **{k: v for k, v in sound_labels[a["id"]].items()})
        if not keep:
            # Camera sound off: nothing it heard is used, not for captions, not for picking moments.
            tr, runs = Transcript(engine="muted"), []
        elif tr.engine not in ("none", "muted"):
            # Only talk to the camera becomes captions or picks moments; chatter and music never do.
            words = H.caption_words(tr.words, sounds)
            wins = H.talk_windows(sounds)
            tr = Transcript(words=words, segments=[sg for sg in tr.segments if any(ws - 0.1 <= sg[0] and sg[1] <= we + 0.1 for ws, we in wins)], engine=tr.engine)
            runs = [(s_, e_) for s_, e_ in runs if any(ws < e_ and we > s_ for ws, we in wins)] if sheet.source != "none" else runs
        # 3d. PROTECT: faces (not hers, when her profile allows) and house numbers blurred before anything is cut.
        safe, ok, _boxes = PR.protect_video(norm, info, rules, sheet, work, str(i), mp_faces(mediapipe))
        if not ok:
            unsafe.add(a["id"])  # the finder could not run on a strict studio: its clips are hidden, never shown unchecked
        srcs[a["id"]] = Source(safe, info, tr, runs, detect_bars(norm, info["duration"]), muted=not keep)
    sheet_list = [sheets[a["id"]] for a, *_ in prepared]
    # Studio fix, SEEING: per-second sharpness/steadiness, a picture hash per shot, events, stages, heroes.
    tracks: dict[str, list[float]] = {}
    for a, norm, info, _w in prepared:
        tracks[a["id"]] = ST.quality_track(norm, info["duration"])
        meta[a["id"]]["track"] = tracks[a["id"]]
        meta[a["id"]]["hashes"] = {(s_.start, s_.end): ST.frame_hash(norm, (s_.start + s_.end) / 2) for s_ in sheets[a["id"]].shots}
    events = ST.event_groups([{"id": aid, "date": x["date"], "name": x["name"]} for aid, x in meta.items()])
    for aid, x in meta.items():
        x["event"] = events.get(aid, "e1")
    # Saved as the model saw them, before her answers are applied (her answers live on the dump).
    saved_sheets = {aid: sh.to_json() for aid, sh in sheets.items() if V.worth_saving(sh)}
    # Layer 7: the videos she tapped as "a before" are cut as before shots.
    if P.mark_before(sheet_list, override.get("before_assets")):
        log("cut.before_marked", videos=len(override.get("before_assets") or []))
    memory = spec.get("memory") if isinstance(spec.get("memory"), dict) else {}
    if memory.get("approach") == "careful":
        log("cut.approach", approach="careful", rate=(memory.get("rejection") or {}).get("rate"), reviewed=(memory.get("rejection") or {}).get("reviewed"))
    seen = [sh for sh in sheet_list if sh.source != "none"]
    engine["vision"] = (seen[0].source.split(":")[0] if seen else "none")
    # 4. PLAN: the service, the shape, the shots in each clip (jobs/plan.py)
    service, sure = P.dump_service(sheet_list, override.get("service"), services)
    # She named the service herself: every finished shot with no service of its own counts as it.
    hers = bool(override.get("service") and override.get("service") != "unsure" and sure)
    if not override.get("service"):
        # Layer 8: a service she has corrected twice is read as what she said it is.
        service = P.relabel(service, memory, services)
    profile = spec.get("brand_profile") or {}
    # Layer 1: the Brand Profile says which shapes fit this service; the footage says which are possible.
    shape, why_not = P.choose_shape(sheet_list, service, {aid: s_.muted for aid, s_ in srcs.items()}, override.get("shape"), P.combined_fit(P.shapes_fit(profile, service), memory), hers)
    if why_not:
        steer_report.append({"what": SHAPE_WORDS.get(str(override.get("shape")), "that kind of video"), "why": why_not})
    moments: list[tuple[Moment, Source]] = []
    looks = ST.build_looks({aid: sh for aid, sh in sheets.items() if aid in meta}, meta)
    by_key = {lk.key: lk for lk in looks}
    photos_in = any(x["photo"] for x in meta.values())
    if (seen or photos_in) and door != "recycle":
        # Studio fix: clips by TYPE from the playbook, each ending on its event's hero, distinct cuts,
        # as many as the footage gives up to the studio's clip target (jobs/clipmaker.py).
        quota = P.careful_quota(target, memory) if spec.get("mode") != "again" else 3
        plans = CM.plan_typed(looks, pb, {"min": rules_s["clip_target"]["min"], "max": quota}, service, tracks, {aid for aid, s_ in srcs.items() if not s_.muted})
        if not plans and seen and shape != "talking":
            # Nothing typed could be made (no hero view at all): the earlier planner, so the dump still gets clips.
            plans = P.plan_clips(sheet_list, shape, service, quota, hers)
        if memory.get("approach") == "careful" and len(plans) > 1:
            # Layer 9, careful: only the strongest plans (at least one).
            plans = [pl for pl in plans if pl.score >= 0.7] or plans[:1]
        if avoid_windows:
            plans.sort(key=lambda pl: sum(avoid_overlap(Moment(pt.asset_id, "montage", pt.start, pt.end, [(pt.start, pt.end)]), avoid_windows) for pt in pl.parts))
            plans = plans[:1]
        P.write_copy(key, plans, profile, services, OPENROUTER_MODEL, ask_text, feedback={0: spec.get("change_request")} if spec.get("change_request") and plans else None, guard=text_ok, rules=PR.copy_rules(rules), memory=memory, extra=copy_extra(rules_s, pb, len(plans)))
        for pl in plans:
            moments.append((plan_moment(pl), srcs[pl.parts[-1].asset_id]))
        if plans:
            engine["picker"] = "shot-sheet"
    if not moments or shape == "talking":
        for i, (a, norm, info, wav) in enumerate(prepared):
            src = srcs[a["id"]]
            tr, runs = src.transcript, src.runs
            # 4b. pick from the speech (talking to camera, an old post, or nobody could look)
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
            if avoid_windows:
                # Try another version: a different moment than the one she has, when the video has one.
                picked.sort(key=lambda m: avoid_overlap(m, avoid_windows))
                fresh = [m for m in picked if avoid_overlap(m, avoid_windows) < 0.5]
                picked = fresh or picked
            if src.muted and picked:
                for m, it in zip(picked, llm_copy(a, spec, len(picked)) or []):
                    m.hook = str(it.get("hook", ""))[:120]
                    m.hook_alt = str(it.get("hook_alt", ""))[:120]
                    m.caption = str(it.get("caption", ""))[:300]
                    m.hashtags = [str(h) for h in (it.get("hashtags") or [])][:6]
            for j, m in enumerate(picked):
                fill_copy(m, tr, spec, j)
                ground_speech_moment(m, sheets.get(a["id"]), src, service if sure else None, shape, services, profile, j)
                guard_moment(m, text_ok, profile, services, j)
                # Studio fix: its type, its event, its words checked, and it ends on the hero too.
                m.clip_type = "talk_to_camera" if src.transcript.words_in(m.start, m.end) else "finished_walkthrough"
                m.event_group = meta.get(a["id"], {}).get("event", "e1")
                m.hook, m.hook_alt, m.caption = SCL.clean_line(m.hook, 120), SCL.clean_line(m.hook_alt, 120), SCL.clean_line(m.caption, 300)
                m.words_pending = CM.is_stock(m.hook, m.caption)
                if door != "recycle":
                    add_hero_ending(m, looks, tracks, float(pb.get("hero_hold_s", 2.0)), j)
                moments.append((m, src))
    if not moments:
        raise NoUsableMoments("no moments")
    # Distinct cuts only: a moment that shares most of its footage with one already made is dropped
    # (a look or a re-pick never counts as another clip).
    moments = distinct_moments(moments)
    if len(moments) < rules_s["clip_target"]["min"] and not (spec.get("steer") or {}).get("count"):
        steer_report.append({"what": f"{rules_s['clip_target']['min']} clips", "why": f"these videos hold {len(moments)} different cuts; the same cut is never made again in another look"})
    looks_like = P.looks_like(service, sure, shape, camera)
    # How many: her number, the moments she asked to include first, then the strongest.
    want = (spec.get("steer") or {}).get("count")
    if want and len(moments) > int(want):
        moments.sort(key=lambda ms: (0 if getattr(ms[0], "included", None) else 1, -clip_score(ms[0], ms[1], recipes)))
        moments = moments[: int(want)]
    elif want and len(moments) < int(want):
        steer_report.append({"what": f"{int(want)} clips", "why": f"we found {len(moments)} good moments in these videos, so {len(moments)} were made"})
    log("cut.picked", moments=len(moments))

    # 5-7. render: clip k takes rotation[k], so a dump's clips never all look alike. A look is only
    # used where it never repeats a picture in one frame: a grid / side-by-side needs at least as many
    # distinct shots as cells (else that look is skipped), an inset only on a talk-to-camera clip.
    ids = [new_clip_id() for _ in moments]
    music_cache: dict[str, Path] = {}
    clips: list[dict[str, Any]] = []
    looks_used: dict[str, int] = {}
    critic_stats = {"checked": 0, "recuts": 0, "hidden": 0, "under_bar": 0, "bar_recuts": 0}
    ctx: list[dict[str, Any]] = []
    skipped_looks: set[str] = set()
    for k, (m, src) in enumerate(moments):
        if m.words_pending:
            m.hook = ""  # no AI words came: nothing stock is burned in (the clip waits for its words)
        asset = next((x for x in assets if x["id"] == m.asset_id), None)
        a_steer = (asset or {}).get("steer") or {}
        rot = [r for r in (a_steer.get("rotation") or []) if r in L.LOOKS] or rotation
        body = grid_body(m)
        turn = rot[k % len(rot):] + rot[: k % len(rot)]
        fitting = [r for r in turn if look_fits(L.look_options(r), m, len(body))]
        for r in turn:
            if r not in fitting and r not in skipped_looks:
                skipped_looks.add(r)
                lo = L.look_options(r)
                why = f"these videos don't have {len(L.cells_of(lo))} different shots for one clip, and a look never repeats a picture" if lo["layout"] == "grid" else "the small replay box only goes on a clip where someone talks to the camera"
                steer_report.append({"what": str(L.LOOKS[r].get("name") or r), "why": why})
        look_id = fitting[0] if fitting else next(r for r in L.LOOK_IDS if L.look_options(r)["layout"] == "fill")
        opts = look_opts.get(f"{m.asset_id}:{look_id}") or look_opts.get(look_id) or L.look_options(look_id)
        if not look_fits(opts, m, len(body)):
            look_id = next(r for r in L.LOOK_IDS if L.look_options(r)["layout"] == "fill")
            opts = look_opts.get(look_id) or L.look_options(look_id)
        cells = None
        layout = None
        ending = None
        voice = 0
        voice_src = src
        if opts["layout"] == "grid":
            n_cells = len(L.cells_of(opts))
            cells, layout, ending = grid_from_parts(m, body[:n_cells], srcs, by_key, mediapipe)
        songs = {"music": a_steer["music"]} if "music" in a_steer else spec
        if src.muted or (m.part_assets and all(srcs[x].muted for x in m.part_assets if x in srcs)):
            # No sound of its own: always a music bed (her songs, else the built-in library), never silent.
            opts = {**opts, "music": True, "mute": True}
        song = music_key(songs, k, src.muted) if opts.get("music") else None
        music_file = music_for(songs, k, work, download, music_cache, src.muted) if song else None
        kbrand = dataclasses.replace(brand, cta=CM.cta_phrase(rules_s, k) or brand.cta)
        ctx.append({"look_id": look_id, "opts": opts, "cells": cells, "layout": layout, "ending": ending, "voice": voice, "voice_src": voice_src, "song": song, "music": music_file, "src": src, "brand": kbrand})

    def render_k(item: tuple[int, Moment]) -> Any:
        k, mm = item
        c = ctx[k]
        progress("Cutting clips", k, len(moments))
        try:
            return render_moment(mm, srcs.get(mm.asset_id, c["src"]), c["opts"], c["brand"], work, ids[k], mediapipe, cells=c["cells"], voice=c["voice"], voice_src=c["voice_src"], music=c["music"], srcs=srcs, ending=c["ending"])
        except subprocess.CalledProcessError:
            log("cut.render.failed", n=k, look=c["look_id"])
            return None

    # 6. CHECK: render every clip, the critic looks at them in batches (rules first), re-cuts the failures
    # with their reasons (one batched re-write per round), at most twice; still failing = hidden with the reason.
    checked_all = C.critic_rounds(
        list(enumerate(m for m, _s in moments)),
        render_k,
        lambda item, rr: critic_rules(item[1], srcs, sheets, services),
        lambda pairs: C.vision_check_batch(key, [critic_item(item[1], rr, srcs, sheets) for item, rr in pairs], work, f"r{critic_round(pairs)}", memory),
        lambda reqs: recut_batch(reqs, key, srcs, sheets, services, profile, text_ok, PR.copy_rules(rules), memory),
    )
    # 6b. SCORE (studio fix): 0..100 from real checks; under the studio's bar -> re-cut once -> still
    # under -> hidden with the reason. Overlap is measured against every other clip of the dump.
    done = [(k, ch) for k, ch in enumerate(checked_all) if ch is not None]
    bodies = {k: clip_body_keys(ch.moment[1]) for k, ch in done}
    bar = rules_s["bar"]
    scored: dict[int, tuple[Any, Moment, int, list[str]]] = {}
    for k, ch in done:
        r, m = ch.rendered, ch.moment[1]
        sc, why = CM.score_clip(score_facts(m, k, bodies, tracks, by_key, rules_s, ctx[k]["opts"]), pb)
        if bar and sc < bar and not ch.hidden_reason:
            critic_stats["under_bar"] += 1
            better = improve_moment(m, tracks, pb)
            if better is not None:
                critic_stats["bar_recuts"] += 1
                r2 = render_k((k, better))
                if r2 is not None:
                    sc2, why2 = CM.score_clip(score_facts(better, k, bodies, tracks, by_key, rules_s, ctx[k]["opts"]), pb)
                    if sc2 > sc:
                        r, m, sc, why = r2, better, sc2, why2
            if sc < bar:
                m.hidden_reason = f"scored {sc}/100, under your bar of {bar}: {why[0][:1].lower() + why[0][1:] if why else 'not good enough yet'}"
        scored[k] = (r, m, sc, why)
    for k, checked in done:
        c = ctx[k]
        look_id, opts, cells, layout, voice, voice_src, song = c["look_id"], c["opts"], c["cells"], c["layout"], c["voice"], c["voice_src"], c["song"]
        clip_id = ids[k]
        r, m, sc, why = scored[k]
        m.hidden_reason = m.hidden_reason or checked.hidden_reason
        if not m.hidden_reason and any(a in unsafe for a in part_owners(m)):
            m.hidden_reason = C.REASON_WORDS["privacy"]
        src = srcs.get(m.asset_id, c["src"])
        critic_stats["checked"] += 1
        critic_stats["recuts"] += checked.recuts
        critic_stats["hidden"] += 1 if m.hidden_reason else 0
        if any(s.cx is not None for s in (cells or [src.seg(m.parts[0][0], m.parts[0][1], mediapipe)])):
            engine["crop"] = "face"
        engine["subtitles"] = r.subtitles if engine["subtitles"] in ("none", "hook-only") else engine["subtitles"]
        looks_used[look_id] = looks_used.get(look_id, 0) + 1
        allowed = next((a.get("allowed_platforms") for a in assets if a["id"] == m.asset_id), None) or ["tiktok", "instagram", "youtube"]
        used = list(dict.fromkeys(part_owners(m)))
        ai_imgs = any(meta.get(x, {}).get("ai_image") for x in used)
        words = CM.final_words(m, rules_s, pb, k, ai_imgs)
        clips.append(
            {
                "id": clip_id,
                "asset_id": m.asset_id,
                "start_s": m.start,
                "end_s": m.end,
                "recipe": m.recipe,
                "hook_text": words["hook_text"][:200],
                "hook_alt": (words["hook_alt"] or None) and words["hook_alt"][:200],
                "caption": words["caption"][:2200],
                "hashtags": words["hashtags"],
                "platforms": allowed,
                "score": sc,
                "r2_key": f"{prefix}{clip_id}.mp4",
                "cover_r2_key": f"{prefix}{clip_id}.jpg",
                "look": look_id,
                "parts": [[round(s, 2), round(e, 2)] for s, e in m.parts],
                "layout": layout,
                "music": song if r.music_used else None,
                "speech": speech_share(src if src.muted else voice_src, [(cells[voice].start, cells[voice].end)] if cells else list(m.parts)) if not m.part_assets else mixed_speech(m, srcs),
                "muted": src.muted,
                # Studio intelligence: the shape, the service, what is on screen, each part's video, why it is hidden.
                "shape": m.shape,
                "service": m.service,
                "on_screen": m.on_screen[:400],
                "part_assets": m.part_assets,
                "hidden_reason": m.hidden_reason,
                # Studio fix (contract): its type, the real score's reasons, the hero it ends on, the files
                # it uses, whether any is an AI picture, its event, the voice-over script, words pending.
                "clip_type": m.clip_type or "finished_walkthrough",
                "score_reasons": why,
                "hero_asset_id": m.hero_asset_id or None,
                "files_used": used,
                "uses_ai_images": ai_imgs,
                "event_group": m.event_group or "e1",
                "voice_script": (SCL.clean_script(m.voice, words["caption"], rules_s["cta_phrases"]) or None) if not words["words_pending"] else None,
                "words_pending": words["words_pending"],
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
    log("cut.done", clips=len(clips), looks=len(looks_used), transcript=engine["transcript"], picker=engine["picker"], crop=engine["crop"], subtitles=engine["subtitles"], vision=engine.get("vision"), vision_calls=V.CALLS.get("vision", 0), text_calls=V.CALLS.get("text", 0), critic_calls=V.CALLS.get("critic", 0), recuts=critic_stats["recuts"], hidden=critic_stats["hidden"])
    log("ai.calls", **A.report())
    return {
        "clips": clips,
        "engine": engine,
        "assets": [{"id": a["id"], "duration_s": round(info["duration"], 2)} for a, _n, info, _w in prepared],
        "skipped": [{"asset_id": s["id"], "reason": s["reason"]} for s in spec.get("skipped_assets", [])],
        "source_marks": marks,
        "steer_report": steer_report,
        "camera": camera,
        "looks_like": looks_like,
        "shot_sheets": saved_sheets,
        "calls": {**dict(V.CALLS), **{f"by_{k}": v for k, v in A.report().items()}},
        "critic": critic_stats,
        # Studio fix (contract): what each upload is (its stage) and how many distinct clips, by type.
        "asset_roles": ST.asset_roles(looks),
        "clip_counts": {**CM.counts([c["clip_type"] for c in clips if not c["hidden_reason"]]), "hidden": sum(1 for c in clips if c["hidden_reason"]), "target": rules_s["clip_target"]},
        "sound_labels": sound_labels,
    }


# ---------------------------------------------------------------- one clip, a new Look

def rerender_clip(spec: dict[str, Any], work: Path, download: Downloader, upload: Uploader, progress: Progress, heavy: dict[str, bool]) -> dict[str, Any]:
    """Re-render one clip in the Look she picked in Review (and, for a grid, the cells she picked).
    The Worker sends every source stretch; each source video is normalized only around the
    stretches it needs. The old file stays live until the Worker swaps in this one."""
    work.mkdir(parents=True, exist_ok=True)
    mediapipe = heavy.get("mediapipe", False)
    brand = brand_for(spec, work, download)
    look_id = str(spec.get("look_id") or "clean")
    opts = L.look_options(look_id, spec.get("look"))
    muted = bool(spec.get("muted"))
    if muted:
        # A clip cut with the camera sound off stays that way in every new look: music, never silence.
        opts = {**opts, "music": True, "mute": True}
    wanted: dict[str, list[tuple[float, float]]] = {}
    stretches = [*(spec.get("parts") or []), *(spec.get("cells") or []), *([spec["inset"]] if spec.get("inset") else []), *([spec["ending"]] if spec.get("ending") else [])]
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
        tr = Transcript(engine="muted") if muted else transcribe(wav, heavy.get("whisper", False))
        sources[key] = (Source(norm, info, tr, [] if muted else speech_runs(wav, info["duration"]), detect_bars(norm, info["duration"]), muted=muted), lo)

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
    k = int(spec.get("music_turn") or 0)
    song = music_key(spec, k, muted) if opts.get("music") else None
    # A grid made from the clip's own shots ends on its hero (layout.ending, studio fix).
    ending = seg(spec["ending"])[0] if cells and spec.get("ending") else None
    r = render_moment(m, main_src, opts, brand, work, str(spec["clip_id"]), mediapipe, cells=cells, voice=voice if ending is None else 0, voice_src=voice_src, music=music_for(spec, k, work, download, {}, muted) if song else None, ending=ending)
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


# ---------------------------------------------------------------- one clip, made again with her notes

def again_clip(spec: dict[str, Any], work: Path, download: Downloader, upload: Uploader, progress: Progress, heavy: dict[str, bool]) -> dict[str, Any]:
    """Try another version with her notes ("what to change"): the clip's video is cut again, steered
    by the notes (moment, hook, pace, look), away from the moment she already has. The Worker swaps
    the new file in when it is ready; the current clip plays meanwhile."""
    out = cut_dump({**spec, "target_clips": {"min": 1, "max": 1}, "steer": {**(spec.get("steer") or {}), "count": 1}}, work, download, upload, progress, heavy)
    clip = out["clips"][0]
    return {"again": {**clip, "replaces": spec.get("clip_id")}, "engine": out["engine"], "camera": out.get("camera", {})}


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
            # 0..100 like every clip (studio fix); nobody checked an editor's finished cut, so it says so.
            "score": int(round(100 * max(0.5, 0.8 - 0.04 * k))),
            "r2_key": it["output_key"],
            "cover_r2_key": it["output_cover_key"],
            "look": None,
            "parts": [[0.0, d["duration"]]],
            "layout": None,
            "music": None,  # the editor's own audio; no song of hers is added
            "speech": None,  # not measured: never voiced over automatically
            "muted": False,  # the editor's own sound stays
            # Nobody looked at an editor's finished clip: no shape, no service, nothing hidden.
            "shape": None,
            "service": None,
            "on_screen": "",
            "part_assets": None,
            "hidden_reason": None,
            "clip_type": "imported",
            "score_reasons": ["Cut in your connected editor, so it was not checked here"],
            "hero_asset_id": None,
            "files_used": [it.get("asset_id")] if it.get("asset_id") else [],
            "uses_ai_images": False,
            "event_group": "e1",
            "voice_script": None,
            "words_pending": False,
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
        if spec.get("mode") == "again":
            return again_clip(spec, work, download_input, upload_output, job.progress, heavy)
        return cut_dump(spec, work, download_input, upload_output, job.progress, heavy)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    run(main)
