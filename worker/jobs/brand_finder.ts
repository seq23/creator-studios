// Weekly brand finder + public contact finder (section 12b.2–3). The job (jobs/brand_finder.py)
// reads its spec from here: her locked profile's themes, deal fit and off-limits list, the
// comparable creators from the approved brief, the brands she listed herself, the names we
// already have, and the keys she pasted (Firecrawl, OpenRouter, optional Hunter). It posts back
// brand cards with fit score, reasons, why-now, source links and contacts.
//
// applyResult is the gate the plan's rules hang on, whatever the job sends:
//   * off-limits brands are dropped (never suggested);
//   * contacts must be public business contacts with the page they were found on;
//   * a brand we already have is updated in place (her hide / save choice is kept).
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { log } from "../lib/log";
import { parseJson, recordEvent, setHealth } from "../lib/db";
import { newId, nowIso } from "../lib/ids";
import { getConnectionSecret, listConnections, markConnection } from "../lib/connections";
import { brandKey, clampFit, contactProblem, offLimitsTerms, violatesOffLimits, type ContactCandidate } from "../domain/brandfit";
import { lockedProfile, readDraft, themeList } from "../routes/mediakit";
import { cleanBudget, type BudgetSignal, type Evidence } from "../domain/prospects";
import type { BriefBody } from "@shared/types";

export interface FinderBrand {
  name: string;
  website: string | null;
  program_url: string | null;
  socials: Record<string, string>;
  categories: string[];
  fit_score: number;
  fit_reasons: string[];
  why_now: string | null;
  source_links: string[];
  origin: "finder" | "program_search" | "her_list";
  contacts: ContactCandidate[];
  /** brand (sells a product), agency (books creators for brands), local (venue, florist, rental, event vendor near her). */
  kind: "brand" | "agency" | "local";
  /** Why we think they pay creators, each line with the page it came from. */
  budget: BudgetSignal;
  /** "Why this brand": one or two lines, each with its source page. */
  why: Evidence[];
}

export interface FinderResult {
  brands: FinderBrand[];
  searches: number;
  hunter_lookups: number;
  /** How the web was reached (jobs/common.py Web): calls made, results seen, whether Firecrawl refused. */
  web?: { calls: number; results: number; firecrawl_refused: string | null };
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}
function urlOrNull(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Coerce whatever the job sent into the shape we store; drops anything malformed. */
export function normaliseBrand(raw: unknown): FinderBrand | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 80);
  if (!name) return null;
  const list = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, n) : []);
  const socials: Record<string, string> = {};
  if (r.socials && typeof r.socials === "object") {
    for (const [k, v] of Object.entries(r.socials as Record<string, unknown>)) {
      const u = urlOrNull(v);
      if (u && /^[a-z]{2,20}$/.test(k)) socials[k] = u;
    }
  }
  const contacts: ContactCandidate[] = Array.isArray(r.contacts)
    ? (r.contacts as unknown[])
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => !!x)
        .map((x) => ({ kind: (x.kind as ContactCandidate["kind"]) ?? "role_email", value: str(x.value, 300) ?? "", found_on_url: urlOrNull(x.found_on_url) ?? "" }))
    : [];
  const origin = r.origin === "program_search" || r.origin === "her_list" ? r.origin : "finder";
  const why = (Array.isArray(r.why) ? r.why : [])
    .map((x) => ({ text: str((x as Evidence)?.text, 200) ?? "", url: urlOrNull((x as Evidence)?.url) ?? "" }))
    .filter((x) => x.text && x.url)
    .slice(0, 3);
  return {
    name,
    website: urlOrNull(r.website),
    program_url: urlOrNull(r.program_url),
    socials,
    categories: list(r.categories, 40, 8),
    fit_score: clampFit(r.fit_score),
    fit_reasons: list(r.fit_reasons, 200, 5),
    why_now: str(r.why_now, 200),
    source_links: (Array.isArray(r.source_links) ? r.source_links : []).map(urlOrNull).filter((x): x is string => !!x).slice(0, 8),
    origin,
    contacts,
    kind: r.kind === "agency" || r.kind === "local" ? r.kind : "brand",
    budget: cleanBudget(r.budget),
    why,
  };
}

