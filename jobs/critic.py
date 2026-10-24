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
    # Not a critic verdict: the blur of a house number or face could not run on this video, so its
    # clips are held unchecked (jobs/cut.py, fail closed). Its own words, so it is never mistaken
    # for a face the check saw (23 Oct 2026).
    "unprotected": "a house number or face could not be blurred, so it is held for a look",
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


# ---------------------------------------------------------------- several clips, one call (quota fix)

# One critic call looks at up to BATCH_CLIPS finished clips (CRITIC_CELLS frames each, every clip
# under its own heading): 12 clips cost 3 calls instead of 12 (jobs/ai.py budgets the account).
BATCH_CLIPS = 4
CRITIC_CELLS = 6

CRITIC_BATCH_SYSTEM = CRITIC_SYSTEM.replace(
    "The picture is a grid of frames from the finished clip, in time order (left to right, top to bottom); text at the top is its on-screen hook. You also get its caption, the words burned in as captions, and what each shot was planned to show. Answer JSON only: {",
    "The picture shows SEVERAL finished clips, each under its own black heading (CLIP 1, CLIP 2, ...), its frames in time order "
    "(left to right, top to bottom); text at the top of a frame is that clip's on-screen hook. For each clip you also get its caption, "
    "the words burned in as captions, and what each shot was planned to show. Judge every clip on its own; if the owner turned down "
    "clips like one of these before, say text_matches_picture false and why. Answer JSON only: "
    "{\"clips\":[{\"clip\":int,",
).replace("\"why\":str}.", "\"why\":str}]}.")


def parse_batch_verdicts(answer: Any, n: int) -> list[list[str] | None]:
    out: list[list[str] | None] = [None] * n
    if not isinstance(answer, dict) or not isinstance(answer.get("clips"), list):
        return out
    for c in answer["clips"]:
        if not isinstance(c, dict):
            continue
        try:
            i = int(c.get("clip")) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= i < n:
            out[i] = parse_verdict(c)
    return out


def vision_check_batch(key: str | None, items: list[dict[str, Any]], work: Path, tag: str, memory: dict[str, Any] | None = None) -> list[list[str] | None]:
    """The critic on several finished clips per call. items: {mp4, duration, hook, caption, said,
    plan_text}. None for a clip no model judged (the rules alone decide it)."""
    out: list[list[str] | None] = [None] * len(items)
    if not key:
        return out
    for i in range(0, len(items), BATCH_CLIPS):
        chunk = items[i : i + BATCH_CLIPS]
        groups = []
        for j, it in enumerate(chunk):
            frames, _t = V.extract_frames(it["mp4"], it["duration"], work / f"critic_{tag}_{i + j}", max_cells=CRITIC_CELLS)
            groups.append((f"CLIP {j + 1}", frames))
        grid = V.labelled_grid(groups, work / f"critic_{tag}_{i}.jpg")
        if not grid:
            continue
        learned = {k: (memory or {}).get(k, [])[:6] for k in ("reject_reasons", "turned_down_hooks") if (memory or {}).get(k)}
        prompt = json.dumps({**({"the_owner_turned_down_clips_like_these": learned} if learned else {}), "clips": [{"clip": j + 1, "hook": it["hook"], "caption": it["caption"], "burned_captions": it["said"][:400], "planned_shots": it["plan_text"][:8]} for j, it in enumerate(chunk)]})
        answer, _model = V.ask_vision(key, CRITIC_BATCH_SYSTEM, prompt, grid, "critic", max_tokens=1600, local=False)
        for j, v in enumerate(parse_batch_verdicts(answer, len(chunk))):
            out[i + j] = v
    return out


def critic_rounds(
    ms: list[Any],
    render: Callable[[Any], Any],
    rules: Callable[[Any, Any], list[str]],
    vision: Callable[[list[tuple[Any, Any]]], list[list[str] | None]],
    recut: Callable[[list[tuple[Any, list[str], int]]], list[Any | None]],
    max_recuts: int = MAX_RECUTS,
) -> list[Checked | None]:
    """The critic over a whole dump, in rounds: render every clip, check them all (rules first, then
    ONE batched vision pass for the clips the rules passed), re-cut the failures together (one batched
    re-write), and again, at most `max_recuts` rounds. A clip that still fails is hidden with the
    reason; a clip whose first render failed comes back as None. Same bound as critic_loop."""
    st: list[dict[str, Any]] = []
    for m in ms:
        r = render(m)
        st.append({"m": m, "r": r, "recuts": 0, "v": Verdict(False, ["render"], "rules"), "done": r is None, "dead": r is None})
    while True:
        pending = [x for x in st if not x["done"]]
        if not pending:
            break
        to_vision = []
        for x in pending:
            rr = rules(x["m"], x["r"])
            x["v"] = Verdict(False, rr, "rules") if rr else None
            if not rr:
                to_vision.append(x)
        found = vision([(x["m"], x["r"]) for x in to_vision]) if to_vision else []
        for x, f in zip(to_vision, [*found, *([None] * len(to_vision))]):
            x["v"] = Verdict(True, [], "rules") if f is None else Verdict(not f, f, "vision")
        again = []
        for x in pending:
            if x["v"].ok or x["recuts"] >= max_recuts:
                x["done"] = True
            else:
                again.append(x)
        if not again:
            break
        news = recut([(x["m"], x["v"].reasons, x["recuts"]) for x in again])
        for x, n in zip(again, [*news, *([None] * len(again))]):
            if n is None:
                x["done"] = True
                continue
            r = render(n)
            if r is None:
                x["done"] = True  # the re-cut did not render: the last render stays, hidden with its reason
                continue
            x["m"], x["r"], x["recuts"] = n, r, x["recuts"] + 1
    out: list[Checked | None] = []
    for x in st:
        if x["dead"]:
            out.append(None)
            continue
        v = x["v"]
        hidden = None if v.ok else REASON_WORDS.get(v.reasons[0] if v.reasons else "", REASON_WORDS["text_mismatch"])
        log("critic.clip", ok=v.ok, recuts=x["recuts"], source=v.source, reason=(v.reasons[0] if v.reasons else None))
        out.append(Checked(x["r"], x["m"], x["recuts"], v, hidden))
    return out
