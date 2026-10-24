"""What converts in this studio's niche, researched monthly (studio fix, 23 Oct 2026).

Spec (worker/jobs/niche.ts buildSpec):
  profile      {who, audience, themes, ctas}   the locked Brand Profile's own words
  services     ["…"]                           the services its footage shows (shared/services.ts)
  place_words  ["…"]                           the studio's local words (Settings > Your clips)
  platforms    ["tiktok", …]
  llm_key      the studio's OpenRouter key (free models only), or null

$0 only: the keyless web search in common.Web (Firecrawl only if the studio has its own key) and
the free AI ladder in jobs/ai.py (OpenRouter free models, then the studio's Cloudflare share). When
no model answers, the playbook is built from the research baseline below with the studio's own
words in it, so a month never passes with nothing.

Clip quality (owner, 23 Oct 2026): this is the DEFAULT style for every studio until she uploads
"My past videos" (then those lead and this supports). For a creator it studies successful PUBLIC
creators in her niche (from her Brand Profile): how they open (the payoff in the first 2 s), hook
patterns, clip lengths per kind of clip, pacing, on-screen word length and caption style. Public
data only, patterns only: never another creator's content or words. A call-to-action tip only when
the studio chose a call to action (spec.has_cta; calls to action are opt-in).

Result: {"playbook": {"formats": [...], "hooks": [...], "caption_tips": [...], "openings": [...],
                      "lengths": {clip_type: [lo, hi]}, "pacing": "...", "on_screen_words": n,
                      "caption_style": "..."},
         "summary": ["…"], "sources": n, "calls": {...}}
The Worker checks and stores it (worker/lib/niche.ts). Logs: step names and counts only.
Self-test (no network): python3 jobs/niche_research.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

# One run a month per studio: two free calls at most, so the shared daily quota is barely touched.
os.environ.setdefault("OPENROUTER_JOB_BUDGET", "2")

import ai as A  # noqa: E402
from common import Job, Web, log, run  # noqa: E402

MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")
MAX_QUERIES = 4
PER_QUERY = 5

# The research baseline (owner's playbook, 23 Oct 2026): what converts on short video for a local
# service business. {service} and {place} are filled from the studio's own words.
BASE_FORMATS = [
    "Payoff first: flash the finished {service} in the first second, then empty, building, reveal",
    "POV walk-in reveal of a finished {service}",
    "Set up with me, sped up, ending on the finished look held for two seconds",
    "Photo slideshow of one event: 4 to 6 photos, strongest last",
    "Team on camera while they work (original footage is ranked up)",
]
BASE_HOOKS = [
    "POV: you walk in and see this",
    "From empty to finished in 20 seconds",
    "Wait for the reveal",
    "{place} {service}, start to finish",
]
BASE_TIPS = [
    "Say {place} in the first line of the caption and on screen",
    "Add a 'send this to someone who needs it' line: sends and saves count more than likes",
    "Keep clips 7 to 30 seconds; reveals 20 to 40",
]

# A creator's baseline (no services to sell): what the public research on short-video creators says.
CREATOR_FORMATS = [
    "Payoff first: open on the best moment (the finished look, the view, the reaction), then how it happened",
    "Talking to camera with the point in the first line, cut tight between sentences",
    "Get ready with me or a day-in-the-life, sped up, ending on the finished look",
    "A few quick close-ups of one thing, the best one first",
]
CREATOR_HOOKS = [
    "POV: …",
    "The one thing I … every …",
    "How I … in under a minute",
    "You asked, so here is …",
]
CREATOR_OPENINGS = [
    "The best moment comes first, in the first second, before any setup",
    "The first words say what the viewer gets",
    "Movement or a face in the first frame, never a still, empty shot",
]
CREATOR_TIPS = [
    "Write the caption the way she talks, one or two short lines",
    "Ask a real question or add a 'send this to …' line: sends and saves count more than likes",
]
CTA_TIP = "End with her own call to action, once"
LENGTHS = {"talk_to_camera": [10, 45], "finished_walkthrough": [8, 30], "pov_walk_in": [8, 25], "payoff_first": [9, 30], "photo_slideshow": [8, 20]}
PACING = "A new shot every 1.5 to 3 seconds before the payoff, slower after it"
ON_SCREEN_WORDS = 7
CAPTION_STYLE = "Short and personal, in her own words, no slogans"

SYSTEM_CREATOR = (
    "You study what makes short social videos work for successful PUBLIC creators in one niche, from the search results "
    "you are given and the baseline. Learn PATTERNS only (how they open, hook shapes, lengths, pacing, how many words on "
    "screen, caption style); never copy any creator's content or words, never name other creators or brands. Plain words "
    "for a non-technical owner, no jargon, no emojis, no prices. "
    'Reply with JSON only: {"formats": [up to 5 short lines], "openings": [up to 4 lines: how the best ones open, the payoff in the first 2 seconds], '
    '"hooks": [up to 5 hook PATTERNS with … for the part that changes], "lengths": {"talk_to_camera": [min, max], "finished_walkthrough": [min, max], '
    '"pov_walk_in": [min, max], "payoff_first": [min, max], "photo_slideshow": [min, max]} in seconds, "pacing": "one line", '
    '"on_screen_words": max words of on-screen text, "caption_style": "one line", "caption_tips": [up to 4 short lines], '
    '"summary": [3 plain sentences telling her what the studio learned]}.'
)

SYSTEM = (
    "You study what makes short social videos turn viewers into customers for one kind of business. "
    "From the search results you are given and the playbook baseline, pick what works for THIS business. "
    "Plain words for a non-technical owner, no jargon, no emojis, no prices, no brand names of other businesses. "
    'Reply with JSON only: {"formats": [up to 5 short lines], "hooks": [up to 5 opening lines], '
    '"caption_tips": [up to 5 short lines], "summary": [3 plain sentences for a monthly note to the owner]}.'
)


def first_or(items: list[str], fallback: str) -> str:
    return next((x for x in items if x and x.strip()), fallback)


def fill(lines: list[str], service: str, place: str) -> list[str]:
    out = []
    for line in lines:
        t = line.replace("{service}", service).replace("{place}", place or "your town")
        out.append(re.sub(r"\s+", " ", t).strip())
    return out


def is_creator(spec: dict[str, Any]) -> bool:
    """A creator studio (no services it sells on camera): the niche is researched through public creators."""
    if spec.get("creator") is not None:
        return bool(spec.get("creator"))
    who = str((spec.get("profile") or {}).get("who") or "").lower()
    return bool(re.search(r"\bcreator|influencer|content\b", who))


def niche_words(spec: dict[str, Any]) -> list[str]:
    """Her niche in her profile's own words: the examples in each theme ("OOTDs, fashion takes")."""
    out: list[str] = []
    for line in str((spec.get("profile") or {}).get("themes") or "").splitlines():
        t = line.strip(" -•\t")
        if not t:
            continue
        head, _, rest = t.partition(":")
        first = (rest.split(",")[0] if rest else head).strip()
        if first and first.lower() not in (x.lower() for x in out):
            out.append(first[:40])
    return out[:3]