export async function applyFinderResult(env: Env, result: unknown): Promise<{ added: number; updated: number; offLimits: number; contactsRefused: number; unsourced: number }> {
  const res = (result && typeof result === "object" ? result : {}) as Partial<FinderResult>;
  const brands = (Array.isArray(res.brands) ? res.brands : []).map(normaliseBrand).filter((b): b is FinderBrand => !!b);
  const profile = await lockedProfile(env);
  const terms = offLimitsTerms(profile?.off_limits);

  const { results: existing } = await env.DB.prepare("SELECT id, name, website, status FROM brands").all<{ id: string; name: string; website: string | null; status: string }>();
  const byKey = new Map(existing.map((b) => [brandKey(b), b]));
  let added = 0;
  let updated = 0;
  let offLimits = 0;
  let contactsRefused = 0;

  let unsourced = 0;
  for (const b of brands) {
    if (violatesOffLimits(b, terms)) {
      offLimits++;
      continue;
    }
    // Nothing without a source: a brand the job can't point to a page for is not stored.
    if (b.origin !== "her_list" && !b.source_links.length && !b.why.length && !b.budget.evidence.length) {
      unsourced++;
      continue;
    }
    const safe = b.contacts.filter((ct) => {
      const bad = contactProblem(ct);
      if (bad) contactsRefused++;
      return !bad;
    });
    const hit = byKey.get(brandKey(b));
    let id: string;
    if (hit) {
      id = hit.id;
      await env.DB.prepare(
        "UPDATE brands SET website = COALESCE(?, website), program_url = COALESCE(?, program_url), socials = ?, fit_score = ?, fit_reasons = ?, why_now = ?, source_links = ?, kind = ?, budget_signal = ?, why_sourced = ?, last_seen_at = ? WHERE id = ?",
      )
        .bind(b.website, b.program_url, JSON.stringify(b.socials), b.fit_score, JSON.stringify(b.fit_reasons), b.why_now, JSON.stringify(b.source_links), b.kind, JSON.stringify(b.budget), JSON.stringify(b.why), nowIso(), id)
        .run();
      updated++;
    } else {
      id = newId("brd");
      await env.DB.prepare(
        "INSERT INTO brands (id, name, website, program_url, socials, fit_score, fit_reasons, why_now, source_links, origin, status, kind, budget_signal, why_sourced, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?)",
      )
        .bind(id, b.name, b.website, b.program_url, JSON.stringify(b.socials), b.fit_score, JSON.stringify(b.fit_reasons), b.why_now, JSON.stringify(b.source_links), b.origin === "her_list" ? "finder" : b.origin, b.kind, JSON.stringify(b.budget), JSON.stringify(b.why), nowIso())
        .run();
      byKey.set(brandKey(b), { id, name: b.name, website: b.website, status: "suggested" });
      added++;
    }
    const { results: have } = await env.DB.prepare("SELECT value FROM brand_contacts WHERE brand_id = ?").bind(id).all<{ value: string }>();
    const known = new Set(have.map((h) => h.value.toLowerCase()));
    for (const ct of safe) {
      if (known.has(ct.value.toLowerCase())) {
        await env.DB.prepare("UPDATE brand_contacts SET checked_at = ?, found_on_url = ? WHERE brand_id = ? AND lower(value) = ?").bind(nowIso(), ct.found_on_url, id, ct.value.toLowerCase()).run();
        continue;
      }
      await env.DB.prepare("INSERT INTO brand_contacts (id, brand_id, kind, value, found_on_url) VALUES (?, ?, ?, ?, ?)").bind(newId("bct"), id, ct.kind, ct.value, ct.found_on_url).run();
      known.add(ct.value.toLowerCase());
    }
  }
  return { added, updated, offLimits, contactsRefused, unsourced };
}

