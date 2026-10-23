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
import script_clean as SCL  # the words are cleaned before they are spoken (studio fix, 23 Oct 2026)
import vo_words as VW  # the words the voice says, burned on screen (Follow-on V, 23 Oct 2026)
from looks import has_filter

import json
import urllib.request

# Stock voices (owner, 22 Oct 2026): Kokoro-82M preset speakers, Apache-2.0, through kokoro-onnx (MIT).
# No real person's voice is cloned. jobs/voices.json lists them and their licences.
VOICES = json.loads((Path(__file__).resolve().parent / "voices.json").read_text(encoding="utf-8"))
STOCK_IDS = [v["id"] for v in VOICES["voices"]]
KOKORO = "kokoro-onnx>=0.4,<0.5"

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


def duration_of(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def words_file(script: str, timings: list[tuple[float, float, str]] | None, voice: Path, clip: Path, work: Path, name: str) -> tuple[Path | None, int]:
    """The ASS file with the voice over's words (jobs/vo_words.py): the engine's own sentence
    timings, else estimated from the voice's length. (None, 0) when there is nothing to show or this
    ffmpeg cannot burn text (local machines only; the runner's static ffmpeg has libass)."""
    if not timings:
        timings = VW.estimate_timings(script, duration_of(voice))
    cues = VW.phrase_cues(timings, duration_of(clip))
    ass = VW.build_vo_ass(cues)
    if ass is None or not has_filter("subtitles"):
        return None, 0
    path = work / f"{name}_words.ass"
    path.write_text(ass, encoding="utf-8")
    return path, len(cues)


def mix_command(clip: Path, voice: Path, out: Path, clip_has_audio: bool, words: Path | None = None) -> list[str]:
    """Her voice over on top, the clip's own sound at a quarter underneath; the result is exactly as
    long as the clip. With `words`, the voice over's words are burned in their band (the video is
    re-encoded once); without, the video stream is copied untouched."""
    if clip_has_audio:
        graph = "[0:a]volume=0.25[bg];[1:a]apad[vo];[bg][vo]amix=inputs=2:duration=first:normalize=0[a]"
        tail = []
    else:
        graph = "[1:a]apad[a]"
        tail = ["-shortest"]
    if words is not None:
        graph += f";[0:v]subtitles=filename='{words.resolve()}'[v]"
        video = ["-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    else:
        video = ["-map", "0:v:0", "-c:v", "copy"]
    return ["ffmpeg", "-y", "-loglevel", "error", "-i", str(clip), "-i", str(voice), "-filter_complex", graph, *video[:2], "-map", "[a]", *video[2:], "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", *tail, str(out)]


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
    words, n_words = words_file(str(spec.get("script") or ""), None, voice, clip, work, "mix")
    subprocess.run(mix_command(clip, voice, out, with_sound, words), check=True)
    key = str(spec["output_key"])
    job.progress("adding your voice over", 1, 2)
    upload_output(out, key, "video/mp4")
    log("voice.mix.done", clip_audio=with_sound, bytes=out.stat().st_size, words=n_words)
    return {"mode": "mix", "r2_key": key, "bytes": out.stat().st_size, "words": n_words}


class Stock:
    """A stock voice: Kokoro with one of its preset speakers. Same speak() shape as Chatterbox."""

    def __init__(self, voice: str, work: Path) -> None:
        if voice not in STOCK_IDS:
            raise RuntimeError("unknown_stock_voice")
        log("voice.install", engine="stock")
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", KOKORO, "soundfile"], check=True, stdout=subprocess.DEVNULL)
        files = {}
        for name, url in (("model", VOICES["engine"]["model_url"]), ("voices", VOICES["engine"]["voices_url"])):
            dest = work / url.rsplit("/", 1)[-1]
            if not dest.exists():
                urllib.request.urlretrieve(url, dest)
            files[name] = dest
        from kokoro_onnx import Kokoro  # noqa: E402

        self.k = Kokoro(str(files["model"]), str(files["voices"]), **espeak_config())
        self.voice = voice
        log("voice.ready", engine="stock")


def espeak_config() -> dict[str, Any]:
    """The system espeak-ng (job-voice.yml installs it) when there is one: the library bundled with
    kokoro-onnx looks for its phoneme data at the path it was built on (macOS, 22 Oct 2026:
    "Error processing file '/Users/runner/.../phontab'") and every sentence failed."""
    import ctypes.util

    lib = ctypes.util.find_library("espeak-ng")
    data = next((d for d in ("/usr/lib/x86_64-linux-gnu/espeak-ng-data", "/usr/share/espeak-ng-data", "/opt/homebrew/share/espeak-ng-data", "/usr/local/share/espeak-ng-data") if Path(d, "phontab").exists()), None)
    if not lib or not data:
        return {}
    from kokoro_onnx.config import EspeakConfig  # noqa: E402

    return {"espeak_config": EspeakConfig(lib_path=lib, data_path=data)}


def load_voice(spec: dict[str, Any], work: Path) -> Any:
    """The stock voice when the studio uses one (Settings > Voice), else her own recorded voice."""
    stock = spec.get("stock_voice")
    if stock:
        return Stock(str(stock), work)
    return load_model(spec, work)[0]


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


Timings = list[tuple[float, float, str]]


def speak(model: Any, script: str, out_mp3: Path, on_sentence: Any = None) -> tuple[float, Timings]:
    """The script in her voice, one sentence at a time (a steady CPU run), as an mp3. Returns the
    seconds and each sentence's exact start and end (the on-screen words follow them)."""
    if isinstance(model, Stock):
        return speak_stock(model, script, out_mp3, on_sentence)
    import torch  # noqa: E402
    import torchaudio  # noqa: E402

    parts = VW.split_sentences(script)
    chunks: list[Any] = []
    timings: Timings = []
    t = 0.0
    for i, p in enumerate(parts):
        chunk = model.generate(p)
        chunks.append(chunk)
        d = chunk.shape[-1] / model.sr
        timings.append((round(t, 3), round(t + d, 3), p))
        t += d
        if on_sentence:
            on_sentence(i + 1, len(parts))
    wav = torch.cat(chunks, dim=-1)
    out_wav = out_mp3.with_suffix(".wav")
    torchaudio.save(str(out_wav), wav, model.sr)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out_wav), "-codec:a", "libmp3lame", "-q:a", "3", str(out_mp3)], check=True)
    return wav.shape[-1] / model.sr, timings


