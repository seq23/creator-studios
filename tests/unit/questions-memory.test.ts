// Studio intelligence layers 7 (one-tap questions), 8 (Studio Memory) and 9 (the live switch).
// Pinned: the questions never need typing and never come back once answered; a "Yes" only records,
// a service or before videos re-plan the dump from its saved shot sheets; every answer is remembered
// and a service corrected twice is relabelled; the cut spec carries the memory; over 50% rejected
// switches the approach to careful on its own, logged with why, and it switches back with hysteresis.
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
import { dumps as dumpsRoute } from "@worker/routes/dumps";
import { cutJob, type CutSpec } from "@worker/jobs/cut";
import { chooseApproach, decisions, loadMemory, rejectionRate, summarize, type ReviewedRow } from "@worker/domain/studioMemory";
import { answerQuestion, cleanOverride, questionsFor } from "@shared/looksLike";
import { setSetting } from "@worker/lib/db";

const SERVICES = ["alpha work", "beta work"];

describe("layer 7: one-tap questions (pure)", () => {
  const sure = { service: "alpha work", shape: "montage" as const, camera: "off" as const, sure: true };
  const videos = [{ id: "a", n: 1, what: "an empty corner", before: false }, { id: "b", n: 2, what: "the finished corner", before: false }];
  it("asks at most two, worded as a tap, never one already answered", () => {
    const q = questionsFor(sure, {}, videos, SERVICES);
    expect(q.map((x) => [x.id, x.text])).toEqual([["service", "Is this alpha work?"], ["before", "Is one of these a before?"]]);
    expect(questionsFor(sure, { answered: ["service", "before"] }, videos, SERVICES)).toEqual([]);
    expect(questionsFor(null, {}, videos, SERVICES)[0]!.text).toBe("What do these videos show?");
    // A before and after already: no before question; one video: none either.
    expect(questionsFor({ ...sure, shape: "transformation" }, {}, videos, SERVICES).map((x) => x.id)).toEqual(["service"]);
    expect(questionsFor(sure, {}, videos.slice(0, 1), SERVICES).map((x) => x.id)).toEqual(["service"]);
  });
  it("Yes records only; a service or befores re-plan", () => {
    expect(answerQuestion({}, { id: "service", yes: true })).toEqual({ override: { answered: ["service"] }, replan: false });
    expect(answerQuestion({ service: "alpha work" }, { id: "service", service: "beta work" })).toEqual({ override: { service: "beta work", answered: ["service"] }, replan: true });
    expect(answerQuestion({}, { id: "before", before_assets: ["a"] })).toEqual({ override: { before_assets: ["a"], answered: ["before"] }, replan: true });
    expect(answerQuestion({}, { id: "before", yes: false }).replan).toBe(false);
  });
  it("only this dump's videos can be a before", () => {
    expect(cleanOverride({ before_assets: ["a", "zzz", "a"] }, SERVICES, ["a", "b"])).toEqual({ before_assets: ["a"] });
    expect(cleanOverride({ before_assets: ["a"] }, SERVICES)).toEqual({});
  });
});