export const brandFinderJob: JobHandler = {
  async buildSpec(env, jobId, refId) {
    const profile = await lockedProfile(env);
    const brief = await env.DB.prepare("SELECT body FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ body: string }>();
    const body = brief ? parseJson<Partial<BriefBody>>(brief.body, {}) : {};
    const { results: herList } = await env.DB.prepare("SELECT name, website FROM brands WHERE origin = 'her_list' AND status != 'hidden'").all<{ name: string; website: string | null }>();
    const { results: known } = await env.DB.prepare("SELECT name, website FROM brands").all<{ name: string; website: string | null }>();
    const conns = await listConnections(env);
    const hunter = conns.find((c) => c.service === "hunter");
    const kit = await readDraft(env);
    const { results: closed } = await env.DB.prepare("SELECT DISTINCT b.name, b.website FROM deals d JOIN brands b ON b.id = d.brand_id WHERE d.stage IN ('declined','lost') OR b.status = 'hidden'").all<{ name: string; website: string | null }>();
    const mode = refId === "daily" ? "daily" : "full";
    return {
      job_id: jobId,
      ref_id: refId,
      type: "brand_finder",
      // "daily": a light refresh inside the free budgets (few searches, rotates the source kinds by
      // day); "full": the weekly run and "Find brands now".
      mode,
      search_budget: mode === "daily" ? 8 : 30,
      day_of_year: Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400_000),
      location: kit.location,
      niche_words: ["hosting", "tablescape", "home", "entertaining", "lifestyle"],
      // Never suggest again: brands she declined, lost, or hid.
      never_again: closed.map((k) => brandKey(k)),
      themes: themeList(profile?.themes),
      audience: profile?.audience ?? "",
      deal_fit: profile?.deal_fit ?? "",
      off_limits: offLimitsTerms(profile?.off_limits),
      comparable_creators: (body.comparable_creators ?? []).map((c) => ({ handle: c.handle, platform: c.platform })).slice(0, 10),
      her_list: herList,
      known_brands: known.map((k) => brandKey(k)),
      max_brands: 12,
      // Keys she pasted in Connect accounts. The spec is fetched over a signed call and never logged.
      keys: {
        firecrawl: await getConnectionSecret(env, "firecrawl"),
        openrouter: await getConnectionSecret(env, "openrouter"),
        hunter: hunter?.status === "ok" ? await getConnectionSecret(env, "hunter") : null,
      },
      hunter_credits_left: (hunter?.meta.credits_left as number | undefined) ?? null,
    };
  },

  async applyResult(env, jobId, _refId, result) {
    const r = await applyFinderResult(env, result);
    const res = (result ?? {}) as Partial<FinderResult>;
    if (typeof res.hunter_lookups === "number" && res.hunter_lookups > 0) {
      const conns = await listConnections(env);
      const h = conns.find((c) => c.service === "hunter");
      const left = typeof h?.meta.credits_left === "number" ? Math.max(0, (h.meta.credits_left as number) - res.hunter_lookups) : null;
      if (h?.status === "ok" && left !== null) await markConnection(env, "hunter", "ok", null, { credits_left: left });
    }
    const web = (res as { web?: { calls?: number; results?: number; firecrawl_refused?: string | null } }).web ?? {};
    if (web.firecrawl_refused) await setHealth(env.DB, "Brand finder", "yellow", `Found ${r.added} new, refreshed ${r.updated}. Firecrawl ${web.firecrawl_refused === "out_of_credits" ? "is out of credits" : "refused its key"}, so the free web search was used.`, "reconnect-firecrawl");
    else if ((web.calls ?? 1) > 0 && web.results === 0) await setHealth(env.DB, "Brand finder", "yellow", "The web search came back empty this run (the free search can be busy). It tries again tomorrow on its own.", "pitch-a-brand");
    else await setHealth(env.DB, "Brand finder", "green", `Last run found ${r.added} new, refreshed ${r.updated}`, null);
    await recordEvent(env.DB, "brand_finder.done", jobId, r);
    log.info("brand_finder.apply", r);
  },

  async onFailure(env, jobId, _refId, safeError) {
    await setHealth(env.DB, "Brand finder", "red", "The brand search did not finish. It tries again tomorrow on its own, or press Find brands now.", "pitch-a-brand");
    await recordEvent(env.DB, "brand_finder.failed", jobId, { len: safeError.length });
    log.warn("brand_finder.failed", { len: safeError.length });
  },

  /** FAKE_SERVICES: 6–8 believable brand cards with public contacts and sources. */
  async fakeRun(env, _jobId, _refId, options) {
    const profile = await lockedProfile(env);
    const theme = themeList(profile?.themes)[0] ?? "everyday style";
    const brands = fakeBrands(theme);
    if (options.failure === "bad_contacts") brands[0].contacts.push({ kind: "role_email", value: "jane.doe@gmail.com", found_on_url: "https://example.org/" });
    return { brands, searches: 9, hunter_lookups: 0, web: { calls: 9, results: 24, firecrawl_refused: null } } satisfies FinderResult;
  },
};

