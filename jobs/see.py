"""SEE the footage (studio intelligence layer 2, owner's plan 22 Oct 2026): a shot sheet per video.

Root cause it fixes: the cutter picked moments and wrote text from the transcript only, so a test
pattern became "a finished result", background talk became captions and a bare BEFORE shot was shown
as the result. Now every uploaded video gets ONE picture grid (about one frame per 2 seconds, at most
MAX_CELLS) and ONE call to a free vision model on OpenRouter, which answers with a structured shot
sheet: what is in each shot, its subject, its state (before / in progress / after / n/a), who is in
it (someone talking to the camera, someone working, other people), privacy hazards (other people's
faces, house numbers, street signs, plates, written names), quality (sharp, bright, steady) and which
of the studio's services it shows. The services come from the locked Brand Profile (the Worker sends
them, shared/services.ts); no business words live in this file (tests/unit/niche-neutral.test.ts).

Backup when no free vision model answers: a local CPU zero-shot model (CLIP ViT-B/32, MIT) scores
each frame against labels built from those services and a neutral before/after pair. It runs only
where VISION_LOCAL=1 (the cut job and the weekly golden set). Never a silent guess: anything under
the confidence floor is "unsure", and with neither model the sheet says "unsure" everywhere.

Pure parsing and merging are unit-tested (jobs/tests/test_see_plan.py); the model is only reached
through common.openrouter_content (validator jobs-one-openrouter-client).
"""
from __future__ import annotations

import base64
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai as A  # noqa: E402  (the model ladder: OpenRouter free within budget, then the local model)
from common import log  # noqa: E402

FRAME_STEP = 2.0
MAX_CELLS = 30
CELL_W = 288
STATES = ("before", "in_progress", "after", "n/a", "unsure")
PEOPLE = ("none", "to_camera", "working", "others")
HAZARDS = ("face", "house_number", "street_sign", "plate", "written_name")
UNSURE = "unsure"
# Under this the model's answer for a shot is not trusted: the shot is "unsure" (never guessed).
CONFIDENCE_FLOOR = 0.5
# Free vision models, best first (checked 22 Oct 2026 on openrouter.ai/api/v1/models: free, image
# input). "openrouter/free" routes a picture to whichever free vision model is up. A 429 / error
# moves on to the next; VISION_MODELS (comma list) overrides for a run.
VISION_MODELS = ["nvidia/nemotron-3.5-super-vl:free", "openrouter/free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"]

# Calls made to the free models in this job, by kind (reported in the result's engine; the plan
# budgets 1,000 a day across every studio).
CALLS: dict[str, int] = {"vision": 0, "critic": 0, "text": 0, "failed": 0}
# Circuit breaker (23 Oct 2026 live run: the account's free quota was used up and 84 calls in one job
# all came back 429). Once a whole round of models answers 429, no more model calls this job: the
# shot sheet uses the local backup and the critic its rules, never a silent pass of either.
QUOTA_OUT = {"out": False}


