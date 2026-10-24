"""MAKE the clips an editor would (owner's studio fix, 23 Oct 2026).

Her review of a real cut: 8 clips sized to the calendar, three of them the same cut in different
looks, every one ending on a near-blank card, scores that were a shape bonus, stock words. Here:
  * plan_typed: clips by TYPE from the playbook (jobs/playbook.json), each built from its template
    (opening, length, pacing, ending, loop), one event per clip, EVERY clip ending on a hero held
    >= 2 s, blurry/shaky seconds never used, distinct cuts only (no two clips share most shots),
    as many as the footage gives up to the studio's clip_target;
  * score_clip: 0..100 from real checks with plain-English reasons (sharp, payoff in the first
    1-2 s, hero ending, call to action (only when the studio chose one), distinct, readable text,
    right length (shorter than its type's range can never pass), follows its template);
  * the words: final caption in the exact layout, the call to action with the studio's link, place
    words, some "send this to..." lines, the "Made with AI" note by the studio's rule, and
    words_pending (never stock lines) when no AI words came.
Pure functions over jobs/stages.py Looks; pinned by jobs/tests/test_studio_fix.py. No business words.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import playbook as PB  # noqa: E402
import plan as P  # noqa: E402
import script_clean as SC  # noqa: E402
import stages as S  # noqa: E402

DIVIDER = "—"
AI_NOTE = "Made with AI"
DEFAULT_TARGET = {"min": 1, "max": 20}
SHAPE_OF = {"payoff_first": "transformation", "pov_walk_in": "walkthrough", "finished_walkthrough": "walkthrough", "talk_to_camera": "talking"}
STORY = ("arrival", "prep", "team", "process", "finished", "detail")


# ---------------------------------------------------------------- the studio's rules (contract)

def studio_rules(spec: dict[str, Any], profile: dict[str, Any] | None = None) -> dict[str, Any]:
    """spec.studio_rules with sane defaults when a key is missing (an older Worker sends none)."""
    r = spec.get("studio_rules") if isinstance(spec.get("studio_rules"), dict) else {}
    old = spec.get("target_clips") or {}
    tgt = r.get("clip_target") if isinstance(r.get("clip_target"), dict) else {}
    mx = int(tgt.get("max") or old.get("max") or DEFAULT_TARGET["max"])
    mn = int(tgt.get("min") or old.get("min") or DEFAULT_TARGET["min"])
    phrases = [re.sub(r"\s+", " ", str(x)).strip()[:60] for x in (r.get("cta_phrases") or []) if str(x).strip()][:8]
    if not phrases:
        phrases = [c.strip().strip('"').rstrip(".!") for c in P.ctas(profile)][:4]
    note = str(r.get("ai_note") or "ai_images")
    return {
        "cta_phrases": phrases,
        "cta_link": str(r.get("cta_link") or "").strip()[:200],
        "ai_note": note if note in ("all", "ai_images") else "ai_images",
        "clip_target": {"min": max(1, min(mn, mx)), "max": max(1, mx)},
        "bar": max(0, min(100, int(r.get("bar") or 0))),
        "place_words": [str(x).strip()[:40] for x in (r.get("place_words") or []) if str(x).strip()][:10],
        "prices": bool(r.get("prices", False)),
    }


# ---------------------------------------------------------------- planning by type

def _piece(lk: S.Look, length: float, track: list[float], offset: float = 0.0, stage: str | None = None) -> P.Part | None:
    """`length` good seconds of a shot (blurry or shaky seconds never used), or None."""
    s0 = min(lk.end - min(length, lk.length), lk.start + max(0.0, offset))
    w = S.best_window(track, max(lk.start, s0), lk.end, min(length, lk.length)) or S.best_window(track, lk.start, lk.end, min(length, lk.length))
    if not w:
        return None
    state = "after" if (lk.stage in ("hero", "finished", "detail") and lk.shot.state in (P.UNSURE, "n/a", "after")) else lk.shot.state
    return P.Part(lk.asset_id, w[0], w[1], state, lk.shot.what, stage or lk.stage, lk.key, lk.photo)


def _pace(base: float, t: dict[str, Any], fixed: float, n: int) -> float:
    """Seconds per middle shot: the template's pace, longer when there are few shots, so the clip
    still reaches its type's minimum length (never past 4 s a shot)."""
    need = (float(t["length_s"][0]) - fixed) / max(1, n)
    return round(min(4.0, max(base, need)), 2)


