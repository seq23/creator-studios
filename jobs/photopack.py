"""The photo maker: one set of photos becomes a pack of posts (worker/jobs/photopack.ts).

For each pack it:
  1. opens every photo (JPG, PNG or iPhone HEIC), turned the right way up,
  2. runs the photo check: faces (OpenCV's face finders) and house numbers / any run of digits
     (tesseract) are blurred hard; with the studio's face/address rules on ("strict"), a check that
     cannot run blocks the pack instead of passing it,
  3. writes the carousel: each checked photo at 1080x1350,
  4. writes the reel (1080x1920): with a Hugging Face token in the spec, the first photo becomes a
     short realistic camera-move clip from an open-source image-to-video model (realistic_clip,
     owner's word 22 Oct 2026); without one, or whenever that model is busy, rate-limited or fails,
     the slow zoom (real photos moved slowly) is used, so the post never waits,
  5. writes the before/after video when a before and an after photo exist.
Logs: step names and counts only (common.log). Nothing about the photos reaches a log.

`python3 jobs/photopack.py --selftest` runs the same pipeline on made-up photos with no Worker
(the PR check in job-photopack.yml): a photo with a big house number must come back blurred.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

W, H = 1080, 1920          # reel and before/after
CW, CH = 1080, 1350        # carousel
REEL_S = 8.0
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
DIGITS = re.compile(r"\d")


def sh(cmd: list[str], timeout: float = 600) -> None:
    subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=timeout)


def open_photo(path: Path):
    from PIL import Image, ImageOps

    try:
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001 - a JPG/PNG pack still works without it
        pass
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def _blur_box(img, box, strength: int = 40):
    from PIL import ImageFilter

    x0, y0, x1, y1 = box
    pad_x, pad_y = int((x1 - x0) * 0.2) + 4, int((y1 - y0) * 0.25) + 4
    x0, y0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
    x1, y1 = min(img.width, x1 + pad_x), min(img.height, y1 + pad_y)
    if x1 <= x0 or y1 <= y0:
        return
    region = img.crop((x0, y0, x1, y1))
    # Pixelate then blur: nothing readable survives.
    small = region.resize((max(1, (x1 - x0) // 16), max(1, (y1 - y0) // 16)))
    region = small.resize(region.size).filter(ImageFilter.GaussianBlur(strength))
    img.paste(region, (x0, y0))


def find_faces(img) -> list[tuple[int, int, int, int]]:
    """Faces, front and side (OpenCV 4 Haar finders: pinned <5 in job-photopack.yml, OpenCV 5 dropped them).
    Raises when the face finder cannot load, so a strict pack blocks instead of passing."""
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
    boxes: list[tuple[int, int, int, int]] = []
    for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
        cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, name))
        if cascade.empty():
            raise RuntimeError("face finder did not load")
        min_side = max(24, min(img.width, img.height) // 40)
        for (x, y, w, h) in cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side)):
            boxes.append((int(x), int(y), int(x + w), int(y + h)))
    return boxes


def find_numbers(img) -> list[tuple[int, int, int, int]]:
    """Every run of digits tesseract can read (house numbers, mailbox numbers, signs)."""
    boxes: list[tuple[int, int, int, int]] = []
    with tempfile.TemporaryDirectory() as d:
        for scale in (1.0, 0.5):
            src = img if scale == 1.0 else img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
            p = Path(d) / f"ocr-{scale}.png"
            src.convert("L").save(p)
            out = subprocess.run(["tesseract", str(p), "stdout", "--psm", "11", "tsv"], capture_output=True, text=True, timeout=180)
            if out.returncode != 0:
                raise RuntimeError("number finder did not run")
            for line in out.stdout.splitlines()[1:]:
                f = line.split("\t")
                if len(f) < 12 or not DIGITS.search(f[11] or ""):
                    continue
                try:
                    conf = float(f[10])
                except ValueError:
                    continue
                if conf < 30:
                    continue
                x, y, w, h = (int(int(v) / scale) for v in f[6:10])
                boxes.append((x, y, x + w, y + h))
    return boxes


def check_photo(img, strict: bool) -> tuple[Any, int, int, bool]:
    """(photo with faces and numbers blurred, faces, numbers, ok). ok=False: the check could not run."""
    faces: list = []
    numbers: list = []
    ok = True
    try:
        faces = find_faces(img)
    except Exception:  # noqa: BLE001
        ok = False
    try:
        numbers = find_numbers(img)
    except Exception:  # noqa: BLE001
        ok = False
    for b in faces:
        _blur_box(img, b, 50)
    for b in numbers:
        _blur_box(img, b, 30)
    return img, len(faces), len(numbers), ok or not strict


def cover_crop(img, w: int, h: int):
    from PIL import ImageOps

    return ImageOps.fit(img, (w, h), centering=(0.5, 0.45))


def silent(seconds: float) -> list[str]:
    return ["-f", "lavfi", "-t", f"{seconds:.2f}", "-i", "anullsrc=r=44100:cl=stereo"]


def zoom_clip(src: Path, dst: Path, seconds: float, label: str | None = None) -> None:
    """A slow push-in on one still photo (Ken Burns), 1080x1920, with a silent track."""
    frames = int(seconds * 30)
    vf = (
        f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},"
        f"zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps=30"
    )
    if label and Path(FONT).exists():
        vf += f",drawtext=fontfile={FONT}:text='{label}':fontsize=72:fontcolor=white:borderw=4:bordercolor=black@0.6:x=(w-text_w)/2:y=h*0.08"
    vf += ",format=yuv420p"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(src), *silent(seconds), "-vf", vf, "-t", f"{seconds:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(dst)])


# ---------------------------------------------------------------- realistic motion (Hugging Face)
# Model: Wan 2.2 image-to-video (Wan-AI/Wan2.2-I2V-A14B), served free on Hugging Face's own ZeroGPU
# Space below. Licence check, 22 Oct 2026: the Wan2.2 weights are Apache-2.0
# (huggingface.co/api/models/Wan-AI/Wan2.2-I2V-A14B → cardData.license "apache-2.0"), which allows
# commercial use, and the Wan licence claims no rights over the videos it makes. LTX-Video was not
# chosen: its weights are under Lightricks' own "LTXV Open Weights" licence (license: other), which
# limits commercial use. The Space is called with the studio's free token (its ZeroGPU quota); $0.
# Only the CHECKED photo (faces and house numbers already blurred) is sent. Every clip is labelled
# "Made with AI" (shared/photoPosts.ts AI_MADE.reel) and still passes the studio's content rules.
HF_SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster"
HF_API = "/generate_video"
HF_ATTEMPTS = 2            # bounded: then the slow zoom
HF_TIMEOUT_S = 240         # per attempt (queue + render); a busy Space falls back instead of waiting
HF_WAIT_S = 20             # between attempts
# Never the word "camera" in the prompt: 22 Oct 2026 the model drew a person holding a video camera
# into the room when asked for a "camera push-in". The view moves; nothing is added.
MOTION_PROMPT = (
    "the view drifts slowly closer, gentle parallax, soft natural light, candle flames flicker softly, "
    "an empty still room, everything stays exactly as photographed"
)
MOTION_NEGATIVE = (
    "person, people, man, woman, hands, arms, face, photographer, camera, tripod, phone, new objects, "
    "text, letters changing, morphing, distortion, blurry, low quality, watermark"
)


def _hf_call(src: Path, token: str) -> str:
    """One Space call; returns the local path of the video it made. Raises on any failure."""
    from gradio_client import Client, handle_file  # type: ignore

    client = Client(HF_SPACE, token=token, verbose=False)  # gradio_client 2.x (pinned in job-photopack.yml)
    out = client.predict(
        input_image=handle_file(str(src)),
        prompt=MOTION_PROMPT,
        negative_prompt=MOTION_NEGATIVE,
        steps=6,
        duration_seconds=3.5,
        randomize_seed=True,
        api_name=HF_API,
    )
    video = out[0] if isinstance(out, (list, tuple)) else out
    if isinstance(video, dict):
        video = video.get("video") or video.get("path")
    if not video or not Path(str(video)).exists():
        raise RuntimeError("the model returned no video")
    return str(video)


DRIFT_MAX = 0.16          # mean difference (0..1) a frame may drift from the photo before the clip is refused


def _frames(video: Path, n: int = 4) -> list:
    """n frames spread over the clip (after the first), as PIL images."""
    from PIL import Image

    dur = probe_duration(video) or 3.0
    out = []
    with tempfile.TemporaryDirectory() as d:
        for i in range(1, n + 1):
            f = Path(d) / f"f{i}.png"
            sh(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{dur * i / (n + 1):.2f}", "-i", str(video), "-frames:v", "1", str(f)], timeout=60)
            out.append(Image.open(f).convert("RGB").copy())
    return out


def _drift(a, b) -> float:
    """Mean absolute difference of two images, small and grey, 0..1."""
    from PIL import ImageChops, ImageStat

    size = (48, 85)
    ga, gb = cover_crop(a, *size).convert("L"), cover_crop(b, *size).convert("L")
    return ImageStat.Stat(ImageChops.difference(ga, gb)).mean[0] / 255.0


def clip_is_faithful(src: Path, video: Path) -> bool:
    """The made clip must still be THIS photo: every sampled frame stays close to it. A model that
    replaces the scene is refused (the slow zoom is used instead)."""
    photo = open_photo(src)
    return all(_drift(photo, fr) <= DRIFT_MAX for fr in _frames(video))


def clip_privacy_boxes(video: Path) -> list[tuple[int, int, int, int]]:
    """Every face and readable number the photo check finds in frames spread over the clip (in the
    clip's own pixels). The clip moves slowly, so each box is padded and held for the whole clip."""
    boxes: list[tuple[int, int, int, int]] = []
    for fr in _frames(video, 5):
        boxes += find_faces(fr) + find_numbers(fr)
    return boxes


def blur_regions(video: Path, boxes: list[tuple[int, int, int, int]], dst: Path) -> None:
    """The clip with each box blurred hard for its whole length (the photo check, applied to motion)."""
    chain, last = "", "[0:v]"
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        pw, ph = int((x1 - x0) * 0.35) + 12, int((y1 - y0) * 0.35) + 12
        x, y = max(0, x0 - pw), max(0, y0 - ph)
        w, h = min(W - x, x1 - x0 + 2 * pw), min(H - y, y1 - y0 + 2 * ph)
        w, h = max(2, w - w % 2), max(2, h - h % 2)
        chain += f"[0:v]crop={w}:{h}:{x}:{y},boxblur=24:3[b{i}];{last}[b{i}]overlay={x}:{y}[o{i}];"
        last = f"[o{i}]"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-filter_complex", chain.rstrip(";"), "-map", last, "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(dst)])


