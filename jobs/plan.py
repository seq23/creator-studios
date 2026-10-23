"""PLAN the story from the shot sheet (studio intelligence layer 4, owner's plan 22 Oct 2026).

From the dump's shot sheets (jobs/see.py) this picks:
  * the service the footage shows (one of the locked Brand Profile's services, or "not sure"),
  * a shape: transformation (before -> reveal) ONLY when both a before and an after shot exist,
    a walk-through (one long steady shot of the result), talking to camera, or a montage of details,
  * the shots in each clip, in order. A before shot is never the last shot and never appears in a
    clip that is not a transformation, so it is never presented as finished.
Then the words: hook, alternative hook, caption and hashtags are GROUNDED. They may describe only
what the shot sheet says is on screen, for the detected service (grounded_ok, one word list with
the Worker: shared/grounded.json). Speech becomes captions only inside shots where someone talks to
the camera; background talk never does. With nothing sure, the hook is neutral.

No business words in this file: every service word comes from the studio's Brand Profile
(tests/unit/niche-neutral.test.ts reads it). Pure functions, unit-tested in jobs/tests/test_see_plan.py.
"""
from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from see import CALLS, UNSURE, Shot, ShotSheet  # noqa: E402

GROUNDED = json.loads((Path(__file__).resolve().parent.parent / "shared" / "grounded.json").read_text(encoding="utf-8"))
SHAPES = ("transformation", "walkthrough", "talking", "montage")
# Where the clips go: every visual shape is cut as a montage (15-45 s), talking keeps the speech recipes.
SHAPE_RECIPE = {"transformation": "montage", "walkthrough": "montage", "montage": "montage"}
MAX_CLIP_S = 44.0
# The Worker keeps at most 8 parts per clip (worker/jobs/cut.ts MAX_PARTS); a plan never has more.
MAX_PARTS = 8
TALKING_SHARE = 0.4
WALK_MIN_S = 6.0


# ---------------------------------------------------------------- words

def stem(w: str) -> str:
    w = w.lower()
    if len(w) > 4 and w.endswith("es") and w[-3] in "shxz":
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    stop = set(GROUNDED["stopwords"])
    return [stem(t) for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if t not in stop and len(t) > 1]


def _has_phrase(text: str, phrases: list[str]) -> str | None:
    t = " " + re.sub(r"[^a-z0-9\-]+", " ", (text or "").lower()) + " "
    for p in phrases:
        if f" {p.lower()} " in t:
            return p
    return None


def banned_tokens(service: str | None, services: list[str], on_screen: str) -> set[str]:
    """Words of the OTHER services that the picture does not show: never in this clip's text."""
    mine = set(tokens(service or ""))
    seen = set(tokens(on_screen))
    out: set[str] = set()
    for s in services:
        if service and s.lower() == service.lower():
            continue
        out |= {t for t in tokens(s) if t not in mine and t not in seen}
    return out


@dataclass
class Ground:
    """What a clip's text may talk about."""

    service: str | None
    services: list[str]
    on_screen: str
    has_before: bool
    has_after: bool


def grounded_ok(text: str, g: Ground) -> tuple[bool, str]:
    """(ok, reason). reason is a short code for the log and the critic's feedback."""
    if not text:
        return True, ""
    if _has_phrase(text, GROUNDED["automation"]):
        return False, "automation"
    if not g.has_after and _has_phrase(text, GROUNDED["finished"]):
        return False, "finished_without_after"
    if not g.has_before and _has_phrase(text, GROUNDED["before"]):
        return False, "before_without_before"
    bad = banned_tokens(g.service, g.services, g.on_screen)
    if bad and any(t in bad for t in tokens(text)):
        return False, "other_service"
    return True, ""


def hashtag_ok(tag: str, g: Ground, own: set[str]) -> bool:
    """A hashtag the studio lists in its Brand Profile is its own (its name, its city); any other
    tag must not carry another service's word or a state the picture does not show."""
    t = tag.lower().lstrip("#")
    if not re.fullmatch(r"[a-z0-9_]{2,40}", t):
        return False
    if t in own:
        return True
    if any(b in t for b in banned_tokens(g.service, g.services, g.on_screen) if len(b) >= 4):
        return False
    words = re.sub(r"[_]+", " ", t)
    if not grounded_ok(words, g)[0]:
        return False
    single = lambda key: [w.replace(" ", "").replace("-", "") for w in GROUNDED[key]]  # noqa: E731
    if not g.has_after and any(w in t for w in single("finished")):
        return False
    if not g.has_before and any(w in t for w in single("before")):
        return False
    return True


