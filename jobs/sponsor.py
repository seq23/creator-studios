"""Get it sponsored (owner-approved mock-up, 23 Oct 2026): brands that would pay for, or give her
free, the experience she typed (a business studio: the event), the videos to make, and extra to-do
lines. The dated plan and the medical rules box are the Worker's (shared/sponsored.ts).

Spec (worker/jobs/sponsor.ts buildSpec):
  kind      "experience" | "event"
  ask       {title, when_month, when_label, who, notes, medical}
  profile   {who, audience, themes, deal_fit, off_limits}   her locked Brand Profile
  numbers   [{platform, followers, avg_views, engagement_rate, as_of}]  her real numbers
  location, today, max_brands
  keys      {openrouter, firecrawl}   the studio's own (free models only; Firecrawl optional)

$0 only: the keyless web search in common.Web (Firecrawl only if the studio has its own key) and the
free AI ladder in jobs/ai.py (OpenRouter free models, then the studio's Cloudflare share). With no
model answer, program pages from the search become the brands (proof = the page we saw).

Every brand's proof line must point at a search result we actually saw; a way in is only a public
business contact read off the brand's own pages (brand_finder.find_contacts), else none ("Needs a
way in"). The Worker checks it all again (cleanSponsorResult).

Result: {"firstMove", "brands", "videos", "todo", "rules", "sources", "madeBy", "calls"}
Logs: step names and counts only. Self-test (no network): python3 jobs/sponsor.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

# One run per experience she asks for: two free calls at most.
os.environ.setdefault("OPENROUTER_JOB_BUDGET", "2")

import ai as A  # noqa: E402
from brand_finder import NOT_BRANDS, find_contacts, host, is_social, root_url  # noqa: E402
from common import Job, Web, log, run  # noqa: E402

MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")
MAX_QUERIES = 6
PER_QUERY = 6
CONTACT_LOOKUPS = 8

TRAVEL = re.compile(r"\b(trip|travel|abroad|vacation|resort|cruise|island|flight|spring break|getaway|honeymoon|retreat|tour|tourism|overseas)\b", re.I)
PROGRAM_WORDS = re.compile(r"(creator program|creator hub|ambassador|affiliate|influencer program|work with us|collaborat|partner with us|press trip|fam trip|hosted creators|sponsorship)", re.I)

SYSTEM = (
    "You are a talent manager finding sponsors for ONE {noun} a {who_kind} wants paid for or given free. "
    "From the search results (each has an id, url, title, description) pick real companies that sponsor {noun}s like this: "
    "brands, hotels, tourism boards, clinics, venues, shops. Not creators, not marketplaces, not news sites. "
    "Never include anything matching the off-limits list. Use only what the results say; never invent a company, a fact or a link. "
    'Reply with JSON only: {{"firstMove": {{"text": one sentence on the single best first pitch, "by": "YYYY-MM-DD" or null}}, '
    '"brands": [{{"name", "website" (the company\'s own site), "what" (short: type · typical deal, e.g. "Family resort · comped stay"), '
    '"fit" ("best"|"good"|"try"), "why" (one plain sentence why it fits her), '
    '"proof": [{{"text": what the result says about them working with creators, "url": MUST be one of the result urls}}], '
    '"firstStep": one short sentence or null}}], '
    '"videos": [{{"title", "format" (e.g. "GRWM · 30–45 sec"), "forBrand" (a brand name above or null), "deal" ("Paid post"|"Gifted"|"Your own"), '
    '"hook" (the first line she says), "shots": [up to 5 short shot names]}}] (4 to 6 videos), '
    '"todo": [{{"text", "by": "YYYY-MM-DD" or null, "label": null or a short word}}] (up to 4 lines special to THIS {noun}, '
    'not pitching, follow-ups, media kit, contracts or #ad: those are already on her list), '
    '"rules": [up to 4 short safety or legal lines special to this {noun}, only if it is medical or cosmetic, else []]}}. '
    "Plain words for a non-technical person. No emojis. Up to {max_brands} brands, best first."
)


def queries(spec: dict[str, Any]) -> list[str]:
    ask = spec.get("ask") or {}
    title = str(ask.get("title") or "").strip()
    kind = spec.get("kind") or "experience"
    loc = str(spec.get("location") or "").strip()
    out: list[str] = []
    if kind == "event":
        out.append(f"{title} sponsors local business event sponsorship")
        if loc:
            out.append(f"{title} {loc} sponsor brands")
        out.append(f"brands that sponsor {title} events apply")
    else:
        out.append(f"{title} brand creator program")
        out.append(f'{title} influencer "#ad" OR "paid partnership" OR "hosted"')
        if TRAVEL.search(title):
            out.append(f"{title} tourism board hosts influencers press trip")
            out.append(f"hotel resort creator program free stay influencers {title}")
        if ask.get("medical"):
            out.append(f"{title} med spa influencer program gifted treatment")
            out.append(f"{title} clinic creator partnership disclosure")
        out.append(f"{title} affiliate program creators")
    seen: list[str] = []
    for q in out:
        q = re.sub(r"\s+", " ", q).strip()
        if q and q not in seen:
            seen.append(q)
    return seen[:MAX_QUERIES]


def her_numbers(spec: dict[str, Any]) -> str:
    lines = []
    for n in spec.get("numbers") or []:
        rate = n.get("engagement_rate")
        lines.append(f"{n.get('platform')}: {n.get('followers')} followers, {n.get('avg_views')} average views" + (f", {rate}% engagement" if rate is not None else ""))
    return "; ".join(lines) or "(no numbers yet)"


def rules_brands(hits: list[dict[str, Any]], max_brands: int) -> list[dict[str, Any]]:
    """Without the model: brand pages that talk about a creator / ambassador / hosted program."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for h in hits:
        url = h.get("url") or ""
        hh = host(url)
        if not hh or hh in seen or any(hh.endswith(n) for n in NOT_BRANDS):
            continue
        text = f"{h.get('title', '')} {h.get('description', '')}"
        if not PROGRAM_WORDS.search(text):
            continue
        seen.add(hh)
        name = re.split(r"\s[|\-–:·]\s", h.get("title") or "")[-1].strip() or hh.split(".")[0].title()
        out.append({"name": name[:80], "website": root_url(url), "what": "Creator program", "fit": "try", "why": "Has a program for creators.", "proof": [{"text": (h.get("description") or h.get("title") or "")[:200], "url": url}], "firstStep": None, "program_url": url})
        if len(out) >= max_brands:
            break
    return out