def _run_with_timeout(fn, timeout: float):
    import concurrent.futures as cf

    ex = cf.ThreadPoolExecutor(max_workers=1)
    try:
        return ex.submit(fn).result(timeout=timeout)
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


def realistic_clip(src: Path, dst: Path, seconds: float, token: str | None, call=None, attempts: int = HF_ATTEMPTS, wait_s: float = HF_WAIT_S, strict: bool = True) -> bool:
    """A realistic camera-move clip of one photo at 1080x1920 with a silent track, or False.

    No token: returns False before anything is imported or called. Any failure (busy, rate
    limit, timeout, bad output) is retried at most `attempts` times, then False: the caller uses
    the slow zoom. A clip that no longer looks like the photo is refused the same way; faces and
    numbers in the clip are blurred like the photo's. Logs carry counts and the error class only."""
    import time

    if not token:
        return False
    call = call or (lambda: _hf_call(src, token))
    for attempt in range(1, attempts + 1):
        try:
            made = _run_with_timeout(call, HF_TIMEOUT_S)
            if not clip_is_faithful(src, Path(made)):
                raise ValueError("drift")
            vf = (
                f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30,"
                f"tpad=stop_mode=clone:stop_duration={seconds:.2f},format=yuv420p"
            )
            raw = dst.with_name(dst.stem + "-raw.mp4")
            sh(["ffmpeg", "-y", "-loglevel", "error", "-i", str(made), *silent(seconds), "-map", "0:v", "-map", "1:a", "-vf", vf, "-t", f"{seconds:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", str(raw)])
            # The photo check again, on the moving clip: anything face- or number-like the model made
            # visible is blurred for the whole clip. With the studio's face/address rules on, a check
            # that cannot run refuses the clip (the slow zoom of the checked photo is used).
            try:
                boxes = clip_privacy_boxes(raw)
            except Exception:  # noqa: BLE001
                if strict:
                    raise
                boxes = []
            if boxes:
                blur_regions(raw, boxes, dst)
            else:
                raw.replace(dst)
            log("photopack.motion", engine="hf-wan2.2", attempt=attempt, ok=True, blurred=len(boxes))
            return True
        except Exception as e:  # noqa: BLE001 - every failure falls back to the slow zoom
            log("photopack.motion", engine="hf-wan2.2", attempt=attempt, ok=False, error=type(e).__name__)
            if attempt < attempts:
                time.sleep(wait_s)
    return False


