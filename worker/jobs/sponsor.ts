// Get it sponsored (owner-approved mock-up, 23 Oct 2026): jobs/sponsor.py reads the spec (the
// experience she typed, her locked Brand Profile and her real numbers), searches the free web and
// asks the free AI ladder ($0 only), and posts back brands, videos and extra to-do lines.
//
// applyResult is the gate, whatever the job sends (cleanSponsorResult):
//   * a brand needs a public proof line with its page, or it is dropped (nothing guessed);
//   * a way in is a public business contact only (role address, form or program page); anything
//     else becomes "Needs a way in";
//   * off-limits brands from her Brand Profile are dropped;
//   * the "Read before you book" rules and the dated to-do plan are code (shared/sponsored.ts).
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { getConnectionSecret } from "../lib/connections";
import { parseJson } from "../lib/db";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { isRoleEmail, offLimitsTerms, violatesOffLimits } from "../domain/brandfit";
import { audienceLine, kitFigures, lockedProfile, readDraft, themeList } from "../routes/mediakit";
import { PLATFORM_LABEL } from "@shared/constants";
import { baselineVideos, monthLabel, type SponsorBrand, type SponsorKind, type SponsorResult, type SponsorTodo, type SponsorVideo, type SponsorWayIn } from "@shared/sponsored";

export const SPONSOR_MAX_BRANDS = 12;

export function sponsorKind(env: Pick<Env, "SPONSOR_KIND">): SponsorKind {
  return env.SPONSOR_KIND === "event" ? "event" : "experience";
}

export interface SponsorSpec {
  job_id: string;
  type: "sponsor";
  kind: SponsorKind;
  ask: { title: string; when_month: string; when_label: string; who: string; notes: string; medical: boolean };
  profile: { who: string; audience: string; themes: string[]; deal_fit: string; off_limits: string[] };
  numbers: { platform: string; followers: number; avg_views: number; engagement_rate: number | null; as_of: string }[];
  location: string;
  today: string;
  max_brands: number;
  keys: { openrouter: string | null; firecrawl: string | null };
}

interface AskRow {
  id: string;
  title: string;
  when_month: string;
  who: string;
  notes: string;
  medical: number;
}

async function buildSpec(env: Env, jobId: string, refId: string | null): Promise<SponsorSpec> {
  const ask = await env.DB.prepare("SELECT id, title, when_month, who, notes, medical FROM sponsor_asks WHERE id = ?").bind(refId).first<AskRow>();
  if (!ask) throw new Error("experience missing");
  const profile = await lockedProfile(env);
  const kit = await readDraft(env);
  const figures = await kitFigures(env);
  return {
    job_id: jobId,
    type: "sponsor",
    kind: sponsorKind(env),
    ask: { title: ask.title, when_month: ask.when_month, when_label: monthLabel(ask.when_month), who: ask.who, notes: ask.notes, medical: !!ask.medical },
    profile: {
      who: String(profile?.who ?? "").slice(0, 1200),
      audience: audienceLine(profile?.audience),
      themes: themeList(profile?.themes).slice(0, 6),
      deal_fit: String(profile?.deal_fit ?? "").slice(0, 600),
      off_limits: offLimitsTerms(profile?.off_limits),
    },
    numbers: figures.map((f) => ({ platform: PLATFORM_LABEL[f.platform], followers: f.followers, avg_views: f.avgViews, engagement_rate: f.engagement?.rate ?? null, as_of: f.asOf })),
    location: kit.location ?? "",
    today: nowIso().slice(0, 10),
    max_brands: SPONSOR_MAX_BRANDS,
    // The studio's own keys (free OpenRouter models only; Firecrawl optional). Signed spec, never logged.
    keys: { openrouter: await getConnectionSecret(env, "openrouter"), firecrawl: await getConnectionSecret(env, "firecrawl") },
  };
}

// ---------- the gate

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
function httpUrl(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
const ymd = (v: unknown): string | null => (typeof v === "string" && /^20\d\d-\d\d-\d\d$/.test(v) ? v : null);

export function keyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "brand";
}

const NEEDS_WAY_IN: SponsorWayIn = { kind: "none", value: null, foundOn: null, label: "Needs a way in" };

