"""The playbook: clip-type library + research (jobs/playbook.json), merged with a studio's niche playbook.

Read by the planner (jobs/clipmaker.py plan_typed: each type's template) AND the critic
(jobs/clipmaker.py score_clip: did the clip follow its template). spec.niche_playbook (the weekly
niche research: {updated_at, formats, hooks, caption_tips}) is merged on top when present: its
formats put the matching clip types first, its hooks and caption tips go to the copy writer.
No business words here.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

BASE = json.loads((Path(__file__).resolve().parent / "playbook.json").read_text(encoding="utf-8"))
TYPES: dict[str, dict[str, Any]] = BASE["types"]
TYPE_IDS = list(TYPES)
STAGES = ("arrival", "prep", "team", "process", "finished", "detail", "hero")


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z]+", (s or "").lower())) - {"the", "a", "an", "of", "with", "and", "to", "your", "you"}


def match_type(name: str) -> str | None:
    """A format name from the niche research ("POV walk in", "slideshow") as a library type."""
    n = (name or "").strip().lower().replace("-", "_").replace(" ", "_")
    if n in TYPES:
        return n
    w = _words(name)
    best, score = None, 0
    for tid, t in TYPES.items():
        s = len(w & (_words(t["label"]) | _words(tid.replace("_", " "))))
        if s > score:
            best, score = tid, s
    return best if score >= 1 else None


def load(spec: dict[str, Any] | None) -> dict[str, Any]:
    """The playbook for one cut: the library, the research lines, and the niche's own on top."""
    pb = copy.deepcopy(BASE)
    pb["order"] = list(TYPE_IDS)
    pb["niche_first"] = []
    pb["niche_hooks"], pb["caption_tips"], pb["niche_formats"] = [], [], []
    niche = (spec or {}).get("niche_playbook")
    if isinstance(niche, dict):
        fmts = [str(f.get("name") if isinstance(f, dict) else f)[:80] for f in (niche.get("formats") or [])][:12]
        pb["niche_formats"] = fmts
        first = [t for t in (match_type(f) for f in fmts) if t]
        pb["order"] = list(dict.fromkeys([*first, *TYPE_IDS]))
        pb["niche_first"] = first
        pb["niche_hooks"] = [str(h.get("text") if isinstance(h, dict) else h)[:120] for h in (niche.get("hooks") or [])][:12]
        pb["caption_tips"] = [str(c)[:200] for c in (niche.get("caption_tips") or [])][:8]
        pb["niche_updated_at"] = str(niche.get("updated_at") or "")[:40]
    return pb


def template(pb: dict[str, Any], clip_type: str) -> dict[str, Any]:
    return pb["types"].get(clip_type) or pb["types"]["finished_walkthrough"]


def prompt_lines(pb: dict[str, Any]) -> dict[str, Any]:
    """What the copy writer reads from the playbook."""
    return {
        "what_converts": pb["research"],
        **({"niche_hooks_that_work": pb["niche_hooks"]} if pb.get("niche_hooks") else {}),
        **({"niche_caption_tips": pb["caption_tips"]} if pb.get("caption_tips") else {}),
    }
