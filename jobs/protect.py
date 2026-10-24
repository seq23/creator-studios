"""PROTECT (studio intelligence layer 5, owner's plan 22 Oct 2026).

Four guards on every clip the cutter makes, from the studio's content rules (studios/<slug>.json
"contentRules", sent in the cut spec; shared/contentRules.ts is the same rule set for the Worker):

  1. Faces: with blockFaces, every face the finder sees is blurred, except the owner's own face
     when ownerFace is "show" (the Brand Profile allows it) and the shot sheet says the person on
     screen is the one working or talking to the camera with no bystander face in the shot.
  2. House numbers: with blockAddresses, every run of 3+ digits the number finder reads is blurred,
     and any digits at all in a shot the sheet flags with a house number, street sign or plate.
     (The planner already leaves out shots the sheet flags: this catches what it missed.)
  3. Words: never a word from the never-list, never a street address, never a price that is not
     on the studio's price list (or, with no price list, written in its Brand Profile). A line
     that breaks a rule is replaced by the neutral line; the Worker checks again on import.
  4. AI label: a clip carrying an AI voice over posts with "Made with AI" (worker/crons/buffer-sync.ts).

A strict studio (blockFaces or blockAddresses) whose finder cannot run fails CLOSED: the video's
clips are hidden with the privacy reason, never shown unchecked. No business words here.
"""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import log  # noqa: E402

SAMPLE_S = 1.0
HOLD_S = 0.7
MAX_REGIONS = 48
NUMBER_RUN = re.compile(r"\d{3,}")
ANY_DIGIT = re.compile(r"\d")
SIGN_HAZARDS = {"house_number", "street_sign", "plate"}

SUFFIX = (
    "st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cv|cove|pl|place|way|cir|circle|pkwy|parkway|"
    "ter|terrace|trl|trail|hwy|highway|pike|loop|row|sq|square|xing|crossing|cres|crescent|bend|run|path|alley"
)
STREET = re.compile(rf"\b\d{{1,6}}[a-z]?\s+(?:[nsew]\.?\s+)?(?:[a-z0-9'.-]+\s+){{0,4}}(?:{SUFFIX})\b\.?", re.I)
HOUSE_NUMBER = re.compile(r"\b(?:house|home|door|unit|apt|apartment)\s*(?:number|num|no\.?|#)?\s*#?\s*\d{1,6}\b", re.I)
AMOUNT = re.compile(r"\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b|\busd\s?(\d[\d,]*(?:\.\d{1,2})?)", re.I)


@dataclass
class Rules:
    ban_words: list[str]
    block_addresses: bool
    block_faces: bool
    prices: list[float]
    owner_face: str = "show"  # show | blur

    @property
    def strict(self) -> bool:
        return self.block_faces or self.block_addresses

    @property
    def any(self) -> bool:
        return bool(self.ban_words or self.block_addresses or self.block_faces or self.prices)


def rules_from(spec: dict[str, Any]) -> Rules:
    """The spec's content_rules (worker/jobs/cut.ts). Missing = no rules; malformed = every rule on."""
    raw = spec.get("content_rules")
    if raw is None:
        return Rules([], False, False, [])
    if not isinstance(raw, dict):
        return Rules(["insured"], True, True, [], "blur")
    prices = []
    for p in raw.get("prices") or []:
        try:
            if isinstance(p, dict) and float(p.get("usd")) > 0:
                prices.append(float(p["usd"]))
        except (TypeError, ValueError):
            continue
    return Rules(
        [str(w).strip().lower() for w in raw.get("banWords") or [] if str(w).strip()],
        raw.get("blockAddresses") is True,
        raw.get("blockFaces") is True,
        prices,
        "blur" if raw.get("ownerFace") == "blur" else "show",
    )


def _amounts(text: str) -> list[float]:
    out = []
    for m in AMOUNT.finditer(text or ""):
        v = (m.group(1) or m.group(2) or m.group(3) or "").replace(",", "")
        try:
            out.append(round(float(v), 2))
        except ValueError:
            continue
    return out


def text_problems(text: str, rules: Rules, profile_text: str = "") -> list[str]:
    """Codes for every rule a line breaks (empty = fine): ban_word, address, price. Pure; the same
    rules as shared/contentRules.ts textProblems, plus: with no price list, a price must be one the
    Brand Profile itself writes (the studio never makes a price up)."""
    t = str(text or "")
    out: list[str] = []
    low = t.lower()
    if any(w in low for w in rules.ban_words):
        out.append("ban_word")
    if rules.block_addresses and (STREET.search(t) or HOUSE_NUMBER.search(t)):
        out.append("address")
    amounts = _amounts(t)
    if amounts:
        if rules.prices:
            bad = any(a not in {round(p, 2) for p in rules.prices} for a in amounts)
        elif rules.any:
            bad = True  # a studio with rules and no price list names no price at all
        else:
            bad = any(a not in set(_amounts(profile_text)) for a in amounts)
        if bad:
            out.append("price")
    return out


