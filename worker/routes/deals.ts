// Brand deals, run the way a talent manager runs them (docs/reviews/agency-pov.md). Money first:
// the money strip, "Brands to pitch this week" ranked by expected money, then every deal with the
// one thing to do next and when. Every step has its email written from real facts; she sends it
// from Gmail (the dashboard never sends to a brand) and taps Mark sent.
//   GET    /api/deals                          money strip, prospects, deals by urgency, listings, finder
//   POST   /api/deals/brands                   a brand she uses and loves
//   PATCH  /api/deals/brands/:id               save / hide / back to suggested
//   POST   /api/deals/brands/:id/contacts      a public contact she found (with its page)
//   DELETE /api/deals/brands/:id/contacts/:cid
//   POST   /api/deals/brands/:id/pitch         one tap: open a deal and write the first pitch
//   POST   /api/deals/inbound                  "a brand wrote to me": brand + pasted email → deal + offer
//   GET    /api/deals/deals/:id                the deal memo, next step, emails, offers, delivery, timeline
//   PATCH  /api/deals/deals/:id                terms, delivery checklist, paid-partnership flag
//   POST   /api/deals/deals/:id/stage          move along the pipeline (canMove; declined/lost need a reason)
//   POST   /api/deals/deals/:id/emails         write an email: {scenario, tone, length}
//   PATCH  /api/deals/emails/:id               her edits
//   POST   /api/deals/emails/:id/sent          she sent it from Gmail: the pipeline moves on
//   POST   /api/deals/deals/:id/offer          paste what they sent → terms, red flags, verdict
//   POST   /api/deals/deals/:id/invoice        make the invoice (number, due date) → stage invoiced
//   GET    /api/deals/deals/:id/invoice        the printable invoice
//   POST   /api/deals/deals/:id/paid           the money landed → paid; the brand joins her kit's collaborations
//   POST/PATCH/DELETE /api/deals/deals/:id/deliverables[/:did]
//   PATCH  /api/deals/listings                 {key, joined} a marketplace she joined
//   POST   /api/deals/finder/run               start the brand finder now
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { getSetting, parseJson, recordEvent, setSetting } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { getLlm } from "../services/openrouter";
import { dispatchJob } from "../services/github";
import { listConnections } from "../lib/connections";
// Pitches link only her own clips: someone else's video (watermark check) is never sent to a brand.
import { POSTABLE_CLIP_SQL } from "../domain/sourceCheck";
import { brandKey, contactProblem, offLimitsTerms, sortContacts, themeHit, validSentAt, violatesOffLimits, type ContactKind } from "../domain/brandfit";
import { byUrgency, CLOSED_STAGES, DECLINE_REASONS, FOLLOWUP_DAYS, LOST_REASONS, canMove, moneyStrip, needsReason, nextAction, nextFollowup, type DealContext, type NextAction } from "../domain/deals";
import { afterFollowupSent, followupsDone } from "../domain/brandfit";
import { SCENARIOS, SCENARIO_KEYS, emailPrompt, parseEmail, starterEmail, suggestedScenario, type EmailFacts, type Length, type ScenarioKey, type Tone } from "../domain/emails";
import { extractTerms, mergeModelTerms, offerPrompt, qualify, redFlags, type OfferTerms } from "../domain/offers";
import { EMPTY_TERMS, cleanTerms, effectiveTerms, exclusivityText, memo, usageText, type DealTerms } from "../domain/memo";
import { EMPTY_DELIVERY, cleanDelivery, deliverySteps, invoiceDue, invoiceNumber, resultsFromStats, type DeliveryState } from "../domain/delivery";
import { counterOffer, leverScripts, packageLabel, quote, threeOptions } from "../domain/ratecard";
import { brandMark, cleanBudget, rankProspects, reachability, BUDGET_LABEL, type BudgetSignal, type Evidence } from "../domain/prospects";
import { listingSteps } from "../domain/marketplaces";
import { beforeYouSend } from "@shared/emailcheck";
import { DEAL_STAGES, DEAL_STAGE_LABEL, PLATFORMS, PLATFORM_LABEL, type DealStage, type Platform } from "@shared/constants";
import { kitName, audienceLine, kitFigures, kitUrl, latestVersion, lockedProfile, readDraft, readKit, themeList } from "./mediakit";
import { readSettings } from "./settings";

export const deals = new Hono<{ Bindings: Env; Variables: Vars }>();
deals.use("*", requireUser);

type C = Context<{ Bindings: Env; Variables: Vars }>;

// ---------- rows

interface BrandDb {
  id: string;
  name: string;
  website: string | null;
  program_url: string | null;
  socials: string;
  fit_score: number;
  fit_reasons: string;
  why_now: string | null;
  source_links: string;
  origin: "her_list" | "finder" | "program_search";
  status: "suggested" | "saved" | "hidden";
  kind: "brand" | "agency" | "local";
  budget_signal: string;
  why_sourced: string;
}
const BRAND_COLS = "id, name, website, program_url, socials, fit_score, fit_reasons, why_now, source_links, origin, status, kind, budget_signal, why_sourced";

interface DealDb {
  id: string;
  brand_id: string;
  stage: DealStage;
  terms_note: string;
  deliverables: string;
  paid_partnership: number;
  terms: string;
  delivery: string;
  outcome_reason: string | null;
  invoice_number: string | null;
  pitched_at: string | null;
  replied_at: string | null;
  agreed_at: string | null;
  delivered_at: string | null;
  invoiced_at: string | null;
  invoice_due_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  updated_at: string;
  created_at: string;
  archived_at: string | null;
  archived_by: "her" | "tidy" | null;
}
const DEAL_COLS = "id, brand_id, stage, terms_note, deliverables, paid_partnership, terms, delivery, outcome_reason, invoice_number, pitched_at, replied_at, agreed_at, delivered_at, invoiced_at, invoice_due_at, paid_at, closed_at, updated_at, created_at, archived_at, archived_by";

/** Day 358: "Do this next" shows this many cards, then "Show all (N)"; Closed and Archived page by this. */
export const DEALS_NEXT_CAP = 8;
export const DEALS_PAGE = 20;

interface PitchDb {
  id: string;
  brand_id: string;
  sent_at: string | null;
  next_followup_at: string | null;
  status: string;
}

export interface Deliverable {
  id: string;
  clip_id: string | null;
  platform: Platform;
  due_at: string;
  note: string;
  done: boolean;
}

interface EmailDb {
  id: string;
  deal_id: string;
  scenario: ScenarioKey;
  subject: string;
  subject_options: string;
  body: string;
  tone: Tone;
  length: Length;
  source: "ai" | "starter";
  status: "draft" | "sent";
  sent_at: string | null;
  created_at: string;
}

const brandById = (env: Env, id: string) => env.DB.prepare(`SELECT ${BRAND_COLS} FROM brands WHERE id = ?`).bind(id).first<BrandDb>();
const dealById = (env: Env, id: string) => env.DB.prepare(`SELECT ${DEAL_COLS} FROM deals WHERE id = ?`).bind(id).first<DealDb>();
const latestDealFor = (env: Env, brandId: string) => env.DB.prepare(`SELECT ${DEAL_COLS} FROM deals WHERE brand_id = ? ORDER BY created_at DESC LIMIT 1`).bind(brandId).first<DealDb>();
const pitchFor = (env: Env, brandId: string) => env.DB.prepare("SELECT id, brand_id, sent_at, next_followup_at, status FROM pitches WHERE brand_id = ? ORDER BY created_at DESC LIMIT 1").bind(brandId).first<PitchDb>();

async function contactsFor(env: Env, brandId: string) {
  const { results } = await env.DB.prepare("SELECT id, kind, value, found_on_url FROM brand_contacts WHERE brand_id = ? ORDER BY checked_at").bind(brandId).all<{ id: string; kind: ContactKind; value: string; found_on_url: string }>();
  return sortContacts(results);
}

const termsOf = (d: DealDb): DealTerms => ({ ...EMPTY_TERMS, ...parseJson<Partial<DealTerms>>(d.terms, {}) });
const deliveryOf = (d: DealDb): DeliveryState & { confirmSentAt?: string | null } => ({ ...EMPTY_DELIVERY, ...parseJson<Partial<DeliveryState>>(d.delivery, {}) });