def concat(parts: list[Path], dst: Path, fade: float = 0.8) -> None:
    """Join clips with a short soft wipe between each."""
    if len(parts) == 1:
        parts[0].replace(dst)
        return
    inputs: list[str] = []
    for p in parts:
        inputs += ["-i", str(p)]
    durs = [probe_duration(p) for p in parts]
    v_chain, a_chain = "", ""
    last_v, last_a, offset = "[0:v]", "[0:a]", 0.0
    for i in range(1, len(parts)):
        offset += durs[i - 1] - fade
        v_chain += f"{last_v}[{i}:v]xfade=transition=wipeleft:duration={fade}:offset={offset:.2f}[v{i}];"
        a_chain += f"{last_a}[{i}:a]acrossfade=d={fade}[a{i}];"
        last_v, last_a = f"[v{i}]", f"[a{i}]"
    sh(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", (v_chain + a_chain).rstrip(";"), "-map", last_v, "-map", last_a, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(dst)])


def probe_duration(p: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)], capture_output=True, text=True)
    return float(out.stdout.strip() or 0)


def make_pack(photos: list[tuple[Path, str]], work: Path, strict: bool, before_after: bool, hf_token: str | None = None) -> dict[str, Any]:
    """photos: (local file, role). Returns local files by piece and the photo check."""
    checked: list[tuple[Path, str]] = []
    faces = numbers = 0
    blocked = False
    for i, (src, role) in enumerate(photos):
        img = open_photo(src)
        img, f, n, ok = check_photo(img, strict)
        faces += f
        numbers += n
        if not ok:
            blocked = True
        out = work / f"checked-{i}.jpg"
        img.save(out, "JPEG", quality=92)
        checked.append((out, role))
    status = "blocked" if blocked else ("fixed" if faces or numbers else "clean")
    log("photopack.checked", photos=len(checked), faces=faces, numbers=numbers, status=status)

    carousel: list[Path] = []
    for i, (p, _role) in enumerate(checked):
        out = work / f"photo-{i + 1}.jpg"
        cover_crop(open_photo(p), CW, CH).save(out, "JPEG", quality=88)
        carousel.append(out)

    mains = [p for p, r in checked if r == "main"] or [p for p, _ in checked]
    reel_parts = []
    each = REEL_S if len(mains) == 1 else max(3.0, REEL_S / min(3, len(mains)) + 0.8)
    motion = "slow-zoom"
    for i, p in enumerate(mains[:3]):
        part = work / f"reel-{i}.mp4"
        # The first photo moves realistically when a token is set; the slow zoom otherwise (and on any failure).
        if i == 0 and realistic_clip(p, part, each, hf_token, strict=strict):
            motion = "realistic"
        else:
            zoom_clip(p, part, each)
        reel_parts.append(part)
    reel = work / "reel.mp4"
    concat(reel_parts, reel)
    reel_cover = work / "reel.jpg"
    cover_crop(open_photo(mains[0]), W, H).save(reel_cover, "JPEG", quality=88)
    log("photopack.reel", parts=len(reel_parts), motion=motion)

    out: dict[str, Any] = {"motion": motion, "status": status, "faces": faces, "numbers": numbers, "carousel": carousel, "reel": reel, "reel_cover": reel_cover}
    if before_after:
        before = next(p for p, r in checked if r == "before")
        after = next(p for p, r in checked if r == "after")
        b, a = work / "ba-before.mp4", work / "ba-after.mp4"
        zoom_clip(before, b, 3.5, "Before")
        zoom_clip(after, a, 4.5, "After")
        ba = work / "before-after.mp4"
        concat([b, a], ba, fade=1.0)
        ba_cover = work / "before-after.jpg"
        cover_crop(open_photo(after), W, H).save(ba_cover, "JPEG", quality=88)
        out["before_after"], out["before_after_cover"] = ba, ba_cover
        log("photopack.before_after")
    return out