@dataclass
class Shot:
    start: float
    end: float
    what: str = ""
    subject: str = ""
    state: str = UNSURE
    people: str = "none"
    privacy: list[str] = field(default_factory=list)
    sharp: bool = True
    bright: bool = True
    steady: bool = True
    service: str = UNSURE
    confidence: float = 0.0

    @property
    def length(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def quality(self) -> float:
        return (int(self.sharp) + int(self.bright) + int(self.steady)) / 3.0

    @property
    def sure(self) -> bool:
        return self.confidence >= CONFIDENCE_FLOOR


@dataclass
class ShotSheet:
    asset_id: str
    duration: float
    shots: list[Shot]
    source: str = "none"  # vision:<model> | local | none | cached

    def to_json(self) -> dict[str, Any]:
        return {"asset_id": self.asset_id, "duration": round(self.duration, 2), "source": self.source, "shots": [asdict(s) for s in self.shots]}

    @staticmethod
    def from_json(d: Any, asset_id: str, duration: float, services: list[str]) -> "ShotSheet | None":
        if not isinstance(d, dict) or not isinstance(d.get("shots"), list) or not d["shots"]:
            return None
        shots = [clean_shot(s, duration, services) for s in d["shots"] if isinstance(s, dict)]
        shots = [s for s in shots if s and s.length > 0]
        src = str(d.get("source") or "")
        # Keep where it came from ("vision:<model>", "local", "local_vlm:<model>"); older rows said "cached".
        return ShotSheet(asset_id, duration, shots, src if src and src != "none" else "cached") if shots else None

    def shot_at(self, t: float) -> Shot | None:
        return next((s for s in self.shots if s.start - 0.01 <= t < s.end + 0.01), None)

    def to_camera_windows(self) -> list[tuple[float, float]]:
        """Where someone talks to the camera: the only speech that may become captions."""
        return [(s.start, s.end) for s in self.shots if s.people == "to_camera"]


def unsure_sheet(asset_id: str, duration: float) -> ShotSheet:
    """Neither model answered: the whole video is one shot nobody is sure about."""
    return ShotSheet(asset_id, duration, [Shot(0.0, round(duration, 2))], "none")


# ---------------------------------------------------------------- frames + the picture grid

def frame_times(duration: float) -> tuple[float, int]:
    """(step, cells): one frame every FRAME_STEP seconds, at most MAX_CELLS (longer videos spread out)."""
    n = max(1, min(MAX_CELLS, math.ceil(max(duration, 0.1) / FRAME_STEP)))
    step = max(FRAME_STEP, duration / n) if duration > 0 else FRAME_STEP
    n = max(1, min(MAX_CELLS, math.ceil(duration / step))) if duration > 0 else 1
    return step, n


def grid_shape(n: int) -> tuple[int, int]:
    cols = 3 if n <= 6 else 4 if n <= 16 else 5
    return cols, math.ceil(n / cols)


def extract_frames(video: Path, duration: float, out_dir: Path, max_cells: int | None = None) -> tuple[list[Path], list[float]]:
    """One JPEG per sampled moment (the middle of each step), small enough for a grid."""
    out_dir.mkdir(parents=True, exist_ok=True)
    step, n = frame_times(duration)
    if max_cells:
        n = min(n, max_cells)
        step = max(0.5, duration / n) if duration > 0 else step
    paths, times = [], []
    for i in range(n):
        t = min(max(0.0, duration - 0.05), i * step + step / 2)
        p = out_dir / f"f_{len(paths):03d}.jpg"  # numbered without gaps: the grid reads them in order
        try:
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={CELL_W}:-2", "-q:v", "4", str(p)],
                capture_output=True, timeout=120, check=True,
            )
        except Exception:  # noqa: BLE001
            continue
        if p.exists() and p.stat().st_size > 0:
            paths.append(p)
            times.append(round(t, 2))
    return paths, times


def contact_sheet(frames: list[Path], out: Path) -> Path | None:
    """The frames as ONE picture (left to right, top to bottom), the only image the model sees."""
    if not frames:
        return None
    cols, rows = grid_shape(len(frames))
    pattern = frames[0].parent / "f_%03d.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", "1", "-start_number", frames[0].stem[2:], "-i", str(pattern), "-frames:v", "1",
             "-vf", f"scale={CELL_W}:-2,tile={cols}x{rows}:padding=6:margin=6:color=white", "-q:v", "4", str(out)],
            capture_output=True, timeout=180, check=True,
        )
    except Exception:  # noqa: BLE001
        return None
    return out if out.exists() and out.stat().st_size > 0 else None


def image_part(path: Path) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()}}


# ---------------------------------------------------------------- the vision model

def vision_models() -> list[str]:
    env = [m.strip() for m in os.environ.get("VISION_MODELS", "").split(",") if m.strip()]
    return env or list(VISION_MODELS)


def ask_vision(key: str | None, system: str, text: str, image: Path, kind: str, max_tokens: int = 3000, local: bool = True) -> tuple[dict[str, Any] | None, str]:
    """One picture + one question, down the model ladder (jobs/ai.py): a free OpenRouter vision
    model within the job's budget, else (local=True, VISION_LOCAL=1) the local open model on the
    runner. Returns (answer, "<provider>:<model>") or (None, "") when neither answered with JSON."""
    if not image or not image.exists():
        return None, ""
    if not key and not (local and os.environ.get("VISION_LOCAL") == "1"):
        return None, ""  # nobody to ask: not a call
    CALLS[kind] = CALLS.get(kind, 0) + 1

    def payload(model: str) -> dict[str, Any]:
        return {"model": model, "max_tokens": max_tokens, "messages": [{"role": "system", "content": system}, {"role": "user", "content": [{"type": "text", "text": text}, image_part(image)]}]}

    content, model = A.ask_openrouter(key, payload, vision_models(), kind)
    QUOTA_OUT["out"] = A.STATE["quota_out"]
    answer = A.first_json(content) if content else None
    if answer is not None:
        return answer, f"openrouter:{model}"
    if local:
        answer = A.first_json(A.ask_local_vlm(system, text, image, kind, max_tokens))
        if answer is not None:
            return answer, f"local_vlm:{A.LOCAL_VLM.split('/')[-1]}"
    CALLS["failed"] = CALLS.get("failed", 0) + 1
    return None, ""