async function setStage(env: Env, d: DealDb, to: DealStage, extra: Record<string, string | null> = {}) {
  const at = nowIso();
  const cols: Record<string, string | null> = { ...extra };
  if (to === "follow_up" && !d.pitched_at) cols.pitched_at = cols.pitched_at ?? at;
  if (to === "negotiating" && !d.replied_at && (d.stage === "follow_up" || d.stage === "pitch")) cols.replied_at = at;
  if (to === "agreed" && !d.agreed_at) cols.agreed_at = at;
  if (to === "invoiced" && !d.delivered_at) cols.delivered_at = at;
  if (to === "paid" && !d.paid_at) cols.paid_at = at;
  if (CLOSED_STAGES.includes(to)) cols.closed_at = at;
  const keys = Object.keys(cols);
  await env.DB.prepare(`UPDATE deals SET stage = ?, updated_at = ?${keys.map((k) => `, ${k} = ?`).join("")} WHERE id = ?`)
    .bind(to, at, ...keys.map((k) => cols[k]), d.id)
    .run();
}

// ---------- the context a card's next action reads

async function dealContext(env: Env, d: DealDb, brand: BrandDb, hasContact: boolean): Promise<DealContext> {
  const p = await pitchFor(env, d.brand_id);
  const del = deliveryOf(d);
  const t = termsOf(d);
  const hasOffer = !!(await env.DB.prepare("SELECT id FROM deal_offers WHERE deal_id = ? LIMIT 1").bind(d.id).first());
  const earlier = await env.DB.prepare("SELECT COUNT(*) AS n FROM deals WHERE brand_id = ? AND id != ? AND agreed_at IS NOT NULL").bind(d.brand_id, d.id).first<{ n: number }>();
  const sent = p?.sent_at ?? null;
  return {
    stage: d.stage,
    kind: brand.kind,
    hasContact,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    pitchSentAt: sent,
    followupsSent: sent ? followupsDone(sent, p?.next_followup_at ?? null) : 0,
    nextFollowupAt: p?.next_followup_at ?? null,
    hasOffer,
    confirmSent: !!del.confirmSentAt,
    delivery: { draftSentAt: del.draftSentAt, approvedAt: del.approvedAt, postedAt: del.postedAt, reportSentAt: del.reportSentAt },
    draftBy: t.draftBy ? `${t.draftBy}T17:00:00.000Z` : null,
    postBy: t.postBy ? `${t.postBy}T17:00:00.000Z` : null,
    invoiceSentAt: del.invoiceSentAt,
    invoiceDueAt: d.invoice_due_at,
    paidAt: d.paid_at,
    deliveredAt: d.delivered_at,
    rebookSentAt: del.rebookSentAt,
    workedBefore: (earlier?.n ?? 0) > 0,
  };
}

/**
 * Everything due for Home and the Monday recap: each open deal's next action with a date, in
 * the window. One list for both, so they can never disagree.
 */
export async function dueDealItems(env: Env, until: Date): Promise<{ dealId: string; brand: string; dueAt: string; what: string }[]> {
  const { results } = await env.DB.prepare(`SELECT ${DEAL_COLS} FROM deals WHERE stage NOT IN ('declined','lost') AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`).all<DealDb>();
  const out: { dealId: string; brand: string; dueAt: string; what: string }[] = [];
  const now = new Date();
  for (const d of results) {
    const b = await brandById(env, d.brand_id);
    if (!b) continue;
    const ctx = await dealContext(env, d, b, (await contactsFor(env, b.id)).length > 0);
    const n = nextAction(ctx, now);
    if (n.dueAt && new Date(n.dueAt).getTime() <= until.getTime()) out.push({ dealId: d.id, brand: b.name, dueAt: n.dueAt, what: n.label });
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

// ---------- overview

function brandSummary(b: BrandDb) {
  return {
    id: b.id,
    name: b.name,
    kind: b.kind,
    website: b.website,
    programUrl: b.program_url,
    socials: parseJson<Record<string, string>>(b.socials, {}),
    fit: b.fit_score,
    fitReasons: parseJson<string[]>(b.fit_reasons, []),
    whyNow: b.why_now,
    why: parseJson<Evidence[]>(b.why_sourced, []),
    budget: cleanBudget(parseJson<BudgetSignal>(b.budget_signal, { level: "unproven", evidence: [] })),
    sources: parseJson<string[]>(b.source_links, []),
    origin: b.origin,
    status: b.status,
  };
}

deals.get("/", async (c) => {
  const env = c.env;
  const now = new Date();
  const s = await readSettings(env);
  // Day 358: a year of brands and deals. Contacts in one read (not one per brand); archived deals
  // (by her, or by the tidy rules: finished 60 days, quiet 90 days) leave "Do this next" and Home.
  const allNext = c.req.query("all") === "1";
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 80);
  const closedOffset = Math.max(0, Number(c.req.query("closedOffset") ?? 0) || 0);
  const showArchived = c.req.query("archived") === "1";
  const { results: brands } = await env.DB.prepare(`SELECT ${BRAND_COLS} FROM brands ORDER BY created_at DESC LIMIT 300`).all<BrandDb>();
  const { results: allDeals } = await env.DB.prepare(`SELECT ${DEAL_COLS} FROM deals ORDER BY created_at DESC LIMIT 1000`).all<DealDb>();
  const { results: allContacts } = await env.DB.prepare("SELECT id, brand_id, kind, value, found_on_url FROM brand_contacts ORDER BY checked_at").all<{ id: string; brand_id: string; kind: ContactKind; value: string; found_on_url: string }>();
  const contactsBy = new Map<string, { id: string; kind: ContactKind; value: string; found_on_url: string }[]>();
  for (const { brand_id, ...ct } of allContacts) contactsBy.set(brand_id, [...(contactsBy.get(brand_id) ?? []), ct]);
  const latestByBrand = new Map<string, DealDb>();
  for (const d of allDeals) if (!latestByBrand.has(d.brand_id)) latestByBrand.set(d.brand_id, d);

  const prospectsIn = [];
  const cards = [];
  const archivedCards = [];
  for (const b of brands) {
    const contacts = sortContacts(contactsBy.get(b.id) ?? []);
    const d = latestByBrand.get(b.id) ?? null;
    const sum = brandSummary(b);
    prospectsIn.push({ ...sum, contacts, dealStage: d?.stage ?? null, status: b.status });
    if (!d) continue;
    if (q && !b.name.toLowerCase().includes(q)) continue;
    const base = { dealId: d.id, brandId: b.id, brand: b.name, kind: b.kind, stage: d.stage, stageLabel: DEAL_STAGE_LABEL[d.stage], fee: termsOf(d).fee, mark: brandMark(d.stage), outcomeReason: d.outcome_reason, closedAt: d.closed_at, archivedAt: d.archived_at, archivedBy: d.archived_by };
    if (d.archived_at) {
      // archived: no next action is computed (nothing is due on an archived deal)
      archivedCards.push({ ...base, next: { label: "Archived", dueAt: null, overdue: false } as NextAction });
      continue;
    }
    const ctx = await dealContext(env, d, b, contacts.length > 0);
    cards.push({ ...base, next: nextAction(ctx, now) });
  }
  const ranked = rankProspects(prospectsIn.map((p) => ({ ...p, fit: p.fit, budget: p.budget })));
  const prospects = ranked.slice(0, 30).map((r) => {
    const best = r.item.contacts[0] ?? null;
    return { ...r.item, score: r.score, math: r.math, aboveLine: r.aboveLine, budgetLabel: BUDGET_LABEL[r.item.budget.level], reach: reachability(r.item.contacts).label, bestContact: best };
  });
  const sorted = byUrgency(cards);
  const openAll = sorted.filter((x) => !CLOSED_STAGES.includes(x.stage));
  const closedAll = sorted.filter((x) => CLOSED_STAGES.includes(x.stage)).sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const open = allNext ? openAll : openAll.slice(0, DEALS_NEXT_CAP);
  const closed = closedAll.slice(closedOffset, closedOffset + DEALS_PAGE);
  archivedCards.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));

  const joined = await getSetting<string[]>(env.DB, "marketplaces_joined", []);
  const followers: Partial<Record<Platform, number>> = {};
  for (const f of await kitFigures(env)) followers[f.platform] = f.followers;
  const job = await env.DB.prepare("SELECT status, created_at, finished_at, safe_error FROM jobs WHERE type = 'brand_finder' ORDER BY created_at DESC LIMIT 1").first<{ status: string; created_at: string; finished_at: string | null; safe_error: string | null }>();
  const conns = await listConnections(env);
  const hunter = conns.find((x) => x.service === "hunter");
  const row = await readKit(env);
  const pub = await latestVersion(env);
  const moneyRows = allDeals.map((d) => ({ stage: d.stage, fee: termsOf(d).fee, pitchedAt: d.pitched_at, repliedAt: d.replied_at, agreedAt: d.agreed_at, paidAt: d.paid_at, outcomeReason: d.outcome_reason }));
  return c.json({
    money: moneyStrip(moneyRows, now, s.audience_timezone),
    prospects,
    deals: open,
    dealsTotal: openAll.length,
    closed,
    closedTotal: closedAll.length,
    closedOffset,
    archived: showArchived ? archivedCards.slice(0, 200) : [],
    archivedTotal: archivedCards.length,
    listings: listingSteps(followers, joined),
    kit: { url: kitUrl(env, row.public_slug), published: !!pub },
    profileLocked: !!(await lockedProfile(env)),
    finder: job
      ? { status: job.status, startedAt: job.created_at, finishedAt: job.finished_at, running: ["queued", "dispatched", "running"].includes(job.status), error: job.safe_error }
      : { status: "never", startedAt: null, finishedAt: null, running: false, error: null },
    hunter: { connected: hunter?.status === "ok", creditsLeft: (hunter?.meta.credits_left as number | undefined) ?? null },
    reasons: { declined: DECLINE_REASONS, lost: LOST_REASONS },
  });
});

