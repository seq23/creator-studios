"""The weekly golden set (studio intelligence layer 9 seed, owner's plan 22 Oct 2026).

A few synthetic clips (made here, CC0: drawn shapes and plain sentences, no real footage) per fixture
business (tests/fixtures/businesses) go through the real shot sheet (jobs/see.py: the free vision model,
else the local backup) and the real planner (jobs/plan.py). Scored:
  * job type:      the service the planner detects is the business's expected one;
  * before/after:  a before -> after appears exactly when both states were filmed, starting on the
                   before and ending on the reveal;
  * caption noise: background chatter (nobody talking to the camera) gives no captions.
First the playbook set (jobs/golden_playbook.py, jobs/golden/playbook_fixtures.json): six businesses'
dumps with prep, process, finished and photo-only events, planned by type; every clip must end on a
hero, follow its template, repeat no picture and mix no events (no model needed).
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
import golden_playbook as GP  # noqa: E402
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
    # Layer 9: six unlike businesses (23 Oct 2026), the two below read their services from the layer 1 sections.
    "landscaper": {
        "expect": {"service": "Lawn mowing", "transformation": True},
        "clips": [
            ("before", 6, (200, 215, 190), "Before: long, uneven, overgrown grass in a yard.", "grass_long"),
            ("after", 8, (215, 230, 205), "After: a freshly cut, striped lawn with clean edges.", "grass_cut"),
        ],
    },
    "bakery": {
        "expect": {"service": "Frosted cakes", "transformation": False},
        "clips": [
            ("after", 8, (250, 240, 230), "A tall frosted layer cake with piped decoration on a stand.", "cake"),
            ("detail", 6, (245, 235, 225), "Close-up of the finished cake's piped frosting.", "cake"),
        ],
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
    elif kind == "grass_long":
        for i in range(220):
            x = 20 + (i * 29) % 680
            d.line([x, 1240, x + (i % 7) - 3, 1240 - 150 - (i * 37) % 260], fill=(40 + i % 40, 120 + i % 60, 30), width=5)
    elif kind == "grass_cut":
        for i in range(8):
            d.rectangle([0, 700 + i * 70, 720, 770 + i * 70], fill=(60, 150, 50) if i % 2 else (90, 180, 70))
        d.line([(0, 700), (720, 700)], fill=(120, 100, 70), width=8)
    elif kind == "cake":
        d.rectangle([300, 1000, 420, 1180], fill=(180, 180, 190))
        for j, (w, c) in enumerate([(420, (250, 220, 230)), (340, (245, 200, 215)), (260, (250, 230, 240))]):
            y = 860 - j * 150
            d.rectangle([360 - w // 2, y, 360 + w // 2, y + 140], fill=c, outline=(200, 150, 170), width=4)
            for k in range(8):
                d.ellipse([360 - w // 2 + k * w // 8, y - 14, 360 - w // 2 + k * w // 8 + 28, y + 14], fill=(255, 255, 255))
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


def base_slugs() -> list[str]:
    return list((json.loads(BASELINE.read_text()) if BASELINE.exists() else {}).get("passing", {}))


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
    shape, _ = P.choose_shape(film, service, {s.asset_id: False for s in film}, None, P.shapes_fit(fixture["profile"], service))
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
    # Which model read this business's clips: the free OpenRouter model, or the $0 backup (the local
    # open model, then CLIP) when the day's free quota was used. Each is held to its own baseline.
    provider = "openrouter" if any(s.source.startswith("vision:openrouter") for s in sheets) else "backup"
    return {"metrics": m, "service": service, "shape": shape, "sources": sorted({s.source.split(":")[0] for s in sheets}), "provider": provider}


def baseline_for(base: dict[str, Any], provider: str) -> dict[str, Any]:
    """The free model's baseline (the top level) or the backup's ("backup"); a missing backup
    baseline holds the backup to the free model's (strict)."""
    return base.get("backup", base) if provider == "backup" else base


