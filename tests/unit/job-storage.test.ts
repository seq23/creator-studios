// Jobs reach R2 only through the Worker: a signed GET streams an input, a signed chunked upload
// writes an output, and lib/jobStorage.ts decides which keys each job type may touch.
// Routes run against the real schema (sqlite-d1) and an in-memory R2 (r2-memory).
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { jobs } from "@worker/routes/jobs";
import { hmacHex } from "@worker/lib/crypto";
import { contentRange, jobStorageScope, mayRead, mayWrite, signedRequestLine, wellFormedKey } from "@worker/lib/jobStorage";
import { parseCutResult } from "@worker/jobs/cut";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";

const SECRET = "job-secret-for-tests";
const BASE = "https://w.example";

const app = new Hono<{ Bindings: Env }>();
app.route("/api/jobs", jobs);

let env: Env;
let r2: ReturnType<typeof memoryR2>;

async function addJob(id: string, type: string, refId: string | null, status = "running", nonce = `n_${id}`) {
  await env.DB.prepare("INSERT INTO jobs (id, type, status, ref_id, nonce) VALUES (?, ?, ?, ?, ?)").bind(id, type, status, refId, nonce).run();
}

async function signed(method: string, path: string, opts: { body?: BodyInit; json?: unknown; nonce?: string; ts?: number; signAs?: string; headers?: Record<string, string> } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const text = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  const line = opts.signAs ?? text ?? signedRequestLine(method, path);
  const jobId = path.split("/")[3];
  const headers: Record<string, string> = {
    "x-job-timestamp": String(ts),
    "x-job-signature": await hmacHex(SECRET, `${ts}.${line}`),
    "x-job-nonce": opts.nonce ?? `n_${jobId}`,
    ...(opts.headers ?? {}),
  };
  return app.request(`${BASE}${path}`, { method, headers, body: text ?? opts.body }, env);
}

beforeEach(async () => {
  r2 = memoryR2();
  env = { DB: sqliteD1().DB, FILES: r2.FILES, JOB_SHARED_SECRET: SECRET } as unknown as Env;
  await addJob("job_cut1", "cut", "dmp_a");
  await r2.FILES.put("raw/dmp_a/ast_1", new TextEncoder().encode("0123456789abcdef"), { httpMetadata: { contentType: "video/mp4" } });
  await r2.FILES.put("raw/dmp_b/ast_9", "other dump", { httpMetadata: { contentType: "video/mp4" } });
});

