"""Research Brief from her data + web + her uploaded reports (BUILD_PLAN.md section 6).

Spec (worker/jobs/research.ts buildSpec):
  profile        her locked Brand Profile sections
  her_data       {summary: {platform: {videos, avg_views, history_days, top_times}}, accounts,
                  learned_slots, timezone}
  uploads        [{id, source_id, title, r2_key, ext}]   outside reports she uploaded
  baseline       section 10b: {slots, caps, sources}      the starting schedule and its studies
  features       {deeper_research}                        OpenRouter Perplexity search (paid, off by default)
  keys           {openrouter, firecrawl}                  from her Connect screen (env fallback); Firecrawl optional,
                                                          the free keyless search runs without it (common.Web)
  model, deeper_model, system

Result: {"body": BriefBody, "sources": BriefSource[]} exactly as shared/types.ts. Posting times
are built here from the 10b baseline (or her learned slots) so they always cite the studies;
the model writes the rest and may cite only the source ids it is given. The Worker re-applies
the truth rules (worker/domain/brief.ts) before storing the draft.
Logs: step names and counts only (section 13).
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from common import WORK, Job, Web, download_input, log, openrouter_content, run
from extract import Unreadable, extract_text, llm_json

PLATFORMS = ("tiktok", "instagram", "youtube")
LABEL = {"tiktok": "TikTok", "instagram": "Instagram", "youtube": "YouTube Shorts"}
DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
EXCERPT = 2500


def hour_label(h: int) -> str:
    return f"{12 if h % 12 == 0 else h % 12} {'am' if h < 12 else 'pm'}"


def claim(text: str, ids: list[str], basis: str, solid: bool = True) -> dict[str, Any]:
    return {"text": text, "source_ids": ids, "basis": basis, "confidence": "solid" if solid else "uncertain"}


# ---------- web ----------

def web_search(web: Web, query: str, limit: int = 4) -> list[dict[str, str]]:
    """Search, then read the top pages for excerpts (common.Web: Firecrawl if connected, else the
    free keyless path). The model only sees text we actually fetched."""
    out = []
    for i, r in enumerate(web.search(query, limit)):
        text = web.read(r["url"])[:EXCERPT] if i < 2 else ""
        out.append({"url": r["url"], "title": (r.get("title") or r["url"])[:200], "text": text or r.get("description", "")[:EXCERPT]})
    return out


def queries_from_profile(profile: dict[str, str] | None) -> list[str]:
    qs = [
        "short-form video hooks that work for women over 50 lifestyle creators",
        "luxury event host content ideas for Instagram Reels and TikTok",
        "best video length for Instagram Reels and TikTok engagement 2026 study",
    ]
    themes = (profile or {}).get("themes", "")
    for line in themes.splitlines():
        t = line.strip("•-* ").split(":")[0].strip()
        if 3 < len(t) < 80:
            qs.append(f"{t} short video ideas")
        if len(qs) >= 6:
            break
    return qs


def deeper_search(key: str, model: str, profile: dict[str, str] | None) -> tuple[str, list[dict[str, str]]]:
    """OpenRouter Perplexity search (about half a cent a search); returns text + cited pages."""
    q = "What short-form video formats, hooks and posting habits work best for a luxury event and lifestyle creator whose audience is mostly women over 40? Cite studies."
    if profile and profile.get("who"):
        q += " Creator: " + profile["who"][:600]
    try:
        _, data = openrouter_content(key, {"model": model, "messages": [{"role": "user", "content": q}], "max_tokens": 1200}, usable=lambda t: bool(t.strip()))
    except Exception:  # noqa: BLE001
        log("deeper.failed")
        return "", []
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    pages: list[dict[str, str]] = []
    for a in msg.get("annotations") or []:
        u = (a.get("url_citation") or {})
        if u.get("url"):
            pages.append({"url": u["url"], "title": (u.get("title") or u["url"])[:200]})
    for u in data.get("citations") or []:
        if isinstance(u, str) and all(p["url"] != u for p in pages):
            pages.append({"url": u, "title": u[:200]})
    return (msg.get("content") or "")[:EXCERPT * 2], pages[:6]


# ---------- posting times (always cited) ----------

def best_times(spec: dict[str, Any], her_ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    learned = spec.get("her_data", {}).get("learned_slots") or {}
    slots = spec["baseline"]["slots"]
    out: dict[str, list[dict[str, Any]]] = {}
    for p in PLATFORMS:
        rows = []
        if learned.get(p) and f"her_{p}" in her_ids:
            for s in learned[p]:
                at = f"{DAY[s['day']]} {hour_label(s['hour'])}"
                rows.append({**s, "claim": claim(f"{at}: one of your best times on {LABEL[p]}, from your own results.", [f"her_{p}"], "her_data")})
        else:
            for s in slots[p]:
                at = f"{DAY[s['day']]} {hour_label(s['hour'])}"
                if p == "tiktok" and s["day"] in (0, 6):
                    c = claim(f"{at}: the big studies disagree on weekends, so this slot is a test your results will settle.", ["b_sprout_tt", "b_buffer_all"], "web", solid=False)
                elif p == "tiktok":
                    c = claim(f"{at}: weekday late afternoon and evening is where both big TikTok studies overlap.", ["b_sprout_tt", "b_buffer_all"], "web")
                elif p == "instagram":
                    c = claim(f"{at}: Instagram evenings and Tuesday to Wednesday are strongest across 9.6M posts; Thursday mornings also do well.", ["b_buffer_ig", "b_sprout_ig"], "web")
                else:
                    c = claim(f"{at}: YouTube Shorts did best Friday around 4 pm, with Saturday close behind.", ["b_buffer_all"], "web")
                rows.append({**s, "claim": c})
        out[p] = rows
    return out


# ---------- clean the model's answer ----------

def clean_claim(c: Any, ids: set[str]) -> dict[str, Any] | None:
    if not isinstance(c, dict) or not isinstance(c.get("text"), str) or not c["text"].strip():
        return None
    src = [s for s in (c.get("source_ids") or []) if isinstance(s, str) and s in ids]
    basis = c.get("basis") if c.get("basis") in ("her_data", "web", "upload") else "web"
    conf = "solid" if c.get("confidence") == "solid" and src else "uncertain"
    return {"text": c["text"].strip()[:600], "source_ids": src, "basis": basis, "confidence": conf}


def clean_list(xs: Any, ids: set[str], cap: int = 10) -> list[dict[str, Any]]:
    out = [clean_claim(c, ids) for c in (xs if isinstance(xs, list) else [])]
    return [c for c in out if c][:cap]


def clean_body(raw: dict[str, Any], ids: set[str], times: dict[str, Any]) -> dict[str, Any]:
    themes = []
    for t in raw.get("themes") or []:
        if isinstance(t, dict) and isinstance(t.get("title"), str):
            cl = clean_list(t.get("claims"), ids, 5)
            if cl:
                themes.append({"title": t["title"][:120], "claims": cl})
    creators = []
    for c in raw.get("comparable_creators") or []:
        if isinstance(c, dict) and isinstance(c.get("handle"), str) and c.get("platform") in PLATFORMS:
            why = clean_claim(c.get("why"), ids)
            if why:
                creators.append({"handle": c["handle"][:80], "platform": c["platform"], "why": why})
    return {
        "audience": clean_list(raw.get("audience"), ids),
        "themes": themes[:5],
        "hooks": clean_list(raw.get("hooks"), ids),
        "cut_styles": clean_list(raw.get("cut_styles"), ids),
        "best_times": times,
        "comparable_creators": creators[:6],
        "shot_list": clean_list(raw.get("shot_list"), ids, 8),
    }


# ---------- main ----------

def main(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    keys = spec.get("keys") or {}
    or_key = keys.get("openrouter") or os.environ.get("OPENROUTER_API_KEY")
    fc_key = keys.get("firecrawl") or os.environ.get("FIRECRAWL_API_KEY")
    if not or_key:
        raise RuntimeError("openrouter key missing")
    profile = spec.get("profile") or {}
    sources: list[dict[str, Any]] = [dict(s) for s in spec["baseline"]["sources"]]
    excerpts: dict[str, str] = {s["id"]: "Posting-time and frequency study used for the section 10b launch baseline." for s in sources}
    sources.append({"id": "her_profile", "url": None, "title": "Your locked Brand Profile", "kind": "her_data"})
    excerpts["her_profile"] = json.dumps(profile)[:6000]

    her = spec.get("her_data") or {}
    her_ids: set[str] = set()
    for p in PLATFORMS:
        s = (her.get("summary") or {}).get(p) or {}
        if s.get("videos"):
            sid = f"her_{p}"
            her_ids.add(sid)
            sources.append({"id": sid, "url": None, "title": f"Your {LABEL[p]} results ({s['videos']} videos)", "kind": "her_data"})
            excerpts[sid] = json.dumps({"summary": s, "accounts": [a for a in her.get("accounts") or [] if a.get("platform") == p], "timezone": her.get("timezone")})

    job.progress("reading uploads", 0, 3)
    work = WORK / "research"
    work.mkdir(parents=True, exist_ok=True)
    for u in spec.get("uploads") or []:
        local = work / u["id"]
        try:
            download_input(u["r2_key"], local)
            text, _ = extract_text(local, "", u.get("ext", ""))
            sources.append({"id": u["source_id"], "url": None, "title": u["title"][:200], "kind": "upload"})
            excerpts[u["source_id"]] = text[: EXCERPT * 3]
        except (Unreadable, Exception):  # noqa: BLE001
            log("research.upload.unreadable")
        finally:
            local.unlink(missing_ok=True)
    log("research.uploads", count=sum(1 for s in sources if s["kind"] == "upload"))

    job.progress("searching the web", 1, 3)
    web = Web(firecrawl_key=fc_key, jina_key=os.environ.get("JINA_API_KEY"))
    seen: set[str] = set()
    n = 0
    for q in queries_from_profile(profile):
        for r in web_search(web, q):
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            n += 1
            sid = f"w{n}"
            sources.append({"id": sid, "url": r["url"], "title": r["title"], "kind": "web"})
            excerpts[sid] = r["text"]
    log("research.web", sources=n, calls=web.calls, firecrawl=web.used.get("firecrawl", 0), free=web.calls - web.used.get("firecrawl", 0))

    if (spec.get("features") or {}).get("deeper_research"):
        text, pages = deeper_search(or_key, spec.get("deeper_model", "perplexity/sonar"), profile)
        for i, pg in enumerate(pages):
            sid = f"d{i + 1}"
            sources.append({"id": sid, "url": pg["url"], "title": pg["title"], "kind": "web"})
            excerpts[sid] = text if i == 0 else "Cited by the deeper search summary above."
        log("research.deeper", sources=len(pages))

    job.progress("writing the brief", 2, 3)
    usable = sources
    ids = {s["id"] for s in usable}
    listing = "\n\n".join(f"[{s['id']}] ({s['kind']}) {s['title']}\n{excerpts.get(s['id'], '')[:EXCERPT]}" for s in usable)
    user = f"BRAND PROFILE:\n{json.dumps(profile)[:6000]}\n\nSOURCES (cite by id):\n{listing}"
    raw = llm_json(or_key, spec["model"], spec["system"], user[:120_000], max_tokens=4000)
    body = clean_body(raw, ids, best_times(spec, her_ids))
    if not body["audience"] and not body["themes"]:
        raise RuntimeError("draft came back empty")
    job.progress("writing the brief", 3, 3)
    log("research.done", sources=len(sources), themes=len(body["themes"]))
    return {"body": body, "sources": sources}


if __name__ == "__main__":
    run(main)
