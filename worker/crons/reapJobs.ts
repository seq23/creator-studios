// A job whose runner died before it could call back (23 Oct 2026: the cut runner's apt install timed
// out three times, the workflow failed in its setup step, and the dump stayed "cutting" with its job
// "dispatched" forever; Start over refused "still being cut"). Hourly, any job that never started
// within NEVER_STARTED_MIN, or has run past RAN_TOO_LONG_MIN (the longest job workflow's
// timeout-minutes plus margin), is marked failed and its handler's onFailure runs, exactly as if the
// job had called back with a failure: the dump is freed, she gets the usual plain message.
import type { Env } from "../env";
import { markJob } from "../services/github";
import { JOB_HANDLERS } from "../jobs/registry";
import { log } from "../lib/log";

export const NEVER_STARTED_MIN = 45;
export const RAN_TOO_LONG_MIN = 200;
export const REAPED_ERROR = "The job computer stopped before it finished (it may not have started). Try again.";

export async function reapStuckJobs(env: Env, now = Date.now()): Promise<number> {
  const neverStarted = new Date(now - NEVER_STARTED_MIN * 60_000).toISOString();
  const tooLong = new Date(now - RAN_TOO_LONG_MIN * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, type, ref_id FROM jobs WHERE (status IN ('queued', 'dispatched') AND created_at < ?) OR (status = 'running' AND COALESCE(started_at, created_at) < ?) LIMIT 50",
  )
    .bind(neverStarted, tooLong)
    .all<{ id: string; type: string; ref_id: string | null }>();
  for (const j of results) {
    await markJob(env, j.id, "failed", REAPED_ERROR);
    const handler = JOB_HANDLERS[j.type as keyof typeof JOB_HANDLERS];
    try {
      await handler?.onFailure(env, j.id, j.ref_id, REAPED_ERROR);
    } catch {
      log.warn("jobs.reap.on_failure_failed", { type: j.type });
    }
    log.warn("jobs.reaped", { type: j.type });
  }
  return results.length;
}
