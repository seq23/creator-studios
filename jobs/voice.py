"""Chatterbox narration (section 12).

Clones her voice from the consented sample (Chatterbox by Resemble AI, MIT, CPU) and speaks the
script. Chatterbox output carries an inaudible watermark. The prepared voice conditionals are
saved to R2 as the "voice model" so later narrations skip that step; "Delete my voice" in the
dashboard removes both the sample and this file.

Chatterbox and torch are heavy, so they are installed here, inside the job, not in
requirements.txt (the light jobs stay fast). Logs: step names and counts only.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from common import WORK, Job, download_input, log, run, upload_output

CHATTERBOX = "chatterbox-tts>=0.1.2,<0.2"
# Chatterbox's watermarker (resemble-perth) imports pkg_resources, which setuptools 81 removed and
# a Python 3.12 runner does not ship: perth.PerthImplicitWatermarker was None and every voice job
# died with "TypeError: 'NoneType' object is not callable" (Phase 0 live test, 26 Sep 2026; the
# diagnostic run with this pin loaded the model in 48 s and spoke a sentence in 17 s on the CPU).
SETUPTOOLS = "setuptools<81"


def install() -> None:
    log("voice.install")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--extra-index-url", "https://download.pytorch.org/whl/cpu", CHATTERBOX, SETUPTOOLS],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def require_watermarker() -> None:
    """Every narration carries the inaudible watermark (BUILD_PLAN section 12). If perth could not
    load its watermarker, stop with a named reason instead of a bare TypeError inside Chatterbox."""
    import perth  # noqa: E402  (installed with chatterbox)

    if getattr(perth, "PerthImplicitWatermarker", None) is None:
        raise RuntimeError("watermarker_unavailable: resemble-perth could not load (pkg_resources missing?)")


def to_wav(src: Path, dest: Path) -> Path:
    # Browser recordings are webm/ogg/mp4; Chatterbox wants a clean mono WAV.
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "24000", str(dest)], check=True)
    return dest


def has_audio(path: Path) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return bool(out.stdout.strip())


def mix_command(clip: Path, voice: Path, out: Path, clip_has_audio: bool) -> list[str]:
    """Her voice over on top, the clip's own sound at a quarter underneath; the video stream is
    copied untouched and the result is exactly as long as the clip."""
    if clip_has_audio:
        graph = "[0:a]volume=0.25[bg];[1:a]apad[vo];[bg][vo]amix=inputs=2:duration=first:normalize=0[a]"
        tail = []
    else:
        graph = "[1:a]apad[a]"
        tail = ["-shortest"]
    return ["ffmpeg", "-y", "-loglevel", "error", "-i", str(clip), "-i", str(voice), "-filter_complex", graph, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", *tail, str(out)]


def mix(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    """Attach: mix the finished voice over into the clip. ffmpeg only, no model, about a minute."""
    work = WORK / "mix"
    work.mkdir(parents=True, exist_ok=True)
    job.progress("adding your voice over", 0, 2)
    clip = download_input(str(spec["clip_key"]), work / "clip.mp4")
    voice_key = str(spec["narration_key"])
    voice = download_input(voice_key, work / ("voice" + Path(voice_key).suffix))
    out = work / "voiced.mp4"
    with_sound = has_audio(clip)
    subprocess.run(mix_command(clip, voice, out, with_sound), check=True)
    key = str(spec["output_key"])
    job.progress("adding your voice over", 1, 2)
    upload_output(out, key, "video/mp4")
    log("voice.mix.done", clip_audio=with_sound, bytes=out.stat().st_size)
    return {"mode": "mix", "r2_key": key, "bytes": out.stat().st_size}


def load_model(spec: dict[str, Any], work: Path) -> tuple[Any, bool]:
    """Chatterbox with her voice, from the saved voice model or, the first time, from her sample
    (then saved to R2 so later runs skip that step). Loaded ONCE per run."""
    install()
    require_watermarker()
    from chatterbox.tts import ChatterboxTTS  # noqa: E402

    model = ChatterboxTTS.from_pretrained(device="cpu")
    conds_path = work / "conds.pt"
    model_key = str(spec["model_key"])
    loaded = False
    if spec.get("model_exists"):
        try:
            download_input(model_key, conds_path)
            from chatterbox.tts import Conditionals  # noqa: E402

            model.conds = Conditionals.load(conds_path, map_location="cpu")
            loaded = True
        except Exception:  # noqa: BLE001  a stale or missing model is rebuilt from the sample
            log("voice.model.rebuild")
    if not loaded:
        raw = download_input(str(spec["sample_key"]), work / "sample.bin")
        sample = to_wav(raw, work / "sample.wav")
        model.prepare_conditionals(str(sample))
        model.conds.save(conds_path)
        upload_output(conds_path, model_key, "application/octet-stream")
    log("voice.ready", reused=loaded)
    return model, loaded


def speak(model: Any, script: str, out_mp3: Path, on_sentence: Any = None) -> float:
    """The script in her voice, sentence by sentence (a steady CPU run), as an mp3. Returns seconds."""
    import torch  # noqa: E402
    import torchaudio  # noqa: E402

    parts = [p.strip() for p in script.replace("\n", " ").split(". ") if p.strip()]
    chunks: list[Any] = []
    for i, p in enumerate(parts):
        chunks.append(model.generate(p if p.endswith((".", "!", "?")) else p + "."))
        if on_sentence:
            on_sentence(i + 1, len(parts))
    wav = torch.cat(chunks, dim=-1)
    out_wav = out_mp3.with_suffix(".wav")
    torchaudio.save(str(out_wav), wav, model.sr)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out_wav), "-codec:a", "libmp3lame", "-q:a", "3", str(out_mp3)], check=True)
    return wav.shape[-1] / model.sr


def batch(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    """Automatic voice overs for a whole dump in ONE run: the model loads once, then each clip with
    no talking gets its voice over spoken (premium ones arrive ready) and mixed in. One clip that
    fails does not stop the others; the Worker marks just that one."""
    started = time.time()
    work = WORK / "batch"
    work.mkdir(parents=True, exist_ok=True)
    items = spec.get("items") or []
    model = None
    if any(it.get("speak") for it in items):
        job.progress("loading your voice", 0, len(items) + 1)
        model, _ = load_model(spec, work)
    results = []
    for k, it in enumerate(items):
        job.progress("voicing clips", k + 1, len(items) + 1)
        nid = str(it["narration_id"])
        try:
            voice_path = work / f"{nid}.mp3"
            seconds = None
            if it.get("speak"):
                seconds = speak(model, str(it["script"]), voice_path)
                upload_output(voice_path, str(it["narration_key"]), "audio/mpeg")
            else:
                download_input(str(it["narration_key"]), voice_path)
            clip = download_input(str(it["clip_key"]), work / f"{nid}_clip.mp4")
            out = work / f"{nid}_voiced.mp4"
            subprocess.run(mix_command(clip, voice_path, out, has_audio(clip)), check=True)
            upload_output(out, str(it["output_key"]), "video/mp4")
            results.append({"narration_id": nid, "ok": True, "narration_key": it["narration_key"], "mixed_key": it["output_key"], "duration_s": round(seconds, 1) if seconds else None})
        except Exception:  # noqa: BLE001  one clip failing never stops the rest
            log("voice.batch.item_failed", n=k)
            results.append({"narration_id": nid, "ok": False})
    minutes = round((time.time() - started) / 60, 2)
    log("voice.batch.done", items=len(items), ok=sum(1 for r in results if r["ok"]), minutes=minutes)
    return {"mode": "batch", "items": results, "model_key": str(spec.get("model_key") or ""), "minutes": minutes}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    if spec.get("mode") == "mix":
        return mix(job, spec)
    if spec.get("mode") == "batch":
        return batch(job, spec)
    script = str(spec.get("script") or "").strip()
    if not script:
        raise RuntimeError("empty_script")
    work = WORK / "voice"
    work.mkdir(parents=True, exist_ok=True)
    job.progress("preparing", 0, 4)
    model, _ = load_model(spec, work)
    job.progress("speaking", 2, 4)
    out_mp3 = work / "narration.mp3"
    seconds = speak(model, script, out_mp3, lambda n, of: (job.progress("speaking", 2, 4), log("voice.sentence", n=n, of=of)))
    job.progress("saving", 3, 4)
    key = str(spec["output_key"])
    upload_output(out_mp3, key, "audio/mpeg")
    log("voice.done", seconds=round(seconds, 1), bytes=out_mp3.stat().st_size)
    return {"r2_key": key, "duration_s": round(seconds, 1), "bytes": out_mp3.stat().st_size, "model_key": str(spec["model_key"])}


if __name__ == "__main__":
    run(main)
