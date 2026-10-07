// Heavy jobs run in GitHub Actions, started only from here with a signed payload
// (section 13). The job then fetches its spec from the Worker and calls back when done.
import type { Env } from "../env";
import { fakeServices, studioSlug } from "../env";
import { inPracticeOnly } from "../lib/practice";
import { newId, nowIso } from "../lib/ids";
import { log, safeError } from "../lib/log";
import { signJobMessage } from "../lib/crypto";

export type JobType = "cut" | "extract" | "research" | "brand_finder" | "voice" | "help_screenshots" | "metrics" | "fullvideo" | "ytupload";

export interface DispatchResult {
  jobId: string;
  dispatched: boolean;
  error: string | null;
}

/**
 * The repository_dispatch body. `studio` tells the workflow which studio started the job, so it
 * picks that studio's shared secret (JOB_SHARED_SECRET_<SLUG>, else JOB_SHARED_SECRET in a
 * studio's own job repository); `worker_url` is where the job fetches its spec and inputs, writes
 * its outputs and calls back. Pure, unit-tested.
 */
export function dispatchBody(env: Pick<Env, "STUDIO_SLUG" | "PUBLIC_BASE_URL">, type: JobType, p: { jobId: string; nonce: string; ts: number | string; sig: string }) {
  return { event_type: type, client_payload: { job_id: p.jobId, nonce: p.nonce, ts: p.ts, sig: p.sig, worker_url: env.PUBLIC_BASE_URL, studio: studioSlug(env).toUpperCase() } };
}

/**
 * Practice mode for the job runner (no GitHub set up yet): the job's stand-in runs right here, in
 * the Worker, the same way the local fake runner does, so a dump still turns into (practice) clips
 * and nothing shows an error. The stand-in's output is labelled "practice" by the Shell banner.
 * It runs AFTER the request that started it has answered (worker/index.ts waitUntil), so the
 * caller's own bookkeeping (e.g. "uploading") is written first and the result lands on top of it.
 */
export async function drainPracticeJobs(env: Env): Promise<void> {
  const queue = env.PRACTICE_JOBS ?? [];
  while (queue.length) {
    const j = queue.shift()!;
    await runPractice(env, j.jobId, j.type as JobType, j.refId);
  }
}

async function runPractice(env: Env, jobId: string, type: JobType, refId: string | null): Promise<void> {
  const { JOB_HANDLERS } = await import("../jobs/registry");
  const handler = JOB_HANDLERS[type];
  if (!handler?.fakeRun) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', safe_error = ? WHERE id = ?").bind("Practice mode: set up Clip cutting on Setup to run this job", jobId).run();
    return;
  }
  try {
    await markJob(env, jobId, "running");
    const result = await handler.fakeRun(env, jobId, refId, {});
    await handler.applyResult(env, jobId, refId, result);
    await markJob(env, jobId, "done");
    log.info("job.practice", { type });
  } catch (e) {
    await markJob(env, jobId, "failed", `Practice run failed: ${safeError(e)}`.slice(0, 160));
    log.error("job.practice", { type, message: safeError(e) });
  }
}

/**
 * Create a jobs row and fire `repository_dispatch` with event_type = job type. The payload
 * carries only ids and a signature; nothing about her content travels to GitHub.
 */
export async function dispatchJob(env: Env, type: JobType, refId: string | null): Promise<DispatchResult> {
  const jobId = newId("job");
  const nonce = newId("n", 16);
  await env.DB.prepare("INSERT INTO jobs (id, type, status, ref_id, nonce) VALUES (?, ?, 'queued', ?, ?)").bind(jobId, type, refId, nonce).run();

  if (fakeServices(env)) {
    await env.DB.prepare("UPDATE jobs SET status = 'dispatched' WHERE id = ?").bind(jobId).run();
    log.info("job.dispatch.fake", { type });
    return { jobId, dispatched: true, error: null };
  }

  if (inPracticeOnly(env, "github")) {
    await env.DB.prepare("UPDATE jobs SET status = 'dispatched' WHERE id = ?").bind(jobId).run();
    (env.PRACTICE_JOBS ??= []).push({ jobId, type, refId });
    log.info("job.dispatch.practice", { type });
    return { jobId, dispatched: true, error: null };
  }

  if (!env.GITHUB_DISPATCH_TOKEN) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', safe_error = ? WHERE id = ?").bind("GitHub job token missing", jobId).run();
    return { jobId, dispatched: false, error: "The dashboard cannot start jobs yet: the GitHub job token is missing." };
  }

  const body = JSON.stringify({ job_id: jobId, nonce });
  const { timestamp, signature } = await signJobMessage(env.JOB_SHARED_SECRET, body);
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "creator-studios",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(dispatchBody(env, type, { jobId, nonce, ts: timestamp, sig: signature })),
    });
    if (res.status !== 204) {
      const err = `GitHub answered ${res.status}`;
      await env.DB.prepare("UPDATE jobs SET status = 'failed', safe_error = ? WHERE id = ?").bind(err, jobId).run();
      log.error("job.dispatch", { type, status: res.status });
      return { jobId, dispatched: false, error: err };
    }
    await env.DB.prepare("UPDATE jobs SET status = 'dispatched' WHERE id = ?").bind(jobId).run();
    log.info("job.dispatch", { type });
    return { jobId, dispatched: true, error: null };
  } catch (e) {
    const err = safeError(e);
    await env.DB.prepare("UPDATE jobs SET status = 'failed', safe_error = ? WHERE id = ?").bind(err, jobId).run();
    return { jobId, dispatched: false, error: err };
  }
}

export async function markJob(env: Env, jobId: string, status: "running" | "done" | "failed", safeErr: string | null = null, runId: string | null = null) {
  const started = status === "running" ? nowIso() : null;
  const finished = status === "done" || status === "failed" ? nowIso() : null;
  await env.DB.prepare(
    "UPDATE jobs SET status = ?, safe_error = ?, run_id = COALESCE(?, run_id), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at) WHERE id = ?",
  )
    .bind(status, safeErr, runId, started, finished, jobId)
    .run();
}