def guard(rules: Rules, profile: dict[str, str] | None):
    """A text check for the planner (plan.apply_copy guard=): True = the line may be used."""
    ptext = " ".join(str(v) for v in (profile or {}).values())
    return lambda text: not text_problems(text, rules, ptext)


def copy_rules(rules: Rules) -> dict[str, Any]:
    """What the copy model is told (it is checked anyway)."""
    out: dict[str, Any] = {}
    if rules.ban_words:
        out["never_write_these_words"] = rules.ban_words
    if rules.prices:
        out["prices_you_may_name_usd"] = rules.prices
    elif rules.any:
        out["prices"] = "do not name any price"
    if rules.block_addresses:
        out["addresses"] = "never write a street, a house number or where a customer lives"
    return out


# ---------------------------------------------------------------- the picture: faces and numbers

def _frame(video: Path, t: float, out: Path) -> Any:
    from PIL import Image  # type: ignore

    # 8-bit RGB explicitly: a static ffmpeg build may write a 16-bit PNG, which reads back washed out.
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-pix_fmt", "rgb24", str(out)], capture_output=True, timeout=120, check=True)
    return Image.open(out).convert("RGB")


def _finders() -> Any:
    """photopack's face finder (OpenCV Haar) and a number finder that keeps the text (tesseract).
    Installs OpenCV if missing."""
    try:
        __import__("cv2")
    except Exception:  # noqa: BLE001
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "opencv-python-headless>=4.8,<5", "numpy"], capture_output=True, timeout=600)
        import importlib

        importlib.invalidate_caches()
    import photopack as PK  # noqa: E402

    return PK.find_faces, numbers_with_text


def owner_only(shot: Any, rules: Rules) -> bool:
    """The only person in this shot is the owner (working or talking to the camera), and the
    Brand Profile lets her face show."""
    return bool(shot) and rules.owner_face == "show" and shot.people in ("to_camera", "working") and "face" not in (shot.privacy or [])


def privacy_regions(video: Path, duration: float, rules: Rules, sheet: Any, work: Path, finders: Any = None) -> tuple[list[tuple[float, float, tuple[int, int, int, int]]], bool]:
    """([(t0, t1, box)], ok): what to blur and when. ok=False when a finder could not run."""
    if not rules.strict:
        return [], True
    try:
        find_faces, find_numbers = finders or _finders()
    except Exception as e:  # noqa: BLE001
        log("protect.finder", ok=False, which="load", error=type(e).__name__, detail=str(e)[:160])
        return [], False
    out: list[tuple[float, float, tuple[int, int, int, int]]] = []
    ok = True
    failed: set[str] = set()
    seen = {"faces": 0, "numbers": 0, "digit_words": 0, "longest_run": 0}
    work.mkdir(parents=True, exist_ok=True)
    t = SAMPLE_S / 2
    i = 0
    while t < duration:
        shot = sheet.shot_at(t) if sheet is not None and getattr(sheet, "source", "none") != "none" else None
        try:
            img = _frame(video, t, work / f"p_{i:04d}.png")
        except Exception as e:  # noqa: BLE001
            if "frame" not in failed:
                log("protect.finder", ok=False, which="frame", error=type(e).__name__, detail=str(e)[:160])
            failed.add("frame")
            ok = False
            t += SAMPLE_S
            i += 1
            continue
        boxes: list[tuple[int, int, int, int]] = []
        if rules.block_faces and not owner_only(shot, rules) and not (shot is not None and shot.people == "none" and "face" not in shot.privacy):
            try:
                got = find_faces(img)
                seen["faces"] += len(got)
                boxes += got
            except Exception as e:  # noqa: BLE001
                if "faces" not in failed:
                    log("protect.finder", ok=False, which="faces", error=type(e).__name__, detail=str(e)[:160])
                failed.add("faces")
                ok = False
        if rules.block_addresses:
            try:
                flagged = shot is not None and bool(SIGN_HAZARDS & set(shot.privacy or []))
                for box, txt in find_numbers(img):
                    seen["digit_words"] += 1
                    seen["longest_run"] = max(seen["longest_run"], max((len(m) for m in re.findall(r"\d+", txt)), default=0))
                    if NUMBER_RUN.search(txt) or (flagged and ANY_DIGIT.search(txt)):
                        seen["numbers"] += 1
                        boxes.append(box)
            except Exception as e:  # noqa: BLE001
                if "numbers" not in failed:
                    log("protect.finder", ok=False, which="numbers", error=type(e).__name__, detail=str(e)[:160])
                failed.add("numbers")
                ok = False
        for b in boxes:
            out.append((round(max(0.0, t - HOLD_S), 2), round(min(duration, t + HOLD_S), 2), b))
        t += SAMPLE_S
        i += 1
    log("protect.regions", frames=i, found=len(out), faces=seen["faces"], numbers=seen["numbers"], digit_words=seen["digit_words"], longest_run=seen["longest_run"], ok=ok)
    return merge_regions(out), ok