// ---------- brands

function normUrl(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function upsertHerBrand(c: C, name: string, website: string | null, note: string | null): Promise<{ id: string; existed: boolean } | Response> {
  const key = brandKey({ name, website });
  const { results: existing } = await c.env.DB.prepare("SELECT id, name, website FROM brands").all<{ id: string; name: string; website: string | null }>();
  const dup = existing.find((b) => brandKey(b) === key);
  if (dup) {
    await c.env.DB.prepare("UPDATE brands SET status = 'saved', origin = 'her_list' WHERE id = ?").bind(dup.id).run();
    return { id: dup.id, existed: true };
  }
  const profile = await lockedProfile(c.env);
  const hit = violatesOffLimits({ name, website }, offLimitsTerms(profile?.off_limits));
  if (hit) return fail(c, 422, `"${hit}" is on your off-limits list in your Brand Profile, so this brand can't be added.`, "pitch-a-brand");
  const id = newId("brd");
  const reasons = ["You use and love this brand (strongest pitches)."];
  if (note) reasons.push(note.slice(0, 200));
  await c.env.DB.prepare("INSERT INTO brands (id, name, website, fit_score, fit_reasons, origin, status) VALUES (?, ?, ?, 0.9, ?, 'her_list', 'saved')").bind(id, name, website, JSON.stringify(reasons)).run();
  return { id, existed: false };
}

deals.post("/brands", async (c) => {
  const body = await readJson<{ name?: string; website?: string; note?: string }>(c);
  const name = body?.name?.trim();
  if (!name || name.length > 80) return fail(c, 400, "Type the brand's name.", "pitch-a-brand");
  const website = normUrl(body?.website);
  if (body?.website && !website) return fail(c, 422, "That website does not look right. Try something like brand.com.", "pitch-a-brand");
  const r = await upsertHerBrand(c, name, website, body?.note?.trim() || null);
  if (r instanceof Response) return r;
  await recordEvent(c.env.DB, "brand.added", r.id, { origin: "her_list" }, c.get("user").email);
  log.info("deals.brand.added");
  return c.json(r);
});

deals.patch("/brands/:id", async (c) => {
  const body = await readJson<{ status?: BrandDb["status"] }>(c);
  if (!body?.status || !["suggested", "saved", "hidden"].includes(body.status)) return fail(c, 400, "Pick save or hide.");
  const r = await c.env.DB.prepare("UPDATE brands SET status = ? WHERE id = ?").bind(body.status, c.req.param("id")).run();
  if (!r.meta.changes) return fail(c, 404, "That brand is gone.");
  await recordEvent(c.env.DB, `brand.${body.status}`, c.req.param("id"), {}, c.get("user").email);
  return c.json({ ok: true });
});

deals.post("/brands/:id/contacts", async (c) => {
  const brand = await brandById(c.env, c.req.param("id"));
  if (!brand) return fail(c, 404, "That brand is gone.");
  const body = await readJson<{ kind?: ContactKind; value?: string; found_on_url?: string }>(c);
  const cand = { kind: body?.kind ?? "role_email", value: (body?.value ?? "").trim(), found_on_url: normUrl(body?.found_on_url) ?? "" };
  const problem = contactProblem(cand);
  if (problem) return fail(c, 422, problem, "pitch-a-brand");
  const id = newId("bct");
  await c.env.DB.prepare("INSERT INTO brand_contacts (id, brand_id, kind, value, found_on_url) VALUES (?, ?, ?, ?, ?)").bind(id, brand.id, cand.kind, cand.value, cand.found_on_url).run();
  const d = await latestDealFor(c.env, brand.id);
  if (d && d.stage === "find_contact") await setStage(c.env, d, "pitch");
  return c.json({ id });
});

deals.delete("/brands/:id/contacts/:cid", async (c) => {
  await c.env.DB.prepare("DELETE FROM brand_contacts WHERE id = ? AND brand_id = ?").bind(c.req.param("cid"), c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- facts for an email (real data only)

async function emailFacts(env: Env, d: DealDb, b: BrandDb, opts: { declineReason?: string | null } = {}): Promise<EmailFacts> {
  const profile = await lockedProfile(env);
  const kit = await readDraft(env);
  const row = await readKit(env);
  const figures = await kitFigures(env);
  const t = termsOf(d);
  const eff = effectiveTerms(t, kit.addons);
  const offer = await env.DB.prepare("SELECT terms FROM deal_offers WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1").bind(d.id).first<{ terms: string }>();
  const theirs = offer ? parseJson<OfferTerms | null>(offer.terms, null) : null;
  const pkg = kit.packages.find((p) => p.id === t.packageId) ?? null;
  const counter = theirs?.fee != null && pkg ? counterOffer(theirs.fee, pkg) : null;
  const { results: clipRows } = await env.DB.prepare(`SELECT c.id, c.media_token FROM clips c WHERE ${POSTABLE_CLIP_SQL} AND c.media_token IS NOT NULL ORDER BY c.score DESC LIMIT 20`).all<{ id: string; media_token: string }>();
  const ordered = [...clipRows.filter((x) => kit.showcase.includes(x.id)), ...clipRows.filter((x) => !kit.showcase.includes(x.id))];
  const best = figures.find((f) => f.engagement);
  const results = await dealResults(env, d);
  return {
    creatorName: kit.name || kitName(env),
    voice: profile?.voice ?? "",
    themes: kit.pillars.length ? kit.pillars.map((p) => p.title) : themeList(profile?.themes),
    audience: audienceLine(profile?.audience),
    brand: { name: b.name, kind: b.kind, contactFirstName: t.contactName ? t.contactName.split(" ")[0] : null, herPick: b.origin === "her_list", product: null },
    research: parseJson<Evidence[]>(b.why_sourced, []).slice(0, 2),
    numbers: figures.map((f) => ({ platform: PLATFORM_LABEL[f.platform], followers: f.followers, avgViews: f.avgViews, asOf: f.asOf })),
    engagementLine: best?.engagement ? `${best.engagement.rate}% of ${PLATFORM_LABEL[best.platform]} viewers like, comment, share or save.` : null,
    kitUrl: kitUrl(env, row.public_slug),
    clipLinks: ordered.slice(0, 2).map((x) => `${env.PUBLIC_BASE_URL}/media/${x.media_token}`),
    idea: t.idea,
    options: threeOptions(kit.packages, kit.addons),
    offer: pkg ? { name: pkg.name, what: packageLabel(pkg.items), price: pkg.onRequest ? null : pkg.startingAt } : null,
    terms: { fee: t.fee, deliverables: t.deliverables ?? (pkg ? packageLabel(pkg.items) : null), postBy: t.postBy, draftBy: t.draftBy, usage: usageText(t), exclusivity: exclusivityText(t), netDays: eff.netDays, upfrontPct: eff.upfrontPct, upfrontOver: kit.addons.upfrontOver, killFeePct: eff.killFeePct, revisionRounds: eff.revisionRounds },
    theirs: theirs ? { fee: theirs.fee, deliverables: theirs.deliverables, usage: theirs.usage, exclusivity: theirs.exclusivity, payment: theirs.payment, timeline: theirs.timeline } : null,
    counter: counter && counter.verdict !== "no_floor" ? { amount: counter.counter, line: counter.line } : null,
    invoice: d.invoice_number && d.invoice_due_at ? { number: d.invoice_number, amount: invoiceTotal(t, kit.addons) ?? 0, dueAt: d.invoice_due_at, link: null } : null,
    results,
    declineReason: opts.declineReason ?? d.outcome_reason ?? null,
    today: nowIso().slice(0, 10),
  };
}

function invoiceTotal(t: DealTerms, addons: Parameters<typeof quote>[2]): number | null {
  if (t.fee == null) return null;
  return quote(t.fee, { usageDays: t.usageDays, paidUsageDays: t.paidUsageDays, exclusivityMonths: t.exclusivityMonths, rush: t.rush }, addons).total;
}

/** The deal's posts' numbers, from Stats: dashboard posts of its deliverable clips, and platform videos at its post links. */
async function dealResults(env: Env, d: DealDb) {
  const clipIds = parseJson<Deliverable[]>(d.deliverables, []).map((x) => x.clip_id).filter((x): x is string => !!x);
  const urls = deliveryOf(d).postUrls;
  const rows: { views: number; likes: number; comments: number; shares: number; saves: number; captured_at: string }[] = [];
  for (const id of clipIds) {
    const { results } = await env.DB.prepare(
      "SELECT m.views, m.likes, m.comments, m.shares, m.saves, m.captured_at FROM posts p JOIN metrics m ON m.post_id = p.id WHERE p.clip_id = ? AND m.captured_at = (SELECT MAX(m2.captured_at) FROM metrics m2 WHERE m2.post_id = p.id)",
    )
      .bind(id)
      .all<(typeof rows)[number]>();
    rows.push(...results);
  }
  for (const u of urls) {
    const r = await env.DB.prepare("SELECT views, likes, comments, shares, saves, captured_at FROM platform_videos WHERE url = ? LIMIT 1").bind(u).first<(typeof rows)[number]>();
    if (r) rows.push(r);
  }
  return resultsFromStats(rows);
}

// ---------- writing an email

async function writeEmail(c: C, d: DealDb, b: BrandDb, key: ScenarioKey, tone: Tone, length: Length, extra: { declineReason?: string | null } = {}) {
  const facts = await emailFacts(c.env, d, b, extra);
  let draft = starterEmail(key, facts, tone, length);
  let source: "ai" | "starter" = "starter";
  let note: string | null = null;
  if (!c.get("fake")) {
    const llm = await getLlm(c.env);
    const { system, user } = emailPrompt(key, facts, tone, length);
    const r = await llm.complete({ system, user, json: true, maxTokens: 900, accept: (t) => !!parseEmail(t, key, facts) });
    const parsed = r.ok ? parseEmail(r.text, key, facts) : null;
    if (parsed) {
      draft = parsed;
      source = "ai";
    } else {
      note = "The free AI model didn't answer well, so this is the starter draft built from your real numbers. Edit anything, or tap Rewrite in a minute.";
      log.warn("deals.email.fallback", { ok: r.ok });
    }
  }
  const id = newId("dem");
  await c.env.DB.prepare("INSERT INTO deal_emails (id, deal_id, scenario, subject, subject_options, body, tone, length, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, d.id, key, draft.subject, JSON.stringify(draft.subjects), draft.body, tone, length, source)
    .run();
  await recordEvent(c.env.DB, "deal.email_drafted", d.id, { scenario: key, source }, c.get("user").email);
  log.info("deals.email.drafted", { scenario: key, source });
  return { id, note, facts };
}

function emailView(e: EmailDb, kit: string) {
  const checks = beforeYouSend(`${e.subject}\n${e.body}`, SCENARIOS[e.scenario]?.checks ?? [], kit);
  return { id: e.id, scenario: e.scenario, label: SCENARIOS[e.scenario]?.label ?? e.scenario, subject: e.subject, subjects: parseJson<string[]>(e.subject_options, []), body: e.body, tone: e.tone, length: e.length, source: e.source, status: e.status, sentAt: e.sent_at, createdAt: e.created_at, checks };
}

const TONES: Tone[] = ["warm", "straight", "short"];
const LENGTHS: Length[] = ["brief", "standard", "detailed"];

/** One tap from a prospect card: the deal opens with its first pitch already written. */
deals.post("/brands/:id/pitch", async (c) => {
  const b = await brandById(c.env, c.req.param("id"));
  if (!b) return fail(c, 404, "That brand is gone.");
  if (!(await lockedProfile(c.env))) return fail(c, 409, "Lock your Brand Profile first, so pitches sound like you.", "upload-brand-docs");
  let d = await latestDealFor(c.env, b.id);
  if (d && !["done", "declined", "lost"].includes(d.stage)) {
    // already in play: open it (a pitch not yet sent gets a fresh draft only if it has none)
    const has = await c.env.DB.prepare("SELECT id FROM deal_emails WHERE deal_id = ? LIMIT 1").bind(d.id).first();
    if (has) return c.json({ dealId: d.id, emailId: null, note: null });
  } else {
    const contacts = await contactsFor(c.env, b.id);
    const id = newId("dl");
    await c.env.DB.prepare("INSERT INTO deals (id, brand_id, stage) VALUES (?, ?, ?)").bind(id, b.id, contacts.length ? "pitch" : "find_contact").run();
    d = (await dealById(c.env, id))!;
    if (b.status === "suggested") await c.env.DB.prepare("UPDATE brands SET status = 'saved' WHERE id = ?").bind(b.id).run();
    await recordEvent(c.env.DB, "deal.opened", id, { from: "prospect" }, c.get("user").email);
  }
  const earlier = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM deals WHERE brand_id = ? AND agreed_at IS NOT NULL").bind(b.id).first<{ n: number }>();
  const key: ScenarioKey = b.kind === "agency" ? "agency_pitch" : (earlier?.n ?? 0) > 0 ? "warm_repitch" : "cold_pitch";
  const e = await writeEmail(c, d, b, key, "warm", "standard");
  return c.json({ dealId: d.id, emailId: e.id, note: e.note });
});

deals.post("/deals/:id/emails", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  const b = (await brandById(c.env, d.brand_id))!;
  const body = await readJson<{ scenario?: string; tone?: string; length?: string; declineReason?: string }>(c);
  const key = body?.scenario as ScenarioKey;
  if (!SCENARIO_KEYS.includes(key)) return fail(c, 400, "Pick which email to write.");
  const tone = TONES.includes(body?.tone as Tone) ? (body!.tone as Tone) : "warm";
  const length = LENGTHS.includes(body?.length as Length) ? (body!.length as Length) : "standard";
  const e = await writeEmail(c, d, b, key, tone, length, { declineReason: body?.declineReason?.trim().slice(0, 200) || null });
  const row = (await c.env.DB.prepare("SELECT * FROM deal_emails WHERE id = ?").bind(e.id).first<EmailDb>())!;
  return c.json({ email: emailView(row, e.facts.kitUrl), note: e.note });
});

deals.patch("/emails/:id", async (c) => {
  const e = await c.env.DB.prepare("SELECT * FROM deal_emails WHERE id = ?").bind(c.req.param("id")).first<EmailDb>();
  if (!e) return fail(c, 404, "That email is gone.");
  const body = await readJson<{ subject?: string; body?: string }>(c);
  const subject = body?.subject !== undefined ? String(body.subject).slice(0, 200) : e.subject;
  const text = body?.body !== undefined ? String(body.body).slice(0, 8000) : e.body;
  await c.env.DB.prepare("UPDATE deal_emails SET subject = ?, body = ? WHERE id = ?").bind(subject, text, e.id).run();
  const row = await readKit(c.env);
  return c.json({ email: emailView({ ...e, subject, body: text }, kitUrl(c.env, row.public_slug)) });
});

/** She sent it from Gmail: record it on the timeline and move the pipeline the way that email means. */
deals.post("/emails/:id/sent", async (c) => {
  const e = await c.env.DB.prepare("SELECT * FROM deal_emails WHERE id = ?").bind(c.req.param("id")).first<EmailDb>();
  if (!e) return fail(c, 404, "That email is gone.");
  const d = (await dealById(c.env, e.deal_id))!;
  const body = await readJson<{ sent_at?: string }>(c);
  const sentAt = validSentAt(body?.sent_at, new Date());
  if (!sentAt) return fail(c, 422, "Pick the day you sent it: today or up to 60 days ago.", "pitch-a-brand");
  if (e.status === "sent") return fail(c, 409, "This email is already marked as sent.", "pitch-a-brand");
  await c.env.DB.prepare("UPDATE deal_emails SET status = 'sent', sent_at = ? WHERE id = ?").bind(sentAt, e.id).run();
  const del = deliveryOf(d);
  const setDel = async (patch: Partial<DeliveryState> & { confirmSentAt?: string }) => c.env.DB.prepare("UPDATE deals SET delivery = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({ ...del, ...patch }), nowIso(), d.id).run();
  let moved: DealStage | null = null;
  switch (e.scenario) {
    case "cold_pitch":
    case "agency_pitch":
    case "warm_repitch": {
      const p = await pitchFor(c.env, d.brand_id);
      const next = nextFollowup(sentAt, 0);
      if (p && p.status === "drafted") await c.env.DB.prepare("UPDATE pitches SET subject = ?, body = ?, status = 'sent', sent_at = ?, next_followup_at = ? WHERE id = ?").bind(e.subject, e.body, sentAt, next, p.id).run();
      else await c.env.DB.prepare("INSERT INTO pitches (id, brand_id, subject, body, status, sent_at, next_followup_at) VALUES (?, ?, ?, ?, 'sent', ?, ?)").bind(newId("pch"), d.brand_id, e.subject, e.body, sentAt, next).run();
      if (d.stage === "pitch" || d.stage === "find_contact") {
        await setStage(c.env, d, "follow_up", { pitched_at: sentAt });
        moved = "follow_up";
      }
      break;
    }
    case "followup_1":
    case "followup_2":
    case "followup_3": {
      const p = await pitchFor(c.env, d.brand_id);
      if (p?.sent_at) await c.env.DB.prepare("UPDATE pitches SET next_followup_at = ? WHERE id = ?").bind(afterFollowupSent(p.sent_at, p.next_followup_at), p.id).run();
      break;
    }
    case "deliverables_confirm":
      await setDel({ confirmSentAt: sentAt });
      break;
    case "draft_for_approval":
      await setDel({ draftSentAt: del.draftSentAt ?? sentAt });
      break;
    case "results_report":
      await setDel({ reportSentAt: sentAt });
      break;
    case "invoice_send":
      await setDel({ invoiceSentAt: sentAt });
      break;
    case "thank_you_rebook":
      await setDel({ rebookSentAt: sentAt });
      if (d.stage === "paid") {
        await setStage(c.env, d, "done");
        moved = "done";
      }
      break;
    case "decline":
      if (canMove(d.stage, "declined")) {
        await setStage(c.env, d, "declined", { outcome_reason: d.outcome_reason ?? "Declined by email" });
        await c.env.DB.prepare("UPDATE pitches SET next_followup_at = NULL, status = 'closed' WHERE brand_id = ?").bind(d.brand_id).run();
        moved = "declined";
      }
      break;
    default:
      break;
  }
  await recordEvent(c.env.DB, "deal.email_sent", d.id, { scenario: e.scenario }, c.get("user").email);
  log.info("deals.email.sent", { scenario: e.scenario });
  return c.json({ ok: true, moved });
});

// ---------- the deal view

deals.get("/deals/:id", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  const b = (await brandById(c.env, d.brand_id))!;
  const contacts = await contactsFor(c.env, b.id);
  const now = new Date();
  const ctx = await dealContext(c.env, d, b, contacts.length > 0);
  const next = nextAction(ctx, now);
  const kit = await readDraft(c.env);
  const row = await readKit(c.env);
  const url = kitUrl(c.env, row.public_slug);
  const t = termsOf(d);
  const { results: emails } = await c.env.DB.prepare("SELECT * FROM deal_emails WHERE deal_id = ? ORDER BY created_at DESC LIMIT 60").bind(d.id).all<EmailDb>();
  const { results: offers } = await c.env.DB.prepare("SELECT id, pasted, terms, flags, verdict, source, created_at FROM deal_offers WHERE deal_id = ? ORDER BY created_at DESC LIMIT 10").bind(d.id).all<{ id: string; pasted: string; terms: string; flags: string; verdict: string; source: string; created_at: string }>();
  const { results: events } = await c.env.DB.prepare("SELECT kind, detail, created_at FROM events WHERE ref_id = ? AND kind LIKE 'deal.%' ORDER BY created_at DESC LIMIT 60").bind(d.id).all<{ kind: string; detail: string; created_at: string }>();
  const del = deliveryOf(d);
  const eff = effectiveTerms(t, kit.addons);
  const p = await pitchFor(c.env, b.id);
  const pub = await latestVersion(c.env);
  return c.json({
    deal: { id: d.id, stage: d.stage, stageLabel: DEAL_STAGE_LABEL[d.stage], outcomeReason: d.outcome_reason, invoiceNumber: d.invoice_number, invoiceDueAt: d.invoice_due_at, paidAt: d.paid_at, paidPartnership: !!d.paid_partnership, pitchedAt: d.pitched_at, followupsSent: ctx.followupsSent, followupsTotal: FOLLOWUP_DAYS.length, nextFollowupAt: p?.next_followup_at ?? null, archivedAt: d.archived_at },
    brand: { ...brandSummary(b), contacts },
    next,
    suggested: next.scenario ?? suggestedScenario(d.stage, { kind: b.kind, followupsSent: ctx.followupsSent, hasOffer: ctx.hasOffer, invoiceOverdue: !!(d.invoice_due_at && d.invoice_due_at < now.toISOString()), delivered: !!del.postedAt, paid: !!d.paid_at, workedBefore: ctx.workedBefore }),
    scenarios: SCENARIO_KEYS.map((k) => ({ key: k, label: SCENARIOS[k].label, when: SCENARIOS[k].when })),
    emails: emails.map((e) => emailView(e, url)),
    offers: offers.map((o) => ({ id: o.id, pasted: o.pasted, terms: parseJson(o.terms, {}), flags: parseJson(o.flags, []), verdict: parseJson(o.verdict, {}), source: o.source, createdAt: o.created_at })),
    terms: t,
    effective: { netDays: eff.netDays, upfrontPct: eff.upfrontPct, killFeePct: eff.killFeePct, revisionRounds: eff.revisionRounds },
    memo: memo({ brand: b.name, contact: contacts[0]?.value ?? null, kind: b.kind, stage: d.stage, terms: t, addons: kit.addons, next, paidAt: d.paid_at, invoiceDueAt: d.invoice_due_at, postedAt: del.postedAt }),
    delivery: { state: del, steps: deliverySteps(del, { draftBy: t.draftBy, postBy: t.postBy, revisionRounds: eff.revisionRounds }) },
    deliverables: parseJson<Deliverable[]>(d.deliverables, []),
    packages: kit.packages.map((x) => ({ id: x.id, name: x.name, what: packageLabel(x.items), items: x.items, startingAt: x.startingAt, onRequest: x.onRequest, floor: x.floor, target: x.target })),
    addons: kit.addons,
    levers: leverScripts(kit.addons),
    results: await dealResults(c.env, d),
    kit: { url, published: !!pub },
    timeline: [
      ...emails.map((e) => ({ at: e.sent_at ?? e.created_at, what: `${e.status === "sent" ? "Sent" : "Drafted"}: ${SCENARIOS[e.scenario]?.label ?? e.scenario}`, emailId: e.id })),
      ...offers.map((o) => ({ at: o.created_at, what: "Pasted their email", emailId: null })),
      ...events.filter((e) => !e.kind.startsWith("deal.email")).map((e) => ({ at: e.created_at, what: eventLabel(e.kind, parseJson<Record<string, unknown>>(e.detail, {})), emailId: null })),
    ].sort((a, b2) => b2.at.localeCompare(a.at)),
    reasons: { declined: DECLINE_REASONS, lost: LOST_REASONS },
    stages: DEAL_STAGES.map((s) => ({ key: s, label: DEAL_STAGE_LABEL[s], allowed: canMove(d.stage, s) })),
  });
});

function eventLabel(kind: string, detail: Record<string, unknown>): string {
  const stage = kind.replace(/^deal\./, "") as DealStage;
  if (DEAL_STAGES.includes(stage)) return `Moved to ${DEAL_STAGE_LABEL[stage]}${detail.reason ? `: ${detail.reason}` : ""}`;
  if (kind === "deal.opened") return "Deal opened";
  if (kind === "deal.invoice") return "Invoice made";
  if (kind === "deal.terms") return "Terms updated";
  return kind.replace(/^deal\./, "").replace(/_/g, " ");
}

deals.patch("/deals/:id", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  const body = await readJson<{ terms?: Partial<DealTerms>; delivery?: Partial<DeliveryState>; paid_partnership?: boolean }>(c);
  if (!body) return fail(c, 400, "Nothing to save.");
  let terms = termsOf(d);
  let delivery = deliveryOf(d);
  if (body.terms) {
    const r = cleanTerms(terms, body.terms);
    if ("problem" in r) return fail(c, 422, r.problem, "negotiate-a-rate");
    if (r.terms.packageId) {
      const kit = await readDraft(c.env);
      if (!kit.packages.some((p) => p.id === r.terms.packageId)) return fail(c, 422, "That package is not on your rate card.", "negotiate-a-rate");
    }
    terms = r.terms;
  }
  if (body.delivery) {
    const r = cleanDelivery(delivery, body.delivery, nowIso());
    if ("problem" in r) return fail(c, 422, r.problem, "invoice-a-brand");
    delivery = { ...delivery, ...r.state };
  }
  const paid = body.paid_partnership !== undefined ? (body.paid_partnership ? 1 : 0) : d.paid_partnership;
  await c.env.DB.prepare("UPDATE deals SET terms = ?, delivery = ?, paid_partnership = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(terms), JSON.stringify(delivery), paid, nowIso(), d.id).run();
  if (body.paid_partnership !== undefined) await syncPaidClips(c.env, { ...d, paid_partnership: paid });
  if (body.terms) await recordEvent(c.env.DB, "deal.terms", d.id, { fields: Object.keys(body.terms).length }, c.get("user").email);
  return c.json({ ok: true, terms, delivery });
});

deals.post("/deals/:id/stage", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  const body = await readJson<{ stage?: DealStage; reason?: string; sent_at?: string }>(c);
  const to = body?.stage;
  if (!to || !DEAL_STAGES.includes(to)) return fail(c, 400, "Pick a stage.");
  if (!canMove(d.stage, to)) return fail(c, 409, `A deal can't go from "${DEAL_STAGE_LABEL[d.stage]}" straight to "${DEAL_STAGE_LABEL[to]}".`, "pitch-a-brand");
  const reason = body?.reason?.trim().slice(0, 200) || null;
  if (needsReason(to) && !reason) return fail(c, 422, "Pick a reason, so the dashboard learns what works.", "pitch-a-brand");
  if (to === "pitch" && d.stage === "find_contact" && !(await contactsFor(c.env, d.brand_id)).length) return fail(c, 409, "Add their contact first.", "pitch-a-brand");
  if (to === "follow_up") {
    // "I sent the pitch" without using an email here (she wrote her own)
    const sentAt = validSentAt(body?.sent_at, new Date());
    if (!sentAt) return fail(c, 422, "Pick the day you sent it: today or up to 60 days ago.", "pitch-a-brand");
    const p = await pitchFor(c.env, d.brand_id);
    if (p) await c.env.DB.prepare("UPDATE pitches SET status = 'sent', sent_at = ?, next_followup_at = ? WHERE id = ?").bind(sentAt, nextFollowup(sentAt, 0), p.id).run();
    else await c.env.DB.prepare("INSERT INTO pitches (id, brand_id, subject, body, status, sent_at, next_followup_at) VALUES (?, ?, '', '', 'sent', ?, ?)").bind(newId("pch"), d.brand_id, sentAt, nextFollowup(sentAt, 0)).run();
    await setStage(c.env, d, to, { pitched_at: sentAt });
  } else {
    await setStage(c.env, d, to, needsReason(to) ? { outcome_reason: reason } : {});
  }
  if (to === "negotiating" || needsReason(to)) await c.env.DB.prepare("UPDATE pitches SET next_followup_at = NULL, status = ? WHERE brand_id = ? AND status IN ('drafted','sent')").bind(needsReason(to) ? "closed" : "replied", d.brand_id).run();
  if (to === "declined" && reason && /fit|off-limits/i.test(reason)) await c.env.DB.prepare("UPDATE brands SET status = 'hidden' WHERE id = ?").bind(d.brand_id).run();
  if (to === "paid") await addCollabFromDeal(c.env, d);
  await recordEvent(c.env.DB, `deal.${to}`, d.id, { from: d.stage, reason }, c.get("user").email);
  log.info("deals.stage", { to });
  return c.json({ ok: true });
});

// ---------- inbound offers

async function readOffer(c: C, text: string, d: DealDb, b: BrandDb) {
  const rules = extractTerms(text);
  let terms = rules;
  let source: "ai" | "rules" = "rules";
  if (!c.get("fake")) {
    const llm = await getLlm(c.env);
    const { system, user } = offerPrompt(text);
    const r = await llm.complete({ system, user, json: true, maxTokens: 700 });
    if (r.ok) {
      try {
        const a = r.text.indexOf("{");
        const z = r.text.lastIndexOf("}");
        terms = mergeModelTerms(text, rules, JSON.parse(r.text.slice(a, z + 1)));
        source = "ai";
      } catch {
        log.warn("deals.offer.unparsed");
      }
    }
  }
  const flags = redFlags(text, terms);
  const profile = await lockedProfile(c.env);
  const kit = await readDraft(c.env);
  const t = termsOf(d);
  const pkg = kit.packages.find((p) => p.id === t.packageId) ?? kit.packages.find((p) => p.floor != null && p.target != null) ?? null;
  const onTheme = themeHit(`${text} ${b.name}`, themeList(profile?.themes));
  const offLimitsHit = violatesOffLimits({ name: b.name, website: b.website, categories: [text.slice(0, 2000)] }, offLimitsTerms(profile?.off_limits));
  const verdict = qualify(terms, flags, { offLimitsHit, themeHit: onTheme, floor: pkg?.floor ?? null, target: pkg?.target ?? null });
  const id = newId("off");
  await c.env.DB.prepare("INSERT INTO deal_offers (id, deal_id, pasted, terms, flags, verdict, source) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, d.id, text, JSON.stringify(terms), JSON.stringify(flags), JSON.stringify(verdict), source).run();
  // Pre-fill what's blank on the deal from their email (she confirms on the memo; the offer stays labelled as theirs).
  const pre: Partial<DealTerms> = {};
  if (!t.deliverables && terms.deliverables) pre.deliverables = terms.deliverables;
  if (!t.buyer && terms.buyer !== "unknown" && terms.buyer !== "gifting") pre.buyer = terms.buyer;
  if (!t.packageId && pkg) pre.packageId = pkg.id;
  if (Object.keys(pre).length) await c.env.DB.prepare("UPDATE deals SET terms = ? WHERE id = ?").bind(JSON.stringify({ ...t, ...pre }), d.id).run();
  if (d.stage === "pitch" || d.stage === "follow_up" || d.stage === "find_contact") {
    const fresh = (await dealById(c.env, d.id))!;
    if (d.stage === "find_contact") await setStage(c.env, fresh, "pitch");
    await setStage(c.env, (await dealById(c.env, d.id))!, "negotiating");
    await c.env.DB.prepare("UPDATE pitches SET next_followup_at = NULL, status = 'replied' WHERE brand_id = ? AND status IN ('drafted','sent')").bind(d.brand_id).run();
  }
  await recordEvent(c.env.DB, "deal.offer", d.id, { flags: flags.length, verdict: verdict.verdict, source }, c.get("user").email);
  log.info("deals.offer", { flags: flags.length, verdict: verdict.verdict, source });
  return { id, terms, flags, verdict, source, counter: terms.fee != null && pkg ? counterOffer(terms.fee, pkg) : null, packageName: pkg?.name ?? null };
}

deals.post("/deals/:id/offer", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  const body = await readJson<{ text?: string }>(c);
  const text = (body?.text ?? "").trim();
  if (text.length < 20) return fail(c, 422, "Paste the brand's whole email (at least a couple of sentences).", "reply-to-a-brand-offer");
  if (text.length > 20_000) return fail(c, 422, "That's very long. Paste just their email, not the whole thread.", "reply-to-a-brand-offer");
  const b = (await brandById(c.env, d.brand_id))!;
  return c.json(await readOffer(c, text, d, b));
});

/** "A brand wrote to me": for a brand not in her list yet. */
deals.post("/inbound", async (c) => {
  const body = await readJson<{ name?: string; website?: string; email?: string; text?: string }>(c);
  const name = body?.name?.trim();
  const text = (body?.text ?? "").trim();
  if (!name || name.length > 80) return fail(c, 400, "Type the brand's name.", "reply-to-a-brand-offer");
  if (text.length < 20) return fail(c, 422, "Paste the brand's whole email (at least a couple of sentences).", "reply-to-a-brand-offer");
  const website = normUrl(body?.website);
  const r = await upsertHerBrand(c, name, website, null);
  if (r instanceof Response) return r;
  await c.env.DB.prepare("UPDATE brands SET fit_reasons = ? WHERE id = ? AND origin = 'her_list'").bind(JSON.stringify(["They wrote to you with an offer."]), r.id).run();
  const email = (body?.email ?? "").trim().toLowerCase();
  if (email) {
    // Their own reply address is a business contact she was sent directly; the page is her inbox, so the brand's site stands in as "found on".
    const cand = { kind: "role_email" as ContactKind, value: email, found_on_url: website ?? "" };
    if (!contactProblem(cand)) await c.env.DB.prepare("INSERT INTO brand_contacts (id, brand_id, kind, value, found_on_url) VALUES (?, ?, ?, ?, ?)").bind(newId("bct"), r.id, cand.kind, cand.value, cand.found_on_url).run();
  }
  let d = await latestDealFor(c.env, r.id);
  if (!d || ["done", "declined", "lost"].includes(d.stage)) {
    const id = newId("dl");
    await c.env.DB.prepare("INSERT INTO deals (id, brand_id, stage) VALUES (?, ?, 'pitch')").bind(id, r.id).run();
    await recordEvent(c.env.DB, "deal.opened", id, { from: "inbound" }, c.get("user").email);
    d = (await dealById(c.env, id))!;
  }
  const b = (await brandById(c.env, r.id))!;
  const offer = await readOffer(c, text, d, b);
  return c.json({ dealId: d.id, offer });
});

// ---------- invoice + paid

async function addCollabFromDeal(env: Env, d: DealDb) {
  const kit = await readDraft(env);
  const b = await brandById(env, d.brand_id);
  if (!b || kit.collabs.some((x) => x.dealId === d.id || x.brand.toLowerCase() === b.name.toLowerCase()) || kit.collabs.length >= 12) return;
  const t = termsOf(d);
  kit.collabs.push({ id: newId("col", 8), brand: b.name, website: b.website ? new URL(b.website).origin : null, logoKey: null, what: t.deliverables ?? "", result: "", dealId: d.id });
  await env.DB.prepare("UPDATE media_kit SET draft = ?, draft_saved_at = ? WHERE id = 1").bind(JSON.stringify(kit), nowIso()).run();
}

deals.post("/deals/:id/invoice", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  if (!["delivering", "invoiced"].includes(d.stage)) return fail(c, 409, "Invoice once the content is made and posted.", "invoice-a-brand");
  const t = termsOf(d);
  if (t.fee == null) return fail(c, 422, "Add the agreed fee to the deal first.", "invoice-a-brand");
  const kit = await readDraft(c.env);
  if (!d.invoice_number) {
    const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM deals WHERE invoice_number IS NOT NULL").first<{ n: number }>())?.n ?? 0;
    const issued = new Date();
    const due = invoiceDue(issued, effectiveTerms(t, kit.addons).netDays);
    await c.env.DB.prepare("UPDATE deals SET invoice_number = ?, invoiced_at = ?, invoice_due_at = ? WHERE id = ?").bind(invoiceNumber(n + 1, issued), issued.toISOString(), due, d.id).run();
    await recordEvent(c.env.DB, "deal.invoice", d.id, {}, c.get("user").email);
  }
  const fresh = (await dealById(c.env, d.id))!;
  if (fresh.stage === "delivering") await setStage(c.env, fresh, "invoiced");
  return c.json({ ok: true, number: fresh.invoice_number, dueAt: fresh.invoice_due_at, path: `/api/deals/deals/${d.id}/invoice` });
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

deals.get("/deals/:id/invoice", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d || !d.invoice_number) return c.text("No invoice yet. Make it on the deal first.", 404);
  const b = (await brandById(c.env, d.brand_id))!;
  const contacts = await contactsFor(c.env, b.id);
  const kit = await readDraft(c.env);
  const t = termsOf(d);
  const eff = effectiveTerms(t, kit.addons);
  const q = quote(t.fee ?? 0, { usageDays: t.usageDays, paidUsageDays: t.paidUsageDays, exclusivityMonths: t.exclusivityMonths, rush: t.rush }, kit.addons);
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "");
  const lines = q.lines.map((l, i) => `<tr><td>${i === 0 ? esc(t.deliverables ?? "Content partnership") : esc(l.label)}</td><td class="n">${money(l.amount)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invoice ${esc(d.invoice_number)}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Montserrat:wght@400;600&display=swap" rel="stylesheet">
<style>
body{margin:0;background:#f7f1e7;color:#211713;font:15px/1.5 Montserrat,system-ui,sans-serif}
.page{max-width:760px;margin:24px auto;padding:40px;background:#fffaf1;border:1px solid rgba(33,23,19,.14);border-radius:18px}
h1{font-family:"Playfair Display",Georgia,serif;font-size:34px;margin:0 0 4px}.muted{color:#665850}
.row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin:24px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:10px 0;border-bottom:1px solid rgba(33,23,19,.12);text-align:left}.n{text-align:right}
.total td{font-weight:600;border-bottom:0;font-size:18px}.bar{max-width:760px;margin:16px auto 0;text-align:right}
button{font:600 15px Montserrat,sans-serif;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid #d7b56d;background:#d7b56d;cursor:pointer}
@media print{body{background:#fff}.bar{display:none}.page{margin:0;border:0;padding:0}}
@media (max-width:600px){.page{margin:0;border-radius:0;padding:24px 16px}}
</style></head><body>
<div class="bar"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<main class="page">
<h1>Invoice</h1><div class="muted">${esc(d.invoice_number)} · issued ${esc(day(d.invoiced_at))}</div>
<div class="row"><div><strong>From</strong><br>${esc(kit.name)}${kit.location ? `<br>${esc(kit.location)}` : ""}${kit.contactEmail ? `<br>${esc(kit.contactEmail)}` : ""}</div>
<div><strong>To</strong><br>${esc(b.name)}${t.contactName ? `<br>Attn: ${esc(t.contactName)}` : ""}${contacts[0] && contacts[0].kind !== "form" ? `<br>${esc(contacts[0].value)}` : ""}</div>
<div><strong>Due</strong><br>${esc(day(d.invoice_due_at))}<br>Net-${eff.netDays}</div></div>
<table><thead><tr><th>Item</th><th class="n">Amount</th></tr></thead><tbody>${lines}<tr class="total"><td>Total due</td><td class="n">${money(q.total)}</td></tr></tbody></table>
<p class="muted">Usage: ${esc(usageText(t))}. Exclusivity: ${esc(exclusivityText(t))}.${t.postBy ? ` Posted by ${esc(day(`${t.postBy}T12:00:00Z`))}.` : ""}</p>
<p class="muted">Please pay by the due date. Payment details: [add your bank transfer or PayPal details here before sending].</p>
</main></body></html>`;
  return c.html(html, 200, { "cache-control": "private, no-store" });
});

deals.post("/deals/:id/paid", async (c) => {
  const d = await dealById(c.env, c.req.param("id"));
  if (!d) return fail(c, 404, "That deal is gone.");
  if (d.stage !== "invoiced") return fail(c, 409, "Mark it paid once it's invoiced.", "invoice-a-brand");
  await setStage(c.env, d, "paid");
  await addCollabFromDeal(c.env, d);
  await recordEvent(c.env.DB, "deal.paid", d.id, {}, c.get("user").email);
  return c.json({ ok: true });
});

// ---------- deliverables (content she owes a won deal)

/** A clip delivered for a paid deal is flagged Paid partnership in Review (#ad + platform label reminder). */
async function syncPaidClips(env: Env, deal: Pick<DealDb, "id" | "deliverables" | "paid_partnership">) {
  const ids = parseJson<Deliverable[]>(deal.deliverables, []).map((x) => x.clip_id).filter((x): x is string => !!x);
  await env.DB.prepare("UPDATE clips SET paid_partnership = 0, deal_id = NULL WHERE deal_id = ?").bind(deal.id).run();
  for (const id of ids) await env.DB.prepare("UPDATE clips SET paid_partnership = ?, deal_id = ? WHERE id = ?").bind(deal.paid_partnership ? 1 : 0, deal.id, id).run();
}

function validDeliverable(d: Partial<Deliverable>): string | null {
  if (!d.platform || !PLATFORMS.includes(d.platform)) return "Pick TikTok, Instagram or YouTube.";
  if (!d.due_at || Number.isNaN(new Date(d.due_at).getTime())) return "Pick a due date.";
  if (d.note && d.note.length > 300) return "Keep the note short.";
  return null;
}

async function saveDeliverables(env: Env, deal: DealDb, items: Deliverable[]) {
  const json = JSON.stringify(items);
  await env.DB.prepare("UPDATE deals SET deliverables = ?, updated_at = ? WHERE id = ?").bind(json, nowIso(), deal.id).run();
  await syncPaidClips(env, { ...deal, deliverables: json });
}

async function wonDeal(c: C): Promise<DealDb | Response> {
  const deal = await dealById(c.env, c.req.param("id")!);
  if (!deal) return fail(c, 404, "That deal is gone.");
  if (!["agreed", "delivering", "invoiced"].includes(deal.stage)) return fail(c, 409, "Deliverables are for agreed deals. Move the deal to Agreed first.", "mark-a-paid-partnership");
  return deal;
}

async function checkClip(env: Env, clipId: string | null | undefined): Promise<boolean> {
  if (!clipId) return true;
  return !!(await env.DB.prepare("SELECT id FROM clips WHERE id = ? AND status IN ('draft','approved')").bind(clipId).first());
}

deals.post("/deals/:id/deliverables", async (c) => {
  const deal = await wonDeal(c);
  if (deal instanceof Response) return deal;
  const body = await readJson<Partial<Deliverable>>(c);
  const problem = validDeliverable(body ?? {});
  if (problem) return fail(c, 422, problem, "mark-a-paid-partnership");
  if (!(await checkClip(c.env, body?.clip_id))) return fail(c, 422, "That clip is not available.", "mark-a-paid-partnership");
  const items = parseJson<Deliverable[]>(deal.deliverables, []);
  const d: Deliverable = { id: newId("dv", 8), clip_id: body!.clip_id ?? null, platform: body!.platform!, due_at: new Date(body!.due_at!).toISOString(), note: (body!.note ?? "").trim(), done: false };
  items.push(d);
  await saveDeliverables(c.env, deal, items);
  if (deal.stage === "agreed") await setStage(c.env, deal, "delivering");
  return c.json({ deliverable: d });
});

deals.patch("/deals/:id/deliverables/:did", async (c) => {
  const deal = await wonDeal(c);
  if (deal instanceof Response) return deal;
  const items = parseJson<Deliverable[]>(deal.deliverables, []);
  const i = items.findIndex((d) => d.id === c.req.param("did"));
  if (i < 0) return fail(c, 404, "That deliverable is gone.");
  const body = (await readJson<Partial<Deliverable>>(c)) ?? {};
  const merged: Deliverable = { ...items[i], ...body, id: items[i].id };
  const problem = validDeliverable(merged);
  if (problem) return fail(c, 422, problem, "mark-a-paid-partnership");
  if (!(await checkClip(c.env, merged.clip_id))) return fail(c, 422, "That clip is not available.", "mark-a-paid-partnership");
  merged.due_at = new Date(merged.due_at).toISOString();
  merged.done = !!merged.done;
  items[i] = merged;
  await saveDeliverables(c.env, deal, items);
  return c.json({ deliverable: merged });
});

deals.delete("/deals/:id/deliverables/:did", async (c) => {
  const deal = await wonDeal(c);
  if (deal instanceof Response) return deal;
  await saveDeliverables(c.env, deal, parseJson<Deliverable[]>(deal.deliverables, []).filter((d) => d.id !== c.req.param("did")));
  return c.json({ ok: true });
});

// ---------- marketplaces she joined

deals.patch("/listings", async (c) => {
  const body = await readJson<{ key?: string; joined?: boolean }>(c);
  const joined = await getSetting<string[]>(c.env.DB, "marketplaces_joined", []);
  if (!body?.key || typeof body.joined !== "boolean") return fail(c, 400, "Pick a marketplace.");
  const next = body.joined ? [...new Set([...joined, body.key])] : joined.filter((k) => k !== body.key);
  await setSetting(c.env.DB, "marketplaces_joined", next);
  return c.json({ ok: true, joined: next });
});

// ---------- finder

deals.post("/finder/run", async (c) => {
  const running = await c.env.DB.prepare("SELECT id FROM jobs WHERE type = 'brand_finder' AND status IN ('queued','dispatched','running') AND created_at > ? LIMIT 1")
    .bind(new Date(Date.now() - 2 * 3600_000).toISOString())
    .first<{ id: string }>();
  if (running) return fail(c, 409, "The brand finder is already looking. New brands show up here when it finishes.", "pitch-a-brand");
  if (!(await lockedProfile(c.env))) return fail(c, 409, "Lock your Brand Profile first, so the finder knows what fits you.", "upload-brand-docs");
  // No web-research key needed: the job searches with the free keyless path when Firecrawl isn't connected.
  const r = await dispatchJob(c.env, "brand_finder", "full");
  if (!r.dispatched) return fail(c, 502, r.error ?? "The brand finder could not start.", "reconnect-github");
  await recordEvent(c.env.DB, "brand_finder.started", r.jobId, {}, c.get("user").email);
  return c.json({ ok: true, jobId: r.jobId });
});

export { type NextAction };