def creator_queries(spec: dict[str, Any]) -> list[str]:
    words = niche_words(spec) or ["lifestyle"]
    out = [f"successful {w} creators tiktok hooks first 2 seconds" for w in words[:2]]
    out.append(f"{words[0]} reels ideal length pacing on-screen text")
    out.append("short video creators how to open payoff first hook patterns")
    return list(dict.fromkeys(out))[:MAX_QUERIES]


def queries(spec: dict[str, Any]) -> list[str]:
    """A few searches in the profile's own words: the services, the town, the platforms."""
    services = [s for s in (spec.get("services") or []) if isinstance(s, str) and s.strip()][:3]
    if not services:
        themes = str((spec.get("profile") or {}).get("themes") or "")
        services = [t.strip(" -•").split(":")[0] for t in themes.splitlines() if t.strip()][:2]
    place = first_or([p for p in (spec.get("place_words") or []) if isinstance(p, str)], "")
    out: list[str] = []
    for s in services or ["local service business"]:
        out.append(f"{s} instagram reels ideas that get bookings")
        out.append(f"{s} tiktok video hooks that convert")
    if place and services:
        out.append(f"{services[0]} {place} social media")
    out.append("short video marketing what converts local service business saves shares")
    seen: list[str] = []
    for q in out:
        if q not in seen:
            seen.append(q)
    return seen[:MAX_QUERIES]


def creator_baseline(spec: dict[str, Any]) -> dict[str, Any]:
    tips = [*CREATOR_TIPS, *([CTA_TIP] if spec.get("has_cta") else [])]
    return {
        "formats": list(CREATOR_FORMATS), "hooks": list(CREATOR_HOOKS), "caption_tips": tips, "openings": list(CREATOR_OPENINGS),
        "lengths": {k: list(v) for k, v in LENGTHS.items()}, "pacing": PACING, "on_screen_words": ON_SCREEN_WORDS, "caption_style": CAPTION_STYLE,
        "summary": [
            "Creators who do well in your niche show the best moment in the first second, before any setup.",
            f"Their on-screen words are short: {ON_SCREEN_WORDS} words or fewer, in their own voice.",
            "Talking clips run about 10 to 45 seconds; quick looks 8 to 30. Your clips now follow this.",
        ],
    }