def profile_hashtags(profile: dict[str, str] | None) -> list[str]:
    """The hashtags the Brand Profile itself lists (any section), in order."""
    out: list[str] = []
    for v in (profile or {}).values():
        for h in re.findall(r"#[A-Za-z0-9_]{2,40}", str(v)):
            if h.lower() not in [x.lower() for x in out]:
                out.append(h)
    return out[:8]


def ctas(profile: dict[str, str] | None) -> list[str]:
    lines = re.split(r"\n|\s\|\s", (profile or {}).get("ctas", ""))
    return [re.sub(r'^[\s\-•"“]+|["”\s]+$', "", l).strip() for l in lines if l.strip(" -•\t\"“”")][:6]


def grounded_cta(profile: dict[str, str] | None, g: Ground) -> str:
    for c in ctas(profile):
        if grounded_ok(c, g)[0]:
            return c[:90]
    return ""


# ---------------------------------------------------------------- know the business (layer 1)

# Words that name a story shape in the Brand Profile's "Which video shapes fit" section. Shape words
# only: the services themselves always come from the profile.
SHAPE_NAMES = {
    "transformation": ("before and after", "before & after", "before/after", "before-and-after", "transformation", "reveal"),
    "walkthrough": ("walk-through", "walkthrough", "walk through", "tour", "slow look"),
    "talking": ("talking to camera", "talking to the camera", "talking", "to camera", "speaking"),
    "montage": ("close-ups", "close-up", "close ups", "close up", "closeups", "details", "montage"),
}


def _profile_lines(text: str) -> list[tuple[str, str]]:
    """'Label: rest' lines (bullets and numbers stripped); a line with no colon has an empty label."""
    out = []
    for raw in re.split(r"\n|\s\|\s", text or ""):
        line = re.sub(r"^[\s\-•*\d.)]+", "", raw).strip()
        if not line:
            continue
        label, sep, rest = line.partition(":")
        out.append((label.strip(), rest.strip()) if sep and len(label) <= 60 else ("", line))
    return out


def _overlap(label: str, service: str) -> float:
    a, b = set(tokens(label)), set(tokens(service))
    if label.strip().lower() == service.lower():
        return 1.0
    return len(a & b) / len(a | b) if a and b else 0.0


def _service_of_label(label: str, services: list[str]) -> str | None:
    """The service a profile line's label names: the closest by shared words, at least half."""
    best = max(services, key=lambda s: _overlap(label, s), default=None) if label else None
    return best if best and _overlap(label, best) >= 0.5 else None


def _matches_service(label: str, service: str) -> bool:
    return _overlap(label, service) >= 0.5


def service_looks(profile: dict[str, str] | None, services: list[str]) -> dict[str, str]:
    """{service: what it looks like}, from the profile's "What each service looks like" section."""
    out: dict[str, str] = {}
    for label, rest in _profile_lines((profile or {}).get("service_looks", "")):
        svc = _service_of_label(label, services)
        if svc and rest and svc not in out:
            out[svc] = rest[:300]
    return out


def shapes_in(text: str) -> list[str]:
    t = (text or "").lower()
    found = [(min(t.find(w) for w in words if w in t), shape) for shape, words in SHAPE_NAMES.items() if any(w in t for w in words)]
    return [shape for _i, shape in sorted(found)]


def shapes_fit(profile: dict[str, str] | None, service: str | None) -> list[str] | None:
    """The shapes the profile says fit this service, best first (its own line wins over a general
    line). None when the profile does not say."""
    general: list[str] = []
    for label, rest in _profile_lines((profile or {}).get("video_shapes", "")):
        if label and service and _matches_service(label, service):
            own = shapes_in(rest)
            if own:
                return own
        elif not label or label.lower() in ("all", "any", "every service", "everything"):
            general += [x for x in shapes_in(rest) if x not in general]
    return general or None


# ---------------------------------------------------------------- her answers and Studio Memory (layers 7, 8, 9)

