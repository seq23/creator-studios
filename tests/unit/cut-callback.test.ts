// A cut's callback answers fast and is safe to retry (Mercedes's first cut, 24 Oct 2026: 21 clips
// saved, then the automatic voice over's AI calls held the callback past the job's 60 s timeout
// four times, the job gave up and the dump was marked failed with its clips in the table).
//   - the clips are saved and the job done before the slow follow-on runs (ctx.waitUntil);
//   - a retried callback never doubles clips, events or the email, and answers ok;
//   - a failure report after the clips were saved never fails the dump;
//   - follow-on that did not finish is finished by the hourly lane;
//   - ops finish-cut puts a saved-then-failed dump back to ready, nothing deleted;
//   - the Python job waits long enough for the callback.
// Real schema (sqlite-d1), in-memory R2, fakes.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { jobs } from "@worker/routes/jobs";
import { ops } from "@worker/routes/ops";
import { hmacHex } from "@worker/lib/crypto";
import { cutFollowOn, cutJob, finishPendingCuts, FOLLOW_ON_BUILT_IN, FOLLOW_ON_RUNNING } from "@worker/jobs/cut";
import { dispatchJob } from "@worker/services/github";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";

const SECRET = "job-secret-for-tests";
const BASE = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.route("/api/jobs", jobs);
app.route("/api/ops", ops);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;