def _overlap(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def body_keys(pl: P.Plan) -> set[str]:
    """The shots that make a clip what it is (the hero ending is shared on purpose and not counted)."""
    return {p.key for p in pl.parts[:-1] if p.key and p.stage != "flash"} or {p.key for p in pl.parts if p.key}


def _distinct_inside(parts: list[P.Part], looks_by_key: dict[str, S.Look]) -> list[P.Part]:
    """No picture twice in one clip: the same stretch of a shot, or another shot of the same picture
    (perceptual hash). The one echo allowed is the loop: the payoff flash and the hero ending."""
    out: list[P.Part] = []
    for i, p in enumerate(parts):
        last = i == len(parts) - 1
        lk = looks_by_key.get(p.key)
        dup = False
        for q in out:
            if last and q.stage == "flash":
                continue
            if q.key == p.key and q.start < p.end and p.start < q.end:
                dup = True
            ql = looks_by_key.get(q.key)
            if q.key != p.key and lk and ql and S.same_picture(lk.hash, ql.hash):
                dup = True
        if not dup:
            out.append(p)
    return out


def _trim(parts: list[P.Part], max_s: float) -> list[P.Part]:
    """Fit the template's length, cutting from the middle, never the hero ending."""
    if not parts:
        return parts
    hero = parts[-1]
    body = parts[:-1]
    room = max_s - hero.length
    out, total = [], 0.0
    for p in body:
        if total + p.length > room:
            left = room - total
            if left >= 1.0:
                out.append(P.Part(p.asset_id, p.start, round(p.start + left, 2), p.state, p.what, p.stage, p.key, p.photo))
            break
        out.append(p)
        total += p.length
    return [*out, hero]


# What each pool-built type draws its middle from, how many shots it takes, and whether they are
# videos (False), photos (True) or either (None).
POOLS: dict[str, tuple[list[str], int, bool | None]] = {
    "payoff_first": (["arrival", "prep", "team", "process"], 4, False),
    "set_up_with_me": (["prep", "team", "process"], 3, False),
    "team_working": (["team", "process"], 3, False),
    "prep_only": (["prep"], 3, None),
    "finished_walkthrough": (["finished", "detail", "hero"], 3, False),
    "photo_details": (["detail", "finished", "hero"], 3, None),
    "video_to_photo": (["process", "team", "finished", "hero"], 3, False),
    "photo_slideshow": (["finished", "detail", "hero", "prep", "team"], 5, True),
}
# The order types are tried in: the specific ones first, so a general type never takes the shots a
# more telling one needs (a niche playbook's own formats go first: jobs/playbook.py load).
TRY_ORDER = ["team_working", "payoff_first", "set_up_with_me", "photo_slideshow", "pov_walk_in", "prep_only", "photo_details", "video_to_photo", "finished_walkthrough", "moving_photo"]


def plan_typed(looks: list[S.Look], pb: dict[str, Any], target: dict[str, int], service: str | None, tracks: dict[str, list[float]], talk_assets: set[str] | None = None) -> list[P.Plan]:
    """Clips by type, every one ending on its event's hero, distinct, up to target['max']. Each clip
    takes the shots used least so far, so the footage spreads across as many kinds of clip as it holds."""
    hold = float(pb.get("hero_hold_s", 2.0))
    by_key = {lk.key: lk for lk in looks}
    events: dict[str, list[S.Look]] = {}
    for lk in looks:
        if lk.shot.people == "to_camera" and lk.asset_id in (talk_assets or set()):
            continue  # talking-to-camera stretches are cut from the speech (cut.py)
        events.setdefault(lk.event, []).append(lk)
    plans: list[P.Plan] = []
    chosen: list[set[str]] = []
    used: dict[str, int] = {}

    def heroes(ev: list[S.Look], photo: bool | None) -> list[S.Look]:
        return sorted([lk for lk in ev if lk.hero_rank and (photo is None or lk.photo == photo)], key=lambda x: (used.get(x.key, 0), x.hero_rank))

    def ending(ev: list[S.Look], i: int, photo: bool | None = None) -> P.Part | None:
        hs = heroes(ev, photo)
        for j in range(len(hs)):
            h = hs[(i + j) % len(hs)]
            p = _piece(h, max(hold, min(3.0, h.length)), tracks.get(h.asset_id, []), stage="hero")
            if p and p.length >= hold - 0.01:
                return p
        return None

    def take(cands: list[S.Look], n: int, i: int) -> list[S.Look]:
        """The n least-used shots (variant i rotates among equals), then in story order."""
        if not cands:
            return []
        rot = {lk.key: (k + len(cands) - i % len(cands)) % len(cands) for k, lk in enumerate(cands)}
        best = sorted(cands, key=lambda lk: (used.get(lk.key, 0), rot[lk.key]))[:n]
        return sorted(best, key=lambda lk: (STORY.index(lk.stage) if lk.stage in STORY else 9, lk.asset_id, lk.start))

    def finish(ctype: str, parts: list[P.Part], ev_id: str, single: bool = False) -> P.Plan | None:
        t = PB.template(pb, ctype)
        parts = _distinct_inside(parts, by_key)
        parts = _trim(parts, float(t["length_s"][1]))
        if not parts or parts[-1].stage != "hero" or (not single and len(parts) < 2):
            return None
        pl = P.Plan(SHAPE_OF.get(ctype, "montage"), service, parts)
        pl.clip_type, pl.event_group, pl.hero_asset_id = ctype, ev_id, parts[-1].asset_id
        if pl.shape == "transformation" and not any(p.state == "before" for p in parts):
            pl.shape = "montage"
        if pl.length < float(t["length_s"][0]) - 0.01 and ctype != "moving_photo":
            return None
        return pl

    def make(ctype: str, ev_id: str, ev: list[S.Look], i: int) -> P.Plan | None:
        t = PB.template(pb, ctype)
        fast, slow = t["pacing_s"]
        good = [lk for lk in ev if lk.quality >= S.GOOD]
        if ctype == "pov_walk_in":
            walks = [lk for lk in good if not lk.photo and lk.stage in ("finished", "hero", "detail") and lk.length >= 6.0 and lk.shot.steady]
            if not walks:
                return None
            for w in take(walks, len(walks), i):
                p = _piece(w, min(12.0, w.length), tracks.get(w.asset_id, []))
                if not p:
                    continue
                if w.hero_rank:
                    got = finish(ctype, [P.Part(p.asset_id, p.start, p.end, p.state, p.what, "hero", p.key, p.photo)], ev_id, single=True)
                else:
                    end = ending([lk for lk in ev if lk.key != w.key], i)
                    got = finish(ctype, [p, end], ev_id) if end else None
                if got:
                    return got
            return None
        if ctype == "moving_photo":
            photos = [lk for lk in good if lk.photo and lk.stage in ("hero", "finished", "detail")]
            if not photos:
                return None
            ph = take(photos, 1, i)[0]
            p = _piece(ph, min(5.0, ph.length), tracks.get(ph.asset_id, []), stage="hero" if ph.hero_rank else ph.stage)
            if not p:
                return None
            if ph.hero_rank:
                return finish(ctype, [p], ev_id, single=True)
            end = ending([lk for lk in ev if lk.key != ph.key], i, True)
            return finish(ctype, [p, end], ev_id) if end else None
        if ctype not in POOLS:
            return None
        stg, n, photo = POOLS[ctype]
        end = ending(ev, i, True if ctype in ("video_to_photo", "photo_slideshow") else None)
        if end is None:
            return None
        cands = [lk for lk in good if lk.stage in stg and lk.key != end.key and (photo is None or lk.photo == photo)]
        if ctype == "payoff_first" and not any(lk.stage in ("arrival", "prep") for lk in cands):
            return None
        if ctype == "team_working" and not any(lk.stage == "team" for lk in cands):
            return None
        if ctype == "photo_details" and sum(1 for lk in cands if lk.stage in ("detail",)) < 2:
            return None
        need = int((t.get("needs") or {}).get("middle_shots", 1))
        if ctype == "photo_slideshow":
            need = int(t.get("photos_min", 4)) - 1
        # Leave shots for the other kinds of clip: at most half the candidates (never under what the type needs).
        n = max(need, min(n, (len(cands) + 1) // 2))
        mid = take(cands, n, i)
        if ctype == "photo_slideshow":
            lead = ("hero", "finished", "detail", "prep", "team")
            mid = sorted(mid, key=lambda lk: lead.index(lk.stage) if lk.stage in lead else 9)
        if ctype == "payoff_first" and not any(lk.stage in ("arrival", "prep") for lk in mid):
            mid = take([lk for lk in cands if lk.stage in ("arrival", "prep")], 1, i) + [lk for lk in mid if lk.stage not in ("arrival", "prep")][: n - 1]
            mid = sorted(mid, key=lambda lk: STORY.index(lk.stage) if lk.stage in STORY else 9)
        if ctype == "team_working" and (not mid or mid[0].stage != "team"):
            mid = take([lk for lk in cands if lk.stage == "team"], 1, i) + [lk for lk in mid if lk.stage != "team"][: n - 1]
        if len(mid) < need:
            return None
        parts: list[P.Part] = []
        if ctype in ("payoff_first", "set_up_with_me"):
            flash = _piece(by_key[end.key], 1.2 if ctype == "payoff_first" else 1.0, tracks.get(end.asset_id, []), stage="flash")
            if flash:
                parts.append(flash)
        base = fast if ctype in ("payoff_first", "set_up_with_me", "prep_only") else (fast + slow) / 2 if ctype == "photo_slideshow" else slow
        pace = _pace(base, t, end.length + sum(p.length for p in parts), len(mid))
        for lk in mid:
            p = _piece(lk, pace, tracks.get(lk.asset_id, []), offset=(i // max(1, len(cands))) * pace)
            if p:
                parts.append(p)
        return finish(ctype, [*parts, end], ev_id)

    want = int(target.get("max") or DEFAULT_TARGET["max"])
    niche_first = [t for t in pb.get("order", []) if t in TRY_ORDER and t in (pb.get("niche_first") or [])]
    order = list(dict.fromkeys([*niche_first, *TRY_ORDER]))
    dead: set[tuple[str, str]] = set()
    progress = True
    rounds = 0
    while len(plans) < want and progress and rounds < 12:
        progress = False
        rounds += 1
        for ev_id, ev in sorted(events.items()):
            for ctype in order:
                if len(plans) >= want:
                    break
                if (ev_id, ctype) in dead:
                    continue
                made = False
                for i in range(rounds - 1, rounds + 2):
                    pl = make(ctype, ev_id, ev, i)
                    if pl is None:
                        if i == rounds - 1:
                            dead.add((ev_id, ctype))
                        break
                    keys = body_keys(pl)
                    if any(_overlap(keys, c) >= 0.5 for c in chosen):
                        continue  # shares most of its shots with a clip already made
                    plans.append(pl)
                    chosen.append(keys)
                    for p in pl.parts:
                        used[p.key] = used.get(p.key, 0) + 1
                    progress = made = True
                    break
                if not made and rounds > 1:
                    dead.add((ev_id, ctype))
    for pl in plans:
        pl.score = 0.5
    return plans


def hero_ending_part(looks: list[S.Look], event: str, tracks: dict[str, list[float]], hold: float = 2.0, i: int = 0) -> P.Part | None:
    """The hero a speech clip ends on (a talk-to-camera clip ends on the finished result too)."""
    hs = sorted([lk for lk in looks if lk.hero_rank and lk.event == event and lk.shot.people != "to_camera"], key=lambda x: x.hero_rank) or sorted([lk for lk in looks if lk.hero_rank and lk.shot.people != "to_camera"], key=lambda x: x.hero_rank)
    for j in range(len(hs)):
        h = hs[(i + j) % len(hs)]
        p = _piece(h, max(hold, min(3.0, h.length)), tracks.get(h.asset_id, []), stage="hero")
        if p and p.length >= hold - 0.01:
            return p
    return None


def counts(plans_types: list[str]) -> dict[str, Any]:
    by: dict[str, int] = {}
    for t in plans_types:
        by[t] = by.get(t, 0) + 1
    return {"distinct": len(plans_types), "by_type": by}


# ---------------------------------------------------------------- the score (0..100)

def _readable_hook(hook: str, max_words: int = 8) -> bool:
    h = (hook or "").strip()
    return bool(h) and len(h.split()) <= max(3, min(10, max_words)) and len(h) <= 56 and not SC.is_reasoning(h)


# A clip shorter than its type's range scores at most this, under any bar a studio can sensibly set,
# and jobs/cut.py hides it with its plain reason whatever the bar (never shown in Review).
SHORT_CAP = 40
# The miss for a readable hook that could pull harder (hook_points under 10).
HOOK_WEAK = "the hook could be more specific"
# A clip whose hook is a copied line of speech scores at most this (under every studio's bar of 70:
# the cut never ships one; this is the score's own guard). One still waiting for its words scores at
# most WORDS_CAP until the words pass writes them (worker/lib/wordsPass.ts adds WORDS_POINTS back).
ECHO_CAP = 55
WORDS_CAP = 80


def too_short(seconds: float, lo: float) -> bool:
    return seconds < float(lo) - 0.5


HOOK_STOP = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "my", "your", "you", "i", "is", "it", "this", "that", "me", "so", "just", "every", "day", "s"}


def hook_words(h: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9']+", (h or "").lower().replace("'s", "")) if w not in HOOK_STOP]


def near_duplicate(a: str, b: str) -> bool:
    """Two hooks that say nearly the same thing (owner, 23 Oct 2026: "Boat mornings, latte art, pure joy"
    next to "Boat mornings, latte art perfection"): the same words, half or more of them in common,
    or a shared two-word phrase."""
    wa, wb = hook_words(a), hook_words(b)
    if not wa or not wb:
        return False
    if wa == wb:
        return True
    sa, sb = set(wa), set(wb)
    if len(sa & sb) / min(len(sa), len(sb)) >= 0.5 and len(sa & sb) >= 2:
        return True
    pa = {(wa[i], wa[i + 1]) for i in range(len(wa) - 1)}
    pb_ = {(wb[i], wb[i + 1]) for i in range(len(wb) - 1)}
    return bool(pa & pb_)


def speech_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower().replace("\u2019", "'").replace("'", ""))


def echoes_speech(hook: str, said: str) -> bool:
    """A hook that is a line of what was said, not a written headline (owner, 24 Oct 2026: "Yeah,
    you're good.", "Go ahead.", "Love you, love you, love you…" and the mis-heard "Marigold's
    differing care, thank you very much." shipped as hooks and scored 94-100). True when every word
    of the hook (two or more) appears, in order and side by side, in the clip's transcript. A written
    hook that borrows one word of hers is fine; a copied line never is."""
    hw = speech_words(hook)
    if len(hw) < 2:
        return False
    sw = speech_words(said)
    n = len(hw)
    return any(sw[i : i + n] == hw for i in range(len(sw) - n + 1))


# Varied hooks in one dump (owner, 24 Oct 2026: many opened "POV:" and reused glow / instant /
# runway, which near_duplicate never caught). Twin of shared/clipWords.ts hookOpening / hookStem /
# hookVarietyProblem / hookPoints; the limits and lists are jobs/playbook.json "hook_variety"
# (guard: tests/unit/hook-variety.test.ts reads both sides).
VARIETY = PB.BASE.get("hook_variety") or {}
HOOK_OPENING_MAX = int(VARIETY.get("opening_max") or 2)
HOOK_WORD_MAX = int(VARIETY.get("word_max") or 2)


def hook_opening(h: str) -> str:
    """"pov" for any "POV:", else the first two words ("how i", "watch me")."""
    w = re.findall(r"[a-z0-9]+", (h or "").lower().replace("\u2019", "").replace("'", ""))
    if not w:
        return ""
    return "pov" if w[0] == "pov" else " ".join(w[:2])


def hook_stem(w: str) -> str:
    s = (w or "").lower().replace("'", "")
    if s.endswith("ly") and len(s) >= 5:
        return s[:-2]
    if s.endswith("ing") and len(s) >= 6:
        return s[:-3]
    if re.search(r"(ss|x|z|ch|sh)es$", s):
        return s[:-2]
    if s.endswith("s") and not s.endswith("ss") and len(s) >= 4:
        return s[:-1]
    return s


def _stems(h: str, exempt: set[str]) -> set[str]:
    return {x for x in (hook_stem(w) for w in hook_words(h)) if len(x) >= 3 and x not in exempt}


def hook_variety_problem(hook: str, others: list[str], exempt: list[str] | None = None) -> str | None:
    """Why a new hook would make its dump read alike, or None: it nearly repeats another hook, opens
    the way HOOK_OPENING_MAX others already open, or uses a word HOOK_WORD_MAX others already use
    (place words exempt)."""
    used = [o for o in others if (o or "").strip()]
    twin = next((u for u in used if near_duplicate(hook, u)), None)
    if twin:
        return f"It says nearly the same as “{twin}”."
    op = hook_opening(hook)
    same = sum(1 for u in used if hook_opening(u) == op)
    if op and same >= HOOK_OPENING_MAX:
        return f"{same} hooks already open with “{op}”."
    ex = {hook_stem(w) for e in (exempt or []) for w in hook_words(e)}
    mine = _stems(hook, ex)
    for st in dict.fromkeys(hook_stem(w) for w in hook_words(hook) if hook_stem(w) in mine):
        n = sum(1 for u in used if st in _stems(u, ex))
        if n >= HOOK_WORD_MAX:
            return f"{n} hooks already use “{next((w for w in hook_words(hook) if hook_stem(w) == st), st)}”."
    return None


HYPE = {hook_stem(str(w)) for w in VARIETY.get("hype") or []}
PULL_OPENERS = [str(w).lower() for w in VARIETY.get("pull_openers") or []]
NUMBER_WORDS = re.compile(r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b")


def hook_points(hook: str, max_words: int = 8) -> int:
    """0..10: 0 when empty or too long to read, else 6, +1 a word under the limit, +1 no vague hype
    word, +2 a pull (a number, "you", or a curiosity opener). Twin of shared/clipWords.ts hookPoints."""
    h = (hook or "").strip()
    words = h.split()
    lim = max(3, min(10, max_words))
    if not h or len(words) > lim or len(h) > 56:
        return 0
    low = h.lower().replace("\u2019", "'")
    raw = re.findall(r"[a-z0-9']+", low)
    pts = 6
    if len(words) <= lim - 1:
        pts += 1
    if not any(hook_stem(w) in HYPE for w in raw):
        pts += 1
    opener = " ".join(raw)
    pull = bool(NUMBER_WORDS.search(low)) or any(w in ("you", "your", "you'll", "you're", "you've") for w in raw) or "?" in low or any(opener == o or opener.startswith(o + " ") for o in PULL_OPENERS)
    if pull:
        pts += 2
    return pts


def copies_pattern(hook: str, patterns: list[str]) -> str | None:
    """The niche pattern a hook copies word for word (three or more of its own words in a row; "…"
    marks the part that changes), or None. Twin of shared/clipWords.ts copiesPattern."""
    def words(t: str) -> list[str]:
        return re.findall(r"[a-z0-9]+", (t or "").lower().replace("\u2019", "").replace("'", ""))
    hw = " " + " ".join(words(hook)) + " "
    for p in patterns or []:
        for seg in re.split(r"…|\.\.\.", str(p)):
            w = words(seg)
            for i in range(len(w) - 2):
                if " " + " ".join(w[i : i + 3]) + " " in hw:
                    return str(p)
    return None


def crowded_hooks(hooks: list[str], exempt: list[str] | None = None) -> list[int]:
    """The indexes whose hook makes the dump read alike next to the EARLIER kept ones (a near
    repeat, a crowded opening or a crowded word); the first ones keep theirs."""
    out: list[int] = []
    kept: list[str] = []
    for i, h in enumerate(hooks):
        if h and hook_variety_problem(h, kept, exempt):
            out.append(i)
        elif h:
            kept.append(h)
    return out


def duplicate_hooks(hooks: list[str]) -> list[int]:
    """The indexes whose hook nearly repeats an EARLIER one in the same dump (the first keeps it)."""
    out: list[int] = []
    for i, h in enumerate(hooks):
        if h and any(hooks[j] and near_duplicate(h, hooks[j]) for j in range(i) if j not in out):
            out.append(i)
    return out


def score_clip(f: dict[str, Any], pb: dict[str, Any]) -> tuple[int, list[str]]:
    """0..100 from real checks; reasons in plain English, the misses first.
    f: clip_type, parts [{stage, start, end, quality, key}], hook, caption, words_pending,
    cta_link, cta_phrases, end_card, overlap (largest share of shots with another clip), repeats."""
    t = PB.template(pb, f.get("clip_type") or "finished_walkthrough")
    parts = f.get("parts") or []
    hold = float(pb.get("hero_hold_s", 2.0))
    got: list[tuple[int, int, str, str]] = []  # (points, max, miss words, hit words)
    q = [float(p.get("quality", 1.0)) for p in parts]
    good = sum(1 for x in q if x >= S.GOOD) / max(1, len(q))
    got.append((round(20 * good), 20, "some shots are blurry or shaky", "sharp and steady throughout"))
    t0 = 0.0
    payoff = False
    payoff_at = 0.0
    window = float(pb.get("payoff_window_s", 2.0))
    for p in parts:
        if t0 > window - 0.01:
            break
        if p.get("stage") in ("hero", "flash", "finished", "detail"):
            payoff, payoff_at = True, t0
            break
        t0 += p["end"] - p["start"]
    opening_ok = bool(parts) and ("any" in t["opening"] or parts[0].get("stage") in t["opening"] or (parts[0].get("stage") == "flash" and "hero" in t["opening"]))
    # Graded by WHEN the payoff lands (owner, 24 Oct 2026: most clips scored 90): first frame is the
    # full 15, landing at the edge of the window is 10; never in the window is 8 or 0 as before.
    pay_pts = (15 - round(5 * min(1.0, payoff_at / max(0.01, window)))) if payoff else (8 if opening_ok else 0)
    got.append((pay_pts, 15, "the payoff doesn't show in the first 2 seconds" if not payoff else f"the payoff lands at {payoff_at:.1f} s, not in the first frame", "shows the payoff in the first 2 seconds"))
    last = parts[-1] if parts else {}
    hero_ok = last.get("stage") == "hero" and (last.get("end", 0) - last.get("start", 0)) >= hold - 0.01
    got.append((15 if hero_ok else 0, 15, "doesn't end on the finished result", "ends on the finished result"))
    cap = f.get("caption") or ""
    link = (f.get("cta_link") or "").strip()
    phrases = [x.lower() for x in (f.get("cta_phrases") or [])]
    if link or phrases:
        # Opt-in (owner, 23 Oct 2026): only a studio that CHOSE a call to action is checked for one.
        # With none chosen this check does not exist: never docked, never mentioned.
        in_cap = (link and link in cap) or (not link and any(ph and ph in cap.lower() for ph in phrases))
        cta_pts = (6 if in_cap else 0) + (4 if f.get("end_card", True) else 0)
        if f.get("words_pending"):
            cta_pts = 4 if f.get("end_card", True) else 0
        got.append((cta_pts, 10, "the call to action is missing" if not f.get("words_pending") else "the caption's call to action comes with its words", "call to action on screen and in the caption"))
    distinct = not f.get("repeats") and float(f.get("overlap", 0.0)) < 0.5
    got.append((10 if distinct else 0, 10, "it repeats shots", "every shot is different"))
    hook = f.get("hook") or ""
    # The score judges the words on screen (owner, 24 Oct 2026): no words yet, or a line copied
    # from the speech, earns nothing here and caps the whole score (WORDS_CAP / ECHO_CAP).
    echo = bool(hook) and not f.get("words_pending") and echoes_speech(hook, f.get("said") or "")
    if f.get("words_pending") or not hook:
        txt = 0
    elif echo:
        txt = 0
    else:
        maxw = int(pb.get("hook_max_words") or 8)
        # Graded hook strength (hook_points), not one flat 10 for every readable hook.
        txt = hook_points(hook, maxw) if _readable_hook(hook, maxw) and not SC.is_reasoning(cap) and not f.get("hook_repeats") else 5
    miss = (
        "the words are still being written" if f.get("words_pending")
        else "the hook is a line from the speech, not a written hook" if echo
        else "the hook says nearly the same as another clip's" if f.get("hook_repeats")
        else HOOK_WEAK if hook and txt > 5
        else "the on-screen words are too long or missing"
    )
    got.append((txt, 10, miss, "short, readable on-screen words"))
    total = sum(p["end"] - p["start"] for p in parts)
    lo, hi = t["length_s"]
    short = too_short(total, lo) and f.get("clip_type") != "moving_photo"
    got.append((10 if lo - 0.5 <= total <= hi + 0.5 else (0 if short else 4), 10, (f"{total:.0f} s is too short for this kind of clip (it needs at least {lo:g} s)" if short else f"{total:.0f} s is the wrong length for this kind of clip ({lo:g}-{hi:g} s)"), f"right length ({total:.0f} s)"))
    cuts = [p["end"] - p["start"] for p in parts[:-1] if p.get("stage") != "flash"]
    mean_cut = sum(cuts) / len(cuts) if cuts else 0.0
    on_pace = not cuts or (t["pacing_s"][0] <= mean_cut <= t["pacing_s"][1])
    pace_ok = not cuts or (t["pacing_s"][0] * 0.5 <= mean_cut <= t["pacing_s"][1] * 1.8)
    # Graded pacing: on its type's pace is 5, near it 3, off it 0.
    tpl = (5 if on_pace else 3 if pace_ok else 0) + (5 if opening_ok and hero_ok else 0)
    got.append((tpl, 10, "doesn't follow its clip type's pacing" if not pace_ok or not (opening_ok and hero_ok) else f"the cuts are near, not on, its type's pace ({mean_cut:.1f} s a shot)", f"follows the {t['label']} template"))
    # Out of the checks that apply (a studio with no call to action is scored out of the rest).
    score = max(0, min(100, round(100 * sum(g[0] for g in got) / max(1, sum(g[1] for g in got)))))
    if short:
        # Shorter than its type's range can never pass a bar (owner, 23 Oct 2026: a 3 s clip scored 88).
        score = min(score, SHORT_CAP)
    if echo:
        score = min(score, ECHO_CAP)
    elif f.get("words_pending") or not hook:
        score = min(score, WORDS_CAP)
    # The misses that cost the most first (a partial miss never hides the decisive one).
    misses = [g[2] for g in sorted((g for g in got if g[0] < g[1]), key=lambda g: g[0] - g[1])]
    hits = [g[3] for g in got if g[0] >= g[1]]
    reasons = [m[:1].upper() + m[1:] for m in misses] + [h[:1].upper() + h[1:] for h in hits]
    return score, reasons


# ---------------------------------------------------------------- the words

def cta_phrase(rules: dict[str, Any], k: int) -> str:
    """Rotate the studio's phrases; every third clip combines two."""
    ph = rules.get("cta_phrases") or []
    if not ph:
        return ""
    a = ph[k % len(ph)].rstrip(".!")
    if len(ph) > 1 and k % 3 == 2:
        b = ph[(k + 1) % len(ph)].rstrip(".!")
        return f"{a} or {b[:1].lower() + b[1:]}"
    return a


def cta_card(rules: dict[str, Any], k: int) -> str:
    """The call to action ON the end card: one of her phrases, rotating, never two combined. A
    combined "Get in touch with us or book your date" wrapped to three lines and ran under the
    link (23 Oct 2026, nine clips of one dump); the combined line stays in the caption."""
    ph = rules.get("cta_phrases") or []
    return ph[k % len(ph)].rstrip(".!") if ph else ""


def cta_line(rules: dict[str, Any], k: int) -> str:
    phrase = cta_phrase(rules, k)
    link = rules.get("cta_link") or ""
    if phrase and link:
        return f"{phrase}: {link}"
    return phrase or link


def wants_ai_note(rules: dict[str, Any], uses_ai_images: bool) -> bool:
    return rules.get("ai_note") == "all" or (rules.get("ai_note") == "ai_images" and uses_ai_images)


def compose_caption(body: str, cta: str, hashtags: list[str], ai_note: bool) -> str:
    """The EXACT layout (owner, 23 Oct 2026): caption body, blank line, the CTA line with the link,
    blank line, hashtags, blank line, the "—" divider, "Made with AI". Blank lines are real
    "\\n\\n"; the divider keeps the AI note apart where an app squashes blank lines."""
    blocks = [b for b in (body.strip(), cta.strip(), " ".join(h for h in hashtags if h).strip()) if b]
    out = "\n\n".join(blocks)
    if ai_note:
        out = f"{out}\n\n{DIVIDER}\n{AI_NOTE}" if out else f"{DIVIDER}\n{AI_NOTE}"
    return out


STOCK_HOOKS = {h.lower().rstrip(".!") for v in P.NEUTRAL.values() for h in [*v[0], *v[1]]}
STOCK_CAPTIONS = {v[2].lower().rstrip(".!") for v in P.NEUTRAL.values()}


def is_stock(hook: str, caption: str) -> bool:
    """A neutral fallback line (no AI words came): never shipped, the clip waits for its words."""
    h = (hook or "").lower().rstrip(".!")
    c = (caption or "").lower()
    if h in STOCK_HOOKS or re.sub(r"^[^:]+: ", "", h) in STOCK_HOOKS:
        return True
    return any(c.startswith(s) for s in STOCK_CAPTIONS) or not c.strip()


def strip_cta(body: str, rules: dict[str, Any]) -> str:
    """The caption body without a call to action of its own (the CTA line carries it, once)."""
    out = []
    phrases = [p.lower().rstrip(".!") for p in rules.get("cta_phrases") or []]
    link = (rules.get("cta_link") or "").lower()
    for s in SC.sentences(body):
        low = s.lower()
        if (link and link in low) or any(p and p in low for p in phrases):
            continue
        out.append(s)
    return " ".join(out).strip()


def place_tag(rules: dict[str, Any], text: str, tags: list[str]) -> list[str]:
    """A place word in the caption or the hashtags (local words rank): added as a tag when missing."""
    words = rules.get("place_words") or []
    low = (text + " " + " ".join(tags)).lower()
    if not words or any(w.lower() in low or re.sub(r"[^a-z0-9]", "", w.lower()) in low for w in words):
        return tags
    tag = "#" + re.sub(r"[^A-Za-z0-9]", "", words[0].title())
    return [*tags[:4], tag] if 3 <= len(tag) <= 30 else tags


def send_line(pb: dict[str, Any], k: int, body: str) -> str:
    """Some captions carry a 'send this to...' line (sends rank Reels)."""
    every = int(pb.get("send_line_every") or 3)
    if k % every != 1 or "send this" in body.lower():
        return body
    lines = pb.get("send_lines") or []
    return f"{body} {lines[(k // every) % len(lines)]}".strip() if lines else body


def final_words(m: Any, rules: dict[str, Any], pb: dict[str, Any], k: int, uses_ai_images: bool) -> dict[str, Any]:
    """The clip's caption string in the contract layout, or words_pending with no stock lines."""
    body = SC.clean_line(m.caption or "", 400)
    hook = SC.clean_line(m.hook or "", 120)
    # A line copied from the speech is never a hook (owner, 24 Oct 2026): the clip waits for its words.
    pending = bool(getattr(m, "words_pending", False)) or is_stock(hook, body) or not body or not hook or echoes_speech(hook, getattr(m, "said", "") or "")
    if pending:
        return {"caption": "", "hook_text": "", "hook_alt": None, "hashtags": [], "words_pending": True}
    body = send_line(pb, k, strip_cta(body, rules) or body)
    tags = place_tag(rules, body, list(m.hashtags or []))
    return {
        "caption": compose_caption(body, cta_line(rules, k), tags, wants_ai_note(rules, uses_ai_images)),
        "hook_text": hook,
        "hook_alt": SC.clean_line(m.hook_alt or "", 120) or None,
        "hashtags": tags,
        "words_pending": False,
    }


# ---------------------------------------------------------------- her one-tap fixes (Review)

# The keys are the interface with the Worker (shared/fixes.ts FIXES): Try another version sends
# spec.fixes, a list of these, with the same words in change_request. Guard: jobs/tests/test_studio_fix.py
# and the validator studio-engine-contract (the two lists must match).
FIX_KEYS = ("end_on_finished", "less_blur", "different_opening", "shorter", "photo_ending")


def clean_fixes(v: Any) -> list[str]:
    asked = {str(x) for x in (v if isinstance(v, list) else [])}
    return [k for k in FIX_KEYS if k in asked]


def apply_fixes(plans: list[P.Plan], fixes: list[str], by_key: dict[str, S.Look], pb: dict[str, Any], overlap: Any) -> list[P.Plan]:
    """Order (and, for "shorter", trim) the re-plans so the first one does what she tapped:
    end_on_finished: the longest-held hero ending; less_blur: the sharpest weakest shot;
    different_opening: an opening away from the version she has (overlap(part) -> 0..1);
    shorter: cut from the middle to the type's shortest length (the hero ending is kept);
    photo_ending: a clip that ends on a photo. Every plan still ends on its hero."""
    fx = set(clean_fixes(fixes))
    out: list[P.Plan] = []
    for pl in plans:
        if "shorter" in fx and pl.parts:
            t = PB.template(pb, pl.clip_type or "finished_walkthrough")
            want = max(float(t["length_s"][0]), min(pl.length * 0.6, float(t["length_s"][1])))
            parts = _trim(pl.parts, want)
            if parts and parts[-1].stage == "hero":
                pl.parts = parts
        out.append(pl)

    def quality(p: P.Part) -> float:
        lk = by_key.get(p.key)
        return float(lk.quality) if lk is not None else 0.0

    def key(pl: P.Plan) -> tuple:
        last = pl.parts[-1] if pl.parts else None
        return (
            0 if ("photo_ending" not in fx or (last is not None and last.photo)) else 1,
            -(last.length if last is not None and "end_on_finished" in fx else 0.0),
            -(min((quality(p) for p in pl.parts), default=0.0) if "less_blur" in fx else 0.0),
            overlap(pl.parts[0]) if pl.parts and "different_opening" in fx else 0.0,
            pl.length if "shorter" in fx else 0.0,
            sum(overlap(p) for p in pl.parts),
        )

    return sorted(out, key=key)