export function fakeBrands(theme: string): FinderBrand[] {
  const b = (name: string, host: string, fit: number, reasons: string[], whyNow: string | null, contacts: ContactCandidate[], extra: Partial<FinderBrand> = {}): FinderBrand => ({
    name,
    website: `https://${host}/`,
    program_url: null,
    socials: { tiktok: `https://www.tiktok.com/@${host.split(".")[0]}`, instagram: `https://www.instagram.com/${host.split(".")[0]}` },
    categories: [],
    fit_score: fit,
    fit_reasons: reasons,
    why_now: whyNow,
    source_links: [`https://${host}/pages/creators`],
    origin: "finder",
    contacts,
    kind: "brand",
    budget: { level: "unproven", evidence: [] },
    why: [],
    ...extra,
  });
  const ev = (text: string, url: string) => ({ text, url });
  return [
    b("Maison Lumière Candles", "maisonlumiere.example", 0.92, [`Matches your "${theme}" theme`, "Sponsors creators your size", "Has an open creator program"], "Sponsored 3 creators in your niche this month", [
      { kind: "form", value: "https://maisonlumiere.example/pages/creators/apply", found_on_url: "https://maisonlumiere.example/pages/creators" },
      { kind: "role_email", value: "partnerships@maisonlumiere.example", found_on_url: "https://maisonlumiere.example/pages/contact" },
    ], {
      program_url: "https://maisonlumiere.example/pages/creators",
      origin: "program_search",
      budget: { level: "paying", evidence: [ev("Paid creator program: \"we pay creators a flat fee per video\"", "https://maisonlumiere.example/pages/creators"), ev("#ad post with @demo.hostess, 12 Sep", "https://www.tiktok.com/@demo.hostess/video/1")] },
      why: [ev("Launching a holiday table collection in October", "https://maisonlumiere.example/blogs/news/holiday-collection")],
    }),
    b("Golden Hour Tableware", "goldenhourtable.example", 0.87, ["Hosting and entertaining fit", "Audience overlap: women 30–55"], "Ran #ad posts with 2 creators from your research brief", [{ kind: "role_email", value: "collabs@goldenhourtable.example", found_on_url: "https://goldenhourtable.example/contact" }], {
      source_links: ["https://goldenhourtable.example/contact", "https://www.tiktok.com/@goldenhourtable"],
      budget: { level: "paying", evidence: [ev("Paid partnership tag on @demo.tablescapes' Reel, 3 Sep", "https://www.instagram.com/p/demo-golden")] },
      why: [ev("Their new stoneware line is shot on brunch tables like yours", "https://goldenhourtable.example/collections/stoneware")],
    }),
    b("Velvet & Vine Wraps", "velvetandvine.example", 0.84, ["Gifting season fits your content calendar", "Affiliate program open"], "Affiliate program reopened this week", [{ kind: "form", value: "https://velvetandvine.example/affiliates", found_on_url: "https://velvetandvine.example/affiliates" }], {
      program_url: "https://velvetandvine.example/affiliates",
      origin: "program_search",
      budget: { level: "likely", evidence: [ev("Ambassador program page: commission plus seasonal paid campaigns", "https://velvetandvine.example/affiliates")] },
      why: [ev("Gift-wrap guides are their top blog posts before the holidays", "https://velvetandvine.example/blog")],
    }),
    b("Cedar & Salt Kitchen", "cedarandsalt.example", 0.81, ["Cooking-for-guests videos match your themes"], null, [{ kind: "role_email", value: "pr@cedarandsalt.example", found_on_url: "https://cedarandsalt.example/press" }], {
      budget: { level: "likely", evidence: [ev("Press page lists creator collaborations", "https://cedarandsalt.example/press")] },
      why: [ev("Their serving boards are in their own \"hosting at home\" lookbook", "https://cedarandsalt.example/lookbook")],
    }),
    b("Aurelia Linen Co.", "aurelialinen.example", 0.78, ["Table styling fit", "Brand tone matches your voice"], "Launched a new collection last week", [{ kind: "agency", value: "talent@brightline-agency.example", found_on_url: "https://aurelialinen.example/press" }], {
      why: [ev("New table linen collection launched 18 Sep", "https://aurelialinen.example/collections/new")],
    }),
    b("Petal Post Florals", "petalpost.example", 0.74, ["Floral styling appears in your top clips"], "Paid partnership posts with 4 lifestyle creators in September", [{ kind: "role_email", value: "creators@petalpost.example", found_on_url: "https://petalpost.example/creators" }], {
      budget: { level: "paying", evidence: [ev("Paid partnership posts with 4 lifestyle creators in September", "https://www.instagram.com/petalpost/tagged")] },
    }),
    b("Brightline Creator Agency", "brightline-agency.example", 0.72, ["Books home and lifestyle creators for brand campaigns"], "Open roster call for home creators", [{ kind: "role_email", value: "talent@brightline-agency.example", found_on_url: "https://brightline-agency.example/creators" }], {
      kind: "agency",
      source_links: ["https://brightline-agency.example/creators"],
      budget: { level: "likely", evidence: [ev("\"We're adding home and hosting creators to our roster\"", "https://brightline-agency.example/creators")] },
      why: [ev("Runs campaigns for Aurelia Linen Co.", "https://aurelialinen.example/press")],
    }),
    b("Local Event Rentals", "localrentals.example", 0.7, ["Local: rents tables, linens and chairs near you"], null, [{ kind: "role_email", value: "hello@localrentals.example", found_on_url: "https://localrentals.example/contact" }], {
      kind: "local",
      source_links: ["https://localrentals.example/contact"],
      why: [ev("Posts styled-table photos from local creators", "https://localrentals.example/gallery")],
    }),
    // Filtered out when "alcohol" is on her off-limits list: proves the rule in fake mode.
    b("Midnight Spirits Co.", "midnightspirits.example", 0.7, ["Party hosting fit"], null, [{ kind: "role_email", value: "partners@midnightspirits.example", found_on_url: "https://midnightspirits.example/contact" }], {
      categories: ["alcohol", "spirits"],
      budget: { level: "paying", evidence: [ev("#ad posts", "https://midnightspirits.example/creators")] },
    }),
    b("Hearth & Honey Bakery", "hearthhoney.example", 0.69, ["Holiday baking fit"], null, [{ kind: "role_email", value: "hello@hearthhoney.example", found_on_url: "https://hearthhoney.example/about" }]),
    // No source at all: must never be stored (nothing without a source).
    b("Nowhere Home Goods", "nowhere.example", 0.9, ["Sounds like a fit"], null, [], { source_links: [] }),
  ];
}
