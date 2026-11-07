// The niche brief (owner, 7 Nov 2026): "do it once each time a new user to each studio gets ready to
// dump / upload photos". The first time a NEW user sends a dump or makes photo posts, the niche job
// (jobs/niche_research.py, mode "brief", $0: free web search + free AI ladder) researches who buys,
// 5-10 named accounts in the niche and how they open, caption and ask; the first dump waits on it
// ("Learning your niche first, about a minute") and goes by itself when it is in. It never runs again
// on its own. A failed run is a NAMED STOP shown in the studio with Try again, and no writer writes
// for this studio until a brief is ready: never generic copy (writerGate). An existing studio (it had
// dumps or photo posts before this) runs nothing; Porch & Party's brief is the research behind its
// captions v3, seeded from studios/briefs/sample1.json. Guards: tests/unit/niche-brief.test.ts.
import type { Env } from "../env";
import { studioSlug } from "../env";
import { newId, nowIso } from "./ids";
import { parseJson, setHealth } from "./db";
import { log } from "./log";
import { dispatchJob } from "../services/github";
import { cleanBrief, type NicheBrief } from "@shared/nicheBrief";
import pnpBrief from "../../studios/briefs/sample1.json";

export const BRIEF_HEALTH = "Your niche brief";
export const BRIEF_WAITING = "Learning your niche first, about a minute. Your dump goes by itself when it's done.";
export const BRIEF_FAILED = "We couldn't research your niche with the free tools. Nothing is written for your studio until it works. Tap Try again.";
export const BRIEF_FIX_GUIDE = "niche-brief";
/** A research run that has not answered after this long counts as failed (the named stop shows). */
export const BRIEF_STUCK_MS = 45 * 60_000;

/** Briefs written by hand from public research, per studio slug, seeded once (no job runs for them). */
const SEEDED: Record<string, { researched_on: string; brief: unknown; sources: string[] }> = { sample1: pnpBrief };

interface BriefRow {
  id: string;
  status: "researching" | "ready" | "failed";
  brief: string | null;
  error: string | null;
  created_at: string;
  researched_on: string | null;
}

export type BriefState =
  | { state: "ready"; brief: NicheBrief; researched_on: string | null }
  | { state: "researching" }
  | { state: "failed"; error: string }
  | { state: "none" };

async function latestRow(env: Pick<Env, "DB">): Promise<BriefRow | null> {
  return env.DB.prepare("SELECT id, status, brief, error, created_at, researched_on FROM niche_briefs ORDER BY created_at DESC, rowid DESC LIMIT 1").first<BriefRow>();
}

/** Seed a hand-written brief for this studio (Porch & Party) the first time anything asks. Idempotent. */
export async function seedBrief(env: Pick<Env, "DB" | "STUDIO_SLUG">): Promise<boolean> {
  const seed = SEEDED[studioSlug(env)];
  if (!seed || !cleanBrief(seed.brief)) return false;
  if (await env.DB.prepare("SELECT 1 AS x FROM niche_briefs LIMIT 1").first()) return false;
  const at = nowIso();
  await env.DB.prepare("INSERT INTO niche_briefs (id, user_email, status, brief, sources, researched_on, origin, created_at, updated_at) VALUES (?, NULL, 'ready', ?, ?, ?, 'seeded', ?, ?)")
    .bind(newId("nbr"), JSON.stringify(cleanBrief(seed.brief)), JSON.stringify(seed.sources ?? []), seed.researched_on, at, at)
    .run();
  return true;
}

/** Where this studio's brief stands. A run older than BRIEF_STUCK_MS with no answer is failed. */
export async function briefState(env: Pick<Env, "DB" | "STUDIO_SLUG">, now = Date.now()): Promise<BriefState> {
  await seedBrief(env);
  const row = await latestRow(env);
  if (!row) return { state: "none" };
  if (row.status === "ready") {
    const b = cleanBrief(parseJson(row.brief, null));
    return b ? { state: "ready", brief: b, researched_on: row.researched_on } : { state: "failed", error: BRIEF_FAILED };
  }
  if (row.status === "researching") return now - Date.parse(row.created_at) > BRIEF_STUCK_MS ? { state: "failed", error: BRIEF_FAILED } : { state: "researching" };
  return { state: "failed", error: row.error || BRIEF_FAILED };
}

/** The brief every writer reads; null when there is none to read (see writerGate for whether to stop). */
export async function currentBrief(env: Pick<Env, "DB" | "STUDIO_SLUG">): Promise<NicheBrief | null> {
  const s = await briefState(env);
  return s.state === "ready" ? s.brief : null;
}

/**
 * Whether the writers may write. Ready: yes, with the brief. Researching or failed: NO, a named stop
 * (never generic copy). None: an existing studio from before briefs (it never gets one on its own),
 * so it writes as it did; a new user always has a row before anything can be written (firstUploadGate).
 */
export async function writerGate(env: Pick<Env, "DB" | "STUDIO_SLUG">): Promise<{ ok: true; brief: NicheBrief | null } | { ok: false; why: string }> {
  const s = await briefState(env);
  if (s.state === "ready") return { ok: true, brief: s.brief };
  if (s.state === "none") return { ok: true, brief: null };
  return { ok: false, why: s.state === "researching" ? BRIEF_WAITING : s.error };
}

