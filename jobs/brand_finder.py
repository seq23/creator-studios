"""Brand finder + public contact finder (section 12b.2-3; owner, 26 Sep 2026: "an emphasis on
finding brands to give you $$").

Sources, all read from PUBLIC pages and search results (never a logged-in Instagram or TikTok
page; social links are used only as the search engine lists them):
  1. brands she listed herself (find their contact route);
  2. brands already paying creators in her niche: sponsored / #ad / paid-partnership posts by
     creators near her size in hosting, tablescape, home, entertaining and lifestyle, and by the
     comparable creators in her Research Brief;
  3. brands with creator / ambassador / affiliate programs ("work with us", "creator program");
  4. local money: event venues, rental companies, florists and party vendors near her that hire
     creators (only when her kit has a location);
  5. agencies that book creators (open rosters, brand-side agencies in her niche): kind "agency".

Every brand carries: kind, a budget signal (paying / likely / unproven) with evidence lines,
"why this brand" lines, and source links, each a URL we actually saw. The Worker drops anything
without a source, anything off-limits, and anything she declined, lost or hid.

Web access goes through common.Web: Firecrawl when she connected it, else the free keyless
search and reader (see common.Web). No key is required. The model is called only
through common.openrouter_content; without an OpenRouter key a rules pass keeps program pages.

Modes: "full" (weekly, Find brands now: up to 30 searches) and "daily" (8 searches, one source
group per day, rotating), inside the free budgets.

Logs: step names and counts only (common.log). No brand names, links or addresses.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
from typing import Any
from urllib.parse import urljoin, urlparse

from common import Job, Web, json_object_in, log, openrouter_content, run

HUNTER = "https://api.hunter.io/v2/domain-search"
MODEL = "openrouter/free"

ROLE_WORDS = {
    "partnerships", "partnership", "partners", "partner", "collab", "collabs", "collaborations",
    "influencer", "influencers", "creators", "creator", "ambassadors", "ambassador", "affiliates",
    "affiliate", "sponsorships", "sponsorship", "pr", "press", "media", "marketing", "brand",
    "brands", "social", "hello", "hi", "info", "contact", "team", "talent", "business", "bookings",
}
FREE_MAIL = {"gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"}
EMAIL_RE = re.compile(r"[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PROGRAM_PATHS = ["/pages/creators", "/creators", "/pages/affiliates", "/affiliates", "/ambassadors", "/pages/ambassador", "/partnerships", "/collaborations", "/pages/contact", "/contact", "/press"]
FORM_HINT = re.compile(r"(apply|application|creator|ambassador|affiliate|influencer|partner)", re.I)
# Hosts that are never "a brand" and whose pages we never fetch (logged-in walls, marketplaces, news).
SOCIAL = ("instagram.com", "tiktok.com", "facebook.com", "youtube.com", "pinterest.com", "x.com", "twitter.com", "threads.net", "linkedin.com")
NOT_BRANDS = SOCIAL + ("amazon.com", "etsy.com", "ltk.app", "shopltk.com", "shopmy.us", "collabstr.com", "aspire.io", "grin.co", "reddit.com", "wikipedia.org", "medium.com", "forbes.com", "nytimes.com", "duckduckgo")
PAID_WORDS = re.compile(r"(#ad\b|#sponsored|paid partnership|sponsored by|in partnership with|#partner\b|ad \|)", re.I)
PROGRAM_WORDS = re.compile(r"(creator program|ambassador|affiliate|influencer program|work with us|collaborat|partner with us)", re.I)


def is_role_email(addr: str) -> bool:
    m = re.fullmatch(r"([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})", addr.strip().lower())
    if not m:
        return False
    local, domain = m.group(1).split("+")[0], m.group(2)
    if domain in FREE_MAIL:
        return False
    return any(p in ROLE_WORDS for p in re.split(r"[._-]", local))


def host(url: str | None) -> str:
    if not url:
        return ""
    return (urlparse(url if "://" in url else f"https://{url}").hostname or "").removeprefix("www.")


def root_url(url: str) -> str:
    h = host(url)
    return f"https://{h}/" if h else ""


def is_social(url: str) -> bool:
    return any(host(url).endswith(s) for s in SOCIAL)


def llm(key: str | None, system: str, user: str) -> dict[str, Any] | None:
    if not key:
        return None
    try:
        text, _ = openrouter_content(key, {"model": MODEL, "max_tokens": 3000, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}, timeout=120, usable=json_object_in)
    except urllib.error.HTTPError as e:
        log("llm.error", status=e.code)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError):
        log("llm.error", kind="network")
        return None
    try:
        return json.loads(text[text.index("{"): text.rindex("}") + 1])
    except (KeyError, ValueError, IndexError):
        log("llm.unparsed")
        return None


def queries(spec: dict[str, Any]) -> list[tuple[str, str]]:
    """(group, query) pairs, money-first. Groups: paying, program, local, agency."""
    themes: list[str] = [str(t) for t in (spec.get("themes") or [])][:4] or ["hosting"]
    niche = spec.get("niche_words") or ["hosting", "tablescape", "home", "entertaining", "lifestyle"]
    out: list[tuple[str, str]] = []
    for c in (spec.get("comparable_creators") or [])[:4]:
        h = str(c.get("handle", "")).lstrip("@")
        if h:
            out.append(("paying", f'"{h}" ("#ad" OR "paid partnership" OR "sponsored")'))
    for w in niche[:5]:
        out.append(("paying", f'{w} creator "#ad" "paid partnership" brand'))
    for t in themes:
        out.append(("program", f"{t} brand creator program OR ambassador program OR \"work with us\" influencer"))
    out.append(("program", "home decor tableware brand influencer program apply"))
    loc = (spec.get("location") or "").strip()
    if loc:
        for v in ("event rentals", "florist", "wedding venue", "party rentals"):
            out.append(("local", f"{v} {loc} content creator collaboration"))
    out.append(("agency", "influencer agency home lifestyle creators roster apply"))
    out.append(("agency", "talent agency lifestyle creators accepting submissions home decor"))
    return out


def pick_queries(spec: dict[str, Any]) -> list[tuple[str, str]]:
    qs = queries(spec)
    budget = int(spec.get("search_budget") or 30)
    if spec.get("mode") == "daily":
        groups = ["paying", "program", "local", "agency"]
        today = groups[int(spec.get("day_of_year") or 0) % len(groups)]
        mine = [q for q in qs if q[0] == today] or [q for q in qs if q[0] == "paying"]
        return mine[:budget]
    return qs[:budget]


def find_contacts(web: Web, website: str, program_url: str | None) -> list[dict[str, str]]:
    """Form -> role email on the brand's own site. Only what is published on a page we read."""
    contacts: list[dict[str, str]] = []
    seen: set[str] = set()
    base = root_url(website)
    if not base:
        return contacts
    brand_host = host(base)
    pages = ([program_url] if program_url and not is_social(program_url) else []) + [urljoin(base, p) for p in PROGRAM_PATHS]
    for page in pages[:5]:
        text = web.read(page)
        if not text.strip():
            continue
        for link in re.findall(r"https?://[^\s)\"'>\]]+", text):
            if FORM_HINT.search(link) and host(link).endswith(brand_host) and link not in seen and ("apply" in link.lower() or "form" in link.lower()):
                contacts.append({"kind": "form", "value": link, "found_on_url": page})
                seen.add(link)
                break
        for addr in EMAIL_RE.findall(text):
            a = addr.lower().rstrip(".")
            if a in seen or not is_role_email(a):
                continue
            kind = "role_email" if a.split("@")[1].endswith(brand_host) else "agency"
            contacts.append({"kind": kind, "value": a, "found_on_url": page})
            seen.add(a)
        if any(c["kind"] == "form" for c in contacts) and any(c["kind"] == "role_email" for c in contacts):
            break
    return contacts


