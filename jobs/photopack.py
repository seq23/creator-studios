"""The photo maker: one set of photos becomes a pack of posts (worker/jobs/photopack.ts).

For each pack it:
  1. opens every photo (JPG, PNG or iPhone HEIC), turned the right way up,
  2. runs the photo check: faces (OpenCV's face finders) and house numbers / any run of digits
     (tesseract) are blurred hard; with the studio's face/address rules on ("strict"), a check that
     cannot run blocks the pack instead of passing it,
  3. writes the carousel: each checked photo at 1080x1350,
  4. writes the slow-zoom reel (1080x1920, real photos moved slowly, never AI-generated pixels),
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


def make_pack(photos: list[tuple[Path, str]], work: Path, strict: bool, before_after: bool) -> dict[str, Any]:
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
    for i, p in enumerate(mains[:3]):
        part = work / f"reel-{i}.mp4"
        zoom_clip(p, part, each)
        reel_parts.append(part)
    reel = work / "reel.mp4"
    concat(reel_parts, reel)
    reel_cover = work / "reel.jpg"
    cover_crop(open_photo(mains[0]), W, H).save(reel_cover, "JPEG", quality=88)
    log("photopack.reel", parts=len(reel_parts))

    out: dict[str, Any] = {"status": status, "faces": faces, "numbers": numbers, "carousel": carousel, "reel": reel, "reel_cover": reel_cover}
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
    made = make_pack(photos, work, bool(spec.get("strict")), bool(spec.get("before_after")))
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
    return {"privacy": {"status": made["status"], "faces": made["faces"], "numbers": made["numbers"]}, "items": items}


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