def loud(lines: list[str]) -> None:
    """A drop is a loud failure: an error annotation per lost check on the run page, and the job summary."""
    for line in lines:
        sys.stdout.write(f"::error title=Golden set dropped::{line}\n")  # a GitHub annotation, not a log line
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("## Golden set dropped\n\n" + "\n".join(f"- {x}" for x in lines) + "\n")


def main() -> int:
    # The playbook set first (studio fix, 23 Oct 2026): no model needed, so it always runs. Every clip
    # ends on a hero, follows its type, repeats no picture, mixes no events; a drop fails loudly.
    pb_problems, pb_stats = GP.run_all()
    for slug, st in pb_stats.items():
        log("golden.playbook", slug=slug, clips=st["clips"], types=",".join(st["types"]))
    if pb_problems:
        log("golden.playbook.DROP", problems=len(pb_problems))
        loud([f"playbook: {p}" for p in pb_problems])
        return 1
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key and os.environ.get("VISION_LOCAL") != "1":
        log("golden.stop", why="no_key_no_local_model")
        return 1
    fixtures = {p.stem: json.loads(p.read_text()) for p in (ROOT / "tests" / "fixtures" / "businesses").glob("*.json")}
    if sorted(fixtures) != sorted(SCENES) or len(SCENES) < 6:
        # Rule 0: every fixture business is scored, and at least six unlike ones (layer 9).
        log("golden.stop", why="fixtures_and_scenes_differ", fixtures=len(fixtures), scenes=len(SCENES))
        loud([f"the golden set scores {len(SCENES)} businesses and there are {len(fixtures)} fixtures; it must be the same six or more"])
        return 1
    work = Path(tempfile.mkdtemp(prefix="golden-"))
    results = {slug: score_business(slug, fixtures[slug], key, work) for slug in SCENES}
    flat = [v for r in results.values() for v in r["metrics"].values()]
    total = round(sum(flat) / len(flat), 3) if flat else 0.0
    for slug, r in results.items():
        log("golden.business", slug=slug, shape=r["shape"], source=",".join(r["sources"]), provider=r["provider"], **r["metrics"])
    log("golden.score", score=total, checks=len(flat), vision_calls=V.CALLS.get("vision", 0), failed_calls=V.CALLS.get("failed", 0))
    log("ai.calls", **A.report())
    missing = [s for s in base_slugs() if s not in results]
    if missing:
        loud([f"the baseline has {s}, the run did not score it" for s in missing])
        return 1
    if "--write-baseline" in sys.argv:
        # Writes the baseline of the provider that scored this run (both kept in one file).
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
        entry = {"score": total, "passing": {s: [k for k, v in r["metrics"].items() if v] for s, r in results.items()}}
        if all(r["provider"] == "backup" for r in results.values()):
            base["backup"] = entry
        else:
            base.update(entry)
        base.setdefault("_why", "jobs/golden.py: the last accepted golden-set score per provider; a drop of more than 0.15, or a passing check turning to a fail, fails the weekly job.")
        BASELINE.write_text(json.dumps(base, indent=2) + "\n")
        return 0
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"score": 0, "passing": {}}
    lost = [f"{s}:{k}" for s, r in results.items() for k in baseline_for(base, r["provider"]).get("passing", {}).get(s, []) if not r["metrics"].get(k)]
    expected = sum(len(baseline_for(base, r["provider"]).get("passing", {}).get(s, [])) for s, r in results.items()) / max(1, len(flat))
    if total < round(expected, 3) - ALLOWED_DROP or lost:
        for item in lost:
            log("golden.lost", check=item)
        log("golden.DROP", score=total, baseline=round(expected, 3), lost=len(lost))
        loud([f"score {total} against the baseline {round(expected, 3)} (providers: {', '.join(sorted({r['provider'] for r in results.values()}))})", *[f"lost: {x}" for x in lost]])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
