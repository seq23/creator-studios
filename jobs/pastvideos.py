"""Learn from my past videos (owner's plan, 23 Oct 2026).

She uploads 3 to 10 of her old FINISHED videos on Client Brain ("My past videos"). They are stored
apart from footage (R2 pastvideos/, never raw/), so they are never cut into clips. This job only
WATCHES them, with the footage reading the cutter already has, and writes one Brand Profile section,
"How my videos feel":
  1. probe (length, sound), cut times (ffmpeg scene changes), the loudness,
  2. what she says (faster-whisper, CPU): when talking starts, how much of the video is talk, pace,
  3. the shot sheets (jobs/see.py see_videos: who is on camera, what is shown),
  4. ONE free vision call on the first two seconds of every video (hook look, on-screen text style),
  5. ONE free text call that writes the section from all of that; the rules below write it when
     the free models are silent. $0 only (OPENROUTER_JOB_BUDGET, free models, then the studio's free
     Cloudflare share, then the local open model, then the rules).
Logs: step names and counts only (common.log); no words she said ever reach a log.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from statistics import median
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

# 3 batched shot-sheet calls + 1 first-seconds look + 1 writing call, at most.
os.environ.setdefault("OPENROUTER_JOB_BUDGET", "6")

import ai as A  # noqa: E402
import see as V  # noqa: E402
from common import WORK, Job, download_input, log, run  # noqa: E402
from fullvideo import probe, transcript  # noqa: E402

MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")
SCENE = 0.3
FIRST = 2.0
# The section's lines, in this order (the Brand Profile shows them as she can edit them).
LINES = ("Hooks and first 2 seconds", "Pacing and cut length", "Typical length", "Captions and on-screen text", "Music and energy", "How I talk to camera", "Recurring formats")
SECTION_MAX = 1800


def sh(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout)


def cut_times(src: Path) -> list[float]:
    """Where the picture changes (a cut), in seconds, from ffmpeg's scene score."""
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-an", "-vf", f"select='gt(scene,{SCENE})',showinfo", "-f", "null", "-"], capture_output=True, text=True, timeout=900)
    except Exception:  # noqa: BLE001
        return []
    return sorted({round(float(m), 2) for m in re.findall(r"pts_time:([0-9.]+)", r.stderr)})


def loudness(src: Path) -> float | None:
    """Mean volume in dB (ffmpeg volumedetect); None without sound."""
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-vn", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, timeout=600)
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", r.stderr)
    return float(m.group(1)) if m else None


def video_stats(duration: float, cuts: list[float], segments: list[dict[str, Any]], has_audio: bool, mean_db: float | None, to_camera_s: float) -> dict[str, Any]:
    """Plain numbers for one video (pure: tested in jobs/tests/test_pastvideos.py)."""
    duration = max(0.1, float(duration))
    talk = sum(max(0.0, float(s["end"]) - float(s["start"])) for s in segments)
    words = sum(len(str(s.get("text", "")).split()) for s in segments)
    shots = len([c for c in cuts if 0 < c < duration]) + 1
    return {
        "seconds": round(duration, 1),
        "cuts": shots - 1,
        "shot_s": round(duration / shots, 1),
        "cuts_first_2s": len([c for c in cuts if 0 < c <= FIRST]),
        "talk_share": round(min(1.0, talk / duration), 2),
        "talk_starts_s": round(float(segments[0]["start"]), 1) if segments else None,
        "words_per_min": round(words / (talk / 60)) if talk >= 3 else 0,
        "has_audio": has_audio,
        "mean_db": mean_db,
        "to_camera_share": round(min(1.0, to_camera_s / duration), 2),
    }


def _range(xs: list[float]) -> str:
    lo, hi = min(xs), max(xs)
    return f"about {round(lo)} seconds" if round(lo) == round(hi) else f"{round(lo)} to {round(hi)} seconds"