SHEET_SYSTEM = (
    "You look at a grid of frames taken from ONE phone video, in time order (left to right, then top to bottom). "
    "Describe only what you can see. Group neighbouring frames that show the same thing into shots. "
    "For each shot answer: what (one plain sentence, max 18 words, no people's names, no addresses), subject (2-4 words), "
    "state: 'before' (empty, bare or unfinished, before the work), 'in_progress' (the work being done), 'after' (the finished result), "
    "'n/a' (a person talking to the camera, or nothing to finish), or 'unsure'; "
    "people: 'none', 'to_camera' (someone facing and talking to the camera), 'working' (someone doing the work, not addressing the camera), "
    "'others' (guests, customers, passers-by); privacy: any of 'face' (the face of someone other than a person working or talking to camera), "
    "'house_number', 'street_sign', 'plate', 'written_name'; quality: sharp, bright, steady (true/false); "
    "service: exactly one label from the services list, or 'unsure'; confidence 0..1 for service and state. "
    "Judge the state from the picture only. A test pattern, black frames or a screen recording is state 'unsure', service 'unsure'. "
    "Answer JSON only: {\"shots\":[{\"frames\":[first,last],\"what\":str,\"subject\":str,\"state\":str,\"people\":str,\"privacy\":[str],"
    "\"sharp\":bool,\"bright\":bool,\"steady\":bool,\"service\":str,\"confidence\":0..1}]}. Frames are numbered from 1."
)


def sheet_prompt(services: list[str], times: list[float], notes: str) -> str:
    return json.dumps(
        {
            "services": services,
            "frames": len(times),
            "frame_seconds": times,
            "owner_note_about_this_upload": (notes or "")[:400],
            "rule": "the note may help you pick the service; the state comes only from what you see",
        }
    )


def clean_shot(s: dict[str, Any], duration: float, services: list[str]) -> Shot | None:
    try:
        start = max(0.0, float(s.get("start", 0)))
        end = min(duration, float(s.get("end", duration)))
    except (TypeError, ValueError):
        return None
    if end <= start:
        return None
    return _shot_fields(Shot(round(start, 2), round(end, 2)), s, services)


def confidence_of(v: Any) -> float:
    """A number 0..1 from what a model wrote: 0.8, "0.8", "80%", or a word (small models say "high")."""
    if isinstance(v, (int, float)):
        return float(v) / 100 if v > 1 else float(v)
    t = str(v or "").strip().lower()
    words = {"very high": 0.95, "high": 0.85, "medium": 0.6, "moderate": 0.6, "low": 0.3, "very low": 0.1}
    if t in words:
        return words[t]
    try:
        return float(t.rstrip("%")) / (100 if t.endswith("%") or float(t.rstrip("%")) > 1 else 1)
    except ValueError:
        return 0.0


