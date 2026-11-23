// The content engine's door into a studio (worker/routes/ops.ts engine-file + engine-pack,
// worker/lib/photoPosts.ts importEnginePack): only a signed piece that PASSED review is queued, its
// files must already be in storage, its captions keep the content rules, no channel goes over 10 a
// week, and a piece is never queued twice. At posting: an engine piece carries no "Made with AI"
// caption line, sets TikTok's own AI switch on a photo-real AI scene (risk R-END-03, P&P filler
// exception, 19 Nov 2026), and never goes out if its PASS is missing.
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ops } from "@worker/routes/ops";
import { importEnginePack, labelFor, photoPostsTick, type EnginePackInput } from "@worker/lib/photoPosts";
import { FakeFacebook } from "@worker/services/facebook";
import { fakePostMetadata, resetFakeBuffer } from "@worker/services/buffer";
import { saveConnection } from "@worker/lib/connections";
import { hydrate } from "@worker/lib/practice";

const SECRET = "job-secret-for-tests";
const KEY = "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=";
const CFG = { on: true, platforms: ["facebook", "instagram", "tiktok", "pinterest"], headsUpHours: 24, postHour: 11 };
const RULES = { banWords: ["insured"], blockAddresses: true, blockFaces: false, prices: [{ name: "Grand Holiday Porch", usd: 1050 }] };
const NOW = Date.parse("2026-11-20T15:00:00.000Z");
const SAT_EVENING = "2026-11-22T00:30:00.000Z"; // Sat 21 Nov, 6:30 PM in Memphis

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  await next();
});
app.route("/api/ops", ops);

let env: Env;
let raw: ReturnType<typeof sqliteD1>["raw"];

beforeEach(async () => {
  const d = sqliteD1();
  raw = d.raw;
  env = {
    DB: d.DB,
    FILES: memoryR2().FILES,
    APP_NAME: "Demo Studio",
    OWNER_EMAIL: "owner@studio.example",
    FAKE_SERVICES: "1",
    PUBLIC_BASE_URL: "https://pnp.example",
    AUDIENCE_TIMEZONE: "America/Chicago",
    AUTH_MODE: "code",
    SESSION_SECRET: "s",
    SECRETS_KEY: KEY,
    JOB_SHARED_SECRET: SECRET,
    PHOTO_POSTS: JSON.stringify(CFG),
    CONTENT_RULES: JSON.stringify(RULES),
  } as unknown as Env;
  FakeFacebook.posted = [];
  resetFakeBuffer();
  await saveConnection(env, "buffer", "good-key-e2e-000", "ok", {});
});

const PASS = { verdict: "PASS", by: "fresh reviewer", looked_at: "contact sheet, 1 frame a second", at: "2026-11-20T14:00:00.000Z" };