def rules_lines(stats: list[dict[str, Any]], look: dict[str, str] | None = None) -> dict[str, str]:
    """The section from the numbers alone (the free models silent). Never invents a style it did not measure."""
    look = look or {}
    n = len(stats)
    shot = median([s["shot_s"] for s in stats])
    first = median([s["cuts_first_2s"] for s in stats])
    talk = median([s["talk_share"] for s in stats])
    cam = median([s["to_camera_share"] for s in stats])
    starts = [s["talk_starts_s"] for s in stats if s["talk_starts_s"] is not None]
    wpm = [s["words_per_min"] for s in stats if s["words_per_min"]]
    pace = "fast" if shot < 1.5 else "quick" if shot < 3 else "steady" if shot < 6 else "slow, long takes"
    hook = f"talking starts in the first second in {sum(1 for x in starts if x <= 1.0)} of {n} videos" if starts else "no talking at the start; the picture does the work"
    lines = {
        "Hooks and first 2 seconds": f"{look.get('first_seconds') or 'Not sure yet what the opening shows'}; {hook}; {'a cut' if first >= 1 else 'no cut'} in the first 2 seconds.",
        "Pacing and cut length": f"{pace.capitalize()}: a cut about every {shot:g} seconds.",
        "Typical length": _range([s["seconds"] for s in stats]) + ".",
        "Captions and on-screen text": look.get("on_screen_text") or "Not sure yet; edit this line to say how your captions look.",
        "Music and energy": ("Mostly music under the picture" if all(s["has_audio"] for s in stats) and talk < 0.25 else "Mostly her own voice" if talk >= 0.5 else "Some talking, some music" if any(s["has_audio"] for s in stats) else "Silent videos") + f", {'high' if shot < 2 else 'easy' if shot >= 4 else 'medium'} energy.",
        "How I talk to camera": (f"Talks to camera for about {round(cam * 100)}% of a video" if cam >= 0.15 else "Rarely on camera; voice or text carries it" if talk >= 0.2 else "Not on camera") + (f", about {round(median(wpm))} words a minute." if wpm else "."),
        "Recurring formats": "Not sure yet; edit this line to name the formats you repeat.",
    }
    return lines


def section_text(lines: dict[str, str]) -> str:
    out = "\n".join(f"{k}: {str(lines.get(k, '')).strip()}" for k in LINES if str(lines.get(k, "")).strip())
    return out[:SECTION_MAX]


def ai_lines(answer: str | None) -> dict[str, str] | None:
    """The model's lines when it answered every one in plain words; else None (the rules write them)."""
    d = A.first_json(answer)
    if not isinstance(d, dict):
        return None
    out = {k: re.sub(r"\s+", " ", str(d.get(k, ""))).strip()[:260] for k in LINES}
    if sum(1 for v in out.values() if v) < len(LINES) - 1:
        return None
    if any(re.search(r"^\s*(\d+\.|[-*#])|analy[sz]e the request|as an ai", v, re.I) for v in out.values()):
        return None
    return out


WRITE_SYSTEM = (
    "You describe how one creator's finished short videos feel, so an editor can make new clips that feel the same. You get "
    "measured numbers per video, what the shot sheets saw, what the first two seconds look like, and the first words she says. "
    "Write ONLY what the numbers and notes show; never invent music titles, names, places or prices. Plain short sentences, "
    "no lists or markdown. Answer JSON only with exactly these keys, one sentence or two each: "
    + json.dumps(list(LINES))
)

LOOK_SYSTEM = (
    "Each group is the first two seconds of one of a creator's finished videos (three frames each). Answer JSON only: "
    '{"first_seconds": str, "on_screen_text": str}. first_seconds: one sentence on what the openings usually show (a face, '
    "the finished result, a before, text on a plain background...). on_screen_text: one sentence on the on-screen text and "
    "captions if any (where they sit, how big, how many words, style), or 'No on-screen text'. Never read out names or addresses."
)


