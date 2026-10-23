"""The weekly golden set (studio intelligence layer 9 seed, owner's plan 22 Oct 2026).

A few synthetic clips (made here, CC0: drawn shapes and plain sentences, no real footage) per fixture
business (tests/fixtures/businesses) go through the real shot sheet (jobs/see.py: the free vision model,
else the local backup) and the real planner (jobs/plan.py). Scored:
  * job type:      the service the planner detects is the business's expected one;
  * before/after:  a before -> after appears exactly when both states were filmed, starting on the
                   before and ending on the reveal;
  * caption noise: background chatter (nobody talking to the camera) gives no captions.
The score is compared with jobs/golden/baseline.json: a drop of more than ALLOWED_DROP on the total,
or any metric of a business going from pass to fail, exits 1 with the names (fails loudly).
Run: python3 jobs/golden.py [--write-baseline]   (needs OPENROUTER_API_KEY or VISION_LOCAL=1)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ai as A  # noqa: E402
import plan as P  # noqa: E402
import see as V  # noqa: E402
from common import log  # noqa: E402
from looks import Word  # noqa: E402

ROOT = HERE.parent
BASELINE = HERE / "golden" / "baseline.json"
ALLOWED_DROP = 0.15

# Each scene: (file, seconds, background, what the frame shows in words, shapes). The words are part
# of the drawing (a seed set; real CC0 footage joins it later), the shapes give the model a picture.
SCENES: dict[str, dict[str, Any]] = {
    "event-decor": {
        "expect": {"service": "balloon garlands", "transformation": True},
        "clips": [
            ("before", 6, (225, 222, 215), "An empty, bare doorway. Nothing set up yet.", "empty"),
            ("after", 8, (250, 236, 240), "Finished: a big balloon garland arch over the doorway.", "balloons"),
            ("chatter", 6, (200, 200, 205), "Guests chatting in the background. Nobody faces the camera.", "crowd"),
        ],
    },
    "hair-salon": {
        "expect": {"service": "silk press", "transformation": True},
        "clips": [
            ("before", 6, (230, 220, 210), "Before: frizzy, unstyled hair, back of the head.", "frizz"),
            ("after", 8, (240, 230, 225), "After: a sleek, glossy silk press, finished.", "sleek"),
        ],
    },
    "car-detailer": {
        "expect": {"service": "Ceramic coating", "transformation": False},
        "clips": [("after", 10, (30, 30, 40), "A car hood with a glossy ceramic coating, finished.", "gloss")],
    },
    "talking-head": {
        "expect": {"service": "Money tips", "transformation": False, "to_camera": True},
        "clips": [("talk", 10, (235, 240, 245), "A woman looks into the camera and talks about money tips.", "face")],
    },
}


def draw(dest: Path, seconds: int, bg: tuple[int, int, int], words: str, kind: str) -> None:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore

    img = Image.new("RGB", (720, 1280), bg)
    d = ImageDraw.Draw(img)
    if kind == "balloons":
        for i in range(40):
            x, y = 120 + (i * 53) % 480, 180 + ((i * 97) % 380)
            d.ellipse([x, y, x + 70, y + 84], fill=[(230, 80, 120), (250, 200, 80), (120, 170, 240), (255, 255, 255)][i % 4])
        d.rectangle([200, 560, 520, 1180], outline=(120, 90, 70), width=12)
    elif kind == "empty":
        d.rectangle([200, 560, 520, 1180], outline=(120, 90, 70), width=12)
    elif kind == "crowd":
        for i in range(6):
            x = 60 + i * 105
            d.ellipse([x, 700, x + 80, 780], fill=(160, 130, 110))
            d.rectangle([x - 10, 780, x + 90, 1100], fill=(90, 100, 130))
    elif kind == "frizz":
        for i in range(160):
            x, y = 200 + (i * 37) % 320, 300 + (i * 53) % 360
            d.line([x, y, x + (i % 13) - 6, y + 40], fill=(60, 40, 30), width=4)
    elif kind == "sleek":
        d.rounded_rectangle([210, 280, 510, 1000], radius=140, fill=(40, 25, 20))
    elif kind == "gloss":
        d.polygon([(60, 900), (660, 900), (600, 600), (120, 600)], fill=(20, 60, 140))
        d.line([(160, 640), (560, 640)], fill=(240, 240, 255), width=10)
    elif kind == "face":
        d.ellipse([220, 300, 500, 620], fill=(205, 160, 130))
        d.ellipse([290, 420, 320, 450], fill=(30, 30, 30))
        d.ellipse([400, 420, 430, 450], fill=(30, 30, 30))
        d.arc([300, 480, 420, 560], 0, 180, fill=(120, 40, 40), width=8)
        d.rectangle([180, 640, 540, 1180], fill=(70, 110, 90))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 40)
    except OSError:
        font = ImageFont.load_default(size=40)
    line, lines = "", []
    for w in words.split():
        if len(line) + len(w) > 26:
            lines.append(line)
            line = ""
        line = f"{line} {w}".strip()
    lines.append(line)
    for i, l in enumerate(lines):
        d.text((40, 60 + i * 52), l, fill=(15, 15, 15) if sum(bg) > 300 else (245, 245, 245), font=font)
    png = dest.with_suffix(".png")
    img.save(png)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", str(png), "-t", str(seconds), "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(dest)], check=True, capture_output=True)


def score_business(slug: str, fixture: dict[str, Any], key: str | None, work: Path) -> dict[str, Any]:
    spec = SCENES[slug]
    services = fixture["services"]
    items = []
    for name, secs, bg, words, kind in spec["clips"]:
        mp4 = work / f"{slug}_{name}.mp4"
        draw(mp4, secs, bg, words, kind)
        items.append({"asset_id": f"{slug}_{name}", "video": mp4, "duration": float(secs), "notes": ""})
    # The same path a dump takes: one batched call for the business's clips, the local model as backup.
    got = V.see_videos(key, items, services, work, {}, P.service_looks(fixture.get("profile"), services))
    sheets = [got[it["asset_id"]] for it in items]
    film = [s for s, c in zip(sheets, spec["clips"]) if c[0] != "chatter"]
    service, sure = P.dump_service(film, None, services)
    shape, _ = P.choose_shape(film, service, {s.asset_id: False for s in film})
    exp = spec["expect"]
    m: dict[str, bool] = {"job_type": bool(sure and service and service.lower() == exp["service"].lower())}
    plans = P.plan_clips(film, shape, service, 4) if shape != "talking" else []
    trans = [p for p in plans if p.shape == "transformation"]
    ok_ba = (shape == "transformation") == exp["transformation"]
    if exp["transformation"]:
        ok_ba = ok_ba and bool(trans) and all(p.parts[0].state == "before" and p.parts[-1].state == "after" for p in trans)
    ok_ba = ok_ba and all(p.last_state() != "before" for p in plans)
    m["before_after"] = ok_ba
    if exp.get("to_camera"):
        m["to_camera"] = any(s.people == "to_camera" for s in film[0].shots)
    chatter = [s for s, c in zip(sheets, spec["clips"]) if c[0] == "chatter"]
    if chatter:
        words = [Word(1.0, 1.5, "what's"), Word(1.5, 2.0, "wrong")]
        m["caption_noise"] = P.keep_to_camera(words, chatter[0]) == [] and chatter[0].source != "none"
    return {"metrics": m, "service": service, "shape": shape, "sources": sorted({s.source.split(":")[0] for s in sheets})}


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key and os.environ.get("VISION_LOCAL") != "1":
        log("golden.stop", why="no_key_no_local_model")
        return 1
    fixtures = {p.stem: json.loads(p.read_text()) for p in (ROOT / "tests" / "fixtures" / "businesses").glob("*.json")}
    work = Path(tempfile.mkdtemp(prefix="golden-"))
    results = {slug: score_business(slug, fixtures[slug], key, work) for slug in SCENES}
    flat = [v for r in results.values() for v in r["metrics"].values()]
    total = round(sum(flat) / len(flat), 3) if flat else 0.0
    for slug, r in results.items():
        log("golden.business", slug=slug, shape=r["shape"], source=",".join(r["sources"]), **r["metrics"])
    log("golden.score", score=total, checks=len(flat), vision_calls=V.CALLS.get("vision", 0), failed_calls=V.CALLS.get("failed", 0))
    log("ai.calls", **A.report())
    if "--write-baseline" in sys.argv:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps({"_why": "jobs/golden.py: the last accepted golden-set score; a drop of more than 0.15, or a passing check turning to a fail, fails the weekly job.", "score": total, "passing": {s: [k for k, v in r["metrics"].items() if v] for s, r in results.items()}}, indent=2) + "\n")
        return 0
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"score": 0, "passing": {}}
    lost = [f"{s}:{k}" for s, ks in base.get("passing", {}).items() for k in ks if not results.get(s, {}).get("metrics", {}).get(k)]
    if total < float(base.get("score", 0)) - ALLOWED_DROP or lost:
        for item in lost:
            log("golden.lost", check=item)
        log("golden.DROP", score=total, baseline=float(base.get("score", 0)), lost=len(lost))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