def numbers_with_text(img: Any) -> list[tuple[tuple[int, int, int, int], str]]:
    """Every word tesseract reads that holds a digit, with its box and its text."""
    import tempfile

    out: list[tuple[tuple[int, int, int, int], str]] = []
    with tempfile.TemporaryDirectory() as d:
        for scale in (1.0, 0.5, 0.25):  # 0.25: big bold numerals (a door number filling the frame) read only when small, 23 Oct 2026
            src = img if scale == 1.0 else img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
            p = Path(d) / f"ocr-{scale}.png"
            src.convert("L").save(p)
            res = subprocess.run(["tesseract", str(p), "stdout", "--psm", "11", "tsv"], capture_output=True, text=True, timeout=180)
            if res.returncode != 0:
                raise RuntimeError("number finder did not run")
            for line in res.stdout.splitlines()[1:]:
                f = line.split("\t")
                if len(f) < 12 or not ANY_DIGIT.search(f[11] or ""):
                    continue
                try:
                    conf = float(f[10])
                except ValueError:
                    continue
                if conf < 30:
                    continue
                x, y, w, h = (int(int(v) / scale) for v in f[6:10])
                out.append(((x, y, x + w, y + h), f[11]))
    return join_digit_runs(out)


def join_digit_runs(words: list[tuple[tuple[int, int, int, int], str]]) -> list[tuple[tuple[int, int, int, int], str]]:
    """Digits read one by one (tesseract on large or spaced numerals, 23 Oct 2026 runner: "4521" came
    back as four words) are joined into one run when they sit on one line, side by side. The joined
    runs are added; the single words stay."""
    digits = sorted((w for w in words if ANY_DIGIT.search(w[1])), key=lambda w: (w[0][0]))
    used: set[int] = set()
    joined: list[tuple[tuple[int, int, int, int], str]] = []
    for i, (b, t) in enumerate(digits):
        if i in used:
            continue
        box, text = b, t
        for j in range(i + 1, len(digits)):
            if j in used:
                continue
            nb, nt = digits[j]
            h = max(1, min(box[3] - box[1], nb[3] - nb[1]))
            same_line = min(box[3], nb[3]) - max(box[1], nb[1]) >= 0.5 * h
            close = 0 <= nb[0] - box[2] <= 0.8 * h
            if same_line and close:
                box = (box[0], min(box[1], nb[1]), nb[2], max(box[3], nb[3]))
                text += nt
                used.add(j)
        if text != t:
            joined.append((box, text))
    return words + joined


def merge_regions(regions: list[tuple[float, float, tuple[int, int, int, int]]]) -> list[tuple[float, float, tuple[int, int, int, int]]]:
    """Overlapping boxes in overlapping time join (one overlay each), at most MAX_REGIONS: beyond
    that, the boxes of each time stretch become one box (coarser, never fewer things blurred)."""
    regions = sorted(regions)
    out: list[list[Any]] = []
    for t0, t1, b in regions:
        for r in out:
            if t0 <= r[1] and t1 >= r[0] and b[0] <= r[2][2] and b[2] >= r[2][0] and b[1] <= r[2][3] and b[3] >= r[2][1]:
                r[0], r[1] = min(r[0], t0), max(r[1], t1)
                r[2] = (min(r[2][0], b[0]), min(r[2][1], b[1]), max(r[2][2], b[2]), max(r[2][3], b[3]))
                break
        else:
            out.append([t0, t1, b])
    while len(out) > MAX_REGIONS:
        out.sort(key=lambda r: r[0])
        a, b2 = out[0], out[1]
        out[:2] = [[min(a[0], b2[0]), max(a[1], b2[1]), (min(a[2][0], b2[2][0]), min(a[2][1], b2[2][1]), max(a[2][2], b2[2][2]), max(a[2][3], b2[2][3]))]]
    return [(r[0], r[1], r[2]) for r in out]


MIN_BOX = 48
BLUR_RADIUS = 24