def first_seconds_look(key: str | None, videos: list[tuple[str, Path, float]], work: Path) -> dict[str, str]:
    groups: list[tuple[str, list[Path]]] = []
    for i, (vid, src, duration) in enumerate(videos):
        frames: list[Path] = []
        for j, t in enumerate((0.3, 1.0, 1.8)):
            if t >= duration:
                break
            f = work / f"{vid}_first{j}.jpg"
            try:
                sh(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(f)])
                frames.append(f)
            except Exception:  # noqa: BLE001
                pass
        if frames:
            groups.append((f"VIDEO {i + 1}", frames))
    grid = V.labelled_grid(groups, work / "first_seconds.jpg", cols=3) if groups else None
    if not grid:
        return {}
    answer, _model = V.ask_vision(key, LOOK_SYSTEM, "Describe the openings and the on-screen text.", grid, "pastvideos", max_tokens=500)
    if not isinstance(answer, dict):
        return {}
    return {k: re.sub(r"\s+", " ", str(answer.get(k, ""))).strip()[:220] for k in ("first_seconds", "on_screen_text") if str(answer.get(k, "")).strip()}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    A.reset()
    work = WORK / "pastvideos"
    work.mkdir(parents=True, exist_ok=True)
    key = spec.get("llm_key") or None
    items = spec.get("videos") or []
    if not items:
        raise RuntimeError("no_past_videos")
    total = len(items) + 2
    prepared: list[tuple[str, Path, dict[str, Any], list[float], list[dict[str, Any]], float | None]] = []
    for i, it in enumerate(items):
        job.progress("watching your past videos", i, total)
        src = download_input(str(it["r2_key"]), work / f"{it['id']}.bin")
        info = probe(src)
        if info["duration"] <= 0 or info["width"] <= 0:
            log("pastvideos.unreadable")
            continue
        segs = transcript(src, work, info["has_audio"])[1]
        prepared.append((str(it["id"]), src, info, cut_times(src), segs, loudness(src) if info["has_audio"] else None))
    if not prepared:
        raise RuntimeError("no_readable_past_videos")
    job.progress("seeing what is on screen", len(items), total)
    sheets = V.see_videos(key, [{"asset_id": vid, "video": src, "duration": info["duration"], "notes": ""} for vid, src, info, _c, _s, _d in prepared], list(spec.get("services") or []), work)
    stats = []
    seen: list[str] = []
    first_words: list[str] = []
    for vid, _src, info, cuts, segs, db in prepared:
        sheet = sheets.get(vid)
        cam = sum(b - a for a, b in (sheet.to_camera_windows() if sheet else []))
        stats.append(video_stats(info["duration"], cuts, segs, info["has_audio"], db, cam))
        if sheet:
            seen.extend(s.what for s in sheet.shots[:4] if s.what)
        if segs:
            first_words.append(" ".join(str(s.get("text", "")) for s in segs[:2])[:160])
    look = first_seconds_look(key, [(vid, src, info["duration"]) for vid, src, info, _c, _s, _d in prepared], work)
    job.progress("writing how your videos feel", len(items) + 1, total)
    payload = {
        "max_tokens": 900,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": WRITE_SYSTEM},
            {"role": "user", "content": json.dumps({"videos": stats, "shot_sheets_saw": seen[:30], "first_two_seconds": look, "first_words": first_words[:10], "her_voice": str((spec.get("profile") or {}).get("voice", ""))[:400]})},
        ],
    }
    answer, _model = A.ask_openrouter(key, lambda m: {**payload, "model": m}, [MODEL], "text")
    lines = ai_lines(answer)
    by = "ai" if lines else "rules"
    measured = rules_lines(stats, look)
    if lines:
        # Numbers are measured, never the model's: pacing and length always come from the clock.
        lines = {**lines, "Pacing and cut length": measured["Pacing and cut length"], "Typical length": measured["Typical length"]}
    else:
        lines = measured
    out = {"section": section_text(lines), "videos": len(prepared), "by": by, "stats": stats, "calls": A.report()}
    log("pastvideos.done", videos=len(prepared), by=out["by"], **A.report())
    return out


if __name__ == "__main__":
    run(main)