def way_in(web: Any, b: dict[str, Any]) -> dict[str, Any] | None:
    """A public business contact from the brand's own pages: a role address first, then a form."""
    website = b.get("website") or ""
    if not website or is_social(website):
        return None
    contacts = find_contacts(web, website, b.get("program_url"))
    for c in contacts:
        if c["kind"] == "role_email":
            return {"kind": "email", "value": c["value"], "foundOn": c["found_on_url"], "label": "Public business email"}
    for c in contacts:
        if c["kind"] == "form":
            return {"kind": "form", "value": c["value"], "foundOn": c["found_on_url"], "label": "Creator application (public)"}
    if b.get("program_url"):
        return {"kind": "page", "value": b["program_url"], "foundOn": b["program_url"], "label": "Creator program page (public)"}
    return None


def research(spec: dict[str, Any], web: Any, ask_model: Any, progress: Any = None) -> dict[str, Any]:
    ask = spec.get("ask") or {}
    kind = spec.get("kind") or "experience"
    max_brands = int(spec.get("max_brands") or 12)
    hits: list[dict[str, Any]] = []
    plan = queries(spec)
    for i, q in enumerate(plan):
        if progress:
            progress("searching", i, len(plan))
        try:
            for r in web.search(q, PER_QUERY):
                hits.append({"id": f"h{len(hits) + 1}", "url": r.get("url", ""), "title": r.get("title", ""), "description": r.get("description", "")})
        except Exception:  # noqa: BLE001  (a failed search is skipped)
            log("sponsor.search_failed")
    urls = {h["url"] for h in hits if h.get("url")}
    log("sponsor.searched", results=len(hits), searches=len(plan))

    if progress:
        progress("thinking", 0, 1)
    profile = spec.get("profile") or {}
    noun = "event" if kind == "event" else "experience"
    system = SYSTEM.format(noun=noun, who_kind="business" if kind == "event" else "creator", max_brands=max_brands)
    user = (
        f"The {noun}: {ask.get('title', '')}\nWhen: {ask.get('when_label', '')}\nWho is coming: {ask.get('who', '')}\nAnything else: {ask.get('notes', '')}\n"
        f"Today: {spec.get('today', '')}\nWhere she is: {spec.get('location', '')}\n\n"
        f"Her Brand Profile:\nWho: {str(profile.get('who', ''))[:800]}\nAudience: {profile.get('audience', '')}\nThemes: {', '.join(profile.get('themes') or [])}\n"
        f"Deals that fit: {str(profile.get('deal_fit', ''))[:400]}\nOff-limits: {', '.join(profile.get('off_limits') or [])}\n"
        f"Her numbers: {her_numbers(spec)}\n\nSearch results:\n{json.dumps(hits[:60])}"
    )
    payload = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "max_tokens": 3500, "temperature": 0.2}
    text = ask_model(payload) if hits else None
    model = A.first_json(text) if text else None

    off = [str(x).lower() for x in (profile.get("off_limits") or []) if str(x).strip()]
    brands: list[dict[str, Any]] = []
    seen: set[str] = set()
    for b in (model or {}).get("brands") or []:
        if not isinstance(b, dict) or not b.get("name"):
            continue
        name = str(b["name"])[:80]
        website = root_url(str(b.get("website") or "")) or None
        if website and any(host(website).endswith(n) for n in NOT_BRANDS):
            continue
        if any(o in name.lower() or (website and o in website.lower()) for o in off):
            continue
        proof = [p for p in (b.get("proof") or []) if isinstance(p, dict) and p.get("url") in urls and p.get("text")][:3]
        if not proof:
            continue  # nothing without a page we saw
        k = (host(website) if website else name.lower())
        if k in seen:
            continue
        seen.add(k)
        prog = next((p["url"] for p in proof if PROGRAM_WORDS.search(str(p.get("text", ""))) and website and host(p["url"]).endswith(host(website))), None)
        brands.append({"name": name, "website": website, "what": str(b.get("what") or "")[:120], "fit": b.get("fit") if b.get("fit") in ("best", "good") else "try", "why": str(b.get("why") or "")[:300], "proof": proof, "firstStep": b.get("firstStep") or None, "program_url": prog})
        if len(brands) >= max_brands:
            break
    made_by = "ai" if brands else "rules"
    if not brands:
        brands = rules_brands(hits, max_brands)

    for i, b in enumerate(brands):
        if progress:
            progress("contacts", i, len(brands))
        b["wayIn"] = way_in(web, b) if i < CONTACT_LOOKUPS else None
        b.pop("program_url", None)

    videos = [v for v in (model or {}).get("videos") or [] if isinstance(v, dict) and v.get("title") and v.get("hook")][:6]
    todo = [t for t in (model or {}).get("todo") or [] if isinstance(t, dict) and t.get("text")][:4]
    rules = [str(r) for r in (model or {}).get("rules") or [] if isinstance(r, str) and r.strip()][:4] if ask.get("medical") else []
    fm = (model or {}).get("firstMove")
    first = fm if isinstance(fm, dict) and fm.get("text") and made_by == "ai" else None
    log("sponsor.done", model=bool(model), brands=len(brands), videos=len(videos), with_way_in=sum(1 for b in brands if b.get("wayIn")))
    return {"firstMove": first, "brands": brands, "videos": videos, "todo": todo, "rules": rules, "sources": len(hits), "madeBy": made_by}


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    A.reset()
    keys = spec.get("keys") or {}
    web = Web(firecrawl_key=keys.get("firecrawl") or None, jina_key=os.environ.get("JINA_API_KEY"))
    key = keys.get("openrouter") or None

    def ask_model(payload: dict[str, Any]) -> str | None:
        text, _m = A.ask_openrouter(key, lambda model: {**payload, "model": model}, [MODEL], "text")
        return text

    out = research(spec, web, ask_model, job.progress)
    out["calls"] = A.report()
    log("sponsor.calls", **A.report())
    return out


