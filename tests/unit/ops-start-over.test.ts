// The host developer's signed Start over (worker/routes/ops.ts): only a request signed with the
// studio's job secret over "ops:<body>" in the last 10 minutes gets through; a job signature or none
// is refused; it runs the studio's own Start over (New clips go, everything else stays).
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ops, OPS_ACTOR } from "@worker/routes/ops";
import { setSetting } from "@worker/lib/db";

const SECRET = "job-secret-for-tests";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  await next();
});
app.route("/api/ops", ops);
let env: Env;
let db: ReturnType<typeof sqliteD1>;
const sign = (body: string, prefix = "ops:", ts = Math.floor(Date.now() / 1000)) => ({ "x-ops-timestamp": String(ts), "x-ops-signature": createHmac("sha256", SECRET).update(`${ts}.${prefix}${body}`).digest("hex") });
const post = (body: string, headers: Record<string, string>) => app.request("http://w.example/api/ops/start-over", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }, env);

beforeEach(async () => {
  db = sqliteD1();
  const r2 = memoryR2();
  env = { DB: db.DB, FILES: r2.FILES, JOB_SHARED_SECRET: SECRET, SESSION_SECRET: "s", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", APP_NAME: "S", FAKE_SERVICES: "1", AUTH_MODE: "code", PUBLIC_BASE_URL: "http://w.example", GITHUB_REPO: "example/jobs", OWNER_EMAIL: "o@example.com" } as unknown as Env;
  await setSetting(env.DB, "features", { voice: true, deeper_research: false, weekly_recap: true, help_ask: false });
  db.raw.exec(`INSERT INTO brand_profile (sections, locked) VALUES ('{"service_looks":"Alpha work: a corner\\nBeta work: a shelf"}', 1);
    INSERT INTO research_briefs (body, status) VALUES ('{}', 'approved');
    INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_o', 'new', '', 'ready');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_o', 'dmp_o', 'a.mp4', 'video/mp4', 'raw/dmp_o/a', 'uploaded');
    INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, status) VALUES ('clp_new', 'ast_o', 'dmp_o', 0, 5, 'montage', 'clips/dmp_o/n.mp4', 'draft'), ('clp_ok', 'ast_o', 'dmp_o', 0, 5, 'montage', 'clips/dmp_o/k.mp4', 'approved');`);
  await r2.FILES.put("raw/dmp_o/a", new Uint8Array(10), { httpMetadata: { contentType: "video/mp4" } });
});

describe("signed Start over", () => {
  it("refuses no signature, a job signature and an old one", async () => {
    const body = JSON.stringify({ dump_id: "dmp_o" });
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, sign(body, ""))).status).toBe(401); // a job-style signature
    expect((await post(body, sign(body, "ops:", Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    expect(db.raw.prepare("SELECT status FROM clips WHERE id = 'clp_new'").get()).toEqual({ status: "draft" });
  });
  it("runs the studio's own Start over with an optional Change pick", async () => {
    const body = JSON.stringify({ dump_id: "dmp_o", service: "beta WORK" });
    const r = await post(body, sign(body));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, removed: 1, kept: 1 });
    expect(db.raw.prepare("SELECT status FROM clips WHERE id = 'clp_new'").get()).toEqual({ status: "deleted" });
    expect(db.raw.prepare("SELECT status FROM clips WHERE id = 'clp_ok'").get()).toEqual({ status: "approved" });
    expect(JSON.parse((db.raw.prepare("SELECT plan_override FROM dumps WHERE id = 'dmp_o'").get() as { plan_override: string }).plan_override)).toEqual({ service: "Beta work" });
    expect(db.raw.prepare("SELECT actor FROM events WHERE kind = 'dump.start_over'").get()).toEqual({ actor: OPS_ACTOR });
    const bad = JSON.stringify({ dump_id: "dmp_o", service: "gamma" });
    expect((await post(bad, sign(bad))).status).toBe(400);
  });

  it("rewrite-words: New clips get written words again with no new cut, the burned hook re-rendered away, nothing else touched", async () => {
    db.raw.exec(`UPDATE clips SET hook_text = 'Go ahead.', caption = 'Go ahead.', look = 'clean', score = 94, number = 7,
      score_reasons = '["Sharp and steady throughout","Short, readable on-screen words"]' WHERE id = 'clp_new';
      UPDATE clips SET hook_text = 'Kept as she approved it', score = 90 WHERE id = 'clp_ok';`);
    const rw = (b: string) => app.request("http://w.example/api/ops/rewrite-words", { method: "POST", headers: { "content-type": "application/json", ...sign(b) }, body: b }, env);
    const body = JSON.stringify({ dump_id: "dmp_o" });
    expect((await app.request("http://w.example/api/ops/rewrite-words", { method: "POST", headers: { "content-type": "application/json" }, body }, env)).status).toBe(401);
    const r = await rw(body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, cleared: 1, written: 1, rerenders: 1 });
    const row = db.raw.prepare("SELECT hook_text, words_pending, score, score_reasons, rerender_job_id, pending_look FROM clips WHERE id = 'clp_new'").get() as { hook_text: string; words_pending: number; score: number; score_reasons: string; rerender_job_id: string | null; pending_look: string };
    expect(row.hook_text).not.toBe("Go ahead.");
    expect(row.hook_text.length).toBeGreaterThan(0);
    expect(row.words_pending).toBe(0);
    // Docked as the engine docks a clip with no words (94 - 10, capped at 80), then the points back once written.
    expect(row.score).toBe(90);
    expect(JSON.parse(row.score_reasons)).toEqual(["Sharp and steady throughout", "Short, readable on-screen words"]);
    expect(row.rerender_job_id).toBeTruthy();
    expect(row.pending_look).toBe("clean");
    expect(db.raw.prepare("SELECT hook_text, score FROM clips WHERE id = 'clp_ok'").get()).toEqual({ hook_text: "Kept as she approved it", score: 90 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM emails_sent").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT status FROM dumps WHERE id = 'dmp_o'").get()).toEqual({ status: "ready" });
  });
});