function cleanWayIn(raw: unknown): SponsorWayIn {
  if (!raw || typeof raw !== "object") return NEEDS_WAY_IN;
  const r = raw as Record<string, unknown>;
  const foundOn = httpUrl(r.foundOn ?? r.found_on);
  const kind = r.kind;
  if (kind === "email") {
    const v = str(r.value, 120).toLowerCase();
    // A public business address printed on a page we can show, never a personal one.
    if (!foundOn || !isRoleEmail(v)) return NEEDS_WAY_IN;
    return { kind: "email", value: v, foundOn, label: str(r.label, 120) || "Public business email" };
  }
  if (kind === "form" || kind === "page") {
    const v = httpUrl(r.value);
    if (!v) return NEEDS_WAY_IN;
    return { kind, value: v, foundOn: foundOn ?? v, label: str(r.label, 120) || (kind === "form" ? "Creator application (public)" : "Public contact page") };
  }
  return NEEDS_WAY_IN;
}

function cleanBrand(raw: unknown, offLimits: string[]): SponsorBrand | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 80);
  if (!name) return null;
  const website = httpUrl(r.website);
  if (violatesOffLimits({ name, website }, offLimits)) return null;
  const proof = (Array.isArray(r.proof) ? r.proof : [])
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : null))
    .map((p) => (p ? { text: str(p.text, 240), url: httpUrl(p.url) } : null))
    .filter((p): p is { text: string; url: string } => !!p && !!p.text && !!p.url)
    .slice(0, 3);
  if (!proof.length) return null; // public proof they sponsor creators, or it isn't shown
  const fit = r.fit === "best" || r.fit === "good" ? r.fit : "try";
  return {
    key: keyOf(str(r.key, 60) || name),
    name,
    website,
    what: str(r.what, 120),
    fit,
    why: str(r.why, 300),
    proof,
    wayIn: cleanWayIn(r.wayIn ?? r.way_in),
    firstStep: str(r.firstStep ?? r.first_step, 240) || null,
  };
}

function cleanVideo(raw: unknown, i: number): SponsorVideo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 120);
  const hook = str(r.hook, 200);
  if (!title || !hook) return null;
  return {
    id: `v${i + 1}`,
    title,
    format: str(r.format, 80),
    forBrand: str(r.forBrand ?? r.for_brand, 80) || null,
    deal: str(r.deal, 40) || "Your own",
    hook,
    shots: (Array.isArray(r.shots) ? r.shots : []).map((s) => str(s, 120)).filter(Boolean).slice(0, 8),
  };
}

/** Whatever the job sent, coerced into what we store; null when nothing usable came back. */
export function cleanSponsorResult(raw: unknown, offLimits: string[] = [], ask: { title: string; kind: SponsorKind } | null = null): SponsorResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const brands: SponsorBrand[] = [];
  for (const b of Array.isArray(r.brands) ? r.brands : []) {
    const c = cleanBrand(b, offLimits);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    brands.push(c);
    if (brands.length >= SPONSOR_MAX_BRANDS) break;
  }
  const said = (Array.isArray(r.videos) ? r.videos : []).map(cleanVideo).filter((v): v is SponsorVideo => !!v).slice(0, 8);
  // No video ideas from the model: the built-in three, in her own words, so the tab is never empty.
  const videos = said.length || !ask ? said : baselineVideos(ask.title, ask.kind);
  const todo: SponsorTodo[] = (Array.isArray(r.todo) ? r.todo : [])
    .map((t, i) => (t && typeof t === "object" ? { id: `x${i + 1}`, text: str((t as Record<string, unknown>).text, 200), by: ymd((t as Record<string, unknown>).by), label: str((t as Record<string, unknown>).label, 40) || null } : null))
    .filter((t): t is SponsorTodo => !!t && !!t.text)
    .slice(0, 5);
  const rules = (Array.isArray(r.rules) ? r.rules : []).map((x) => str(x, 240)).filter(Boolean).slice(0, 6);
  const fm = r.firstMove && typeof r.firstMove === "object" ? (r.firstMove as Record<string, unknown>) : null;
  const firstMove = fm && str(fm.text, 300) ? { text: str(fm.text, 300), by: ymd(fm.by) } : null;
  // A result with no brand that has public proof is no result: she sees a clear failure and Try again.
  if (!brands.length) return null;
  return { firstMove, brands, videos, todo, rules, sources: Math.max(0, Math.floor(Number(r.sources) || 0)), madeBy: r.madeBy === "ai" ? "ai" : "rules" };
}