def mark_before(sheets: list[ShotSheet], before_assets: list[str] | None) -> int:
    """She tapped "This one is a before" (layer 7): every shot of those videos is a before shot,
    sure. Returns how many videos changed."""
    ids = set(before_assets or [])
    n = 0
    for sh in sheets:
        if sh.asset_id in ids:
            for s in sh.shots:
                s.state, s.confidence = "before", max(s.confidence, 0.9)
                if s.people == "to_camera":
                    s.people = "working"
            n += 1
    return n


def memory_fit(memory: dict[str, Any] | None) -> list[str] | None:
    """The shapes she keeps, best first: at least 3 reviewed and kept at least half the time, by
    how often she kept them, then views. None when the studio has not learned enough yet."""
    rated = []
    for shape, v in ((memory or {}).get("shapes") or {}).items():
        if shape not in SHAPES or not isinstance(v, dict):
            continue
        seen = int(v.get("approved", 0)) + int(v.get("rejected", 0))
        if seen >= 3:
            rate = int(v.get("approved", 0)) / seen
            if rate >= 0.5:
                rated.append((rate, int(v.get("views", 0)), shape))
    return [x[2] for x in sorted(rated, reverse=True)] or None


def combined_fit(profile_fit: list[str] | None, memory: dict[str, Any] | None) -> list[str] | None:
    """Her Brand Profile's shapes first; in the careful approach (layer 9) the shapes she keeps lead."""
    learned = memory_fit(memory) or []
    own = profile_fit or []
    order = [*learned, *own] if (memory or {}).get("approach") == "careful" else [*own, *learned]
    out = [x for i, x in enumerate(order) if x not in order[:i]]
    return out or None


def relabel(service: str | None, memory: dict[str, Any] | None, services: list[str]) -> str | None:
    """A service she has corrected at least twice is read as what she said it is (layer 8)."""
    to = ((memory or {}).get("relabel") or {}).get(service or "")
    return next((s for s in services if s.lower() == str(to).lower()), service) if to else service


def careful_quota(quota: int, memory: dict[str, Any] | None) -> int:
    """Layer 9: in the careful approach the studio makes half as many clips (at least 2)."""
    return max(2, math.ceil(quota / 2)) if (memory or {}).get("approach") == "careful" else quota


def memory_prompt(memory: dict[str, Any] | None) -> dict[str, Any]:
    m = memory or {}
    out = {k: m[k][:8] for k in ("kept_hooks", "turned_down_hooks", "notes", "reject_reasons") if isinstance(m.get(k), list) and m[k]}
    return {"what_the_owner_kept_and_turned_down": out} if out else {}


# ---------------------------------------------------------------- the dump: service + shape

def dump_service(sheets: list[ShotSheet], override: str | None = None, services: list[str] | None = None) -> tuple[str | None, bool]:
    """(service, sure): the service most of the sure footage shows. Her "Change" wins."""
    if override:
        if override == UNSURE:
            return None, False
        match = next((s for s in services or [] if s.lower() == override.lower()), None)
        if match:
            return match, True
    total = sum(sh.duration for sh in sheets) or 1.0
    by: dict[str, float] = {}
    sure_time = 0.0
    for sh in sheets:
        for s in sh.shots:
            if s.sure and s.service != UNSURE:
                by[s.service] = by.get(s.service, 0.0) + s.length
                sure_time += s.length
    if not by:
        return None, False
    best = max(by.items(), key=lambda kv: kv[1])
    sure = best[1] >= 0.5 * sure_time and sure_time >= 0.3 * total
    return (best[0], True) if sure else (None, False)


def usable(s: Shot) -> bool:
    return not s.privacy and s.quality > 0.34 and s.length >= 1.0