def main(job, spec: dict[str, Any]) -> dict[str, Any]:
    from common import WORK, download_input

    work = Path(WORK) / "photopack"
    work.mkdir(parents=True, exist_ok=True)
    photos: list[tuple[Path, str]] = []
    for i, p in enumerate(spec["photos"]):
        dest = work / f"in-{i}"
        download_input(p["key"], dest)
        photos.append((dest, p.get("role") or "main"))
    job.progress("Checking your photos", 1, 4)
    hf_token = (spec.get("motion") or {}).get("hf_token") or None
    made = make_pack(photos, work, bool(spec.get("strict")), bool(spec.get("before_after")), hf_token)
    if made["status"] == "blocked":
        # Nothing is uploaded for a pack that could not be checked: it never posts.
        return {"privacy": {"status": "blocked", "faces": made["faces"], "numbers": made["numbers"]}, "items": [{"kind": "carousel", "key": None, "cover_key": None, "images": []}]}
    out = spec["out"]
    job.progress("Saving your posts", 3, 4)
    for i, f in enumerate(made["carousel"]):
        job.upload_output(f, out["carousel"][i], "image/jpeg")
    job.upload_output(made["reel"], out["reel"], "video/mp4")
    job.upload_output(made["reel_cover"], out["reel_cover"], "image/jpeg")
    items: list[dict[str, Any]] = [
        {"kind": "reel", "key": out["reel"], "cover_key": out["reel_cover"]},
        {"kind": "carousel", "key": None, "cover_key": None, "images": out["carousel"][: len(made["carousel"])]},
    ]
    if "before_after" in made:
        job.upload_output(made["before_after"], out["before_after"], "video/mp4")
        job.upload_output(made["before_after_cover"], out["before_after_cover"], "image/jpeg")
        items.append({"kind": "before_after", "key": out["before_after"], "cover_key": out["before_after_cover"]})
    return {"privacy": {"status": made["status"], "faces": made["faces"], "numbers": made["numbers"]}, "motion": made["motion"], "items": items}


