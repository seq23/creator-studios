// Setup before the first cut (section 6 gate): a locked Brand Profile and an approved Research
// Brief. A dump refused by that gate waits (dumps.waiting_setup_at) instead of failing, and is sent
// by itself, once, the moment both are done (sendWaitingDumps in routes/dumps.ts). Locking the
// profile starts the research on its own (startResearch), so she never presses Refresh for it.
import { fakeServices, type Env } from "../env";
import { practice } from "./practice";
import { getConnectionSecret } from "./connections";
import { recordEvent } from "./db";
import { log } from "./log";
import { dispatchJob } from "../services/github";
import type { SetupStep } from "@shared/types";
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
  if (!profile) return { ok: false, status: 409, error: "Lock your Brand Profile first. The research starts from it.", fix_guide: "upload-brand-docs" };
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

/** The two setup steps, ticked when done; plain words, a direct link each. */
export async function setupSteps(env: Env): Promise<SetupStep[]> {
  const profile = !!(await env.DB.prepare(`SELECT version FROM brand_profile ${PROFILE_IN_USE}`).first());
  const brief = !!(await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' LIMIT 1").first());
  const draft = !!(await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'draft' LIMIT 1").first());
  const writing = !brief && !draft && profile && !!(await runningResearch(env));
  return [
    { key: "profile", label: "Lock your Brand Profile", done: profile, href: "/brain" },
    {
      key: "brief",
      label: "Approve your Research Brief",
      done: brief,
      href: "/research",
      ...(brief ? {} : draft ? { note: "It is ready for you to read and approve." } : writing ? { note: "It is being written now (usually 5 to 10 minutes)." } : profile ? {} : { note: "It is written for you as soon as your profile is locked." }),
    },
  ];
}

/** "Your 19 videos are saved. Two quick steps first, then your clips start by themselves:" */
export function setupHeadline(files: number, steps: SetupStep[]): string {
  const left = steps.filter((s) => !s.done).length;
  const what = files === 1 ? "Your video is saved." : `Your ${files} videos are saved.`;
  return `${what} ${left === 1 ? "One quick step" : "Two quick steps"} first, then your clips start by themselves:`;
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
