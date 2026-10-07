// The Worker side of every GitHub Actions job (section 13):
//   GET  /api/jobs/:id/spec       job → Worker, signed: everything the job needs (ids, R2 keys,
//                                 locked Brand Profile, approved brief, notes). Never logged.
//   POST /api/jobs/:id/progress   job → Worker, signed: {step, done, total}
//   POST /api/jobs/:id/callback   job → Worker, signed: the result (clips, extracted text, brief…)
//   GET  /api/jobs/:id/input/<key>          job → Worker, signed over the path: streams an input
//                                           from R2 (Range supported). Jobs hold no R2 keys.
//   POST /api/jobs/:id/output/start         job → Worker, signed: {key, contentType} opens an R2
//   PUT  /api/jobs/:id/output/parts/:n        multipart upload; parts are streamed through (signed
//   POST /api/jobs/:id/output/complete        over "PUT <path>?<query>"), then assembled. The same
//   POST /api/jobs/:id/output/abort           10 MB-part protocol the browser uses (routes/uploads.ts).
//                                           lib/jobStorage.ts decides which keys each job type may
//                                           read and write; anything else is refused with 403.
//   GET  /api/jobs                user: recent jobs for the Health panel
// Each job type has a handler in worker/jobs/<type>.ts that builds the spec and applies the result.
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { verifyJobMessage } from "../lib/crypto";
import { contentRange, jobStorageScope, mayRead, mayWrite, signedRequestLine } from "../lib/jobStorage";
import { completeParts, putPart } from "./uploads";
import { UPLOAD_PART_SIZE } from "@shared/constants";
import { fail, readJson } from "../lib/http";
import { nowIso } from "../lib/ids";
import { log, safeError } from "../lib/log";
import { markJob } from "../services/github";
import { requireUser } from "../lib/auth";
import { parseJson } from "../lib/db";
import type { JobRow } from "@shared/types";
import { JOB_HANDLERS } from "../jobs/registry";
import { youtubeAccessToken } from "../lib/youtubeDirect";

export const jobs = new Hono<{ Bindings: Env; Variables: Vars }>();

interface JobDb {
  id: string;
  type: JobRow["type"];
  status: JobRow["status"];
  ref_id: string | null;
  nonce: string;
}

type C = Context<{ Bindings: Env; Variables: Vars }, any>;

async function loadSignedJob(c: C, bodyText: string): Promise<JobDb | Response> {
  const ok = await verifyJobMessage(c.env.JOB_SHARED_SECRET, bodyText, c.req.header("x-job-timestamp") ?? null, c.req.header("x-job-signature") ?? null);
  if (!ok) return fail(c, 401, "Bad job signature.");
  const id = c.req.param("id");
  const job = await c.env.DB.prepare("SELECT id, type, status, ref_id, nonce FROM jobs WHERE id = ?").bind(id).first<JobDb>();
  if (!job) return fail(c, 404, "No such job.");
  const nonce = c.req.header("x-job-nonce");
  if (nonce !== job.nonce) return fail(c, 401, "Bad job nonce.");
  return job;
}

jobs.get("/:id/spec", async (c) => {
  const job = await loadSignedJob(c, `spec:${c.req.param("id")}`);
  if (job instanceof Response) return job;
  const handler = JOB_HANDLERS[job.type];
  if (!handler) return fail(c, 422, "This job type has no handler yet.");
  await markJob(c.env, job.id, "running", null, c.req.header("x-job-run-id") ?? null);
  const spec = await handler.buildSpec(c.env, job.id, job.ref_id);
  log.info("job.spec", { type: job.type });
  return c.json(spec);
});

/** The exact path + query as sent, still percent-encoded: what the job signed. */
function pathAndQuery(c: C): string {
  const u = new URL(c.req.url);
  return u.pathname + u.search;
}

/** A job that has finished may no longer touch storage: a leaked nonce is worth nothing after. */
async function loadStorageJob(c: C, signed: string): Promise<JobDb | Response> {
  const job = await loadSignedJob(c, signed);
  if (job instanceof Response) return job;
  if (job.status === "done") return fail(c, 409, "This job has already finished.");
  return job;
}