async function stored(key: string, ...files: string[]) {
  for (const f of files) await env.FILES.put(`engine/${key}/${f}`, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: f.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
}

function piece(key: string, over: Partial<EnginePackInput> = {}): EnginePackInput {
  return {
    key,
    note: "Thanksgiving porch countdown",
    format: "countdown",
    review: PASS,
    ai_scene: true,
    items: [{ kind: "reel", r2_key: `engine/${key}/reel.mp4`, cover_r2_key: `engine/${key}/cover.jpg`, images: [] }],
    posts: [
      { platform: "tiktok", item_kind: "reel", caption: "Five days. One form. porchandparty901.com/request", scheduled_at: SAT_EVENING },
      { platform: "instagram", item_kind: "reel", caption: "Five days out. porchandparty901.com/request", scheduled_at: SAT_EVENING },
      { platform: "facebook", item_kind: "reel", caption: "Five days to Thanksgiving. porchandparty901.com/request", scheduled_at: SAT_EVENING },
    ],
    ...over,
  };
}

const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;

describe("queueing a piece", () => {
  it("queues a reviewed piece as a ready pack with its posts at the engine's times", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    const r = await importEnginePack(env, piece("tg-countdown"), NOW);
    expect(r).toMatchObject({ ok: true, pack_id: "pck_eng_tg-countdown", posts: 3 });
    expect(raw.prepare("SELECT status, privacy, made_by, format FROM photo_packs").get()).toEqual({ status: "ready", privacy: "clean", made_by: "engine", format: "countdown" });
    expect(raw.prepare("SELECT DISTINCT scheduled_at AS at, status FROM social_posts").all()).toEqual([{ at: SAT_EVENING, status: "scheduled" }]);
  });

  it("refuses, writing nothing: no PASS, a missing file, a broken content rule, a time in the past", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    expect(await importEnginePack(env, piece("tg-countdown", { review: { ...PASS, verdict: "FAIL" } }), NOW)).toMatchObject({ ok: false, status: 422 });
    expect(await importEnginePack(env, piece("not-stored"), NOW)).toMatchObject({ ok: false, status: 400 });
    const p = piece("tg-countdown");
    p.posts[1].caption = "Fully insured porch crews";
    expect(await importEnginePack(env, p, NOW)).toMatchObject({ ok: false, status: 422 });
    expect(await importEnginePack(env, piece("tg-countdown", { posts: [{ ...piece("x").posts[0], scheduled_at: "2026-11-20T15:05:00.000Z" }] }), NOW)).toMatchObject({ ok: false, status: 422 });
    expect(count("SELECT COUNT(*) AS n FROM photo_packs")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM social_posts")).toBe(0);
  });

  it("never queues a piece twice and never takes a channel over 10 posts in a week", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    expect((await importEnginePack(env, piece("tg-countdown"), NOW)).ok).toBe(true);
    expect(await importEnginePack(env, piece("tg-countdown"), NOW)).toMatchObject({ ok: false, status: 409 });
    // 9 more TikTok posts the same week (Mon 16 – Sun 22 Nov): the 11th is refused whole.
    raw.prepare("INSERT INTO photo_packs (id, status) VALUES ('pck_s', 'ready')").run();
    for (let i = 0; i < 9; i++) raw.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, scheduled_at, status) VALUES (?, 'pck_s', 'reel', 'tiktok', '2026-11-19T17:00:00.000Z', 'posted')").run(`spo_${i}`);
    await stored("another", "reel.mp4", "cover.jpg");
    const r = await importEnginePack(env, piece("another"), NOW);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(count("SELECT COUNT(*) AS n FROM photo_packs WHERE id = 'pck_eng_another'")).toBe(0);
  });
});

