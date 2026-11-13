// Setup runs by itself and holds nothing (owner, 13 Nov 2026): the studio locks its own first Brand
// Profile and puts its own Research Brief to use (selfSetup), so an upload is never kept waiting for
// an approval. Both stay under the menu to read, change or redo. Locking the profile starts the
// research on its own (startResearch), so she never presses Refresh for it. An upload can still
// wait for the one-time niche research of a brand-new studio (lib/nicheBrief.ts firstUploadGate),
// which says so in plain words; those go by themselves too (sendWaitingDumps in routes/dumps.ts).
import { fakeServices, type Env } from "../env";
import { practice } from "./practice";
import { getConnectionSecret } from "./connections";
import { parseJson, recordEvent } from "./db";
import { nowIso } from "./ids";
import { cleanSections, filledCount } from "../domain/profile";
import { log } from "./log";
import { dispatchJob } from "../services/github";
import { PROFILE_IN_USE } from "./profileInUse";

/** A research job younger than this that has not finished counts as running. */
const RESEARCH_RUNNING_MS = 45 * 60_000;

export async function runningResearch(env: Env): Promise<{ id: string } | null> {
  return env.DB.prepare("SELECT id FROM jobs WHERE type = 'research' AND status IN ('queued', 'dispatched', 'running') AND created_at > ? LIMIT 1")
    .bind(new Date(Date.now() - RESEARCH_RUNNING_MS).toISOString())
    .first<{ id: string }>();
}

export type ResearchStart = { ok: true; jobId: string; already?: boolean } | { ok: false; status: 409 | 502; error: string; fix_guide: string };

/** Start the research job (the Refresh research button and the profile lock both come here). */
export async function startResearch(env: Env, fake: boolean, email: string | null): Promise<ResearchStart> {
  const profile = await env.DB.prepare(`SELECT version FROM brand_profile ${PROFILE_IN_USE}`).first();
  if (!profile) return { ok: false, status: 409, error: "Tell the studio a little about you first, on Client Brain. The research starts from it.", fix_guide: "upload-brand-docs" };
  const running = await runningResearch(env);
  if (running) return { ok: true, jobId: running.id, already: true };
  if (!fake && !(await getConnectionSecret(env, "openrouter"))) return { ok: false, status: 409, error: "Connect the AI (OpenRouter) first; it writes the brief.", fix_guide: "connect-openrouter" };
  const r = await dispatchJob(env, "research", null);
  if (!r.dispatched) return { ok: false, status: 502, error: r.error ?? "The research could not start.", fix_guide: "approve-research-brief" };
  await recordEvent(env.DB, "brief.refresh", r.jobId, {}, email ?? undefined);
  log.info("research.refresh");
  return { ok: true, jobId: r.jobId };
}

/**
 * After the profile is locked: start the research by itself when no brief is approved yet and none
 * is being written or waiting for approval. Never throws (the lock already succeeded).
 */
export async function researchAfterLock(env: Env, fake: boolean, email: string | null): Promise<ResearchStart | null> {
  try {
    const brief = await env.DB.prepare("SELECT version FROM research_briefs WHERE status IN ('approved', 'draft') LIMIT 1").first();
    if (brief) return null;
    if (await runningResearch(env)) return null;
    return await startResearch(env, fake, email);
  } catch {
    log.warn("research.after_lock_failed");
    return null;
  }
}

/** Who did it, in the events, when the studio set itself up. */
export const STUDIO_ACTOR = "the studio";
/** A profile draft thinner than this is not a first version worth using (the same floor as her own Lock button, routes/brain.ts). */
const PROFILE_MIN_SECTIONS = 3;