def selftest() -> None:
    """No network: queries use her words, proof must be a result we saw, the rules pass stands in."""

    class FakeWeb:
        calls = 0

        def search(self, q: str, n: int) -> list[dict[str, str]]:
            return [
                {"url": "https://hotel.example/creators", "title": "Creator program | Example Hotel", "description": "Our creator program hosts creators for free stays."},
                {"url": "https://news.example.org/a", "title": "News", "description": "Something else"},
            ]

        def read(self, url: str) -> str:
            return "Write to creators@hotel.example to apply." if "hotel.example" in url else ""

    spec = {"kind": "experience", "ask": {"title": "Spring break trip", "when_label": "Mar 2027", "medical": False}, "profile": {"off_limits": ["vape"]}, "numbers": [], "max_brands": 12, "today": "2026-10-23"}
    qs = queries(spec)
    assert qs and all("Spring break trip" in q for q in qs) and len(qs) <= MAX_QUERIES, qs
    assert any("tourism board" in q for q in qs), qs
    silent = research(spec, FakeWeb(), lambda p: None)
    assert silent["madeBy"] == "rules" and silent["brands"], silent
    b = silent["brands"][0]
    assert b["proof"][0]["url"] == "https://hotel.example/creators", b
    assert b["wayIn"] == {"kind": "email", "value": "creators@hotel.example", "foundOn": "https://hotel.example/creators", "label": "Public business email"}, b
    invented = json.dumps({"brands": [
        {"name": "Made Up Co", "website": "https://madeup.example.net", "proof": [{"text": "hosts creators", "url": "https://madeup.example.net/x"}]},
        {"name": "Vape Brand", "website": "https://vape.example.com", "proof": [{"text": "creator program", "url": "https://hotel.example/creators"}]},
        {"name": "Example Hotel", "website": "https://hotel.example", "fit": "best", "what": "Hotel · comped stay", "proof": [{"text": "Creator program hosts creators", "url": "https://hotel.example/creators"}]},
    ], "videos": [{"title": "Hotel GRWM", "hook": "Getting ready", "shots": ["mirror"]}], "rules": ["should not appear"], "firstMove": {"text": "Pitch Example Hotel first.", "by": "2026-11-02"}})
    spoke = research(spec, FakeWeb(), lambda p: invented)
    assert [x["name"] for x in spoke["brands"]] == ["Example Hotel"], spoke["brands"]
    assert spoke["madeBy"] == "ai" and spoke["videos"][0]["title"] == "Hotel GRWM" and spoke["rules"] == [], spoke
    assert spoke["firstMove"]["by"] == "2026-11-02"
    med = research({**spec, "ask": {"title": "Botox in NYC", "medical": True}}, FakeWeb(), lambda p: invented)
    assert med["rules"] == ["should not appear"], med
    assert any("med spa" in q for q in queries({**spec, "ask": {"title": "Botox in NYC", "medical": True}}))
    ev = queries({**spec, "kind": "event", "location": "Springfield", "ask": {"title": "Holiday open house"}})
    assert any("sponsor" in q for q in ev) and any("Springfield" in q for q in ev), ev
    log("sponsor.selftest", ok=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        run(main)