async function applyResult(env: Env, jobId: string, refId: string | null, result: unknown): Promise<void> {
  const profile = await lockedProfile(env);
  const ask = await env.DB.prepare("SELECT title FROM sponsor_asks WHERE id = ?").bind(refId).first<{ title: string }>();
  const clean = cleanSponsorResult(result, offLimitsTerms(profile?.off_limits), ask ? { title: ask.title, kind: sponsorKind(env) } : null);
  const now = nowIso();
  if (!clean) {
    await env.DB.prepare("UPDATE sponsor_asks SET status = 'failed', safe_error = ?, updated_at = ? WHERE id = ? AND job_id = ?")
      .bind("We found no brands with public proof for this yet. Tap Try again, or add a word about where or what.", now, refId, jobId)
      .run();
    log.warn("sponsor.apply.empty");
    return;
  }
  // "Run it again" keeps her ticks, hidden cards and pitches: only the research is replaced.
  await env.DB.prepare("UPDATE sponsor_asks SET status = 'ready', result = ?, safe_error = NULL, ready_at = ?, updated_at = ? WHERE id = ? AND job_id = ?")
    .bind(JSON.stringify(clean), now, now, refId, jobId)
    .run();
  log.info("sponsor.apply", { brands: clean.brands.length, videos: clean.videos.length, by: clean.madeBy });
}

async function onFailure(env: Env, jobId: string, refId: string | null): Promise<void> {
  await env.DB.prepare("UPDATE sponsor_asks SET status = 'failed', safe_error = ?, updated_at = ? WHERE id = ? AND job_id = ?")
    .bind("The search didn't finish. Nothing was lost. Tap Try again.", nowIso(), refId, jobId)
    .run();
}

/** FAKE_SERVICES=1 / practice mode: a realistic, niche-neutral result with example brands. */
async function fakeRun(env: Env, _jobId: string, refId: string | null): Promise<unknown> {
  const ask = await env.DB.prepare("SELECT title FROM sponsor_asks WHERE id = ?").bind(refId).first<{ title: string }>();
  const t = ask?.title ?? "this";
  return {
    firstMove: { text: "Start with Example Hotel Co.: its creator program takes creators your size.", by: null },
    brands: [
      { name: "Example Hotel Co.", website: "https://hotel.example.com/", what: "Hotel group · comped stay for content", fit: "best", why: `Hosts creators for stays like ${t.toLowerCase()}.`, proof: [{ text: "Creator program: free stays for creators with 1K–30K followers.", url: "https://hotel.example.com/creators" }], wayIn: { kind: "email", value: "creators@example.com", foundOn: "https://hotel.example.com/creators", label: "Creator program page (public)" }, firstStep: "Apply on the creator program page." },
      { name: "Example Travel Gear", website: "https://gear.example.com/", what: "Travel gear · gifted + affiliate", fit: "good", why: "Pairs with a packing video.", proof: [{ text: "Affiliate program open to creators.", url: "https://gear.example.com/affiliates" }], wayIn: { kind: "form", value: "https://gear.example.com/affiliates/apply", foundOn: "https://gear.example.com/affiliates", label: "Affiliate application (public)" }, firstStep: null },
      { name: "Example Tourism Board", website: "https://visit.example.com/", what: "Tourism board · hosted trip", fit: "try", why: "Hosts creators on press trips.", proof: [{ text: "Hosted creators on a press trip this year.", url: "https://visit.example.com/press" }], wayIn: null, firstStep: null },
    ],
    videos: [
      { title: "Get ready with me, hotel edition", format: "GRWM · 30–45 sec", forBrand: "Example Hotel Co.", deal: "Paid post", hook: "Getting ready in a room that does half the work for me.", shots: ["room reveal", "vanity close-ups", "outfit", "walk out"] },
      { title: "Pack with me", format: "List · 20 sec", forBrand: "Example Travel Gear", deal: "Gifted", hook: "Everything in one carry-on, here's how.", shots: ["the open bag", "each item going in", "zipped and done"] },
      { title: "What it really cost", format: "Talking to camera · 45 sec", forBrand: null, deal: "Your own", hook: "Here is the honest version.", shots: ["you to camera", "receipts", "the best moment"] },
    ],
    todo: [],
    rules: [],
    sources: 18,
    madeBy: "rules",
  };
}

export const sponsorJob: JobHandler = { buildSpec, applyResult, onFailure, fakeRun };

/** Parse a stored result (null when there is none yet). */
export function storedResult(text: string | null): SponsorResult | null {
  return text ? parseJson<SponsorResult | null>(text, null) : null;
}