/** A new user: this studio has never had a dump sent or a photo pack made. */
async function isNewUser(env: Pick<Env, "DB">): Promise<boolean> {
  const dumps = await env.DB.prepare("SELECT 1 AS x FROM dumps WHERE status NOT IN ('uploading') LIMIT 1").first();
  if (dumps) return false;
  const packs = await env.DB.prepare("SELECT 1 AS x FROM photo_packs WHERE status NOT IN ('draft', 'uploading') LIMIT 1").first().catch(() => null);
  return !packs;
}

/** Start the research (one job). The row is the record that it ran: it never runs again on its own. */
export async function startBrief(env: Env, email: string | null): Promise<{ started: boolean; error?: string }> {
  const id = newId("nbr");
  const at = nowIso();
  await env.DB.prepare("INSERT INTO niche_briefs (id, user_email, status, origin, created_at, updated_at) VALUES (?, ?, 'researching', 'research', ?, ?)").bind(id, email, at, at).run();
  const job = await dispatchJob(env, "niche", `brief/${id}`);
  if (!job.dispatched) {
    await env.DB.prepare("UPDATE niche_briefs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(BRIEF_FAILED, nowIso(), id).run();
    await setHealth(env.DB, BRIEF_HEALTH, "red", BRIEF_FAILED, BRIEF_FIX_GUIDE);
    return { started: false, error: job.error ?? "could not start" };
  }
  await env.DB.prepare("UPDATE niche_briefs SET job_id = ? WHERE id = ?").bind(job.jobId, id).run();
  await setHealth(env.DB, BRIEF_HEALTH, "green", "Learning your niche now, about a minute.", null);
  log.info("brief.started");
  return { started: true };
}

/**
 * The gate at the first dump and the first photo posts. Null = go ahead. Otherwise the calm line to show
 * (researching) or the named stop (failed). A new user with no brief starts the research here, once.
 */
export async function firstUploadGate(env: Env, email: string | null): Promise<{ message: string; fix_guide: string | null; failed: boolean } | null> {
  const s = await briefState(env);
  if (s.state === "ready") return null;
  if (s.state === "researching") return { message: BRIEF_WAITING, fix_guide: null, failed: false };
  if (s.state === "failed") return { message: s.error, fix_guide: BRIEF_FIX_GUIDE, failed: true };
  if (!(await isNewUser(env))) return null; // an existing studio: nothing extra runs
  const r = await startBrief(env, email);
  if (!r.started) return { message: BRIEF_FAILED, fix_guide: BRIEF_FIX_GUIDE, failed: true };
  // A job that answered at once (local fakes) leaves nothing to wait for.
  const now = await briefState(env);
  if (now.state === "ready") return null;
  return now.state === "failed" ? { message: now.error, fix_guide: BRIEF_FIX_GUIDE, failed: true } : { message: BRIEF_WAITING, fix_guide: null, failed: false };
}

/** Try again (the named stop's button): one new run, only when the last one failed. */
export async function retryBrief(env: Env, email: string | null): Promise<{ ok: boolean; message: string }> {
  const s = await briefState(env);
  if (s.state !== "failed") return { ok: false, message: s.state === "ready" ? "Your niche brief is ready." : BRIEF_WAITING };
  const r = await startBrief(env, email);
  return { ok: r.started, message: r.started ? BRIEF_WAITING : BRIEF_FAILED };
}

/** The job's answer: ready with the brief, or failed with the plain reason (a named stop). */
export async function storeBrief(env: Env, rowId: string, result: unknown): Promise<boolean> {
  const r = (result ?? {}) as { brief?: unknown; sources?: unknown; error?: unknown };
  const brief = cleanBrief(r.brief);
  const at = nowIso();
  if (!brief) {
    const why = typeof r.error === "string" && r.error ? `${r.error} Nothing is written for your studio until it works. Tap Try again.` : BRIEF_FAILED;
    await env.DB.prepare("UPDATE niche_briefs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'researching'").bind(why.slice(0, 400), at, rowId).run();
    await setHealth(env.DB, BRIEF_HEALTH, "red", why.slice(0, 300), BRIEF_FIX_GUIDE);
    log.warn("brief.failed");
    return false;
  }
  const sources = Array.isArray(r.sources) ? r.sources.map(String).slice(0, 30) : [];
  await env.DB.prepare("UPDATE niche_briefs SET status = 'ready', brief = ?, sources = ?, researched_on = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'researching'")
    .bind(JSON.stringify(brief), JSON.stringify(sources), at.slice(0, 10), at, rowId)
    .run();
  await setHealth(env.DB, BRIEF_HEALTH, "green", `Ready: ${brief.competitors.length} accounts in your niche studied.`, null);
  log.info("brief.ready", { competitors: brief.competitors.length });
  return true;
}

/** The job never answered: the run is failed (named stop). */
export async function failBrief(env: Env, rowId: string): Promise<void> {
  await env.DB.prepare("UPDATE niche_briefs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'researching'").bind(BRIEF_FAILED, nowIso(), rowId).run();
  await setHealth(env.DB, BRIEF_HEALTH, "red", BRIEF_FAILED, BRIEF_FIX_GUIDE);
}