def baseline(spec: dict[str, Any]) -> dict[str, Any]:
    if is_creator(spec):
        return creator_baseline(spec)
    service = first_or([s for s in (spec.get("services") or []) if isinstance(s, str)], "result")
    place = first_or([p for p in (spec.get("place_words") or []) if isinstance(p, str)], "")
    formats = fill(BASE_FORMATS, service.lower(), place)
    hooks = fill(BASE_HOOKS, service.lower(), place)
    tips = fill(BASE_TIPS, service.lower(), place)
    return {
        "formats": formats,
        "hooks": hooks,
        "caption_tips": tips,
        "openings": ["The finished result in the first second, then how it came together"],
        "lengths": {}, "pacing": PACING, "on_screen_words": ON_SCREEN_WORDS, "caption_style": "",
        "summary": [
            "Show the finished result in the first second, then how it came together.",
            f"Openings like “{hooks[0]}” keep people watching.",
            tips[0] + (", and end with your request link." if spec.get("has_cta") else "."),
        ],
    }


def clean_list(v: Any, n: int, chars: int) -> list[str]:
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        if isinstance(x, str) and x.strip():
            out.append(re.sub(r"\s+", " ", x).strip()[:chars])
    return out[:n]


def clean_lengths(v: Any) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    if isinstance(v, dict):
        for k, r in v.items():
            if isinstance(k, str) and re.fullmatch(r"[a-z_]{3,30}", k) and isinstance(r, list) and len(r) == 2:
                try:
                    lo, hi = int(float(r[0])), int(float(r[1]))
                except (TypeError, ValueError):
                    continue
                if 3 <= lo < hi <= 90:
                    out[k] = [lo, hi]
    return out


def clean_int(v: Any, lo: int, hi: int) -> int | None:
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n if lo <= n <= hi else None


def clean_text(v: Any, chars: int) -> str:
    return re.sub(r"\s+", " ", v).strip()[:chars] if isinstance(v, str) else ""


CTA_WORDS = re.compile(r"call to action|link in bio|request link|book now|follow for more", re.I)


def merge(model: dict[str, Any] | None, base: dict[str, Any], has_cta: bool = False) -> dict[str, Any]:
    """The model's picks first, the baseline filling anything it left empty. Calls to action are
    opt-in: with none chosen, no tip ever tells her clips to ask for one."""
    m = model or {}
    tips = clean_list(m.get("caption_tips"), 5, 160) or base["caption_tips"]
    if not has_cta:
        tips = [t for t in tips if not CTA_WORDS.search(t)] or [t for t in base["caption_tips"] if not CTA_WORDS.search(t)]
    return {
        "formats": clean_list(m.get("formats"), 5, 160) or base["formats"],
        "hooks": clean_list(m.get("hooks"), 5, 120) or base["hooks"],
        "caption_tips": tips,
        "openings": clean_list(m.get("openings"), 4, 160) or base.get("openings", []),
        "lengths": {**base.get("lengths", {}), **clean_lengths(m.get("lengths"))},
        "pacing": clean_text(m.get("pacing"), 200) or base.get("pacing", ""),
        "on_screen_words": clean_int(m.get("on_screen_words"), 3, 12) or base.get("on_screen_words") or ON_SCREEN_WORDS,
        "caption_style": clean_text(m.get("caption_style"), 200) or base.get("caption_style", ""),
        "summary": clean_list(m.get("summary"), 3, 200) or base["summary"],
    }