describe("one post per slot (migration 0046, Noelle's re-run after a crash)", () => {
  const slotted = (key: string, slot: string) =>
    piece(key, { posts: piece(key).posts.map((p) => ({ ...p, idem_key: `${p.platform}:${slot}` })) });

  it("the queue script names every post's slot: the plan's slot, else its planned time", async () => {
    // @ts-expect-error a plain .mjs script
    const { enginePosts } = await import("../../scripts/studio.mjs");
    const base = { platforms: ["tiktok", "instagram"], captions: { tiktok: "a", instagram: "b" }, at: "2026-12-04T18:40" };
    expect(enginePosts({ ...base, slot: "2026-12-04#2" }, "reel", SAT_EVENING).map((p: { idem_key: string }) => p.idem_key)).toEqual(["tiktok:2026-12-04#2", "instagram:2026-12-04#2"]);
    expect(enginePosts(base, "reel", SAT_EVENING)[0]).toMatchObject({ idem_key: "tiktok:2026-12-04T18:40", scheduled_at: SAT_EVENING, caption: "a" });
  });

  it("a second piece for a slot already taken is refused whole with 409, even under a new pack key", async () => {
    await stored("dec-04-a", "reel.mp4", "cover.jpg");
    await stored("dec-04-b", "reel.mp4", "cover.jpg");
    expect(await importEnginePack(env, slotted("dec-04-a", "2026-11-21#1"), NOW)).toMatchObject({ ok: true, posts: 3 });
    const again = await importEnginePack(env, slotted("dec-04-b", "2026-11-21#1"), NOW);
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect((again as { error: string }).error).toMatch(/instagram:2026-11-21#1/);
    expect(count("SELECT COUNT(*) AS n FROM social_posts")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM photo_packs")).toBe(1);
    // Another slot the same day is fine.
    expect(await importEnginePack(env, slotted("dec-04-b", "2026-11-21#2"), NOW)).toMatchObject({ ok: true });
  });

  it("a slot she skipped stays taken: a re-run never re-fills what she said no to", async () => {
    await stored("dec-05-a", "reel.mp4", "cover.jpg");
    await stored("dec-05-b", "reel.mp4", "cover.jpg");
    await importEnginePack(env, slotted("dec-05-a", "2026-11-21#1"), NOW);
    raw.prepare("UPDATE social_posts SET status = 'skipped'").run();
    expect(await importEnginePack(env, slotted("dec-05-b", "2026-11-21#1"), NOW)).toMatchObject({ ok: false, status: 409 });
  });

  it("the database itself refuses a doubled slot when two runs race past the check", async () => {
    await stored("race-a", "reel.mp4", "cover.jpg");
    await importEnginePack(env, slotted("race-a", "2026-11-21#1"), NOW);
    raw.prepare("INSERT INTO photo_packs (id, status) VALUES ('pck_r', 'ready')").run();
    expect(() => raw.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, scheduled_at, status, idem_key) VALUES ('spo_r', 'pck_r', 'reel', 'tiktok', ?, 'scheduled', 'tiktok:2026-11-21#1')").run(SAT_EVENING)).toThrow(/UNIQUE/);
    // Posts with no key (the studio's own planner, everything before 0046) never collide.
    raw.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, scheduled_at, status) VALUES ('spo_n1', 'pck_r', 'reel', 'tiktok', ?, 'scheduled')").run(SAT_EVENING);
    raw.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, scheduled_at, status) VALUES ('spo_n2', 'pck_r', 'reel', 'tiktok', ?, 'scheduled')").run(SAT_EVENING);
  });

  it("a forged slot key (another platform's, the same slot twice, junk) is refused, writing nothing", async () => {
    await stored("forged", "reel.mp4", "cover.jpg");
    const cross = piece("forged", { posts: [{ ...piece("forged").posts[0], idem_key: "facebook:2026-11-21#1" }] }); // a TikTok post
    expect(await importEnginePack(env, cross, NOW)).toMatchObject({ ok: false, status: 400 });
    const twice = piece("forged", { posts: [0, 1].map(() => ({ ...piece("forged").posts[0], idem_key: "tiktok:2026-11-21#1" })) });
    expect(await importEnginePack(env, twice, NOW)).toMatchObject({ ok: false, status: 400 });
    const junk = piece("forged", { posts: [{ ...piece("forged").posts[0], idem_key: "tiktok:'; DROP TABLE x" }] });
    expect(await importEnginePack(env, junk, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(count("SELECT COUNT(*) AS n FROM social_posts")).toBe(0);
  });

  it("the race answer: a unique-index refusal inside the batch is a 409, never a 500", async () => {
    await stored("race-b", "reel.mp4", "cover.jpg");
    // Another run's row lands between this run's check and its write: the check is made to see
    // nothing while that row is inserted, so only the unique index can stop the doubled slot.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let hidden = true;
    (env.DB as { prepare: typeof realPrepare }).prepare = (sql: string) => {
      if (hidden && sql.startsWith("SELECT idem_key FROM social_posts")) {
        hidden = false;
        raw.prepare("INSERT INTO photo_packs (id, status) VALUES ('pck_o', 'ready')").run();
        raw.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, scheduled_at, status, idem_key) VALUES ('spo_o', 'pck_o', 'reel', 'tiktok', ?, 'scheduled', 'tiktok:2026-11-21#9')").run(SAT_EVENING);
        return realPrepare(`${sql} AND 0`);
      }
      return realPrepare(sql);
    };
    const r = await importEnginePack(env, slotted("race-b", "2026-11-21#9"), NOW);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(count("SELECT COUNT(*) AS n FROM photo_packs WHERE id = 'pck_eng_race-b'")).toBe(0);
  });
});

describe("the signed door", () => {
  const sign = (msg: string) => {
    const ts = Math.floor(Date.now() / 1000);
    return { "x-ops-timestamp": String(ts), "x-ops-signature": createHmac("sha256", SECRET).update(`${ts}.${msg}`).digest("hex") };
  };
  it("stores a file only with a signature over its path and bytes", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const url = "http://w.example/api/ops/engine-file/engine/tg-countdown/reel.mp4";
    expect((await app.request(url, { method: "PUT", headers: sign(`ops:file:engine/tg-countdown/reel.mp4:${"0".repeat(64)}`), body: bytes }, env)).status).toBe(401);
    expect((await app.request(url, { method: "PUT", body: bytes }, env)).status).toBe(401);
    expect(await env.FILES.head("engine/tg-countdown/reel.mp4")).toBeNull();
    expect((await app.request(url, { method: "PUT", headers: sign(`ops:file:engine/tg-countdown/reel.mp4:${sha}`), body: bytes }, env)).status).toBe(200);
    expect(await env.FILES.head("engine/tg-countdown/reel.mp4")).not.toBeNull();
    const outside = "http://w.example/api/ops/engine-file/packs/x/reel.mp4";
    expect((await app.request(outside, { method: "PUT", headers: sign(`ops:file:packs/x/reel.mp4:${sha}`), body: bytes }, env)).status).toBe(400);
  });
  it("queues a pack only when signed", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const body = JSON.stringify(piece("tg-countdown", { posts: piece("x").posts.map((p) => ({ ...p, scheduled_at: later })) }));
    const url = "http://w.example/api/ops/engine-pack";
    expect((await app.request(url, { method: "POST", body }, env)).status).toBe(401);
    expect((await app.request(url, { method: "POST", headers: sign(body), body }, env)).status).toBe(401); // a job-style signature
    const r = await app.request(url, { method: "POST", headers: sign(`ops:${body}`), body }, env);
    expect(r.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM social_posts")).toBe(3);
  });
});

