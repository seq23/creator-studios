"""CHECK its own work (studio intelligence layer 6, owner's plan 22 Oct 2026).

After a clip is rendered, a critic pass looks at the FINISHED clip: a grid of its frames (with the
burned-in hook) plus its hook and caption go to the free vision model, which answers four questions:
does the text match the picture, is a before shot shown as finished, is background noise in the
captions, is a privacy hazard visible. Rules that need no model run first (the grounded-text guard,
a before shot last, captions in a clip nobody talks in to the camera).

A failing clip is re-cut automatically with the critic's reason fed back, at most MAX_RECUTS times.
If it still fails it is hidden under the quality bar with the reason in plain words (REASON_WORDS),
never silently passed. When no model answers, the rules alone decide (reported as source "rules").

critic_loop is pure (render / critique / recut are passed in) and pinned by
jobs/tests/test_critic.py: the loop is bounded. No business words here (niche-neutral test).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plan as P  # noqa: E402
import see as V  # noqa: E402
from common import log  # noqa: E402

MAX_RECUTS = 2
REASONS = ("text_mismatch", "before_as_finished", "noise_captions", "privacy")
# What a hidden clip says in Review ("Hidden because …"), in plain words.
REASON_WORDS = {
    "text_mismatch": "the words didn't match what's in the video",
    "before_as_finished": "an unfinished shot looked like the finished result",
    "noise_captions": "background talk showed up in the captions",
    "privacy": "a face, house number or name may be showing",
}


@dataclass
class Verdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)
    source: str = "rules"  # rules | vision


@dataclass
class Checked:
    """What the critic loop did for one clip."""

    rendered: Any
    moment: Any
    recuts: int
    verdict: Verdict
    hidden_reason: str | None


def rules_check(hook: str, hook_alt: str, caption: str, ground: P.Ground, states: list[str], shape: str | None, captions_text: str, to_camera: bool) -> list[str]:
    """The checks that need no model."""
    out: list[str] = []
    if any(not P.grounded_ok(t, ground)[0] for t in (hook, hook_alt, caption) if t):
        out.append("text_mismatch")
    # A talking-to-camera clip over an unfinished scene does not present it as finished; a walk-through or close-ups would.
    if states and (states[-1] == "before" or (shape in ("walkthrough", "montage") and "before" in states)):
        out.append("before_as_finished")
    if captions_text.strip() and not to_camera:
        out.append("noise_captions")
    return out


CRITIC_SYSTEM = (
    "You check a finished short vertical video before the business owner sees it. The picture is a grid of frames from the "
    "finished clip, in time order (left to right, top to bottom); text at the top is its on-screen hook. You also get its "
    "caption, the words burned in as captions, and what each shot was planned to show. Answer JSON only: "
    "{\"text_matches_picture\":bool,\"before_shown_as_finished\":bool,\"noise_in_captions\":bool,\"privacy_hazard\":bool,"
    "\"why\":str}. text_matches_picture is false if the hook or caption describes something not visible, names a different "
    "service, or calls an empty or unfinished scene finished. before_shown_as_finished is true if an empty or unfinished scene "
    "is presented as the end result. noise_in_captions is true if the burned captions read like background chatter, not "
    "someone talking to the camera. privacy_hazard is true if a bystander's face, a house number, a street sign, a licence "
    "plate or a written name of a person is readable. why: max 20 words, no names."
)


def parse_verdict(answer: Any) -> list[str] | None:
    """The model's answer → reason codes (None = no usable answer)."""
    if not isinstance(answer, dict) or not any(k in answer for k in ("text_matches_picture", "before_shown_as_finished", "noise_in_captions", "privacy_hazard")):
        return None
    out: list[str] = []
    if answer.get("text_matches_picture") is False:
        out.append("text_mismatch")
    if answer.get("before_shown_as_finished") is True:
        out.append("before_as_finished")
    if answer.get("noise_in_captions") is True:
        out.append("noise_captions")
    if answer.get("privacy_hazard") is True:
        out.append("privacy")
    return out


def vision_check(key: str | None, mp4: Path, duration: float, work: Path, name: str, hook: str, caption: str, captions_text: str, plan_text: list[dict[str, str]]) -> list[str] | None:
    """One critic call on the finished clip's frames. None when no model answered."""
    if not key:
        return None
    frames, _times = V.extract_frames(mp4, duration, work / f"critic_{name}", max_cells=8)
    grid = V.contact_sheet(frames, work / f"critic_{name}.jpg")
    if not grid:
        return None
    prompt = json.dumps({"hook": hook, "caption": caption, "burned_captions": captions_text[:600], "planned_shots": plan_text[:8]})
    answer, _model = V.ask_vision(key, CRITIC_SYSTEM, prompt, grid, "critic", max_tokens=800)
    return parse_verdict(answer)


def critic_loop(m: Any, render: Callable[[Any], Any], critique: Callable[[Any, Any], Verdict], recut: Callable[[Any, list[str], int], Any | None], max_recuts: int = MAX_RECUTS) -> Checked:
    """Render, check, and re-cut with the reason fed back, at most `max_recuts` times. A clip that
    still fails (or cannot be re-cut) keeps its last render and is hidden with the reason."""
    rendered = render(m)
    verdict = critique(m, rendered)
    recuts = 0
    while not verdict.ok and recuts < max_recuts:
        nxt = recut(m, verdict.reasons, recuts)
        if nxt is None:
            break
        recuts += 1
        m = nxt
        rendered = render(m)
        verdict = critique(m, rendered)
    hidden = None if verdict.ok else REASON_WORDS.get(verdict.reasons[0] if verdict.reasons else "", REASON_WORDS["text_mismatch"])
    log("critic.clip", ok=verdict.ok, recuts=recuts, source=verdict.source, reason=(verdict.reasons[0] if verdict.reasons else None))
    return Checked(rendered, m, recuts, verdict, hidden)
