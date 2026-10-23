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

Result: {"playbook": {"formats": [...], "hooks": [...], "caption_tips": [...]},
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
    "End with one call to action and the request link, not a phone number",
    "Add a 'send this to someone who needs it' line: sends and saves count more than likes",
    "Keep clips 7 to 30 seconds; reveals 20 to 40",
]

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


def baseline(spec: dict[str, Any]) -> dict[str, Any]:
    service = first_or([s for s in (spec.get("services") or []) if isinstance(s, str)], "result")
    place = first_or([p for p in (spec.get("place_words") or []) if isinstance(p, str)], "")
    formats = fill(BASE_FORMATS, service.lower(), place)
    hooks = fill(BASE_HOOKS, service.lower(), place)
    tips = fill(BASE_TIPS, service.lower(), place)
    return {
        "formats": formats,
        "hooks": hooks,
        "caption_tips": tips,
        "summary": [
            "Show the finished result in the first second, then how it came together.",
            f"Openings like “{hooks[0]}” keep people watching.",
            tips[0] + ", and end with your request link.",
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


def merge(model: dict[str, Any] | None, base: dict[str, Any]) -> dict[str, Any]:
    """The model's picks first, the baseline filling any list it left empty."""
    m = model or {}
    return {
        "formats": clean_list(m.get("formats"), 5, 160) or base["formats"],
        "hooks": clean_list(m.get("hooks"), 5, 120) or base["hooks"],
        "caption_tips": clean_list(m.get("caption_tips"), 5, 160) or base["caption_tips"],
        "summary": clean_list(m.get("summary"), 3, 200) or base["summary"],
    }


def research(spec: dict[str, Any], web: Any, ask: Any) -> dict[str, Any]:
    results: list[dict[str, str]] = []
    for q in queries(spec):
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
    payload = {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], "max_tokens": 900, "temperature": 0.3}
    text = ask(payload)
    model = A.first_json(text) if text else None
    out = merge(model, base)
    log("niche.done", model=bool(model), formats=len(out["formats"]), hooks=len(out["hooks"]), tips=len(out["caption_tips"]))
    return {
        "playbook": {"formats": out["formats"], "hooks": out["hooks"], "caption_tips": out["caption_tips"]},
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
    log("niche.selftest", ok=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        run(main)