/** An execution context that keeps what was handed to waitUntil, to run later (or never). */
function heldCtx() {
  const held: Promise<unknown>[] = [];
  return { held, ctx: { waitUntil: (p: Promise<unknown>) => void held.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext };
}

async function callback(jobId: string, nonce: string, payload: unknown, ctx?: ExecutionContext) {
  const text = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const headers = { "x-job-timestamp": String(ts), "x-job-signature": await hmacHex(SECRET, `${ts}.${text}`), "x-job-nonce": nonce };
  const res = await app.request(`${BASE}/api/jobs/${jobId}/callback`, { method: "POST", headers, body: text }, env, ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function opsCall(action: string, payload: unknown) {
  const text = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const headers = { "x-ops-timestamp": String(ts), "x-ops-signature": await hmacHex(SECRET, `${ts}.ops:${text}`) };
  const res = await app.request(`${BASE}/api/ops/${action}`, { method: "POST", headers, body: text }, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A dump with one uploaded video, its cut job dispatched and running, and the fake cutter's result. */
async function cutReady(id = "dmp_cb1") {
  db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('${id}', 'new', '', 'cutting');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_${id}', '${id}', 'a.mp4', 'video/mp4', 'raw/${id}/ast', 'uploaded');`);
  await r2.FILES.put(`raw/${id}/ast`, new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
  const job = await dispatchJob(env, "cut", id);
  db.raw.prepare("UPDATE jobs SET status = 'running', created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(job.jobId);
  const nonce = one<{ nonce: string }>("SELECT nonce FROM jobs WHERE id = ?", job.jobId).nonce;
  const result = await cutJob.fakeRun!(env, job.jobId, id, { clips: 8 });
  return { id, jobId: job.jobId, nonce, result };
}
const clipCount = (id: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = ?", id).n;
const dumpRow = (id: string) => one<{ status: string; follow_on_pending: number; error_summary: string | null; clips_made: number }>("SELECT status, follow_on_pending, error_summary, clips_made FROM dumps WHERE id = ?", id);
const emails = (id: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent WHERE kind = 'clips_ready' AND ref_id = ?", id).n;
const events = (id: string, kind: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ref_id = ?", kind, id).n;

beforeEach(() => {
  db = sqliteD1();
  r2 = memoryR2();
  env = {
    DB: db.DB,
    FILES: r2.FILES,
    OWNER_EMAIL: "owner@example.com",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE,
    GITHUB_REPO: "example/studio-jobs",
    JOB_SHARED_SECRET: SECRET,
  } as unknown as Env;
});

describe("the cut callback answers before the slow follow-on", () => {
  it("clips saved, dump ready and job done when it answers; the light, email and voice overs run after (waitUntil)", async () => {
    const { id, jobId, nonce, result } = await cutReady();
    const { held, ctx } = heldCtx();
    const res = await callback(jobId, nonce, { ok: true, result }, ctx);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(one<{ status: string }>("SELECT status FROM jobs WHERE id = ?", jobId).status).toBe("done");
    expect(clipCount(id)).toBe(8);
    expect(dumpRow(id).status).toBe("ready");
    // The slow part was handed to waitUntil and had not finished when the callback answered.
    expect(held.length).toBe(1);
    expect(dumpRow(id).follow_on_pending).toBeGreaterThan(0);
    await Promise.all(held);
    expect(dumpRow(id).follow_on_pending).toBe(0);
    expect(emails(id)).toBe(1);
  });

  it("without an execution context (the fake runner, tests) the follow-on runs inline", async () => {
    const { id, jobId, result } = await cutReady();
    await cutJob.applyResult(env, jobId, id, result);
    expect(dumpRow(id).follow_on_pending).toBe(0);
    expect(emails(id)).toBe(1);
  });
});

describe("a retried callback is safe", () => {
  it("a retry while the job is still running (the first answer was lost) doubles nothing and answers ok", async () => {
    const { id, jobId, nonce, result } = await cutReady();
    await cutJob.applyResult(env, jobId, id, result); // the first delivery saved everything
    const tokens = db.raw.prepare("SELECT id, media_token FROM clips WHERE dump_id = ? ORDER BY id").all(id);
    expect(one<{ status: string }>("SELECT status FROM jobs WHERE id = ?", jobId).status).toBe("running");
    const res = await callback(jobId, nonce, { ok: true, result });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(clipCount(id)).toBe(8);
    expect(db.raw.prepare("SELECT id, media_token FROM clips WHERE dump_id = ? ORDER BY id").all(id)).toEqual(tokens); // not re-inserted
    expect(events(id, "dump.cut")).toBe(1);
    expect(emails(id)).toBe(1);
    expect(one<{ status: string }>("SELECT status FROM jobs WHERE id = ?", jobId).status).toBe("done");
  });

  it("a retry after the job is done answers ok, already", async () => {
    const { jobId, nonce, result } = await cutReady();
    expect((await callback(jobId, nonce, { ok: true, result })).json.ok).toBe(true);
    const again = await callback(jobId, nonce, { ok: true, result });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, already: true });
  });

  it("a second runner never runs the follow-on while the first holds it", async () => {
    const { id, jobId, result } = await cutReady();
    const { held, ctx } = heldCtx();
    await cutJob.applyResult(env, jobId, id, result, { defer: (w) => ctx.waitUntil(w()) });
    // the deferred run claimed it; a second delivery's runner finds it taken
    db.raw.prepare("UPDATE dumps SET follow_on_pending = ? WHERE id = ?").run(FOLLOW_ON_BUILT_IN + FOLLOW_ON_RUNNING, id);
    expect((await cutFollowOn(env, id)).done).toBe(false);
    await Promise.allSettled(held);
    expect(emails(id)).toBeLessThanOrEqual(1);
  });
});

describe("a failure report after the clips were saved never fails the dump", () => {
  it("ok:false after the result applied (the job gave up waiting): the dump stays ready with every clip", async () => {
    const { id, jobId, nonce, result } = await cutReady();
    await cutJob.applyResult(env, jobId, id, result);
    const res = await callback(jobId, nonce, { ok: false, safe_error: "RuntimeError at common.py:423" });
    expect(res.status).toBe(200);
    expect(dumpRow(id).status).toBe("ready");
    expect(dumpRow(id).error_summary).toBeNull();
    expect(clipCount(id)).toBe(8);
  });

  it("ok:false with no clips saved still fails the dump with its plain sentence", async () => {
    const { id, jobId, nonce } = await cutReady();
    await callback(jobId, nonce, { ok: false, safe_error: "RuntimeError at common.py:423" });
    expect(dumpRow(id).status).toBe("failed");
    expect(dumpRow(id).error_summary).toMatch(/Cutting stopped partway/);
  });
});

describe("follow-on left over is finished by the hourly lane", () => {
  it("a follow-on cut off after the response (never ran) runs on the next hourly lane, once", async () => {
    const { id, jobId, nonce, result } = await cutReady();
    const { ctx } = heldCtx(); // held, never awaited: the isolate went away
    await callback(jobId, nonce, { ok: true, result }, ctx);
    // a runner that was cut off mid-way leaves its claim behind
    db.raw.prepare("UPDATE dumps SET follow_on_pending = ?, ready_at = '2026-01-01T01:00:00.000Z' WHERE id = ?").run(FOLLOW_ON_BUILT_IN + FOLLOW_ON_RUNNING, id);
    expect(await finishPendingCuts(env, new Date("2026-01-01T02:00:00Z"))).toBe(1);
    expect(dumpRow(id).follow_on_pending).toBe(0);
    expect(emails(id)).toBe(1);
    expect(await finishPendingCuts(env, new Date("2026-01-01T03:00:00Z"))).toBe(0);
    expect(emails(id)).toBe(1);
  });

  it("the lane is wired into the hourly cron", () => {
    const src = readFileSync("worker/crons/index.ts", "utf8");
    expect(src).toMatch(/await finishPendingCuts\(env\)/);
  });
});

describe("ops finish-cut", () => {
  it("a saved-then-failed dump goes back to ready, nothing deleted, its follow-on run", async () => {
    const { id, jobId, result } = await cutReady();
    await cutJob.applyResult(env, jobId, id, result, { defer: () => undefined }); // saved; follow-on lost
    db.raw.prepare("UPDATE dumps SET status = 'failed', error_summary = 'Cutting stopped partway.', follow_on_pending = 0 WHERE id = ?").run(id);
    const res = await opsCall("finish-cut", { dump_id: id });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, was: "failed", clips: 8 });
    expect(dumpRow(id)).toMatchObject({ status: "ready", error_summary: null, follow_on_pending: 0, clips_made: 8 });
    expect(clipCount(id)).toBe(8);
    expect(emails(id)).toBe(1);
    expect(events(id, "dump.finish_cut")).toBe(1);
  });

  it("refuses a dump whose latest cut saved no clips, and leaves it failed", async () => {
    const { id, jobId, nonce } = await cutReady();
    await callback(jobId, nonce, { ok: false, safe_error: "ffmpeg" });
    const res = await opsCall("finish-cut", { dump_id: id });
    expect(res.status).toBe(409);
    expect(dumpRow(id).status).toBe("failed");
  });

  it("refuses without the signature", async () => {
    const res = await app.request(`${BASE}/api/ops/finish-cut`, { method: "POST", body: JSON.stringify({ dump_id: "dmp_x" }) }, env);
    expect(res.status).toBe(401);
  });
});

describe("the Python job waits long enough for the callback", () => {
  it("the callback timeout is at least 3 minutes, used by both callbacks; other calls keep 60 s", () => {
    const py = readFileSync("jobs/common.py", "utf8");
    const t = Number(/CALLBACK_TIMEOUT_S = (\d+)/.exec(py)?.[1]);
    expect(t).toBeGreaterThanOrEqual(180);
    expect(py.match(/"\/callback", json\.dumps\([^\n]*timeout=self\.CALLBACK_TIMEOUT_S\)/g)?.length).toBe(2);
    expect(py).toMatch(/CALL_TIMEOUT_S = 60/);
  });
});

describe("voice-over scripts are drafted a few at a time", () => {
  it("inBatches keeps order and never runs more than DRAFT_AT_ONCE together; DRAFT_AT_ONCE is 2 to 5", async () => {
    const { inBatches, DRAFT_AT_ONCE } = await import("@worker/lib/autoVoice");
    expect(DRAFT_AT_ONCE).toBeGreaterThanOrEqual(2);
    expect(DRAFT_AT_ONCE).toBeLessThanOrEqual(5);
    let running = 0;
    let peak = 0;
    const out = await inBatches([...Array(9).keys()], DRAFT_AT_ONCE, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 - (n % 3)));
      running--;
      return n * 2;
    });
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(DRAFT_AT_ONCE);
  });
  it("both voice paths draft through inBatches, never one await per clip", () => {
    const src = readFileSync("worker/lib/autoVoice.ts", "utf8");
    expect(src.match(/inBatches\(targets, DRAFT_AT_ONCE/g)?.length).toBe(2);
    expect(src).not.toMatch(/for \(const clip of targets\) items\.push\(\{ clip, script: await draftScript/);
  });
});