def pools(sheets: list[ShotSheet], service: str | None, hers: bool = False) -> dict[str, list[tuple[str, Shot]]]:
    """Usable shots by state. A before / in-progress shot may have no service of its own (an empty
    space shows none); an after shot must show this dump's service when one was found, or, when she
    named the service herself (hers=True, "Change" or a one-tap answer), have no other service."""
    out: dict[str, list[tuple[str, Shot]]] = {"before": [], "in_progress": [], "after": [], "other": [], "to_camera": []}
    for sh in sheets:
        for s in sh.shots:
            if not usable(s):
                continue
            if s.people == "to_camera":
                out["to_camera"].append((sh.asset_id, s))
            fits = s.service == UNSURE or not service or s.service == service
            if s.state == "before" and s.sure and fits:
                out["before"].append((sh.asset_id, s))
            elif s.state == "in_progress" and s.sure and fits:
                out["in_progress"].append((sh.asset_id, s))
            elif s.state == "after" and s.sure and (not service or s.service == service or (hers and s.service == UNSURE)):
                out["after"].append((sh.asset_id, s))
            elif s.state in ("n/a", UNSURE) and s.people != "to_camera":
                out["other"].append((sh.asset_id, s))
    return out


def choose_shape(sheets: list[ShotSheet], service: str | None, muted: dict[str, bool] | None = None, override: str | None = None, fit: list[str] | None = None, hers: bool = False) -> tuple[str, str | None]:
    """(shape, why_not): the story shape, and a plain reason when her pick cannot be made. `fit`
    (the Brand Profile's shapes for this service, best first) decides among the shapes the footage
    allows; her own pick ("Change") still wins."""
    p = pools(sheets, service, hers)
    both = bool(p["before"]) and bool(p["after"])
    total = sum(sh.duration for sh in sheets) or 1.0
    talk = sum(s.length for aid, s in p["to_camera"] if not (muted or {}).get(aid))
    natural = (
        "transformation" if both
        else "talking" if talk >= TALKING_SHARE * total
        else "walkthrough" if any(s.length >= WALK_MIN_S and s.steady for _a, s in p["after"])
        else "montage"
    )
    if fit:
        possible = {
            "transformation": both,
            "talking": talk > 0,
            "walkthrough": any(s.length >= WALK_MIN_S and s.steady for _a, s in p["after"]),
            "montage": bool(p["after"] or p["other"]),
        }
        # Her profile's order wins among the shapes this footage can make.
        natural = next((x for x in fit if possible.get(x)), natural)
    if override in SHAPES and override != natural:
        if override == "transformation" and not both:
            return natural, "we couldn't find both a before shot and a finished shot in these videos"
        if override == "talking" and talk <= 0:
            return natural, "nobody talks to the camera in these videos (or the camera sound is off)"
        return override, None
    return natural, None


# ---------------------------------------------------------------- clips

@dataclass
class Part:
    asset_id: str
    start: float
    end: float
    state: str
    what: str

    @property
    def length(self) -> float:
        return self.end - self.start


@dataclass
class Plan:
    shape: str
    service: str | None
    parts: list[Part]
    hook: str = ""
    hook_alt: str = ""
    caption: str = ""
    hashtags: list[str] = field(default_factory=list)
    score: float = 0.5
    # Set by the critic loop (jobs/critic.py): captions off after noise was seen, and why it was hidden.
    captions_off: bool = False
    hidden_reason: str | None = None

    @property
    def recipe(self) -> str:
        return SHAPE_RECIPE.get(self.shape, "montage")

    @property
    def length(self) -> float:
        return sum(p.length for p in self.parts)

    @property
    def on_screen(self) -> str:
        seen: list[str] = []
        for p in self.parts:
            if p.what and p.what not in seen:
                seen.append(p.what)
        return " · ".join(seen)[:400]

    def ground(self, services: list[str]) -> Ground:
        return Ground(self.service, services, self.on_screen, any(p.state == "before" for p in self.parts), any(p.state == "after" for p in self.parts))

    def last_state(self) -> str:
        return self.parts[-1].state if self.parts else UNSURE


def _piece(aid: str, s: Shot, length: float, offset: float = 0.0) -> Part:
    """`length` seconds of a shot, starting `offset` into it (kept inside the shot)."""
    length = min(length, s.length)
    start = min(s.end - length, s.start + max(0.0, offset))
    start = max(s.start, start)
    return Part(aid, round(start, 2), round(start + length, 2), s.state, s.what)


def _fit(parts: list[Part]) -> list[Part]:
    out, total = [], 0.0
    for p in parts[:MAX_PARTS]:
        if total + p.length > MAX_CLIP_S:
            left = MAX_CLIP_S - total
            if left >= 1.5:
                out.append(Part(p.asset_id, p.start, round(p.start + left, 2), p.state, p.what))
            break
        out.append(p)
        total += p.length
    return out