def speak_stock(model: Stock, script: str, out_mp3: Path, on_sentence: Any = None) -> tuple[float, Timings]:
    """The stock voice, one sentence at a time (so each sentence's timing is exact), joined."""
    import numpy as np  # noqa: E402  (installed with kokoro-onnx)
    import soundfile as sf  # noqa: E402

    parts = VW.split_sentences(script)
    pieces: list[Any] = []
    timings: Timings = []
    sr = 24000
    t = 0.0
    for i, p in enumerate(parts):
        piece, sr = model.k.create(p, voice=model.voice, speed=1.0, lang="en-us")
        pieces.append(piece)
        d = len(piece) / sr
        timings.append((round(t, 3), round(t + d, 3), p))
        t += d
        if on_sentence:
            on_sentence(i + 1, len(parts))
    samples = np.concatenate(pieces) if pieces else np.zeros(1, dtype="float32")
    out_wav = out_mp3.with_suffix(".wav")
    sf.write(str(out_wav), samples, sr)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out_wav), "-codec:a", "libmp3lame", "-q:a", "3", str(out_mp3)], check=True)
    return len(samples) / sr, timings


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
        model = load_voice(spec, work)
    results = []
    for k, it in enumerate(items):
        job.progress("voicing clips", k + 1, len(items) + 1)
        nid = str(it["narration_id"])
        try:
            voice_path = work / f"{nid}.mp3"
            seconds = None
            timings = None
            script = str(it.get("script") or "")
            if it.get("speak"):
                script = SCL.clean_script(str(it.get("script") or ""), str(it.get("caption") or ""), it.get("ctas") or [])
                if not script:
                    # Reasoning-shaped or empty (a model's "thinking"): never spoken (jobs/script_clean.py).
                    log("voice.batch.script_rejected", n=k)
                    results.append({"narration_id": nid, "ok": False, "reason": "script_rejected"})
                    continue
                seconds, timings = speak(model, script, voice_path)
                upload_output(voice_path, str(it["narration_key"]), "audio/mpeg")
            else:
                download_input(str(it["narration_key"]), voice_path)
            clip = download_input(str(it["clip_key"]), work / f"{nid}_clip.mp4")
            out = work / f"{nid}_voiced.mp4"
            # The words on screen: the engine's sentence timings, else estimated from the voice's length.
            words, n_words = words_file(script, timings, voice_path, clip, work, nid)
            subprocess.run(mix_command(clip, voice_path, out, has_audio(clip), words), check=True)
            upload_output(out, str(it["output_key"]), "video/mp4")
            results.append({"narration_id": nid, "ok": True, "narration_key": it["narration_key"], "mixed_key": it["output_key"], "duration_s": round(seconds, 1) if seconds else None, "words": n_words})
        except Exception:  # noqa: BLE001  one clip failing never stops the rest
            log("voice.batch.item_failed", n=k)
            results.append({"narration_id": nid, "ok": False})
    minutes = round((time.time() - started) / 60, 2)
    log("voice.batch.done", items=len(items), ok=sum(1 for r in results if r["ok"]), minutes=minutes)
    # A stock voice makes no voice model of hers: nothing to record on the Worker.
    return {"mode": "batch", "items": results, "model_key": "" if spec.get("stock_voice") else str(spec.get("model_key") or ""), "minutes": minutes}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    if spec.get("mode") == "mix":
        return mix(job, spec)
    if spec.get("mode") == "batch":
        return batch(job, spec)
    script = SCL.clean_script(str(spec.get("script") or ""), str(spec.get("caption") or ""), spec.get("ctas") or [])
    if not script:
        # Empty, or reasoning-shaped ("1. **Analyze the Request:** ..."): never spoken (jobs/script_clean.py).
        raise RuntimeError("empty_script" if not str(spec.get("script") or "").strip() else "script_rejected")
    work = WORK / "voice"
    work.mkdir(parents=True, exist_ok=True)
    job.progress("preparing", 0, 4)
    model = load_voice(spec, work)
    job.progress("speaking", 2, 4)
    out_mp3 = work / "narration.mp3"
    seconds, _timings = speak(model, script, out_mp3, lambda n, of: (job.progress("speaking", 2, 4), log("voice.sentence", n=n, of=of)))
    job.progress("saving", 3, 4)
    key = str(spec["output_key"])
    upload_output(out_mp3, key, "audio/mpeg")
    log("voice.done", seconds=round(seconds, 1), bytes=out_mp3.stat().st_size)
    return {"r2_key": key, "duration_s": round(seconds, 1), "bytes": out_mp3.stat().st_size, "model_key": "" if spec.get("stock_voice") else str(spec["model_key"])}


if __name__ == "__main__":
    run(main)