def blur_box(box: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    """(x, y, w, h) of the blurred patch: the box padded 35 % + 12 px, at least MIN_BOX a side, even
    sizes, never outside the frame."""
    x0, y0, x1, y1 = box
    pw, ph = int((x1 - x0) * 0.35) + 12, int((y1 - y0) * 0.35) + 12

    def span(lo: int, hi: int, pad: int, size: int) -> tuple[int, int]:
        lo, hi = lo - pad, hi + pad
        if hi - lo < MIN_BOX:
            mid = (lo + hi) // 2
            lo, hi = mid - MIN_BOX // 2, mid + MIN_BOX // 2
        if lo < 0:  # slide inside the frame, never shrink against its edge
            lo, hi = 0, hi - lo
        if hi > size:
            lo, hi = max(0, lo - (hi - size)), size
        n = hi - lo
        n = max(2, n - n % 2)
        return lo, n

    x, w = span(x0, x1, pw, width)
    y, h = span(y0, y1, ph, height)
    return x, y, w, h


def blur_radii(w: int, h: int) -> tuple[int, int]:
    """(luma, chroma) boxblur radius for a w x h yuv420p patch. ffmpeg refuses a radius that is not
    under half the plane's short side (chroma planes are half size), and a refused filter fails the
    whole pass, which hides every clip of the video (23 Oct 2026: 7 of 45 videos of one dump, every
    one a small house-number box, each with "radius value 24, must be >= 0 and < 16")."""
    luma = max(0, min(BLUR_RADIUS, (min(w, h) - 1) // 2))
    chroma = max(0, min(BLUR_RADIUS, (min(w // 2, h // 2) - 1) // 2))
    return luma, chroma


def blur_filter(regions: list[tuple[float, float, tuple[int, int, int, int]]], width: int, height: int) -> tuple[str, str]:
    """The ffmpeg filter graph: each box blurred hard only while it is on screen. The source is
    split once per use (a filter pad is read once)."""
    n = len(regions)
    chain = f"[0:v]split={n + 1}[base]" + "".join(f"[s{i}]" for i in range(n)) + ";"
    last = "[base]"
    for i, (t0, t1, box) in enumerate(regions):
        x, y, w, h = blur_box(box, width, height)
        lr, cr = blur_radii(w, h)
        chain += f"[s{i}]crop={w}:{h}:{x}:{y},boxblur=luma_radius={lr}:luma_power=3:chroma_radius={cr}:chroma_power=3[b{i}];{last}[b{i}]overlay={x}:{y}:enable='between(t,{t0:.2f},{t1:.2f})'[o{i}];"
        last = f"[o{i}]"
    return chain.rstrip(";"), last


def ffmpeg_error(stderr: str) -> str:
    """ffmpeg's cause, not its last line ("Nothing was written..." hid "radius value 24" on 23 Oct 2026)."""
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    for ln in lines:
        if any(k in ln for k in ("Invalid", "Error", "error", "Failed", "failed")) and "Nothing was written" not in ln:
            return ln
    return lines[-1] if lines else "ffmpeg failed"


BLUR_PASS = 6


def blur_video(video: Path, regions: list[tuple[float, float, tuple[int, int, int, int]]], width: int, height: int, dst: Path) -> Path:
    """Every region blurred while on screen, at most BLUR_PASS overlays per ffmpeg pass (one pass with
    dozens of overlays failed on the live runner, 23 Oct 2026). Raises with ffmpeg's last line."""
    if not regions:
        return video
    src = video
    for i in range(0, len(regions), BLUR_PASS):
        chain, last = blur_filter(regions[i : i + BLUR_PASS], width, height)
        out = dst.with_name(f"{dst.stem}_{i // BLUR_PASS}{dst.suffix}")
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src), "-filter_complex", chain, "-map", last, "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "copy", str(out)], capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            raise RuntimeError(ffmpeg_error(r.stderr))
        src = out
    return src


def protect_video(video: Path, info: dict[str, Any], rules: Rules, sheet: Any, work: Path, tag: str, face_finder: Any = None) -> tuple[Path, bool, int]:
    """(video to cut from, ok, boxes blurred). ok=False on a strict studio = its clips are hidden.
    face_finder: the cut's MediaPipe face detector (jobs/cut.py mp_faces) when it loaded; else the
    photo job's OpenCV finder (23 Oct 2026: MediaPipe's OpenCV build has no Haar files)."""
    if not rules.strict:
        return video, True, 0
    finders = None
    if face_finder is not None:
        finders = (face_finder, numbers_with_text)
    regions, ok = privacy_regions(video, float(info.get("duration") or 0), rules, sheet, work / f"protect_{tag}", finders)
    try:
        out = blur_video(video, regions, int(info.get("width") or 1080), int(info.get("height") or 1920), work / f"safe_{tag}.mp4")
    except Exception as e:  # noqa: BLE001
        log("protect.video", n=tag, ok=False, boxes=len(regions), error=type(e).__name__, detail=str(e)[:160])
        return video, False, 0
    log("protect.video", n=tag, ok=ok, boxes=len(regions))
    return out, ok, len(regions)