def hunter_role_emails(key: str, domain: str) -> list[dict[str, str]]:
    import requests

    try:
        r = requests.get(HUNTER, params={"domain": domain, "type": "generic", "limit": 5, "api_key": key}, timeout=30)
    except requests.RequestException:
        return []
    if r.status_code in (401, 403):
        raise RuntimeError("hunter_key_invalid")
    if r.status_code >= 400:
        log("hunter.error", status=r.status_code)
        return []
    out = []
    for e in (r.json().get("data") or {}).get("emails") or []:
        addr = (e.get("value") or "").lower()
        sources = e.get("sources") or []
        page = sources[0].get("uri") if sources else None
        if addr and page and is_role_email(addr):
            out.append({"kind": "role_email", "value": addr, "found_on_url": page})
    return out


SYSTEM = (
    "You pick brands that pay creators, for a home / hosting / tablescape / lifestyle creator. From the search results "
    "(each has an id, url, title, description, group), list real companies: brands, local vendors (group local), or "
    "agencies that book creators (group agency). Not creators, not marketplaces, not news sites. Never include anything "
    "matching the off-limits list. For each: name, website (the company's own site), kind (brand|agency|local), "
    "budget_level (paying = evidence they paid a creator: #ad, paid partnership, sponsored, a paid creator program; "
    "likely = a creator/ambassador/affiliate program or open roster with no pay shown; unproven = neither), "
    "evidence: [{text, url}] quoting what the result says (url MUST be one of the result urls), "
    "why: [{text, url}] one line on why this brand fits her now (url MUST be one of the result urls), "
    "fit_score 0-100 against her themes, fit_reasons (short plain sentences), categories, program_url or null. "
    'Answer JSON: {"brands":[...]}. Use only what the results say; never invent.'
)