describe("layer 8 + 9: memory and the switch (pure)", () => {
  const row = (status: ReviewedRow["status"], shape = "montage", hook = "A hook"): ReviewedRow => ({ status, shape, service: "alpha work", hook_text: hook, reject_reason: status === "rejected" ? "Not my style" : null, reviewed_at: "2026-10-20T00:00:00Z", views: 10 });
  it("learns shapes, hooks, reasons, notes and corrections twice over", () => {
    const m = summarize([row("approved", "walkthrough", "Kept one"), row("rejected", "montage", "Turned down")], ["slower please"], [{ from: "alpha work", to: "beta work" }, { from: "alpha work", to: "beta work" }, { from: "beta work", to: "alpha work" }], "standard");
    expect(m.shapes).toEqual({ walkthrough: { approved: 1, rejected: 0, views: 10 }, montage: { approved: 0, rejected: 1, views: 10 } });
    expect(m.kept_hooks).toEqual(["Kept one"]);
    expect(m.turned_down_hooks).toEqual(["Turned down"]);
    expect(m.reject_reasons).toEqual(["Not my style"]);
    expect(m.notes).toEqual(["slower please"]);
    expect(m.relabel).toEqual({ "alpha work": "beta work" }); // once is not a pattern
  });
  it("a clear-out (the same decision for the same reason, seconds apart) is one decision, not many", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 23, 9, 0) - s * 1000).toISOString();
    const row = (status: "approved" | "rejected", reason: string | null, s: number): ReviewedRow => ({ status, shape: null, service: null, hook_text: "", reject_reason: reason, reviewed_at: at(s), views: null });
    // 23 Oct 2026: 16 "bad cut" 0.7 s apart, then 3 "not on brand" 1 s apart, two hours later.
    const live = [...[0, 1, 2].map((i) => row("rejected", "not on brand", -7200 + i)), ...Array.from({ length: 16 }, (_, i) => row("rejected", "bad cut", i * 0.7))];
    expect(decisions(live).length).toBe(2);
    expect(rejectionRate(live)).toEqual({ rate: 1, reviewed: 2 });
    expect(chooseApproach("standard", rejectionRate(live)).approach).toBe("standard"); // 2 decisions are too few to switch
    // Deliberate reviews a minute apart each count, the same reason or not; a different reason or decision breaks a run.
    const slow = Array.from({ length: 12 }, (_, i) => row("rejected", "bad cut", i * 60));
    expect(rejectionRate(slow)).toEqual({ rate: 1, reviewed: 12 });
    expect(chooseApproach("standard", rejectionRate(slow)).approach).toBe("careful");
    const mixed = [row("rejected", "bad cut", 0), row("rejected", "bad hook", 1), row("approved", null, 2), row("rejected", "bad hook", 3)];
    expect(decisions(mixed).length).toBe(4);
  });
  it("over half turned down (10+ reviewed) switches to careful; back only at 35% or under", () => {
    expect(chooseApproach("standard", { rate: 0.6, reviewed: 12 }).approach).toBe("careful");
    expect(chooseApproach("standard", { rate: 0.9, reviewed: 5 }).approach).toBe("standard");
    expect(chooseApproach("careful", { rate: 0.45, reviewed: 20 }).approach).toBe("careful");
    expect(chooseApproach("careful", { rate: 0.3, reviewed: 20 }).approach).toBe("standard");
    expect(chooseApproach("standard", { rate: 0.6, reviewed: 12 }).why).toMatch(/60% of the last 12 clips were turned down/);
  });
});

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/dumps", dumpsRoute);
let env: Env;
let db: ReturnType<typeof sqliteD1>;
const call = async (method: string, p: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const one = <T>(sql: string) => db.raw.prepare(sql).get() as T;

describe("the routes and the spec", () => {
  beforeEach(async () => {
    db = sqliteD1();
    const r2 = memoryR2();
    env = { DB: db.DB, FILES: r2.FILES, OWNER_EMAIL: "owner@example.com", SESSION_SECRET: "session-secret-for-tests", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", APP_NAME: "Sample Studio", FAKE_SERVICES: "1", AUTH_MODE: "code", PUBLIC_BASE_URL: BASE_URL, GITHUB_REPO: "example/studio-jobs" } as unknown as Env;
    await setSetting(env.DB, "features", { voice: true, deeper_research: false, weekly_recap: true, help_ask: false });
    const sheet = JSON.stringify({ source: "vision:x", shots: [{ start: 0, end: 4, what: "an empty corner", state: "unsure" }] });
    db.raw.exec(`INSERT INTO brand_profile (sections, locked) VALUES ('{"service_looks":"Alpha work: a corner set up\\nBeta work: a shelf set up","ctas":"Message us."}', 1);
      INSERT INTO research_briefs (body, status) VALUES ('{}', 'approved');
      INSERT INTO dumps (id, door, notes, status, looks_like) VALUES ('dmp_q', 'new', '', 'ready', '{"service":"Alpha work","shape":"montage","camera":"off","sure":true}');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status, shot_sheet, created_at) VALUES ('ast_1', 'dmp_q', 'a.mp4', 'video/mp4', 'raw/dmp_q/1', 'uploaded', '${sheet}', '2026-10-22T01:00:00Z');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status, created_at) VALUES ('ast_2', 'dmp_q', 'b.mp4', 'video/mp4', 'raw/dmp_q/2', 'uploaded', '2026-10-22T02:00:00Z');`);
    await r2.FILES.put("raw/dmp_q/1", new Uint8Array(10), { httpMetadata: { contentType: "video/mp4" } });
    await r2.FILES.put("raw/dmp_q/2", new Uint8Array(10), { httpMetadata: { contentType: "video/mp4" } });
  });
  it("the questions name what the studio saw in each video", async () => {
    const r = await call("GET", "/api/dumps/dmp_q/questions");
    expect(r.json.questions.map((q: { id: string }) => q.id)).toEqual(["service", "before"]);
    expect(r.json.services).toEqual(["Alpha work", "Beta work"]);
    expect(r.json.videos).toEqual([{ id: "ast_1", n: 1, what: "an empty corner", before: false }, { id: "ast_2", n: 2, what: "We couldn't tell what this one shows", before: false }]);
  });
  it("Yes records without cutting; a before re-plans and is remembered", async () => {
    expect((await call("POST", "/api/dumps/dmp_q/answer", { id: "service", yes: true })).json).toEqual({ ok: true, replan: false });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").n).toBe(0);
    const r = await call("POST", "/api/dumps/dmp_q/answer", { id: "before", before_assets: ["ast_1", "not_mine"] });
    expect(r.status).toBe(200);
    expect(JSON.parse(one<{ plan_override: string }>("SELECT plan_override FROM dumps WHERE id = 'dmp_q'").plan_override)).toEqual({ answered: ["service", "before"], before_assets: ["ast_1"] });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'dump.question_answered'").n).toBe(2);
    const job = one<{ id: string }>("SELECT id FROM jobs WHERE type = 'cut' ORDER BY created_at DESC LIMIT 1");
    const spec = (await cutJob.buildSpec(env, job.id, "dmp_q")) as CutSpec;
    expect(spec.plan_override.before_assets).toEqual(["ast_1"]);
    expect(spec.memory.approach).toBe("standard");
    expect(spec.content_rules).toBeTruthy();
    // Nothing more to ask.
    db.raw.exec("UPDATE dumps SET status = 'ready' WHERE id = 'dmp_q'");
    expect((await call("GET", "/api/dumps/dmp_q/questions")).json.questions).toEqual([]);
  });
  it("a service answer must be one of hers", async () => {
    expect((await call("POST", "/api/dumps/dmp_q/answer", { id: "service", service: "gamma work" })).status).toBe(400);
    expect((await call("POST", "/api/dumps/dmp_q/answer", { id: "nope" })).status).toBe(400);
  });
  it("the live switch is recorded with why, once", async () => {
    // One decision a minute (a clear-out within BURST_S counts once: see the test below).
    for (let i = 0; i < 12; i++) db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, status, reviewed_at, hook_text) VALUES ('clp_${i}', 'ast_1', 'dmp_q', 0, 5, 'montage', 'k${i}', '${i < 8 ? "rejected" : "approved"}', '${new Date(Date.now() - i * 60_000).toISOString()}', 'h${i}')`);
    const m = await loadMemory(env);
    expect(m.approach).toBe("careful");
    expect(m.rejection).toMatchObject({ rate: 0.667, reviewed: 12 });
    await loadMemory(env);
    const ev = db.raw.prepare("SELECT detail FROM events WHERE kind = 'studio.approach_switched'").all() as { detail: string }[];
    expect(ev.length).toBe(1);
    expect(JSON.parse(ev[0]!.detail)).toMatchObject({ from: "standard", to: "careful", reviewed: 12 });
  });
});