def research(spec: dict[str, Any], web: Any, ask: Any) -> dict[str, Any]:
    results: list[dict[str, str]] = []
    creator = is_creator(spec)
    for q in (creator_queries(spec) if creator else queries(spec)):
        try:
            results.extend(web.search(q, PER_QUERY))
        except Exception:  # noqa: BLE001  (a search that fails is skipped; the baseline still stands)
            log("niche.search_failed")
    log("niche.searched", results=len(results))
    base = baseline(spec)
    snippets = "\n".join(f"- {r.get('title', '')[:120]}: {r.get('description', '')[:300]}" for r in results[:20])
    profile = spec.get("profile") or {}
    user = (
        f"The business, in its own words:\nWho: {str(profile.get('who', ''))[:800]}\nAudience: {str(profile.get('audience', ''))[:600]}\n"
        f"Services: {', '.join(spec.get('services') or [])}\nTown words: {', '.join(spec.get('place_words') or [])}\n"
        f"Platforms: {', '.join(spec.get('platforms') or [])}\n\nBaseline playbook:\n{json.dumps({k: base[k] for k in ('formats', 'hooks', 'caption_tips')})}\n\n"
        f"Search results:\n{snippets or '(none this month)'}"
    )
    if creator:
        user = (
            f"The creator, in her own words:\nWho: {str(profile.get('who', ''))[:800]}\nAudience: {str(profile.get('audience', ''))[:600]}\n"
            f"Her niche: {', '.join(niche_words(spec))}\nThemes: {str(profile.get('themes', ''))[:600]}\nPlatforms: {', '.join(spec.get('platforms') or [])}\n\n"
            f"Baseline:\n{json.dumps({k: base[k] for k in ('formats', 'openings', 'hooks', 'lengths', 'pacing', 'on_screen_words', 'caption_style')})}\n\n"
            f"Search results (public):\n{snippets or '(none this month)'}"
        )
    payload = {"messages": [{"role": "system", "content": SYSTEM_CREATOR if creator else SYSTEM}, {"role": "user", "content": user}], "max_tokens": 1200, "temperature": 0.3}
    text = ask(payload)
    model = A.first_json(text) if text else None
    out = merge(model, base, bool(spec.get("has_cta")))
    log("niche.done", model=bool(model), formats=len(out["formats"]), hooks=len(out["hooks"]), tips=len(out["caption_tips"]))
    return {
        "playbook": {k: out[k] for k in ("formats", "hooks", "caption_tips", "openings", "lengths", "pacing", "on_screen_words", "caption_style")},
        "summary": out["summary"],
        "sources": len(results),
    }


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    A.reset()
    web = Web(firecrawl_key=None, jina_key=os.environ.get("JINA_API_KEY"))
    key = spec.get("llm_key") or None

    def ask(payload: dict[str, Any]) -> str | None:
        text, _m = A.ask_openrouter(key, lambda model: {**payload, "model": model}, [MODEL], "text")
        return text

    out = research(spec, web, ask)
    out["calls"] = A.report()
    log("niche.calls", **A.report())
    return out


def selftest() -> None:
    """No network: the queries use the profile's words, the baseline fills a silent model, a model answer wins."""

    class FakeWeb:
        def search(self, q: str, n: int) -> list[dict[str, str]]:
            return [{"url": "https://example.com/a", "title": "Ideas", "description": "Show the reveal first"}]

    spec = {"profile": {"who": "We design gardens", "themes": "Gardens"}, "services": ["Garden design"], "place_words": ["Springfield"], "platforms": ["tiktok"]}
    qs = queries(spec)
    assert qs and all("Garden design" in q or "local service" in q for q in qs), qs
    assert len(qs) <= MAX_QUERIES
    silent = research(spec, FakeWeb(), lambda p: None)
    assert silent["playbook"]["formats"][0].startswith("Payoff first"), silent
    assert "garden design" in silent["playbook"]["formats"][0]
    assert any("Springfield" in t for t in silent["playbook"]["caption_tips"]), silent
    assert len(silent["summary"]) == 3 and silent["sources"] == len(qs)
    answer = json.dumps({"formats": ["Reveal first"], "hooks": [], "caption_tips": ["Name the town"], "summary": ["One.", "Two."]})
    spoke = research(spec, FakeWeb(), lambda p: answer)
    assert spoke["playbook"]["formats"] == ["Reveal first"] and spoke["playbook"]["hooks"] == silent["playbook"]["hooks"], spoke
    assert spoke["summary"] == ["One.", "Two."]
    # A creator: public creators in HER niche, every field of the style, no call-to-action tip when none was chosen.
    cspec = {"profile": {"who": "A content creator in Brooklyn", "themes": "• Style Identity: OOTDs, fashion takes\n• Beauty: GRWMs, skincare"}, "services": [], "platforms": ["tiktok"]}
    cq = creator_queries(cspec)
    assert is_creator(cspec) and any("OOTDs" in q for q in cq) and len(cq) <= MAX_QUERIES, cq
    cs = research(cspec, FakeWeb(), lambda p: None)
    pbk = cs["playbook"]
    assert pbk["openings"] and pbk["lengths"]["talk_to_camera"] == [10, 45] and pbk["on_screen_words"] == ON_SCREEN_WORDS and pbk["pacing"] and pbk["caption_style"], pbk
    assert not any(CTA_WORDS.search(t) for t in pbk["caption_tips"]), pbk
    junk = json.dumps({"caption_tips": ["End with a call to action"], "lengths": {"talk_to_camera": [1, 500], "pov_walk_in": [10, 20]}, "on_screen_words": 99})
    cj = research(cspec, FakeWeb(), lambda p: junk)["playbook"]
    assert cj["lengths"]["talk_to_camera"] == [10, 45] and cj["lengths"]["pov_walk_in"] == [10, 20] and cj["on_screen_words"] == ON_SCREEN_WORDS, cj
    assert not any(CTA_WORDS.search(t) for t in cj["caption_tips"]), cj
    log("niche.selftest", ok=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        run(main)