describe("signed GET of a job input", () => {
  it("streams the file with its content type and length when the path is signed", async () => {
    const res = await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe("16");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("0123456789abcdef");
  });

  it("serves a Range with 206 and a Content-Range", async () => {
    const res = await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1", { headers: { range: "bytes=4-7" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("4567");
  });

  it("refuses a signature made for a different path (no swapping the key after signing)", async () => {
    const res = await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1", { signAs: "/api/jobs/job_cut1/input/raw/dmp_a/ast_2" });
    expect(res.status).toBe(401);
  });

  it("refuses a signature older than 10 minutes", async () => {
    const res = await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1", { ts: Math.floor(Date.now() / 1000) - 601 });
    expect(res.status).toBe(401);
  });

  it("refuses the wrong job nonce and a missing signature", async () => {
    expect((await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1", { nonce: "n_other" })).status).toBe(401);
    const bare = await app.request(`${BASE}/api/jobs/job_cut1/input/raw/dmp_a/ast_1`, {}, env);
    expect(bare.status).toBe(401);
  });

  it("refuses a PUT signature replayed as a GET and a GET line replayed as a PUT", async () => {
    const path = "/api/jobs/job_cut1/input/raw/dmp_a/ast_1";
    expect((await signed("GET", path, { signAs: `PUT ${path}` })).status).toBe(401);
    expect(signedRequestLine("GET", path)).not.toBe(signedRequestLine("PUT", path));
  });

  it("refuses a file outside the job's scope with 403, and a missing one with 404", async () => {
    expect((await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_b/ast_9")).status).toBe(403);
    expect((await signed("GET", "/api/jobs/job_cut1/input/brain/doc_1")).status).toBe(403);
    expect((await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/..%2Fdmp_b%2Fast_9")).status).toBe(403);
    expect((await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_404")).status).toBe(404);
  });

  it("refuses storage once the job is done", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = 'job_cut1'").run();
    expect((await signed("GET", "/api/jobs/job_cut1/input/raw/dmp_a/ast_1")).status).toBe(409);
  });
});

describe("signed chunked upload of a job output", () => {
  async function upload(jobId: string, key: string, pieces: string[], contentType = "video/mp4") {
    const start = await signed("POST", `/api/jobs/${jobId}/output/start`, { json: { key, contentType } });
    if (start.status !== 200) return { start };
    const { uploadId, partSize } = (await start.json()) as { uploadId: string; partSize: number };
    const parts = [];
    for (let i = 0; i < pieces.length; i++) {
      const path = `/api/jobs/${jobId}/output/parts/${i + 1}?${new URLSearchParams({ key, uploadId })}`;
      const res = await signed("PUT", path, { body: pieces[i] });
      expect(res.status).toBe(200);
      parts.push(await res.json());
    }
    const done = await signed("POST", `/api/jobs/${jobId}/output/complete`, { json: { key, uploadId, parts } });
    return { start, partSize, done };
  }

  it("writes inside the job's prefix, in pieces, with the content type, part size 8–16 MB", async () => {
    const { done, partSize } = await upload("job_cut1", "clips/dmp_a/clp_12345678.mp4", ["abc", "def"]);
    expect(done!.status).toBe(200);
    expect(partSize).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(partSize).toBeLessThanOrEqual(16 * 1024 * 1024);
    const obj = r2.objects.get("clips/dmp_a/clp_12345678.mp4")!;
    expect(new TextDecoder().decode(obj.bytes)).toBe("abcdef");
    expect(obj.contentType).toBe("video/mp4");
  });

  it("refuses a job writing outside its prefix: another dump, the raw footage, a traversal", async () => {
    for (const key of ["clips/dmp_b/clp_12345678.mp4", "raw/dmp_a/ast_1", "brain/text/doc_1.txt", "clips/dmp_a/../dmp_b/x.mp4", "clips/dmp_a/"]) {
      const { start } = await upload("job_cut1", key, ["x"]);
      expect(start.status, key).toBe(403);
    }
    expect(r2.uploads.size).toBe(0);
    expect(new TextDecoder().decode(r2.objects.get("raw/dmp_a/ast_1")!.bytes)).toBe("0123456789abcdef");
  });

  it("refuses a part or a completion aimed outside the prefix even with a valid upload id", async () => {
    const start = await signed("POST", "/api/jobs/job_cut1/output/start", { json: { key: "clips/dmp_a/clp_12345678.mp4" } });
    const { uploadId } = (await start.json()) as { uploadId: string };
    const path = `/api/jobs/job_cut1/output/parts/1?${new URLSearchParams({ key: "clips/dmp_b/clp_12345678.mp4", uploadId })}`;
    expect((await signed("PUT", path, { body: "x" })).status).toBe(403);
    const done = await signed("POST", "/api/jobs/job_cut1/output/complete", { json: { key: "raw/dmp_a/ast_1", uploadId, parts: [{ partNumber: 1, etag: "p1" }] } });
    expect(done.status).toBe(403);
  });

  it("refuses a part whose signed line was for another part number", async () => {
    const start = await signed("POST", "/api/jobs/job_cut1/output/start", { json: { key: "clips/dmp_a/clp_12345678.mp4" } });
    const { uploadId } = (await start.json()) as { uploadId: string };
    const q = new URLSearchParams({ key: "clips/dmp_a/clp_12345678.mp4", uploadId });
    expect((await signed("PUT", `/api/jobs/job_cut1/output/parts/2?${q}`, { body: "x", signAs: `PUT /api/jobs/job_cut1/output/parts/1?${q}` })).status).toBe(401);
  });

  it("the extract and voice jobs write only their own folders", async () => {
    await addJob("job_ex", "extract", "doc_1");
    await addJob("job_vo", "voice", "nar_1");
    expect((await upload("job_ex", "brain/text/doc_1.txt", ["t"], "text/plain; charset=utf-8")).done!.status).toBe(200);
    expect((await upload("job_ex", "brain/doc_1", ["t"])).start.status).toBe(403);
    expect((await upload("job_vo", "voice/narrations/nar_1.mp3", ["a"], "audio/mpeg")).done!.status).toBe(200);
    expect((await upload("job_vo", "voice/narrations/nar_2.mp3", ["a"])).start.status).toBe(403);
    expect((await upload("job_vo", "voice/sample/x", ["a"])).start.status).toBe(403);
    // mix mode: its own mixed file only
    expect((await upload("job_vo", "voice/mixed/nar_1.mp4", ["v"], "video/mp4")).done!.status).toBe(200);
    expect((await upload("job_vo", "voice/mixed/nar_2.mp4", ["v"])).start.status).toBe(403);
    expect((await upload("job_vo", "clips/dmp_1/clp_1.mp4", ["v"])).start.status).toBe(403);
  });
});

describe("job storage scope (pure)", () => {
  it("a cut job reads its dump's raw footage and writes only its dump's clip folder", () => {
    const s = jobStorageScope("cut", "job_1", "dmp_a");
    expect(mayRead(s, "raw/dmp_a/ast_1")).toBe(true);
    expect(mayRead(s, "raw/dmp_ab/ast_1")).toBe(false);
    expect(mayWrite(s, "clips/dmp_a/clp_1.mp4")).toBe(true);
    expect(mayWrite(s, "clips/dmp_b/clp_1.mp4")).toBe(false);
    expect(mayWrite(s, "raw/dmp_a/ast_1")).toBe(false);
    expect(mayWrite(s, "jobs/job_1/scratch.bin")).toBe(true);
    expect(mayWrite(s, "jobs/job_2/scratch.bin")).toBe(false);
  });

  it("job types with no files read and write only their scratch folder", () => {
    for (const t of ["metrics", "brand_finder", "help_screenshots"] as const) {
      const s = jobStorageScope(t, "job_x", null);
      expect(s).toEqual({ read: ["jobs/job_x/"], write: ["jobs/job_x/"] });
    }
  });

  it("the cut job's write scope and parseCutResult accept the same keys (one rule, not two lists)", () => {
    const s = jobStorageScope("cut", "job_1", "dmp_a");
    const clip = (key: string) => ({ id: "clp_abcdefgh", asset_id: "ast_1", start_s: 0, end_s: 20, recipe: "talking_head", score: 0.8, hook_text: "h", caption: "c", hashtags: [], platforms: ["tiktok"], r2_key: key, cover_r2_key: null });
    const ctx = { dumpId: "dmp_a", allowed: new Map([["ast_1", ["tiktok" as const]]]), rawKeys: new Set(["raw/dmp_a/ast_1"]) };
    for (const key of ["clips/dmp_a/clp_abcdefgh.mp4", "clips/dmp_b/clp_abcdefgh.mp4"]) {
      const accepted = parseCutResult({ clips: [clip(key)] }, ctx).clips.length === 1;
      expect(accepted, key).toBe(mayWrite(s, key));
    }
  });

  it("well-formed keys only; Content-Range for offset and suffix ranges", () => {
    for (const bad of ["", "a//b", "a/./b", "a/../b", "a/", "/a", "a\\b", "a\u0000b", "x".repeat(513)]) expect(wellFormedKey(bad), JSON.stringify(bad)).toBe(false);
    expect(wellFormedKey("clips/dmp_a/clp_1.mp4")).toBe(true);
    expect(contentRange({ offset: 10, length: 5 }, 100)).toBe("bytes 10-14/100");
    expect(contentRange({ suffix: 10 }, 100)).toBe("bytes 90-99/100");
    expect(contentRange({ offset: 90 }, 100)).toBe("bytes 90-99/100");
    expect(contentRange(undefined, 100)).toBeNull();
  });
});