/**
 * Nothing is held (owner, 13 Nov 2026, replacing "research brief approved before the first cut"):
 * the studio approves its own brief and locks its own first profile; both stay under the menu to
 * read, change or redo.
 *   - Brief: the newest draft is put to use at once (the one before it is replaced), first version
 *     or a later one. A later one is told to her in one line (crons/brief.ts briefInUseNotice, Home).
 *   - Profile (`lockProfile`: when an upload needs it): with no version in use yet, the newest draft
 *     with something in it is locked. A profile she unlocked to edit is never touched (the version
 *     she locked last stays in use, lib/profileInUse.ts).
 * This is what lets a studio that was waiting on an unapproved draft flow again after a deploy with
 * no hand edit: it runs on the hourly lane and whenever an upload is sent. Never throws.
 */
export async function selfSetup(env: Env, opts: { lockProfile: boolean }): Promise<{ profile: number | null; brief: number | null }> {
  const done: { profile: number | null; brief: number | null } = { profile: null, brief: null };
  try {
    if (opts.lockProfile && !(await env.DB.prepare(`SELECT version FROM brand_profile ${PROFILE_IN_USE}`).first())) {
      const newest = await env.DB.prepare("SELECT version, sections FROM brand_profile ORDER BY version DESC LIMIT 1").first<{ version: number; sections: string }>();
      if (newest && filledCount(cleanSections(parseJson(newest.sections, {}))) >= PROFILE_MIN_SECTIONS) {
        await env.DB.batch([
          env.DB.prepare("UPDATE brand_profile SET locked = 0 WHERE version != ?").bind(newest.version),
          env.DB.prepare("UPDATE brand_profile SET locked = 1, locked_at = ? WHERE version = ?").bind(nowIso(), newest.version),
        ]);
        await recordEvent(env.DB, "profile.self_locked", String(newest.version), {}, STUDIO_ACTOR);
        log.info("setup.profile_self_locked");
        done.profile = newest.version;
      }
    }
    const draft = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'draft' ORDER BY version DESC LIMIT 1").first<{ version: number }>();
    if (draft) {
      const before = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ version: number }>();
      await env.DB.batch([
        env.DB.prepare("UPDATE research_briefs SET status = 'superseded' WHERE status = 'approved'"),
        env.DB.prepare("UPDATE research_briefs SET status = 'approved', approved_at = ? WHERE version = ? AND status = 'draft'").bind(nowIso(), draft.version),
      ]);
      await recordEvent(env.DB, "brief.self_approved", String(draft.version), { first: !before, replaced: before?.version ?? null }, STUDIO_ACTOR);
      log.info("setup.brief_self_approved", { first: !before });
      done.brief = draft.version;
    }
    // A profile just put to use with no brief on the way: the research starts by itself.
    if (done.profile !== null) await ensureFirstResearch(env);
  } catch {
    log.warn("setup.self_failed");
  }
  return done;
}

/** A first brief that never started is retried at most this often. */
const FIRST_RESEARCH_RETRY_MS = 24 * 60 * 60_000;

/**
 * The backfill for a profile locked before locking started the research (or a start that failed):
 * a profile in use, no brief at all (approved or draft), and no research job in the last day →
 * start the research once. Runs on the hourly lane, on a Dump the setup gate refuses and when
 * Research opens. Never throws.
 */
export async function ensureFirstResearch(env: Env, email: string | null = null): Promise<boolean> {
  try {
    if (!(await env.DB.prepare(`SELECT version FROM brand_profile ${PROFILE_IN_USE}`).first())) return false;
    if (await env.DB.prepare("SELECT version FROM research_briefs WHERE status IN ('approved', 'draft') LIMIT 1").first()) return false;
    const recent = await env.DB.prepare("SELECT id FROM jobs WHERE type = 'research' AND created_at > ? LIMIT 1").bind(new Date(Date.now() - FIRST_RESEARCH_RETRY_MS).toISOString()).first();
    if (recent) return false;
    const r = await startResearch(env, fakeServices(env) || practice(env, "openrouter"), email);
    if (r.ok && !r.already) log.info("research.first_started");
    return r.ok && !r.already;
  } catch {
    log.warn("research.first_failed");
    return false;
  }
}