def rules_pass(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Without the model: keep program pages on brand sites (budget 'likely'), with the result as evidence."""
    out = []
    for h in hits:
        url = h.get("url") or ""
        if h.get("group") not in ("program", "agency", "local") or any(host(url).endswith(n) for n in NOT_BRANDS):
            continue
        text = f"{h.get('title', '')} {h.get('description', '')}"
        if not PROGRAM_WORDS.search(text):
            continue
        name = re.split(r"\s[|\-–:·]\s", h.get("title") or "")[-1].strip() or host(url).split(".")[0].title()
        ev = [{"text": (h.get("description") or h.get("title") or "")[:180], "url": url}]
        out.append({"name": name[:80], "website": root_url(url), "kind": "agency" if h["group"] == "agency" else "local" if h["group"] == "local" else "brand", "budget_level": "likely", "evidence": ev, "why": ev, "fit_score": 60, "fit_reasons": ["Has a creator program in your niche."], "categories": [], "program_url": url})
    return out


def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    keys = spec.get("keys") or {}
    web = Web(firecrawl_key=keys.get("firecrawl") or os.environ.get("FIRECRAWL_API_KEY"), jina_key=os.environ.get("JINA_API_KEY"))
    or_key = keys.get("openrouter") or os.environ.get("OPENROUTER_API_KEY")
    hunter_key = keys.get("hunter")
    hunter_left = spec.get("hunter_credits_left")
    her_list = spec.get("her_list") or []
    known = set(spec.get("known_brands") or [])
    never = set(spec.get("never_again") or [])
    max_brands = int(spec.get("max_brands") or 12)

    hits: list[dict[str, Any]] = []
    plan = pick_queries(spec)
    for i, (group, q) in enumerate(plan):
        job.progress("searching", i, len(plan))
        for r in web.search(q, 6):
            hits.append({"id": f"h{len(hits) + 1}", "group": group, "url": r["url"], "title": r.get("title", ""), "description": r.get("description", "")})
    urls = {h["url"] for h in hits}
    log("brand_finder.search", hits=len(hits), searches=len(plan), calls=web.calls)

    picked: list[dict[str, Any]] = []
    if hits:
        user = json.dumps({"themes": spec.get("themes") or [], "deal_fit": spec.get("deal_fit", ""), "audience": spec.get("audience", ""), "location": spec.get("location", ""), "off_limits": spec.get("off_limits") or [], "results": hits[:80]})
        picked = (llm(or_key, SYSTEM, user) or {}).get("brands") or []
        if not picked:
            picked = rules_pass(hits)

    brands: list[dict[str, Any]] = []
    for b in her_list:
        brands.append({"name": b.get("name"), "website": b.get("website"), "program_url": None, "categories": [], "fit_score": 90, "fit_reasons": ["You use and love this brand."], "why_now": None, "source_links": [], "origin": "her_list", "socials": {}, "kind": "brand", "budget": {"level": "unproven", "evidence": []}, "why": []})
    for b in picked:
        if not isinstance(b, dict) or not b.get("name") or not b.get("website"):
            continue
        if any(host(b["website"]).endswith(n) for n in NOT_BRANDS):
            continue
        key = host(b["website"]) or str(b["name"]).lower()
        if key in known or key in never:
            continue
        # Evidence and "why" lines must point at a result we actually saw.
        ev = [e for e in (b.get("evidence") or []) if isinstance(e, dict) and e.get("url") in urls and e.get("text")][:3]
        why = [e for e in (b.get("why") or []) if isinstance(e, dict) and e.get("url") in urls and e.get("text")][:2]
        level = b.get("budget_level") if b.get("budget_level") in ("paying", "likely") else "unproven"
        if level == "paying" and not any(PAID_WORDS.search(e["text"]) for e in ev):
            level = "likely" if ev else "unproven"
        if not ev:
            level = "unproven"
        sources = list(dict.fromkeys([e["url"] for e in ev + why]))[:6]
        if not sources:
            continue  # nothing without a source
        known.add(key)
        prog = b.get("program_url") if isinstance(b.get("program_url"), str) and b.get("program_url") in urls else None
        brands.append({
            "name": b["name"], "website": root_url(b["website"]), "program_url": prog, "categories": b.get("categories") or [],
            "fit_score": b.get("fit_score") or 50, "fit_reasons": b.get("fit_reasons") or [], "why_now": (why[0]["text"] if why else None),
            "source_links": sources, "origin": "program_search" if prog else "finder", "socials": {},
            "kind": b.get("kind") if b.get("kind") in ("brand", "agency", "local") else "brand",
            "budget": {"level": level, "evidence": ev}, "why": why,
        })
        if len(brands) >= max_brands + len(her_list):
            break

    hunter_used = 0
    for i, b in enumerate(brands):
        job.progress("contacts", i, len(brands))
        if not b.get("website"):
            b["contacts"] = []
            continue
        b["contacts"] = find_contacts(web, b["website"], b.get("program_url"))
        has_email = any(c["kind"] in ("role_email", "agency") for c in b["contacts"])
        if not has_email and hunter_key and (hunter_left is None or hunter_left - hunter_used > 0):
            b["contacts"] += hunter_role_emails(hunter_key, host(b["website"]))
            hunter_used += 1
        if b.get("program_url") and not any(c["kind"] == "form" for c in b["contacts"]):
            b["contacts"].insert(0, {"kind": "form", "value": b["program_url"], "found_on_url": b["program_url"]})
        if not b.get("source_links"):
            b["source_links"] = [c["found_on_url"] for c in b["contacts"]][:3]

    log("brand_finder.done", brands=len(brands), calls=web.calls, hunter=hunter_used, firecrawl=web.used.get("firecrawl", 0))
    return {"brands": brands, "searches": len(plan), "hunter_lookups": hunter_used, "web": {"calls": web.calls, "results": len(hits), "firecrawl_refused": web.firecrawl_refused}}


if __name__ == "__main__":
    run(main)