def _shot_fields(shot: Shot, s: dict[str, Any], services: list[str]) -> Shot:
    shot.what = re.sub(r"\s+", " ", str(s.get("what", "")))[:200].strip()
    shot.subject = re.sub(r"\s+", " ", str(s.get("subject", "")))[:60].strip()
    state = str(s.get("state", UNSURE)).strip().lower().replace("-", "_").replace(" ", "_")
    state = {"unfinished": "before", "finished": "after", "in progress": "in_progress", "na": "n/a", "n_a": "n/a"}.get(state, state)
    shot.state = state if state in STATES else UNSURE
    people = str(s.get("people", "none")).strip().lower()
    shot.people = people if people in PEOPLE else "others" if people else "none"
    shot.privacy = sorted({str(h).strip().lower() for h in (s.get("privacy") or []) if str(h).strip().lower() in HAZARDS})
    for q in ("sharp", "bright", "steady"):
        setattr(shot, q, s.get(q) is not False)
    svc = str(s.get("service", UNSURE)).strip()
    match = next((x for x in services if x.lower() == svc.lower()), None)
    if not match and svc.lower() not in ("", UNSURE):
        # A small model may echo a label loosely ("balloon garland" for "balloon garlands"): the
        # one service whose words it carries, never a guess between two.
        hits = [x for x in services if set(re.findall(r"[a-z]+", x.lower())) <= set(re.findall(r"[a-z]+", svc.lower() + "s")) or svc.lower().rstrip("s") in x.lower()]
        match = hits[0] if len(hits) == 1 else None
    conf = confidence_of(s.get("confidence", 0))
    shot.confidence = max(0.0, min(1.0, conf))
    shot.service = match if match and shot.sure else UNSURE
    if not shot.sure and shot.state in ("before", "after", "in_progress"):
        shot.state = UNSURE  # never guessed: a low-confidence state is "not sure"
    return shot


def parse_sheet(answer: Any, asset_id: str, duration: float, times: list[float], services: list[str], source: str) -> ShotSheet | None:
    """The model's grid answer → shots in seconds. Frames are 1-based cells of `times`."""
    if not isinstance(answer, dict) or not isinstance(answer.get("shots"), list) or not times:
        return None
    n = len(times)
    step = (times[1] - times[0]) if n > 1 else max(duration, 0.1)
    shots: list[Shot] = []
    for s in answer["shots"]:
        if not isinstance(s, dict):
            continue
        fr = s.get("frames") or [s.get("first"), s.get("last")]
        try:
            a, b = int(fr[0]), int(fr[-1])
        except (TypeError, ValueError, IndexError):
            continue
        a, b = max(1, min(n, a)), max(1, min(n, b))
        if b < a:
            a, b = b, a
        start = max(0.0, times[a - 1] - step / 2)
        end = min(duration, times[b - 1] + step / 2)
        if end - start <= 0.2:
            continue
        shots.append(_shot_fields(Shot(round(start, 2), round(end, 2)), s, services))
    if not shots:
        return None
    shots.sort(key=lambda x: x.start)
    # No gaps, no overlaps: each shot runs to the next one's start; the first from 0, the last to the end.
    shots[0].start = 0.0
    for prev, nxt in zip(shots, shots[1:]):
        nxt.start = max(nxt.start, prev.start + 0.2)
        prev.end = nxt.start
    shots[-1].end = round(duration, 2)
    shots = [s for s in shots if s.length > 0.2]
    return ShotSheet(asset_id, duration, shots, source) if shots else None


# ---------------------------------------------------------------- the local backup (CLIP, MIT)

_CLIP = None
LOCAL_MODEL = "openai/clip-vit-base-patch32"
# Neutral label pairs for the state; the services' own labels come from the Brand Profile.
STATE_LABELS = {
    "before": "a photo of an empty, bare, unfinished space before the work starts",
    "after": "a photo of a finished, styled, complete result after the work",
    "n/a": "a photo of a person talking to the camera",
}