def log(step: str, **fields: Any) -> None:
    try:
        from common import log as safe_log

        safe_log(step, **fields)
    except Exception:  # noqa: BLE001 - selftest without the Worker env
        sys.stderr.write(f"{step} {sorted(fields.items())}\n")


def selftest() -> int:
    """Made-up photos through the whole pipeline; a big house number must be found and blurred."""
    from PIL import Image, ImageDraw, ImageFont

    with tempfile.TemporaryDirectory() as d:
        work = Path(d)
        font = ImageFont.truetype(FONT, 260) if Path(FONT).exists() else ImageFont.load_default()
        before = Image.new("RGB", (1200, 1600), (200, 190, 170))
        ImageDraw.Draw(before).text((300, 600), "4821", fill=(10, 10, 10), font=font)
        after = Image.new("RGB", (1200, 1600), (120, 160, 110))
        ImageDraw.Draw(after).rectangle((200, 300, 1000, 1300), fill=(240, 220, 120))
        bp, ap = work / "before.png", work / "after.jpg"
        before.save(bp)
        after.save(ap, "JPEG")
        made = make_pack([(ap, "main"), (bp, "before"), (ap, "after")], work, True, True)
        problems = []
        if made["numbers"] < 1:
            problems.append("the house number was not found")
        if made["status"] != "fixed":
            problems.append(f"photo check said {made['status']}, expected fixed")
        for key in ("reel", "before_after"):
            if probe_duration(made[key]) < 3:
                problems.append(f"{key} is too short")
        if len(made["carousel"]) != 3:
            problems.append("carousel is not three photos")
        # The blurred number must no longer read as digits.
        again = find_numbers(open_photo(work / "checked-1.jpg"))
        if again:
            problems.append("the house number can still be read after blurring")
        for p in problems:
            sys.stdout.write(f"SELFTEST FAIL: {p}\n")
        sys.stdout.write("SELFTEST OK\n" if not problems else "SELFTEST FAILED\n")
        return 1 if problems else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    from common import run

    run(main)