def plan_clips(sheets: list[ShotSheet], shape: str, service: str | None, quota: int, hers: bool = False) -> list[Plan]:
    """The clips, in the order they are made. Never a before shot last; never a before shot
    outside a transformation. Talking-to-camera clips are picked from the speech (cut.py)."""
    p = pools(sheets, service, hers)
    before, prog, after, other = p["before"], p["in_progress"], p["after"], p["other"]
    plans: list[Plan] = []
    quota = max(1, quota)
    if shape == "transformation" and before and after:
        n = min(math.ceil(quota * 0.5), max(2, len(after) + len(before)))
        for i in range(n):
            parts: list[Part] = []
            b = before[i % len(before)]
            parts.append(_piece(b[0], b[1], 3.0, (i // len(before)) * 1.5))
            if len(before) > 1 and i % 2:
                b2 = before[(i + 1) % len(before)]
                if b2 is not b:
                    parts.append(_piece(b2[0], b2[1], 2.0))
            if prog:
                g = prog[i % len(prog)]
                parts.append(_piece(g[0], g[1], 2.5, (i // len(prog)) * 1.0))
            picks = [after[(i + j) % len(after)] for j in range(min(3, len(after)))]
            for j, (aid, s) in enumerate(picks):
                parts.append(_piece(aid, s, 6.0 if j == len(picks) - 1 else 4.0, (i // len(after)) * 1.5))
            plans.append(Plan("transformation", service, _fit(parts)))
    show = after or ([] if shape == "transformation" else other)
    longs = [(a, s) for a, s in show if s.length >= WALK_MIN_S and s.steady]
    if shape in ("transformation", "walkthrough", "montage") and longs:
        want = quota - len(plans) if shape == "walkthrough" else math.ceil(quota * 0.25)
        for i, (aid, s) in enumerate(longs[: max(0, want)]):
            plans.append(Plan("walkthrough", service, [_piece(aid, s, min(20.0, s.length))]))
    if show:
        left = quota - len(plans)
        n = min(left, max(1, len(show) // 2)) if len(show) >= 2 else min(left, 1)
        for i in range(max(0, n)):
            picks = [show[(i * 2 + j) % len(show)] for j in range(min(4, len(show)))]
            parts = [_piece(aid, s, 3.0, (i // max(1, len(show))) * 1.0) for aid, s in picks]
            if sum(x.length for x in parts) >= 3:
                plans.append(Plan("montage", service, _fit(parts)))
    for pl in plans:
        pl.parts = [x for x in pl.parts if x.length >= 0.8]
        if pl.shape != "transformation":
            pl.parts = [x for x in pl.parts if x.state != "before"]
        while pl.parts and pl.parts[-1].state == "before":
            pl.parts.pop()
    plans = [pl for pl in plans if pl.parts and pl.length >= 3.0]
    for pl in plans:
        pl.score = plan_score(pl, sheets)
    return plans[:quota]


def plan_score(pl: Plan, sheets: list[ShotSheet]) -> float:
    qual = []
    for part in pl.parts:
        sh = next((x for x in sheets if x.asset_id == part.asset_id), None)
        s = sh.shot_at((part.start + part.end) / 2) if sh else None
        qual.append(s.quality if s else 0.5)
    bonus = {"transformation": 0.25, "walkthrough": 0.15, "montage": 0.1}.get(pl.shape, 0.0)
    base = 0.5 + bonus + 0.1 * (sum(qual) / max(1, len(qual))) if pl.service else 0.5
    return round(min(0.95, base), 3)


# ---------------------------------------------------------------- grounded copy

NEUTRAL = {
    "transformation": (["{S}: before and after", "Before and after"], ["Watch it come together", "From start to finish"], "From start to finish."),
    "walkthrough": (["Take a slow look", "{S}, up close"], ["Come take a look", "Every detail"], "A slow look at the finished result."),
    "montage": (["The little details", "{S}, up close"], ["A closer look", "Every detail counts"], "A closer look."),
    "talking": (["Real talk for a second", "Here's what to know"], ["Listen to this", "Quick one"], "A quick word."),
    "unsure": (["Have a look", "A little look at today"], ["Take a look", "Here's a look"], "Have a look."),
}


def neutral_copy(pl: Plan, profile: dict[str, str] | None, services: list[str], i: int) -> dict[str, Any]:
    """Words that only say what is sure: the service's own label and the shape. With nothing sure
    (no service) the neutral "unsure" lines. Always passes grounded_ok."""
    g = pl.ground(services)
    key = pl.shape if pl.service else "unsure"
    if key == "walkthrough" and not g.has_after:
        key = "montage"
    hooks, alts, cap = NEUTRAL.get(key, NEUTRAL["unsure"])
    svc = (pl.service or "").strip()
    def fill(t: str) -> str:
        return t.replace("{S}", svc[:1].upper() + svc[1:]) if "{S}" in t and svc else t
    pick = [fill(h) for h in hooks if "{S}" not in h or svc]
    alt_pick = [fill(h) for h in alts if "{S}" not in h or svc]
    hook = pick[i % len(pick)]
    alt = alt_pick[i % len(alt_pick)]
    cta = grounded_cta(profile, g)
    caption = f"{cap} {cta}".strip()
    own = {h.lower().lstrip("#") for h in profile_hashtags(profile)}
    tags = [h for h in profile_hashtags(profile) if hashtag_ok(h, g, own)][:5]
    if svc:
        st = "#" + re.sub(r"[^A-Za-z0-9]", "", svc.title())
        if 3 <= len(st) <= 30 and st.lower() not in [t.lower() for t in tags]:
            tags.append(st)
    out = {"hook": hook, "hook_alt": alt if alt != hook else "", "caption": caption, "hashtags": tags[:5] or ["#behindthescenes"]}
    for k in ("hook", "hook_alt", "caption"):
        if not grounded_ok(out[k], g)[0]:
            out[k] = NEUTRAL["unsure"][0][0] if k == "hook" else ("" if k == "hook_alt" else NEUTRAL["unsure"][2])
    return out


COPY_SYSTEM = (
    "You write on-screen hooks and captions for short vertical videos for one business. Each clip lists, in order, exactly what is "
    "on screen in each shot and its state (before = empty or unfinished, in_progress, after = the finished result). Write ONLY about "
    "what is listed. Never mention any service other than the clip's service. Call something finished, a reveal or an after ONLY if a "
    "shot's state is after; say before or empty ONLY if a shot's state is before. Never write people's names, addresses or prices. "
    "Never mention automation, software or how the video was made. Follow studio_rules exactly. Learn from what the owner kept and turned down (never reuse a turned-down hook). Every clip's hook must be different from every other clip's "
    "and describe that clip's own shots; do not reuse lines from the voice examples. hook and hook_alt: on-screen text, max 8 words each. caption: "
    "max 150 characters in their voice, ending with one call to action from their list. 3-5 hashtags. Answer JSON only: "
    "{\"items\":[{\"n\":int,\"hook\":str,\"hook_alt\":str,\"caption\":str,\"hashtags\":[str]}]}."
)


def copy_prompt(plans: list[Plan], profile: dict[str, str] | None, feedback: dict[int, str] | None = None, rules: dict[str, Any] | None = None, memory: dict[str, Any] | None = None) -> str:
    prof = profile or {}
    return json.dumps(
        {
            **({"studio_rules": rules} if rules else {}),
            **memory_prompt(memory),
            "voice": prof.get("voice", "")[:600],
            "do_dont": prof.get("do_dont", "")[:600],
            "off_limits": prof.get("off_limits", "")[:400],
            "calls_to_action": ctas(profile),
            "clips": [
                {
                    "n": i,
                    "service": pl.service or "not sure (do not name a service)",
                    **({"what_this_service_looks_like": service_looks(profile, [pl.service]).get(pl.service, "")} if pl.service else {}),
                    "shape": pl.shape,
                    "shots": [{"state": p.state, "what": p.what or "not sure what this shows"} for p in pl.parts],
                    **({"last_try_was_rejected_because": feedback[i]} if feedback and i in feedback else {}),
                }
                for i, pl in enumerate(plans)
            ],
        }
    )


def apply_copy(plans: list[Plan], answer: Any, profile: dict[str, str] | None, services: list[str], guard: Any = None, avoid: list[str] | None = None) -> int:
    """The model's lines where they pass grounded_ok; the neutral lines everywhere else.
    Returns how many fields fell back (logged as a count)."""
    items = {}
    if isinstance(answer, dict):
        for it in answer.get("items") or []:
            if isinstance(it, dict) and isinstance(it.get("n"), int):
                items[it["n"]] = it
    fell = 0
    own = {h.lower().lstrip("#") for h in profile_hashtags(profile)}
    # A hook she turned down before (Studio Memory) is never used again, like a hook already on another clip.
    used: set[str] = {h.lower().rstrip(".!") for h in (avoid or [])}
    for i, pl in enumerate(plans):
        g = pl.ground(services)
        base = neutral_copy(pl, profile, services, i)
        it = items.get(i, {})
        for k, limit in (("hook", 120), ("hook_alt", 120), ("caption", 300)):
            v = re.sub(r"\s+", " ", str(it.get(k, "") or "")).strip()[:limit]
            ok = bool(v) and grounded_ok(v, g)[0] and (guard is None or guard(v))
            if not pl.service and v:
                # Nothing sure: the model's words are kept only when they name no service at all.
                ok = ok and not any(t in banned_tokens(None, services, "") for t in tokens(v))
            # A dump's clips never all say the same thing: a hook already on another clip is not used again.
            if ok and k in ("hook", "hook_alt") and v.lower().rstrip(".!") in used:
                ok = False
            if ok:
                setattr(pl, k, v)
            else:
                # Layer 5: the neutral line too must pass the studio's rules (never-list, prices, addresses).
                safe = base[k] if guard is None or guard(base[k]) else (NEUTRAL["unsure"][0][0] if k == "hook" else ("" if k == "hook_alt" else NEUTRAL["unsure"][2]))
                setattr(pl, k, safe)
                fell += 1
            if k in ("hook", "hook_alt") and getattr(pl, k):
                used.add(getattr(pl, k).lower().rstrip(".!"))
        tags = [str(h) if str(h).startswith("#") else f"#{h}" for h in (it.get("hashtags") or [])]
        tags = [t for t in tags if hashtag_ok(t, g, own)]
        merged: list[str] = []
        for t in [*base["hashtags"], *tags]:
            if t.lower() not in [m.lower() for m in merged]:
                merged.append(t)
        pl.hashtags = merged[:5]
    return fell


def write_copy(key: str | None, plans: list[Plan], profile: dict[str, str] | None, services: list[str], model: str, ask: Any, feedback: dict[int, str] | None = None, guard: Any = None, rules: dict[str, Any] | None = None, memory: dict[str, Any] | None = None) -> int:
    """ONE text call for every clip of the dump (or a re-cut's clips). `ask(key, payload)` returns
    the model's text (cut.ask_text in the job, a fake in tests)."""
    answer = None
    if key and plans:
        payload = {"model": model, "max_tokens": 2500, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": COPY_SYSTEM}, {"role": "user", "content": copy_prompt(plans, profile, feedback, rules, memory)}]}
        try:
            CALLS["text"] = CALLS.get("text", 0) + 1
            text = ask(key, payload)
            m = re.search(r"\{.*\}", text or "", re.S)
            answer = json.loads(m.group(0)) if m else None
        except Exception:  # noqa: BLE001
            CALLS["failed"] = CALLS.get("failed", 0) + 1
            answer = None
    return apply_copy(plans, answer, profile, services, guard, (memory or {}).get("turned_down_hooks"))


# ---------------------------------------------------------------- speech: only talking to camera

def keep_to_camera(words: list[Any], sheet: ShotSheet | None) -> list[Any]:
    """The words said inside shots where someone talks to the camera. With no sure sheet (nobody
    could look) the words stay as the camera-sound rule left them (jobs/cut.py camera_keep)."""
    if sheet is None or sheet.source == "none":
        return words
    wins = sheet.to_camera_windows()
    return [w for w in words if any(s - 0.1 <= w.start and w.end <= e + 0.1 for s, e in wins)]


def looks_like(service: str | None, sure: bool, shape: str | None, camera: dict[str, str]) -> dict[str, Any]:
    """The dump's plain line (shared/looksLike.ts says it): service · shape · camera sound."""
    vals = set(camera.values())
    cam = "off" if vals == {"off"} else "on" if vals <= {"kept"} else "mixed"
    return {"service": service if sure else None, "shape": shape if sure else None, "camera": cam, "sure": bool(sure and service)}