describe("posting an engine piece", () => {
  it("no 'Made with AI' line anywhere; TikTok's AI switch on for an AI scene, not Instagram's", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    await importEnginePack(env, piece("tg-countdown"), NOW);
    const out = await photoPostsTick(await hydrate(env), Date.parse(SAT_EVENING) + 60_000);
    expect(out.posted).toBe(3);
    const fb = FakeFacebook.posted.find((p) => p.kind === "video");
    const buffered = raw.prepare("SELECT platform, external_id, caption FROM social_posts WHERE status = 'posted'").all() as { platform: string; external_id: string }[];
    const meta = (p: string) => fakePostMetadata(buffered.find((b) => b.platform === p)!.external_id);
    expect(meta("tiktok")).toMatchObject({ tiktok: { isAiGenerated: true } });
    expect(JSON.stringify(meta("instagram") ?? {})).not.toMatch(/isAiGenerated/);
    expect(fb).toBeDefined();
    expect(fb!.text).not.toMatch(/Made with AI/i);
  });

  it("a real-work piece (no AI scene) sets no AI switch", () => {
    expect(labelFor("engine", "tiktok", "Real setup.", false)).toEqual({ text: "Real setup.", aiFlag: false });
    expect(labelFor("engine", "facebook", "Idea.", true)).toEqual({ text: "Idea.", aiFlag: false });
    // The studio's own pieces keep R-END-03 as written.
    expect(labelFor("studio", "facebook", "Fall steps.", true).text).toMatch(/Made with AI$/);
    expect(labelFor("studio", "instagram", "Fall steps.", true)).toEqual({ text: "Fall steps.", aiFlag: true });
  });

  it("an engine piece whose PASS is gone is held at posting, never sent", async () => {
    await stored("tg-countdown", "reel.mp4", "cover.jpg");
    await importEnginePack(env, piece("tg-countdown"), NOW);
    raw.prepare("UPDATE photo_packs SET review = NULL").run();
    const out = await photoPostsTick(await hydrate(env), Date.parse(SAT_EVENING) + 60_000);
    expect(out.posted).toBe(0);
    expect(out.held).toBe(3);
  });
});
