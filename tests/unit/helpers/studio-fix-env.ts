// One studio on the real schema (every migration), memory R2 and the real routes, signed in as the
// owner: the studio-fix tests drive it the way the app does.
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./sqlite-d1";
import { memoryR2 } from "./r2-memory";
import { ownerCookie } from "./owner-session";
import { clips as clipsRoute } from "@worker/routes/clips";
import { dumps as dumpsRoute } from "@worker/routes/dumps";
import { settings as settingsRoute } from "@worker/routes/settings";
import { uploads as uploadsRoute } from "@worker/routes/uploads";
import { brain as brainRoute } from "@worker/routes/brain";
import { posts as postsRoute } from "@worker/routes/posts";
import { research as researchRoute } from "@worker/routes/research";
import { cutJob } from "@worker/jobs/cut";
import { dispatchJob } from "@worker/services/github";
import { setSetting } from "@worker/lib/db";

export const BASE_URL = "http://w.example";

export async function harness(extra: Partial<Env> = {}) {
  const db = sqliteD1();
  const r2 = memoryR2();
  const env = {
    DB: db.DB,
    FILES: r2.FILES,
    OWNER_EMAIL: "owner@example.com",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
    STUDIO_SLUG: "sample9",
    AUDIENCE_TIMEZONE: "America/Chicago",
    ...extra,
  } as unknown as Env;
  await setSetting(env.DB, "features", { voice: false, deeper_research: false, weekly_recap: true, help_ask: false });
  db.raw.exec(`INSERT INTO brand_profile (sections, locked) VALUES ('{"voice":"warm","ctas":"Message us.","who":"We design gardens: Garden design, Patio planting"}', 1);
    INSERT INTO research_briefs (body, status) VALUES ('{}', 'approved');`);
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("fake", fakeServices(c.env));
    c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
    await next();
  });
  app.route("/api/clips", clipsRoute);
  app.route("/api/dumps", dumpsRoute);
  app.route("/api/settings", settingsRoute);
  app.route("/api/uploads", uploadsRoute);
  app.route("/api/brain", brainRoute);
  app.route("/api/posts", postsRoute);
  app.route("/api/research", researchRoute);
  const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
  const all = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as T[];
  const request = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }, env);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await request(method, p, body);
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  /** A dump with these files already uploaded (video/mp4 or image/jpeg rows, bytes in R2). */
  async function dumpWith(id: string, files: { id: string; name: string; mime: string; exif?: 0 | 1 | null; bytes?: Uint8Array }[]) {
    db.raw.exec(`INSERT INTO dumps (id, door, notes, status, created_at) VALUES ('${id}', 'new', '', 'cutting', '2026-10-22T15:00:00.000Z')`);
    for (const f of files) {
      const key = `raw/${id}/${f.id}`;
      db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status, exif_camera) VALUES (?, ?, ?, ?, ?, 'uploaded', ?)").run(f.id, id, f.name, f.mime, key, f.exif ?? null);
      await r2.FILES.put(key, f.bytes ?? new Uint8Array(100).fill(1), { httpMetadata: { contentType: f.mime } });
    }
  }
  /** Cut a dump with the fake engine (or a given result), as the job callback would. */
  async function cut(dumpId: string, result?: unknown, clipsWanted = 4) {
    const job = await dispatchJob(env, "cut", dumpId);
    await cutJob.applyResult(env, job.jobId, dumpId, result ?? (await cutJob.fakeRun!(env, job.jobId, dumpId, { clips: clipsWanted })));
    return job.jobId;
  }
  return { env, db, r2, app, one, all, call, request, dumpWith, cut };
}