jobs.get("/:id/input/*", async (c) => {
  const job = await loadStorageJob(c, signedRequestLine("GET", pathAndQuery(c)));
  if (job instanceof Response) return job;
  const u = new URL(c.req.url);
  const marker = `/api/jobs/${job.id}/input/`;
  let key: string;
  try {
    key = decodeURIComponent(u.pathname.slice(u.pathname.indexOf(marker) + marker.length));
  } catch {
    return fail(c, 400, "Bad file key.");
  }
  if (!u.pathname.includes(marker) || !mayRead(jobStorageScope(job.type, job.id, job.ref_id), key)) {
    log.warn("job.input.refused", { type: job.type });
    return fail(c, 403, "This job may not read that file.");
  }
  const obj = await c.env.FILES.get(key, { range: c.req.raw.headers });
  if (!obj) return fail(c, 404, "That file is not in storage.");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  const ranged = c.req.header("range") ? contentRange(obj.range, obj.size) : null;
  if (!("body" in obj) || !obj.body) return fail(c, 422, "That file could not be read.");
  if (ranged) {
    headers.set("content-range", ranged);
    const [, from, to] = ranged.match(/bytes (\d+)-(\d+)/) ?? [];
    headers.set("content-length", String(Number(to) - Number(from) + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

jobs.post("/:id/output/start", async (c) => {
  const text = await c.req.text();
  const job = await loadStorageJob(c, text);
  if (job instanceof Response) return job;
  const body = parseJson<{ key?: string; contentType?: string }>(text, {});
  const key = String(body.key ?? "");
  if (!mayWrite(jobStorageScope(job.type, job.id, job.ref_id), key)) {
    log.warn("job.output.refused", { type: job.type });
    return fail(c, 403, "This job may not write there.");
  }
  const contentType = typeof body.contentType === "string" && /^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(body.contentType) ? body.contentType : "application/octet-stream";
  const mp = await c.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType } });
  return c.json({ key, uploadId: mp.uploadId, partSize: UPLOAD_PART_SIZE });
});

jobs.put("/:id/output/parts/:n", async (c) => {
  const job = await loadStorageJob(c, signedRequestLine("PUT", pathAndQuery(c)));
  if (job instanceof Response) return job;
  const key = c.req.query("key") ?? "";
  const uploadId = c.req.query("uploadId");
  const n = Number(c.req.param("n"));
  if (!uploadId || !Number.isInteger(n) || n < 1 || n > 10_000) return fail(c, 400, "Bad part request.");
  if (!mayWrite(jobStorageScope(job.type, job.id, job.ref_id), key)) return fail(c, 403, "This job may not write there.");
  if (!c.req.raw.body) return fail(c, 400, "Empty part.");
  const part = await putPart(c.env.FILES, key, uploadId, n, c.req.raw.body);
  if (!part) return fail(c, 502, "That piece did not upload. It will retry.");
  return c.json(part);
});

jobs.post("/:id/output/complete", async (c) => {
  const text = await c.req.text();
  const job = await loadStorageJob(c, text);
  if (job instanceof Response) return job;
  const body = parseJson<{ key?: string; uploadId?: string; parts?: { partNumber: number; etag: string }[] }>(text, {});
  const key = String(body.key ?? "");
  if (!mayWrite(jobStorageScope(job.type, job.id, job.ref_id), key)) return fail(c, 403, "This job may not write there.");
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) return fail(c, 400, "Missing upload parts.");
  const size = await completeParts(c.env.FILES, key, body.uploadId, body.parts);
  if (size === null) return fail(c, 502, "The upload could not be finished.");
  log.info("job.output", { type: job.type, bytes: size });
  return c.json({ ok: true, size });
});

jobs.post("/:id/output/abort", async (c) => {
  const text = await c.req.text();
  const job = await loadStorageJob(c, text);
  if (job instanceof Response) return job;
  const body = parseJson<{ key?: string; uploadId?: string }>(text, {});
  const key = String(body.key ?? "");
  if (!mayWrite(jobStorageScope(job.type, job.id, job.ref_id), key) || !body.uploadId) return fail(c, 403, "This job may not write there.");
  try {
    await c.env.FILES.resumeMultipartUpload(key, body.uploadId).abort();
  } catch {
    // already gone
  }
  return c.json({ ok: true });
});

/**
 * The ytupload job's YouTube access token: short-lived (about an hour), refreshed here from her
 * stored sign-in. The refresh token never leaves the Worker. Only a running ytupload job may ask;
 * 409 = Google refused her sign-in (the light is already red, the video falls back).
 */
jobs.post("/:id/youtube-token", async (c) => {
  const text = await c.req.text();
  const job = await loadStorageJob(c, text);
  if (job instanceof Response) return job;
  if (job.type !== "ytupload" || job.status === "failed") return fail(c, 403, "This job may not have a YouTube token.");
  const tok = await youtubeAccessToken(c.env);
  if (!tok) return fail(c, 409, "YouTube needs her to reconnect.", "reconnect-youtube");
  log.info("job.youtube_token", {});
  return c.json({ access_token: tok.access_token, expires_at: tok.expires_at }, 200, { "cache-control": "no-store" });
});

jobs.post("/:id/progress", async (c) => {
  const text = await c.req.text();
  const job = await loadSignedJob(c, text);
  if (job instanceof Response) return job;
  const body = parseJson<{ step?: string; done?: number; total?: number }>(text, {});
  const progress = { step: String(body.step ?? "working"), done: Number(body.done ?? 0), total: Number(body.total ?? 0) };
  await c.env.DB.prepare("UPDATE jobs SET progress = ? WHERE id = ?").bind(JSON.stringify(progress), job.id).run();
  const handler = JOB_HANDLERS[job.type];
  if (handler?.onProgress) await handler.onProgress(c.env, job.id, job.ref_id, progress);
  return c.json({ ok: true });
});

jobs.post("/:id/callback", async (c) => {
  const text = await c.req.text();
  const job = await loadSignedJob(c, text);
  if (job instanceof Response) return job;
  if (job.status === "done") return c.json({ ok: true, already: true });
  const body = parseJson<{ ok?: boolean; safe_error?: string; result?: unknown }>(text, {});
  const handler = JOB_HANDLERS[job.type];
  if (!handler) return fail(c, 422, "This job type has no handler yet.");
  try {
    if (body.ok === false) {
      await markJob(c.env, job.id, "failed", String(body.safe_error ?? "job failed").slice(0, 160));
      await handler.onFailure(c.env, job.id, job.ref_id, String(body.safe_error ?? "job failed"));
      log.warn("job.failed", { type: job.type });
      return c.json({ ok: true });
    }
    await handler.applyResult(c.env, job.id, job.ref_id, body.result);
    await markJob(c.env, job.id, "done");
    log.info("job.done", { type: job.type });
    return c.json({ ok: true });
  } catch (e) {
    const err = safeError(e);
    await markJob(c.env, job.id, "failed", err);
    await handler.onFailure(c.env, job.id, job.ref_id, err);
    log.error("job.apply", { type: job.type });
    return fail(c, 500, "The dashboard could not save the job result.");
  }
});

jobs.get("/", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, type, status, ref_id, safe_error, progress, created_at, finished_at FROM jobs ORDER BY created_at DESC LIMIT 50").all<
    Omit<JobRow, "progress"> & { progress: string | null }
  >();
  return c.json(results.map((r) => ({ ...r, progress: parseJson(r.progress, null) })));
});

/** Local-only helper: with FAKE_SERVICES=1 a job can be "run" instantly by the fake runner. */
jobs.post("/:id/run-fake", requireUser, async (c) => {
  if (c.env.FAKE_SERVICES !== "1") return fail(c, 403, "Only available with fake services.");
  const job = await c.env.DB.prepare("SELECT id, type, status, ref_id, nonce FROM jobs WHERE id = ?").bind(c.req.param("id")).first<JobDb>();
  if (!job) return fail(c, 404, "No such job.");
  const handler = JOB_HANDLERS[job.type];
  if (!handler?.fakeRun) return fail(c, 422, "No fake runner for this job type.");
  const body = await readJson<Record<string, unknown>>(c);
  await markJob(c.env, job.id, "running");
  const result = await handler.fakeRun(c.env, job.id, job.ref_id, body ?? {});
  await handler.applyResult(c.env, job.id, job.ref_id, result);
  await markJob(c.env, job.id, "done");
  await c.env.DB.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").bind(nowIso(), job.id).run();
  return c.json({ ok: true });
});