def _local_classifier() -> Any:
    global _CLIP
    if _CLIP is not None:
        return _CLIP or None
    if os.environ.get("VISION_LOCAL") != "1":
        _CLIP = False
        return None
    pip = [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check"]
    try:
        __import__("transformers")
        __import__("torch")
    except Exception:  # noqa: BLE001
        try:
            subprocess.run([*pip, "torch", "--index-url", "https://download.pytorch.org/whl/cpu"], capture_output=True, timeout=900, check=True)
            subprocess.run([*pip, "transformers>=4.40,<5", "pillow"], capture_output=True, timeout=600, check=True)
        except Exception:  # noqa: BLE001
            log("see.local.install", ok=False)
            _CLIP = False
            return None
        # Installed while this process runs: the import system's directory caches must be refreshed, or
        # the new packages are not found (23 Oct 2026 live run: "see.local.ready ok false" after a good install).
        import importlib

        importlib.invalidate_caches()
    try:
        from transformers import pipeline  # type: ignore

        _CLIP = pipeline("zero-shot-image-classification", model=LOCAL_MODEL, device=-1)
        log("see.local.ready", ok=True)
    except Exception as e:  # noqa: BLE001
        log("see.local.ready", ok=False, error=type(e).__name__)
        _CLIP = False
    return _CLIP or None


def local_frame_labels(scores_svc: dict[str, float], scores_state: dict[str, float], services: list[str]) -> dict[str, Any]:
    """One frame's zero-shot scores → shot fields (pure; unit-tested). Under the floor = unsure."""
    svc, sconf = max(scores_svc.items(), key=lambda kv: kv[1]) if scores_svc else (UNSURE, 0.0)
    ranked = sorted(scores_svc.values(), reverse=True)
    margin = ranked[0] - ranked[1] if len(ranked) > 1 else ranked[0] if ranked else 0.0
    service = svc if svc in services and sconf >= CONFIDENCE_FLOOR and margin >= 0.15 else UNSURE
    st, stconf = max(scores_state.items(), key=lambda kv: kv[1]) if scores_state else (UNSURE, 0.0)
    state = st if stconf >= 0.55 else UNSURE
    return {
        "state": state,
        "people": "to_camera" if state == "n/a" else "none",
        "service": service,
        "confidence": round(min(sconf, stconf) if service != UNSURE else stconf * 0.6, 3),
        "what": "" if service == UNSURE else f"{service}",
        "subject": "" if service == UNSURE else service,
    }


def local_sheet(asset_id: str, duration: float, frames: list[Path], times: list[float], services: list[str]) -> ShotSheet | None:
    clf = _local_classifier()
    if clf is None or not frames:
        return None
    try:
        from PIL import Image  # type: ignore
    except Exception:  # noqa: BLE001
        return None
    svc_labels = {f"a photo of {s}": s for s in services}
    other = "a photo of something else"
    state_labels = {v: k for k, v in STATE_LABELS.items()}
    labels = []
    for p in frames:
        try:
            img = Image.open(p).convert("RGB")
            r1 = clf(img, candidate_labels=[*svc_labels, other])
            r2 = clf(img, candidate_labels=list(state_labels))
        except Exception:  # noqa: BLE001
            labels.append({"state": UNSURE, "people": "none", "service": UNSURE, "confidence": 0.0})
            continue
        s1 = {svc_labels.get(x["label"], UNSURE): float(x["score"]) for x in r1}
        s2 = {state_labels[x["label"]]: float(x["score"]) for x in r2}
        labels.append(local_frame_labels(s1, s2, services))
    return merge_frames(asset_id, duration, times, labels, "local")


def merge_frames(asset_id: str, duration: float, times: list[float], labels: list[dict[str, Any]], source: str) -> ShotSheet | None:
    """Per-frame labels → shots: neighbouring frames with the same service, state and people join."""
    if not labels or len(labels) != len(times):
        return None
    step = (times[1] - times[0]) if len(times) > 1 else max(duration, 0.1)
    shots: list[Shot] = []
    for t, lab in zip(times, labels):
        key = (lab.get("service"), lab.get("state"), lab.get("people"))
        if shots and (shots[-1].service, shots[-1].state, shots[-1].people) == key:
            shots[-1].end = round(min(duration, t + step / 2), 2)
            shots[-1].confidence = min(shots[-1].confidence, float(lab.get("confidence", 0)))
            continue
        sh = Shot(round(max(0.0, t - step / 2), 2), round(min(duration, t + step / 2), 2))
        sh.state, sh.people, sh.service = lab.get("state", UNSURE), lab.get("people", "none"), lab.get("service", UNSURE)
        sh.confidence = float(lab.get("confidence", 0))
        sh.what, sh.subject = lab.get("what", ""), lab.get("subject", "")
        shots.append(sh)
    shots[0].start = 0.0
    for prev, nxt in zip(shots, shots[1:]):
        prev.end = nxt.start
    shots[-1].end = round(duration, 2)
    return ShotSheet(asset_id, duration, shots, source)


# ---------------------------------------------------------------- one video's sheet

def see_video(key: str | None, video: Path, asset_id: str, duration: float, services: list[str], notes: str, work: Path, cached: Any = None) -> ShotSheet:
    """The shot sheet for one video: the saved one (a re-plan), else the free vision model on ONE
    grid, else the local model, else "unsure" everywhere. Never raises."""
    sheet = ShotSheet.from_json(cached, asset_id, duration, services) if cached else None
    if sheet:
        log("see.sheet", source="cached", shots=len(sheet.shots))
        return sheet
    fdir = work / f"see_{asset_id}"
    try:
        frames, times = extract_frames(video, duration, fdir)
        grid = contact_sheet(frames, work / f"see_{asset_id}.jpg")
        if grid:
            answer, model = ask_vision(key, SHEET_SYSTEM, sheet_prompt(services, times, notes), grid, "vision")
            sheet = parse_sheet(answer, asset_id, duration, times, services, f"vision:{model}") if answer else None
        if not sheet:
            sheet = local_sheet(asset_id, duration, frames, times, services)
    except Exception:  # noqa: BLE001
        sheet = None
    sheet = sheet or unsure_sheet(asset_id, duration)
    log("see.sheet", source=sheet.source.split(":")[0], shots=len(sheet.shots), sure=sum(1 for s in sheet.shots if s.sure))
    return sheet


# ---------------------------------------------------------------- several videos, one call (quota fix)

# One picture holds up to BATCH_VIDEOS videos, BATCH_CELLS frames each, every video under its own
# heading: 9 videos cost 3 calls instead of 9 (jobs/ai.py budgets the account's 50 a day).
BATCH_VIDEOS = 3
BATCH_CELLS = 12
LABEL_W = 240


def labelled_grid(groups: list[tuple[str, list[Path]]], out: Path, cols: int = 6) -> Path | None:
    """Each group under a heading ("VIDEO 1", "CLIP 2"), its frames in rows of `cols`, every cell
    numbered from 1 within its group. The only picture the model sees for a batch."""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore
    except Exception:  # noqa: BLE001
        return None
    cells: list[list[Any]] = []
    for _title, frames in groups:
        imgs = []
        for f in frames:
            try:
                im = Image.open(f).convert("RGB")
                im = im.resize((LABEL_W, max(1, int(im.height * LABEL_W / max(1, im.width)))))
                imgs.append(im)
            except Exception:  # noqa: BLE001
                continue
        cells.append(imgs)
    if not any(cells):
        return None
    ch = max(im.height for g in cells for im in g)
    head, pad = 44, 6
    width = cols * (LABEL_W + pad) + pad
    height = sum(head + math.ceil(len(g) / cols) * (ch + pad) for g in cells if g) + pad
    sheet = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 30)
        small = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
        small = font
    y = pad
    for (title, _f), g in zip(groups, cells):
        if not g:
            continue
        d.rectangle([0, y, width, y + head - 4], fill=(20, 20, 20))
        d.text((12, y + 4), title, fill=(255, 255, 255), font=font)
        y += head
        for i, im in enumerate(g):
            x = pad + (i % cols) * (LABEL_W + pad)
            yy = y + (i // cols) * (ch + pad)
            sheet.paste(im, (x, yy))
            d.rectangle([x, yy, x + 34, yy + 28], fill=(255, 230, 0))
            d.text((x + 4, yy + 2), str(i + 1), fill=(0, 0, 0), font=small)
        y += math.ceil(len(g) / cols) * (ch + pad)
    sheet.save(out, quality=82)
    return out if out.exists() else None


SHEET_BATCH_SYSTEM = SHEET_SYSTEM.replace(
    "You look at a grid of frames taken from ONE phone video, in time order (left to right, then top to bottom). ",
    "You look at frames from SEVERAL phone videos. Each video's frames sit under its own black heading (VIDEO 1, VIDEO 2, ...), "
    "in time order (left to right, then top to bottom); the yellow number on a frame is its number within that video. "
    "Never mix frames of different videos in one shot. ",
).replace(
    "Answer JSON only: {\"shots\":[",
    "Answer JSON only: {\"videos\":[{\"video\":int,\"shots\":[",
).replace("\"confidence\":0..1}]}. Frames are numbered from 1.", "\"confidence\":0..1}]}]}. Frames are numbered from 1 within each video.")


def batch_prompt(services: list[str], batch: list[dict[str, Any]], looks: dict[str, str] | None = None) -> str:
    return json.dumps(
        {
            "services": services,
            **({"what_each_service_looks_like": looks} if looks else {}),
            "videos": [{"video": i + 1, "frames": len(b["times"]), "frame_seconds": b["times"], "owner_note_about_this_upload": (b.get("notes") or "")[:300]} for i, b in enumerate(batch)],
            "rule": "notes and descriptions may help you pick the service; the state comes only from what you see",
        }
    )


def parse_batch(answer: Any, batch: list[dict[str, Any]], services: list[str], source: str) -> dict[str, ShotSheet]:
    """{"videos":[{"video":n,"shots":[...]}]} → a sheet per video that the answer covers."""
    out: dict[str, ShotSheet] = {}
    if not isinstance(answer, dict) or not isinstance(answer.get("videos"), list):
        return out
    for v in answer["videos"]:
        if not isinstance(v, dict):
            continue
        try:
            n = int(v.get("video"))
        except (TypeError, ValueError):
            continue
        if not 1 <= n <= len(batch):
            continue
        b = batch[n - 1]
        sh = parse_sheet({"shots": v.get("shots")}, b["asset_id"], b["duration"], b["times"], services, source)
        if sh:
            out[b["asset_id"]] = sh
    return out


def see_videos(key: str | None, items: list[dict[str, Any]], services: list[str], work: Path, cached: dict[str, Any] | None = None, looks: dict[str, str] | None = None) -> dict[str, ShotSheet]:
    """Shot sheets for a dump. items: {asset_id, video, duration, notes}. The saved sheet when there
    is one (never looked at again); else up to BATCH_VIDEOS videos per free-model call; a video the
    batch did not cover gets its own picture down the ladder (OpenRouter if budget is left, else the
    local open model), then the CLIP backup, then "unsure". Never raises."""
    cached = cached or {}
    out: dict[str, ShotSheet] = {}
    todo: list[dict[str, Any]] = []
    for it in items:
        sh = ShotSheet.from_json(cached.get(it["asset_id"]), it["asset_id"], it["duration"], services) if cached.get(it["asset_id"]) else None
        if sh:
            out[it["asset_id"]] = sh
            log("see.sheet", source="cached", shots=len(sh.shots))
            continue
        try:
            frames, times = extract_frames(it["video"], it["duration"], work / f"see_{it['asset_id']}", max_cells=BATCH_CELLS)
        except Exception:  # noqa: BLE001
            frames, times = [], []
        todo.append({**it, "frames": frames, "times": times})
    for i in range(0, len(todo), BATCH_VIDEOS):
        batch = [b for b in todo[i : i + BATCH_VIDEOS] if b["frames"]]
        if len(batch) < 2 or not key:
            continue
        grid = labelled_grid([(f"VIDEO {j + 1}", b["frames"]) for j, b in enumerate(batch)], work / f"see_batch_{i}.jpg")
        if not grid:
            continue
        answer, model = ask_vision(key, SHEET_BATCH_SYSTEM, batch_prompt(services, batch, looks), grid, "vision", max_tokens=4000, local=False)
        got = parse_batch(answer, batch, services, f"vision:{model}") if answer else {}
        out.update(got)
        log("see.batch", videos=len(batch), covered=len(got))
    for b in todo:
        if b["asset_id"] in out:
            log("see.sheet", source=out[b["asset_id"]].source.split(":")[0], shots=len(out[b["asset_id"]].shots), sure=sum(1 for s in out[b["asset_id"]].shots if s.sure))
            continue
        sheet = None
        try:
            if b["frames"]:
                grid = contact_sheet(b["frames"], work / f"see_{b['asset_id']}.jpg")
                if grid:
                    prompt = json.loads(sheet_prompt(services, b["times"], b.get("notes") or ""))
                    if looks:
                        prompt["what_each_service_looks_like"] = looks
                    answer, model = ask_vision(key, SHEET_SYSTEM, json.dumps(prompt), grid, "vision", local=False)
                    sheet = parse_sheet(answer, b["asset_id"], b["duration"], b["times"], services, f"vision:{model}") if answer else None
            if not sheet:
                sheet = local_vlm_sheet(b, services, looks, work)
            if not sheet:
                sheet = local_sheet(b["asset_id"], b["duration"], b["frames"], b["times"], services)
        except Exception:  # noqa: BLE001
            sheet = None
        sheet = sheet or unsure_sheet(b["asset_id"], b["duration"])
        out[b["asset_id"]] = sheet
        log("see.sheet", source=sheet.source.split(":")[0], shots=len(sheet.shots), sure=sum(1 for s in sheet.shots if s.sure))
    return out


def worth_saving(sheet: ShotSheet) -> bool:
    """Only a sheet a vision model made is saved for re-plans; the CLIP backup's guess is made again
    for free next time, so a later run with quota left can look properly."""
    return sheet.source.startswith("vision:") or sheet.source == "cached"


# ---------------------------------------------------------------- the local open model's sheet (quota fix)

# A small model on a CPU answers a short, flat question far more reliably than the shot grid
# (23 Oct 2026 golden run on the local model alone: 0.8 with the grid prompt). So each stretch of a
# video gets one flat answer: a video up to SEGMENT_S long is one stretch, a longer one up to 3.
SEGMENT_S = 20.0
LOCAL_CELLS = 6
LOCAL_SYSTEM = (
    "You see frames from one short phone video, in time order. Describe only what you can see. "
    "Answer JSON only, with exactly these keys: "
    "\"what\": one plain sentence, no names, no addresses; "
    "\"state\": one of \"before\" (empty, bare or not set up yet), \"in_progress\" (the work being done), "
    "\"after\" (the finished result), \"n/a\" (a person talking to the camera), \"unsure\"; "
    "\"people\": one of \"none\", \"to_camera\" (a person facing the camera and talking to it), \"working\", "
    "\"others\" (guests or passers-by); "
    "\"service\": exactly one item of the services list, or \"unsure\"; "
    "\"confidence\": a number from 0 to 1; "
    "\"privacy\": a list with any of \"face\" (a bystander's face), \"house_number\", \"street_sign\", \"plate\", \"written_name\"."
)


def segments(duration: float) -> list[tuple[float, float]]:
    n = 1 if duration <= SEGMENT_S else min(3, math.ceil(duration / SEGMENT_S))
    step = duration / n
    return [(round(i * step, 2), round(duration if i == n - 1 else (i + 1) * step, 2)) for i in range(n)]


def local_vlm_sheet(b: dict[str, Any], services: list[str], looks: dict[str, str] | None, work: Path) -> ShotSheet | None:
    """The local open model's sheet for one video: one flat answer per stretch (jobs/ai.py)."""
    if os.environ.get("VISION_LOCAL") != "1":
        return None
    shots: list[Shot] = []
    model = ""
    for j, (s0, s1) in enumerate(segments(b["duration"])):
        frames = [f for f, t in zip(b["frames"], b["times"]) if s0 - 0.01 <= t < s1 + 0.01] or b["frames"]
        frames = frames[:: max(1, math.ceil(len(frames) / LOCAL_CELLS))][:LOCAL_CELLS]
        seg_dir = work / f"local_{b['asset_id']}_{j}"
        seg_dir.mkdir(parents=True, exist_ok=True)
        for k, f in enumerate(frames):  # numbered without gaps for the grid
            (seg_dir / f"f_{k:03d}.jpg").write_bytes(f.read_bytes())
        grid = contact_sheet(sorted(seg_dir.glob("f_*.jpg")), work / f"local_{b['asset_id']}_{j}.jpg")
        if not grid:
            return None
        text = json.dumps({"services": services, **({"what_each_service_looks_like": looks} if looks else {}), "owner_note": (b.get("notes") or "")[:300]})
        answer = A.first_json(A.ask_local_vlm(LOCAL_SYSTEM, text, grid, "vision", 400))
        if answer is None:
            return None
        sh = _shot_fields(Shot(s0, s1), answer, services)
        # Enums and numbers only (never the words): how the local model read this stretch.
        log("see.local.answer", state=sh.state, people=sh.people, service=sh.service != UNSURE, confidence=round(sh.confidence, 2), raw_state=str(answer.get("state", ""))[:12] in STATES)
        shots.append(sh)
        model = A.LOCAL_VLM.split("/")[-1]
    if not shots:
        return None
    # Neighbouring stretches with the same reading join.
    merged: list[Shot] = []
    for sh in shots:
        if merged and (merged[-1].state, merged[-1].service, merged[-1].people) == (sh.state, sh.service, sh.people):
            merged[-1].end = sh.end
            merged[-1].confidence = min(merged[-1].confidence, sh.confidence)
            continue
        merged.append(sh)
    return ShotSheet(b["asset_id"], b["duration"], merged, f"vision:local_vlm:{model}")
