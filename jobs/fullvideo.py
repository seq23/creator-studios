"""The full-video door: "A full video for YouTube" (owner, 26 Sep 2026).

One video goes up WHOLE: no cutting and no 9:16 reframing (validator `full-video-uncut` reads this
file: no crop, no vertical size, no import of the cutter). This job only:
  1. probes the video (size, length, whether it has sound),
  2. copies it into a streaming-friendly MP4 WITHOUT re-encoding (`-c copy`, moov atom first) so
     Buffer and the Review player can fetch it; a codec an MP4 cannot hold (ProRes, say) is
     re-encoded at its own size and shape, never scaled or cropped,
  3. writes what she said (faster-whisper) for the title, description and chapters,
  4. picks three thumbnail frames from different parts of the video.
Logs: step names and counts only (common.log); no words she said ever reach a log.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from common import WORK, Job, download_input, log, run, upload_output

THUMB_AT = (0.2, 0.5, 0.8)


def sh(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout)


def probe(src: Path) -> dict[str, Any]:
    out = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(src)]).stdout
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return {
        "duration": float((data.get("format") or {}).get("duration") or 0),
        "width": int((video or {}).get("width") or 0),
        "height": int((video or {}).get("height") or 0),
        "vcodec": (video or {}).get("codec_name") or "",
        "acodec": (audio or {}).get("codec_name") or "",
        "has_audio": audio is not None,
    }


# Codecs an MP4 carries as they are; anything else is re-encoded at the same size and shape.
MP4_VIDEO = {"h264", "hevc", "av1", "mpeg4", "vp9"}
MP4_AUDIO = {"aac", "mp3", "opus", "ac3", "eac3", "alac", ""}


def copy_command(src: Path, dst: Path) -> list[str]:
    """The whole video, every frame, same size and shape: streams copied, moov atom first."""
    return ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", str(dst)]


def reencode_command(src: Path, dst: Path) -> list[str]:
    """Only when the codec can't live in an MP4: re-encoded at its own size and shape (no filters)."""
    return ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dst)]


def thumb_command(src: Path, at: float, dst: Path) -> list[str]:
    """The most representative frame in a 4-second window (ffmpeg's thumbnail filter), as a JPEG
    at most 1280 wide, its own shape (the video itself is never touched here)."""
    return ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{max(0.0, at):.2f}", "-t", "4", "-i", str(src), "-vf", "thumbnail=90,scale='min(1280,iw)':-2", "-frames:v", "1", "-q:v", "3", str(dst)]


def thumb_times(duration: float) -> list[float]:
    return [round(max(0.0, min(duration - 4, duration * f)), 2) for f in THUMB_AT]


def ensure_whisper() -> bool:
    if os.environ.get("JOB_HEAVY") == "1":
        try:
            sh([sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "faster-whisper>=1.0,<2"], timeout=900)
        except Exception:  # noqa: BLE001
            log("fullvideo.whisper", ok=False)
    try:
        import faster_whisper  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def transcript(src: Path, work: Path, has_audio: bool) -> tuple[str, list[dict[str, Any]]]:
    if not has_audio or not ensure_whisper():
        return "none", []
    wav = work / "audio.wav"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(wav)])
    try:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8")
        segs, _ = model.transcribe(str(wav), vad_filter=True)
        return "faster-whisper", [{"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": s.text.strip()} for s in segs if s.text.strip()]
    except Exception:  # noqa: BLE001
        log("fullvideo.transcribe_failed")
        return "none", []


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    work = WORK / "fullvideo"
    work.mkdir(parents=True, exist_ok=True)
    job.progress("getting your video", 0, 4)
    src = download_input(str(spec["source_key"]), work / "source.bin")
    info = probe(src)
    if info["width"] <= 0 or info["duration"] <= 0:
        raise RuntimeError("no_video_stream")
    job.progress("making it ready for YouTube", 1, 4)
    out = work / "video.mp4"
    copied = info["vcodec"] in MP4_VIDEO and info["acodec"] in MP4_AUDIO
    if copied:
        try:
            sh(copy_command(src, out))
        except subprocess.CalledProcessError:
            copied = False
    if not copied:
        sh(reencode_command(src, out))
    after = probe(out)
    # The same video: same size and shape, the same length (a copy never drops frames).
    if (after["width"], after["height"]) != (info["width"], info["height"]) or abs(after["duration"] - info["duration"]) > 1.0:
        raise RuntimeError("copy_changed_the_video")
    upload_output(out, str(spec["output_key"]), "video/mp4")
    log("fullvideo.video", copied=copied, seconds=round(info["duration"]), mb=round(out.stat().st_size / 1e6))

    job.progress("writing down what you said", 2, 4)
    engine, segments = transcript(out, work, info["has_audio"])
    log("fullvideo.transcript", engine=engine, segments=len(segments))

    job.progress("picking thumbnails", 3, 4)
    thumbs = []
    for i, (key, at) in enumerate(zip(spec["thumb_keys"], thumb_times(info["duration"]))):
        jpg = work / f"thumb{i + 1}.jpg"
        sh(thumb_command(out, at, jpg))
        upload_output(jpg, str(key), "image/jpeg")
        thumbs.append({"key": key, "t": at})
    log("fullvideo.done", thumbs=len(thumbs))
    return {
        "video": {"key": spec["output_key"], "width": info["width"], "height": info["height"], "duration_s": round(info["duration"], 2), "size_bytes": out.stat().st_size, "copied": copied},
        "transcript": segments,
        "engine": engine,
        "thumbnails": thumbs,
    }


if __name__ == "__main__":
    run(main)
