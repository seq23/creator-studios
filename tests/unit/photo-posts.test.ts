// Photo posts end to end through the real Worker (worker/index.ts) on an in-memory D1 and R2:
// planning (heads-up lead, one per platform per day, the weekly cap), auto-post, Skip (in the app
// and from the signed email link: a skipped post NEVER goes out), the "Made with AI" label and
// platform flag, content rules re-checked at the moment of posting, the photo check gate, and a
// platform with no token waiting as a named "Connect Facebook" stop instead of failing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
import { planPack, readSkipToken, skipToken } from "@worker/domain/photoPosts";
import { finishPack, photoPostsTick, photosHome } from "@worker/lib/photoPosts";
import { photoPackJob } from "@worker/jobs/photopack";
import { FakeFacebook } from "@worker/services/facebook";
import { FakePinterest } from "@worker/services/pinterest";
import { fakePostMetadata, resetFakeBuffer } from "@worker/services/buffer";
import { saveConnection } from "@worker/lib/connections";
import { hydrate } from "@worker/lib/practice";
import { parsePhotoPosts, type PhotoPostsConfig } from "@shared/photoPosts";

const BASE = "https://pnp.example";
const KEY = "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=";
const ASSETS = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const CFG = { on: true, platforms: ["facebook", "instagram", "tiktok", "pinterest"], headsUpHours: 24, postHour: 11 };
const RULES = { banWords: ["insured"], blockAddresses: true, blockFaces: true, prices: [{ name: "Grand Holiday Porch", usd: 1050 }] };
const NOW = Date.parse("2026-10-22T15:00:00.000Z"); // 10 AM in Memphis
let env: Env;
let raw: ReturnType<typeof sqliteD1>["raw"];

function makeEnv(over: Partial<Env> = {}): Env {
  const d = sqliteD1();
  raw = d.raw;
  return {
    DB: d.DB,
    FILES: memoryR2().FILES,
    ASSETS,
    APP_NAME: "Demo Studio",
    OWNER_NAME: "",
    OWNER_EMAIL: "owner@studio.example",
    STUDIO_SLUG: "sample1",
    FAKE_SERVICES: "1",
    PUBLIC_BASE_URL: BASE,
    GITHUB_REPO: "",
    AUDIENCE_TIMEZONE: "America/Chicago",
    ENV_NAME: "dev",
    AUTH_MODE: "code",
    SESSION_SECRET: "s",
    SECRETS_KEY: KEY,
    JOB_SHARED_SECRET: "j",
    PHOTO_POSTS: JSON.stringify(CFG),
    CONTENT_RULES: JSON.stringify(RULES),
    ...over,
  } as unknown as Env;
}

