"""The golden playbook set (owner's studio fix, 23 Oct 2026): real-style synthetic dumps across six
businesses (jobs/golden/playbook_fixtures.json), planned with the real planner, checked against the
playbook. No model and no footage needed, so it runs in every PR (jobs/tests/test_studio_fix.py) and
in the weekly golden set (jobs/golden.py). A drop fails loudly with the business's name.
Checks per clip: ends on a hero held >= 2 s; length and opening follow its type's template; no picture
twice in a clip; one event per clip; no two clips share most shots; a photo slideshow is photos only.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clipmaker as CM  # noqa: E402
import playbook as PB  # noqa: E402
import stages as ST  # noqa: E402
from see import Shot, ShotSheet  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "golden" / "playbook_fixtures.json"


def load() -> dict[str, Any]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))["businesses"]


def looks_for(uploads: list[dict[str, Any]]) -> tuple[list[ST.Look], dict[str, list[float]], set[str]]:
    sheets: dict[str, ShotSheet] = {}
    info: dict[str, dict[str, Any]] = {}
    h = 0
    for u in uploads:
        shots = [Shot(float(s), float(e), what, "", state, people, [], True, True, True, "unsure", 0.9) for s, e, state, people, what in u["shots"]]
        sheets[u["id"]] = ShotSheet(u["id"], max(sh.end for sh in shots), shots, "vision:golden")
        hashes = {}
        for sh in shots:
            h += 1
            hashes[(sh.start, sh.end)] = (h * 0x9E3779B97F4A7C15) & ((1 << 64) - 1)  # every shot its own picture
        info[u["id"]] = {"photo": u["photo"], "name_hero": ST.name_is_hero(u["name"]), "hashes": hashes, "track": []}
    events = ST.event_groups([{"id": u["id"], "date": u.get("date"), "name": u["name"]} for u in uploads])
    for aid in info:
        info[aid]["event"] = events[aid]
    looks = ST.build_looks(sheets, info)
    talk = {u["id"] for u in uploads if any(s[3] == "to_camera" for s in u["shots"])}
    return looks, {u["id"]: [] for u in uploads}, talk


def check_business(slug: str, fx: dict[str, Any], target: int = 30) -> tuple[list[str], dict[str, Any]]:
    pb = PB.load({})
    looks, tracks, talk = looks_for(fx["uploads"])
    by_key = {lk.key: lk for lk in looks}
    plans = CM.plan_typed(looks, pb, {"min": 1, "max": target}, None, tracks, talk)
    exp = fx.get("expect") or {}
    problems: list[str] = []
    hold = float(pb["hero_hold_s"])
    bodies = []
    for i, pl in enumerate(plans):
        t = PB.template(pb, pl.clip_type)
        tag = f"{slug} clip {i + 1} ({pl.clip_type})"
        last = pl.parts[-1]
        if last.stage != "hero" or last.length < hold - 0.01:
            problems.append(f"{tag}: does not end on a hero held {hold:.0f} s")
        lo, hi = t["length_s"]
        if not (pl.clip_type == "moving_photo" or lo - 0.01 <= pl.length <= hi + 0.01):
            problems.append(f"{tag}: {pl.length:.1f} s is outside its template's {lo}-{hi} s")
        first = pl.parts[0].stage
        if "any" not in t["opening"] and not (first in t["opening"] or (first == "flash" and "hero" in t["opening"]) or len(pl.parts) == 1):
            problems.append(f"{tag}: opens on {first or 'an unknown shot'}, its template opens on {'/'.join(t['opening'])}")
        seen = []
        for j, p in enumerate(pl.parts):
            lk = by_key.get(p.key)
            loop = j == len(pl.parts) - 1 and pl.parts[0].stage == "flash"
            if not loop and any(q.key == p.key and q.start < p.end and p.start < q.end for q in seen):
                problems.append(f"{tag}: shows the same shot twice")
            if not loop and lk and any(by_key.get(q.key) and q.key != p.key and ST.same_picture(lk.hash, by_key[q.key].hash) for q in seen):
                problems.append(f"{tag}: shows the same picture twice")
            seen.append(p)
        evs = {by_key[p.key].event for p in pl.parts if p.key in by_key}
        if len(evs) > 1:
            problems.append(f"{tag}: mixes events {sorted(evs)}")
        if pl.clip_type == "photo_slideshow" and not all(p.photo for p in pl.parts):
            problems.append(f"{tag}: a slideshow with a video in it")
        bodies.append(CM.body_keys(pl))
    for i in range(len(bodies)):
        for j in range(i):
            if CM._overlap(bodies[i], bodies[j]) >= 0.5:
                problems.append(f"{slug}: clips {j + 1} and {i + 1} share most of their shots")
    types = {pl.clip_type for pl in plans}
    if len(plans) < int(exp.get("min_clips", 1)):
        problems.append(f"{slug}: {len(plans)} distinct clips, expected at least {exp.get('min_clips')}")
    for need in exp.get("types_all") or []:
        if need not in types:
            problems.append(f"{slug}: no {need} clip from footage that has one")
    if exp.get("events") and len({lk.event for lk in looks}) != int(exp["events"]):
        problems.append(f"{slug}: {len({lk.event for lk in looks})} events found, expected {exp['events']}")
    stats = {"clips": len(plans), "types": sorted(types), "counts": CM.counts([pl.clip_type for pl in plans])}
    return problems, stats


def run_all() -> tuple[list[str], dict[str, Any]]:
    problems: list[str] = []
    stats: dict[str, Any] = {}
    fx = load()
    if len(fx) < 6:
        problems.append(f"the golden playbook set covers {len(fx)} businesses, not 6")
    for slug, b in fx.items():
        p, s = check_business(slug, b)
        problems += p
        stats[slug] = s
    return problems, stats


if __name__ == "__main__":
    from common import log  # noqa: PLC0415

    probs, st = run_all()
    for slug, x in st.items():
        log("golden.playbook", slug=slug, clips=x["clips"], types=",".join(x["types"]))
    for p in probs:
        log("golden.playbook.problem", detail=p)
    sys.exit(1 if probs else 0)