const req = async (method: string, p: string, body?: unknown) =>
  worker.fetch(new Request(`${BASE}${p}`, { method, headers: { cookie: await ownerCookie(env), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);

/** A pack with photos in storage, made by the photo maker's stand-in, its posts planned at NOW. */
async function readyPack(roles: ("main" | "before" | "after")[] = ["main"], privacy?: "unchecked" | "clean" | "fixed" | "blocked"): Promise<string> {
  const r = await req("POST", "/api/photos/packs", { note: "Fall front steps" });
  expect(r.status).toBe(200);
  const { id } = (await r.json()) as { id: string };
  for (const [i, role] of roles.entries()) {
    const key = `packs/${id}/in/pph_${i}`;
    await env.FILES.put(key, new Uint8Array([255, 216, 255, 0]), { httpMetadata: { contentType: "image/jpeg" } });
    raw.prepare("INSERT INTO pack_photos (id, pack_id, role, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES (?, ?, ?, ?, 'image/jpeg', 4, ?, 'uploaded')").run(`pph_${id}_${i}`, id, role, `p${i}.jpg`, key);
  }
  raw.prepare("UPDATE photo_packs SET captions = ? WHERE id = ?").run(JSON.stringify(["Fall front steps, ready.", "Swipe for details.", "Made with care."]), id);
  const h = await hydrate(env);
  const result = (await photoPackJob.fakeRun!(h, "job_x", id, {})) as { privacy: { status: string } };
  if (privacy) result.privacy.status = privacy;
  const { parsePackResult } = await import("@worker/jobs/photopack");
  const p = parsePackResult(result, id);
  await finishPack(h, id, p.items, p.privacy, p.detail, NOW);
  return id;
}

const posts = () => raw.prepare("SELECT id, platform, item_kind, status, scheduled_at, caption, error FROM social_posts ORDER BY scheduled_at, platform").all() as { id: string; platform: string; item_kind: string; status: string; scheduled_at: string; caption: string; error: string | null }[];
const tick = async (at: number) => photoPostsTick(await hydrate(env), at);

beforeEach(async () => {
  env = makeEnv();
  FakeFacebook.posted = [];
  FakePinterest.pinned = [];
  resetFakeBuffer();
  await saveConnection(env, "buffer", "good-key-e2e-000", "ok", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("planning (pure)", () => {
  const cfg = parsePhotoPosts(JSON.stringify(CFG)) as PhotoPostsConfig;
  it("reel day 1, photo set day 2, before/after day 3, at the post hour, never inside the heads-up lead", () => {
    const plan = planPack(NOW, cfg, "America/Chicago", ["reel", "carousel", "before_after"], new Set());
    expect(plan.filter((p) => p.kind === "reel").map((p) => p.scheduled_at)).toEqual(Array(3).fill("2026-10-23T16:00:00.000Z"));
    expect(plan.filter((p) => p.kind === "carousel").map((p) => [p.platform, p.scheduled_at])).toEqual([
      ["facebook", "2026-10-24T16:00:00.000Z"],
      ["pinterest", "2026-10-24T16:00:00.000Z"],
    ]);
    expect(plan.filter((p) => p.kind === "before_after").every((p) => p.scheduled_at === "2026-10-25T16:00:00.000Z")).toBe(true);
    for (const p of plan) expect(Date.parse(p.scheduled_at) - NOW).toBeGreaterThanOrEqual(24 * 3_600_000);
  });
  it("one photo post per platform per day: a taken day moves to the next free one", () => {
    const plan = planPack(NOW, cfg, "America/Chicago", ["reel"], new Set(["facebook|2026-10-23"]));
    expect(plan.find((p) => p.platform === "facebook")!.scheduled_at).toBe("2026-10-24T16:00:00.000Z");
    expect(plan.find((p) => p.platform === "instagram")!.scheduled_at).toBe("2026-10-23T16:00:00.000Z");
  });
  it("a week already at the hard cap of 10 is skipped", () => {
    const plan = planPack(NOW, cfg, "America/Chicago", ["reel"], new Set(), (platform, at) => platform === "tiktok" && at < "2026-10-26T05:00:00.000Z");
    expect(plan.find((p) => p.platform === "tiktok")!.scheduled_at).toBe("2026-10-26T16:00:00.000Z");
  });
  it("only the studio's platforms are planned; a studio with photo posts off plans nothing", () => {
    expect(planPack(NOW, { ...cfg, platforms: ["facebook"] }, "America/Chicago", ["reel", "carousel"], new Set()).map((p) => p.platform)).toEqual(["facebook", "facebook"]);
    expect(parsePhotoPosts(undefined).on).toBe(false);
    expect(parsePhotoPosts('{"on":false}').on).toBe(false);
  });
});

describe("auto-post with a heads-up and Skip", () => {
  it("posts go out on their own at their time, after a heads-up email with a Skip link each", async () => {
    await readyPack();
    const planned = posts();
    expect(planned.map((p) => p.platform).sort()).toEqual(["facebook", "facebook", "instagram", "pinterest", "tiktok"]);
    // Nothing before its time.
    expect((await tick(NOW + 3_600_000)).posted).toBe(0);
    // The heads-up went out a day ahead, listing each with its own signed Skip link.
    const sent = raw.prepare("SELECT kind, subject FROM emails_sent WHERE kind = 'heads_up'").all() as { subject: string }[];
    expect(sent.length).toBe(1);
    expect(planned.filter((p) => p.status === "scheduled").length).toBe(5);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM social_posts WHERE heads_up_at IS NOT NULL").get() as { n: number }).n).toBeGreaterThanOrEqual(3);
    // Day 1: the reel goes to Facebook, Instagram and TikTok.
    const out = await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    expect(out.posted).toBe(3);
    expect(FakeFacebook.posted.length).toBe(1);
  });

  it("a skipped post NEVER goes out (in-app Skip)", async () => {
    await readyPack();
    const fb = posts().find((p) => p.platform === "facebook" && p.item_kind === "reel")!;
    expect((await req("POST", `/api/photos/posts/${fb.id}/skip`)).status).toBe(200);
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    await tick(Date.parse("2026-10-30T16:05:00.000Z"));
    expect(FakeFacebook.posted.filter((p) => p.kind === "video")).toEqual([]);
    expect(posts().find((p) => p.id === fb.id)!.status).toBe("skipped");
    // A second Skip, or a Skip after it went out, says so in plain words.
    expect((await req("POST", `/api/photos/posts/${fb.id}/skip`)).status).toBe(409);
  });

  it("Undo skip puts it back on with a fresh heads-up", async () => {
    await readyPack();
    const fb = posts().find((p) => p.platform === "facebook" && p.item_kind === "reel")!;
    await req("POST", `/api/photos/posts/${fb.id}/skip`);
    expect((await req("POST", `/api/photos/posts/${fb.id}/unskip`)).status).toBe(200);
    expect(posts().find((p) => p.id === fb.id)!.status).toBe("scheduled");
  });

  it("the email Skip link only SHOWS on open (mail scanners) and skips on the button; a forged link does nothing", async () => {
    await readyPack();
    const fb = posts().find((p) => p.platform === "facebook")!;
    const token = await skipToken(env.SESSION_SECRET, fb.id);
    expect(await readSkipToken(env.SESSION_SECRET, token)).toBe(fb.id);
    const shown = await worker.fetch(new Request(`${BASE}/skip/${token}`), env, ctx);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Yes, skip it");
    expect(posts().find((p) => p.id === fb.id)!.status).toBe("scheduled");
    const forged = await worker.fetch(new Request(`${BASE}/skip/${fb.id}.0000000000000000000000000000000`, { method: "POST" }), env, ctx);
    expect(forged.status).toBe(404);
    expect(posts().find((p) => p.id === fb.id)!.status).toBe("scheduled");
    const done = await worker.fetch(new Request(`${BASE}/skip/${token}`, { method: "POST" }), env, ctx);
    expect(done.status).toBe(200);
    expect(posts().find((p) => p.id === fb.id)!.status).toBe("skipped");
    await tick(Date.parse("2026-10-24T17:00:00.000Z"));
    expect(FakeFacebook.posted.filter((p) => p.kind === "video")).toEqual([]);
  });
});

describe("Made with AI", () => {
  it("an AI-moved video carries the label on Facebook and the platform flag through Buffer; a plain photo set does not", async () => {
    await readyPack();
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    await tick(Date.parse("2026-10-24T16:05:00.000Z"));
    const video = FakeFacebook.posted.find((p) => p.kind === "video")!;
    const photos = FakeFacebook.posted.find((p) => p.kind === "photos")!;
    expect(video.text).toMatch(/Made with AI$/);
    expect(photos.text).not.toMatch(/Made with AI/);
    const ig = raw.prepare("SELECT external_id FROM social_posts WHERE platform = 'instagram' AND status = 'posted'").get() as { external_id: string };
    expect(fakePostMetadata(ig.external_id)).toMatchObject({ instagram: { isAiGenerated: true } });
  });
});

describe("content rules are checked again at the moment of posting", () => {
  it("a caption that says insured is refused on edit and HELD if it got in any other way", async () => {
    await readyPack();
    const fb = posts().find((p) => p.platform === "facebook" && p.item_kind === "reel")!;
    const r = await req("PATCH", `/api/photos/posts/${fb.id}`, { caption: "Fully insured porch team" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { problems: string[] }).problems[0]).toMatch(/insured/);
    // Written straight into the table (an old row, a bug): the send-time check still stops it.
    raw.prepare("UPDATE social_posts SET caption = 'We are insured. Grand Holiday Porch $900 at 12 Elm St' WHERE id = ?").run(fb.id);
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    const after = posts().find((p) => p.id === fb.id)!;
    expect(after.status).toBe("held");
    expect(FakeFacebook.posted.filter((p) => p.kind === "video")).toEqual([]);
  });

  it("a photo the check could not make safe never posts; an unchecked one waits when face/address rules are on", async () => {
    await readyPack(["main"], "blocked");
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    expect(posts().filter((p) => p.item_kind === "reel").every((p) => p.status === "held")).toBe(true);
    expect(FakeFacebook.posted).toEqual([]);
  });

  it("an unchecked photo waits for the photo check (rules on)", async () => {
    await readyPack(["main"], "unchecked");
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    const reel = posts().filter((p) => p.item_kind === "reel");
    expect(reel.every((p) => p.status === "waiting" && p.error === "photo-check")).toBe(true);
  });

  it("a studio without rules (Hadiyah) is not held by them", async () => {
    env = makeEnv({ CONTENT_RULES: undefined });
    await saveConnection(env, "buffer", "good-key-e2e-000", "ok", {});
    await readyPack();
    const fb = posts().find((p) => p.platform === "facebook" && p.item_kind === "reel")!;
    expect((await req("PATCH", `/api/photos/posts/${fb.id}`, { caption: "We are insured, $5" })).status).toBe(200);
  });
});

describe("a platform with no token is a named stop; its posts wait, never fail", () => {
  it("practice studio: Connect Facebook / Pinterest / Buffer are listed, posts wait, nothing is called", async () => {
    env = makeEnv({ FAKE_SERVICES: "0" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("no vendor may be called without a token");
    });
    const id = await (async () => {
      const r = await req("POST", "/api/photos/packs", { note: "" });
      return ((await r.json()) as { id: string }).id;
    })();
    raw.prepare("INSERT INTO pack_photos (id, pack_id, role, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES ('pph_a', ?, 'main', 'a.jpg', 'image/jpeg', 4, 'k', 'uploaded')").run(id);
    await finishPack(await hydrate(env), id, [{ kind: "reel", r2_key: `packs/${id}/out/reel.mp4`, cover_r2_key: null, images: [] }], "clean", {}, NOW);
    await tick(Date.parse("2026-10-23T16:05:00.000Z"));
    const ps = posts();
    expect(ps.length).toBe(3);
    expect(ps.every((p) => p.status === "waiting")).toBe(true);
    expect(ps.find((p) => p.platform === "facebook")!.error).toBe("connect:facebook");
    const home = await photosHome(await hydrate(env));
    expect(home.stops.map((s) => s.label)).toEqual(["Connect Facebook", "Connect Instagram", "Connect TikTok", "Connect Pinterest"]);
    expect(home.upcoming.find((p) => p.platform === "facebook")!.line).toMatch(/Waiting: Connect Facebook/);
    expect(home.upcoming.find((p) => p.platform === "facebook")!.connect).toBe("facebook");
  });

  it("a studio with photo posts off refuses a new set in plain words", async () => {
    env = makeEnv({ PHOTO_POSTS: undefined });
    const r = await req("POST", "/api/photos/packs", { note: "" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/not part of this studio/);
  });
});

describe("photo uploads", () => {
  it("accepts JPG, PNG and iPhone HEIC (even with no type: the app sends application/octet-stream), refuses a video", async () => {
    const { id } = (await (await req("POST", "/api/photos/packs", { note: "" })).json()) as { id: string };
    for (const [fileName, mimeType] of [["a.jpg", "image/jpeg"], ["b.png", "image/png"], ["c.HEIC", "image/heic"], ["d.heic", "application/octet-stream"]]) {
      const r = await req("POST", "/api/uploads/start", { kind: "photo", parentId: id, fileName, size: 1000, mimeType });
      expect(r.status, fileName).toBe(200);
    }
    const bad = await req("POST", "/api/uploads/start", { kind: "photo", parentId: id, fileName: "v.mp4", size: 1000, mimeType: "video/mp4" });
    expect(bad.status).toBe(422);
    const heic = raw.prepare("SELECT mime_type FROM pack_photos WHERE file_name = 'd.heic'").get() as { mime_type: string };
    expect(heic.mime_type).toBe("image/heic");
  });
});
