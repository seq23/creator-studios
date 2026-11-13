// The Posts overhaul, phase 1 (owner's rulings, 13 Nov 2026), through the real Worker on an
// in-memory D1 and R2. One test per behaviour, where it lives:
//   - "Fill the calendar" answers one of three true things (never "full" when it is only out of clips);
//   - one list of every upcoming post of every kind, with its words, and what cannot go out yet;
//   - one set of numbers: Home, the Calendar and the Settings line agree, photo posts counted;
//   - the Rejected bin: nothing in it can be planned or sent; Bring back; Delete for good removes
//     the made file and never her originals, and never a post that is planned or already out;
//     the daily job never clears a rejected reel, however long ago she said no.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
import { finishPack, photoPostsTick } from "@worker/lib/photoPosts";
import { photoPackJob, parsePackResult } from "@worker/jobs/photopack";
import { FakeFacebook } from "@worker/services/facebook";
import { FakePinterest } from "@worker/services/pinterest";
import { resetFakeBuffer } from "@worker/services/buffer";
import { saveConnection } from "@worker/lib/connections";
import { hydrate } from "@worker/lib/practice";
import { postCounts } from "@worker/domain/postCounts";
import { planAhead } from "@worker/routes/posts";
import { dailyMaintenance } from "@worker/crons/daily";
import { comingLine, fillLine, limitLine, type BinList, type FillResult, type PostsList, type PostsSummary } from "@shared/posts";

const BASE = "https://pnp.example";
const ASSETS = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let env: Env;
let raw: ReturnType<typeof sqliteD1>["raw"];

function makeEnv(): Env {
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
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    JOB_SHARED_SECRET: "j",
    PHOTO_POSTS: JSON.stringify({ on: true, platforms: ["facebook", "instagram", "tiktok"], headsUpHours: 24, postHour: 11 }),
    CONTENT_RULES: JSON.stringify({ banWords: ["insured"], blockAddresses: false, blockFaces: false, prices: [] }),
  } as unknown as Env;
}

async function call<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await worker.fetch(new Request(`${BASE}${p}`, { method, headers: { cookie: await ownerCookie(env), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}

/** Approved reels with their made file and their original upload in storage. */
async function seedClips(n: number, status = "approved") {
  raw.exec("INSERT OR IGNORE INTO dumps (id, door, notes, status) VALUES ('dmp_t', 'new', '', 'reviewed')");
  for (let i = 0; i < n; i++) {
    raw.exec(`INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_${i}', 'dmp_t', 'a${i}.mp4', 'video/mp4', 'raw/dmp_t/ast_${i}', 'uploaded')`);
    raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, score, r2_key, cover_r2_key, media_token, status) VALUES ('clp_${i}', 'ast_${i}', 'dmp_t', 0, 20, 'hook_first', 'Hook ${i}', 'Caption ${i}\nSecond line', '#porch #party', ${90 - i}, 'clips/dmp_t/clp_${i}.mp4', 'clips/dmp_t/clp_${i}.jpg', '${`tok${i}`.padEnd(40, "x")}', '${status}')`);
    await env.FILES.put(`raw/dmp_t/ast_${i}`, new Uint8Array([1]));
    await env.FILES.put(`clips/dmp_t/clp_${i}.mp4`, new Uint8Array([2]));
    await env.FILES.put(`clips/dmp_t/clp_${i}.jpg`, new Uint8Array([3]));
  }
}

/** A photo set made by the photo maker's stand-in, its posts planned from now. */
async function readyPack(): Promise<string> {
  const { json } = await call<{ id: string }>("POST", "/api/photos/packs", { note: "Fall front steps" });
  const id = json.id;
  const key = `packs/${id}/in/pph_0`;
  await env.FILES.put(key, new Uint8Array([255, 216, 255, 0]), { httpMetadata: { contentType: "image/jpeg" } });
  raw.prepare("INSERT INTO pack_photos (id, pack_id, role, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES (?, ?, 'main', 'p.jpg', 'image/jpeg', 4, ?, 'uploaded')").run(`pph_${id}`, id, key);
  raw.prepare("UPDATE photo_packs SET captions = ? WHERE id = ?").run(JSON.stringify(["Fall front steps, ready. Book your date.", "Swipe for details.", "Made with care."]), id);
  const h = await hydrate(env);
  const p = parsePackResult(await photoPackJob.fakeRun!(h, "job_x", id, {}), id);
  await finishPack(h, id, p.items, p.privacy, p.detail, Date.now());
  return id;
}

const stored = async (key: string) => !!(await env.FILES.head(key));

beforeEach(async () => {
  env = makeEnv();
  FakeFacebook.posted = [];
  FakePinterest.pinned = [];
  resetFakeBuffer();
  await saveConnection(env, "buffer", "good-key-e2e-000", "ok", {});
});

describe("the words (pure)", () => {
  const week = { start: "2026-11-09T06:00:00.000Z", end: "2026-11-16T06:00:00.000Z" };
  const now = "2026-11-13T15:00:00.000Z";
  it("counts every kind once: posted this week, still to go out, planned through the last upcoming post", () => {
    const s = postCounts(
      [
        { source: "clip", status: "posted", scheduled_at: "2026-11-10T16:00:00.000Z", posted_at: "2026-11-10T16:01:00.000Z" },
        { source: "photo", status: "posted", scheduled_at: "2026-11-12T17:00:00.000Z", posted_at: "2026-11-12T17:00:30.000Z" },
        { source: "clip", status: "posted", scheduled_at: "2026-11-02T16:00:00.000Z", posted_at: "2026-11-02T16:00:00.000Z" }, // last week
        { source: "clip", status: "planned", scheduled_at: "2026-11-14T16:00:00.000Z", posted_at: null },
        { source: "clip", status: "in_buffer", scheduled_at: "2026-11-15T03:00:00.000Z", posted_at: null },
        { source: "photo", status: "scheduled", scheduled_at: "2026-11-18T17:00:00.000Z", posted_at: null },
        { source: "photo", status: "waiting", scheduled_at: "2026-11-20T17:00:00.000Z", posted_at: null }, // cannot go out yet: not counted
        { source: "photo", status: "skipped", scheduled_at: "2026-11-21T17:00:00.000Z", posted_at: null },
        { source: "clip", status: "unscheduled", scheduled_at: "2026-11-22T17:00:00.000Z", posted_at: null },
        { source: "clip", status: "failed", scheduled_at: "2026-11-12T17:00:00.000Z", posted_at: null },
      ],
      week,
      now,
    );
    expect(s).toEqual({ postedThisWeek: 2, toGo: 3, plannedThrough: "2026-11-18T17:00:00.000Z" });
  });
  it("line 1 says how many are coming and through when, and 'then nothing' when under a week is left", () => {
    const at = Date.parse(now);
    expect(comingLine({ postedThisWeek: 0, toGo: 10, plannedThrough: "2026-11-15T23:00:00.000Z" }, "America/Chicago", at)).toBe("10 posts coming · planned through Sun 15 Nov, then nothing");
    expect(comingLine({ postedThisWeek: 0, toGo: 40, plannedThrough: "2026-12-02T18:00:00.000Z" }, "America/Chicago", at)).toBe("40 posts coming · planned through Wed 2 Dec");
    expect(comingLine({ postedThisWeek: 3, toGo: 0, plannedThrough: null }, "America/Chicago", at)).toBe("No posts coming");
  });
  it("Fill the calendar says one of three true things, word for word", () => {
    const summary: PostsSummary = { postedThisWeek: 0, toGo: 12, plannedThrough: "2026-12-02T18:00:00.000Z" };
    const r = (state: FillResult["state"], added: number, s = summary): FillResult => ({ state, added, weeks: 4, summary: s });
    expect(fillLine(r("added", 12), "America/Chicago")).toBe("Added 12 posts. You are now planned through Wed 2 Dec.");
    expect(fillLine(r("nothing_left", 0, { ...summary, plannedThrough: "2026-11-15T23:00:00.000Z" }), "America/Chicago")).toBe("Nothing left to add. You are planned through Sun 15 Nov.");
    expect(fillLine(r("all_planned", 0), "America/Chicago")).toBe("All 4 weeks are planned. Nothing to do.");
    expect(limitLine({ platform: "tiktok", label: "TikTok", used: 10, cap: 10 })).toBe("TikTok: 10 of 10 this week's limit used");
  });
});

describe("Fill the calendar tells the truth", () => {
  it("added, then nothing left (out of approved clips while the week has room), never 'all planned'", async () => {
    await seedClips(1);
    const first = await call<FillResult>("POST", "/api/posts/plan", { start_week: 1, weeks: 1 });
    expect(first.json).toMatchObject({ added: 3, state: "added", weeks: 1 });
    expect(first.json.summary.toGo).toBe(3);
    expect(first.json.summary.plannedThrough).toBe((raw.prepare("SELECT MAX(scheduled_at) AS t FROM posts").get() as { t: string }).t);
    // The one clip is used on every platform; the week still has room for 19 more posts.
    const again = await call<FillResult>("POST", "/api/posts/plan", { start_week: 1, weeks: 1 });
    expect(again.json).toMatchObject({ added: 0, state: "nothing_left" });
    expect(again.json.summary.toGo).toBe(3);
  });
  it("all planned only when every week looked at is truly at its limits", async () => {
    await seedClips(2);
    expect((await call("PATCH", "/api/settings", { weekly_caps: { tiktok: 1, instagram: 1, youtube: 0 } })).status).toBe(200);
    const first = await call<FillResult>("POST", "/api/posts/plan", { start_week: 1, weeks: 2 });
    expect(first.json).toMatchObject({ added: 4, state: "added", weeks: 2 });
    const again = await call<FillResult>("POST", "/api/posts/plan", { start_week: 1, weeks: 2 });
    expect(again.json).toMatchObject({ added: 0, state: "all_planned", weeks: 2 });
    // Proven the other way: raise a limit and the same weeks have room again, with nothing left to
    // put there (each reel is already on TikTok once). That is "nothing left", not "all planned".
    expect((await call("PATCH", "/api/settings", { weekly_caps: { tiktok: 2, instagram: 1, youtube: 0 } })).status).toBe(200);
    expect((await planAhead(env, { weeks: 2, startWeek: 1, respectHeld: false })).state).toBe("nothing_left");
  });
});

describe("one list, one set of numbers", () => {
  it("every upcoming post of every kind is listed, soonest first, with its words; what cannot go out says why", async () => {
    await seedClips(2);
    await call("POST", "/api/posts/plan", { start_week: 1, weeks: 1 });
    const pack = await readyPack();
    const fb = raw.prepare("SELECT id FROM social_posts WHERE pack_id = ? AND platform = 'facebook' AND item_kind = 'reel'").get(pack) as { id: string };
    raw.prepare("UPDATE social_posts SET status = 'waiting', error = 'connect:facebook' WHERE id = ?").run(fb.id);

    const list = (await call<PostsList>("GET", "/api/posts/upcoming")).json;
    const times = list.posts.map((p) => p.scheduled_at);
    expect(times).toEqual([...times].sort());
    expect(new Set(list.posts.map((p) => p.source))).toEqual(new Set(["clip", "photo"]));
    expect(new Set(list.posts.map((p) => p.kind_label)).has("Reel")).toBe(true);
    expect(list.posts.some((p) => p.kind_label === "Moving photo")).toBe(true);
    const reel = list.posts.find((p) => p.source === "clip")!;
    expect(reel.headline).toMatch(/^Hook \d$/);
    expect(reel.caption_line).toMatch(/^Caption \d$/);
    expect(reel.caption).toMatch(/^Caption \d\nSecond line\n\n#porch #party$/); // the whole caption with its tags
    expect(reel.video_url).toMatch(/^\/media\/tok/);
    const photo = list.posts.find((p) => p.source === "photo")!;
    expect(photo.caption.length).toBeGreaterThan(0);
    expect(photo.thumb_url ?? photo.video_url ?? photo.images[0]).toBeTruthy();
    // No ids, no vendor names in anything she reads.
    for (const p of list.posts) expect(`${p.kind_label} ${p.platform_label} ${p.headline} ${p.edit_note ?? ""} ${p.reason ?? ""}`).not.toMatch(/Buffer|clp_|pst_|spo_|runway/i);

    expect(list.blocked).toHaveLength(1);
    expect(list.blocked[0]).toMatchObject({ key: "connect:facebook", label: "Waiting on Facebook", action: { label: "Connect ›", to: "/settings/connections" } });
    expect(list.blocked[0].posts.map((p) => p.id)).toEqual([fb.id]);
    expect(list.posts.some((p) => p.id === fb.id)).toBe(false);
    expect(list.limits.map((l) => l.label)).toEqual(["TikTok", "Instagram", "YouTube"]);

    // One post opens with everything the sheet shows, either kind.
    expect((await call("GET", `/api/posts/item/${reel.id}`)).json).toMatchObject({ id: reel.id, can: { move: true, swap: true, remove: true } });
    expect((await call("GET", `/api/posts/item/${photo.id}`)).json).toMatchObject({ id: photo.id, can: { move: true, swap: false, remove: true } });
  });

  it("Home, the Calendar and the Settings line read the same numbers, photo posts included", async () => {
    await seedClips(2);
    await call("POST", "/api/posts/plan", { start_week: 1, weeks: 1 }); // 6 reel posts
    await readyPack(); // photo posts on Facebook, Instagram, TikTok
    const photoPosts = (raw.prepare("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'scheduled'").get() as { n: number }).n;
    expect(photoPosts).toBeGreaterThan(0);
    // Two went out this week: one reel, one photo post. One photo post waits on a connection.
    const now = new Date().toISOString();
    const reel = raw.prepare("SELECT id FROM posts LIMIT 1").get() as { id: string };
    raw.prepare("UPDATE posts SET status = 'posted', posted_at = ?, scheduled_at = ? WHERE id = ?").run(now, now, reel.id);
    const [a, b] = raw.prepare("SELECT id FROM social_posts ORDER BY scheduled_at, platform LIMIT 2").all() as { id: string }[];
    raw.prepare("UPDATE social_posts SET status = 'posted', posted_at = ?, scheduled_at = ? WHERE id = ?").run(now, now, a.id);
    raw.prepare("UPDATE social_posts SET status = 'waiting', error = 'connect:facebook' WHERE id = ?").run(b.id);
    const last = (raw.prepare("SELECT MAX(t) AS t FROM (SELECT scheduled_at AS t FROM posts WHERE status = 'planned' UNION ALL SELECT scheduled_at FROM social_posts WHERE status = 'scheduled')").get() as { t: string }).t;
    const expected: PostsSummary = { postedThisWeek: 2, toGo: 5 + photoPosts - 2, plannedThrough: last };

    const home = (await call<{ thisWeek: { posted: number; toGo: number; plannedThrough: string | null } }>("GET", "/api/home")).json.thisWeek;
    const calendar = (await call<PostsList>("GET", "/api/posts/upcoming")).json.summary;
    const settings = (await call<{ summary: PostsSummary }>("GET", "/api/posts/summary")).json.summary;
    expect(calendar).toEqual(expected);
    expect(settings).toEqual(expected);
    expect({ postedThisWeek: home.posted, toGo: home.toGo, plannedThrough: home.plannedThrough }).toEqual(expected);
    // The list itself holds exactly the posts the number counts.
    expect((await call<PostsList>("GET", "/api/posts/upcoming")).json.posts).toHaveLength(expected.toGo);
  });

  it("a photo post moves to another day at the same time; a skipped or sent one does not", async () => {
    await readyPack();
    const p = raw.prepare("SELECT id, platform, scheduled_at FROM social_posts WHERE platform = 'instagram' ORDER BY scheduled_at LIMIT 1").get() as { id: string; platform: string; scheduled_at: string };
    const target = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.parse(p.scheduled_at) + 9 * DAY));
    const moved = await call<{ scheduled_at: string }>("PATCH", `/api/photos/posts/${p.id}/move`, { date: target });
    expect(moved.status).toBe(200);
    expect(Date.parse(moved.json.scheduled_at) - Date.parse(p.scheduled_at)).toBe(9 * DAY);
    expect((await call("PATCH", `/api/photos/posts/${p.id}/move`, { date: "2020-01-01" })).status).toBe(409); // never into the past
    await call("POST", `/api/photos/posts/${p.id}/skip`);
    expect((await call("PATCH", `/api/photos/posts/${p.id}/move`, { date: target })).status).toBe(409);
  });
});

describe("the Rejected bin", () => {
  it("a rejected reel is kept, can never be planned or placed, comes back, and only then can be planned", async () => {
    await seedClips(2);
    await call("POST", "/api/posts/plan", { start_week: 1, weeks: 1 });
    expect((await call("POST", "/api/clips/clp_0/reject", { reason: "bad hook" })).status).toBe(200);
    // Rejecting deletes nothing: the row, the made file and the original are all there.
    expect((raw.prepare("SELECT status FROM clips WHERE id = 'clp_0'").get() as { status: string }).status).toBe("rejected");
    expect(await stored("clips/dmp_t/clp_0.mp4")).toBe(true);
    const bin = (await call<BinList>("GET", "/api/bin")).json;
    expect(bin.items.map((i) => [i.id, i.source, i.kind_label])).toEqual([["clp_0", "clip", "Reel"]]);
    expect((await call<PostsList>("GET", "/api/posts/upcoming")).json.bin).toBe(1);
    // Nothing in the bin is on the calendar, and nothing can put it there.
    expect((raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE clip_id = 'clp_0' AND status IN ('planned','in_buffer','posted')").get() as { n: number }).n).toBe(0);
    expect((await call("POST", "/api/posts", { clip_id: "clp_0", platform: "tiktok", scheduled_at: new Date(Date.now() + 3 * DAY).toISOString() })).status).toBe(409);
    await call("POST", "/api/posts/plan", { start_week: 2, weeks: 3 });
    await planAhead(env, { respectHeld: false });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE clip_id = 'clp_0' AND status != 'unscheduled'").get() as { n: number }).n).toBe(0);
    expect((await call<PostsList>("GET", "/api/posts/upcoming")).json.posts.some((p) => p.ref_id === "clp_0")).toBe(false);

    // Bring back: waiting for review again, out of the bin.
    expect((await call("POST", "/api/bin/clip/clp_0/restore")).status).toBe(200);
    expect((raw.prepare("SELECT status FROM clips WHERE id = 'clp_0'").get() as { status: string }).status).toBe("draft");
    expect((await call<BinList>("GET", "/api/bin")).json.items).toEqual([]);
    expect((await call("POST", "/api/bin/clip/clp_0/restore")).status).toBe(409); // not in the bin any more
  });

  it("the daily job never clears a rejected reel: 30 days on it is still in the bin with its files, and still comes back", async () => {
    await seedClips(1);
    expect((await call("POST", "/api/clips/clp_0/reject", { reason: "bad hook" })).status).toBe(200);
    raw.prepare("UPDATE clips SET reviewed_at = ? WHERE id = 'clp_0'").run(new Date(Date.now() - 30 * DAY).toISOString());
    const before = raw.prepare("SELECT status, r2_key, cover_r2_key, media_token FROM clips WHERE id = 'clp_0'").get();
    await dailyMaintenance(env);
    expect(raw.prepare("SELECT status, r2_key, cover_r2_key, media_token FROM clips WHERE id = 'clp_0'").get()).toEqual(before);
    expect(before).toMatchObject({ status: "rejected", r2_key: "clips/dmp_t/clp_0.mp4", cover_r2_key: "clips/dmp_t/clp_0.jpg" });
    expect(await stored("clips/dmp_t/clp_0.mp4")).toBe(true);
    expect(await stored("clips/dmp_t/clp_0.jpg")).toBe(true);
    expect((await call<BinList>("GET", "/api/bin")).json.items.map((i) => i.id)).toEqual(["clp_0"]);
    expect((await call("POST", "/api/bin/clip/clp_0/restore")).status).toBe(200);
  });

  it("Delete for good removes the made post and its made file, never the original; never a post that is planned or out", async () => {
    await seedClips(3);
    // An approved reel on the calendar is not in the bin: the bin cannot delete it.
    await call("POST", "/api/posts/plan", { start_week: 1, weeks: 1 });
    expect((await call("DELETE", "/api/bin/clip/clp_1")).status).toBe(409);
    expect(await stored("clips/dmp_t/clp_1.mp4")).toBe(true);

    await call("POST", "/api/clips/clp_0/reject", {});
    expect((await call("DELETE", "/api/bin/clip/clp_0")).status).toBe(200);
    expect((raw.prepare("SELECT status, media_token FROM clips WHERE id = 'clp_0'").get() as { status: string; media_token: string | null })).toEqual({ status: "deleted", media_token: null });
    expect(await stored("clips/dmp_t/clp_0.mp4")).toBe(false);
    expect(await stored("clips/dmp_t/clp_0.jpg")).toBe(false);
    expect(await stored("raw/dmp_t/ast_0")).toBe(true); // her original video is kept
    expect((await call("POST", "/api/bin/clip/clp_0/restore")).status).toBe(409); // for good

    // A reel that already went out and was rejected afterwards is kept, by the row and by Empty.
    const out = raw.prepare("SELECT id FROM posts WHERE clip_id = 'clp_2' LIMIT 1").get() as { id: string };
    raw.prepare("UPDATE posts SET status = 'posted', posted_at = ? WHERE id = ?").run(new Date().toISOString(), out.id);
    raw.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = 'clp_2' AND id != ?").run(out.id);
    await call("POST", "/api/clips/clp_2/reject", {});
    await call("POST", "/api/clips/clp_1/reject", {});
    expect((await call("DELETE", "/api/bin/clip/clp_2")).status).toBe(409);
    expect((await call("POST", "/api/bin/empty")).json).toMatchObject({ deleted: 1, kept: 1 });
    expect(await stored("clips/dmp_t/clp_1.mp4")).toBe(false);
    expect(await stored("clips/dmp_t/clp_2.mp4")).toBe(true);
    expect(await stored("raw/dmp_t/ast_1")).toBe(true);
  });

  it("a skipped photo post sits in the bin and never goes out; deleted for good it cannot come back, and her photo is kept", async () => {
    const pack = await readyPack();
    const posts = raw.prepare("SELECT id, platform, item_kind, scheduled_at FROM social_posts WHERE pack_id = ? ORDER BY scheduled_at, platform").all(pack) as { id: string; platform: string; item_kind: string; scheduled_at: string }[];
    const item = raw.prepare("SELECT kind, r2_key, cover_r2_key, images FROM pack_items WHERE pack_id = ? AND kind = ?").get(pack, posts[0].item_kind) as { kind: string; r2_key: string | null; cover_r2_key: string | null; images: string };
    const made = [item.r2_key, item.cover_r2_key, ...(JSON.parse(item.images) as string[])].filter((k): k is string => !!k);
    const same = posts.filter((p) => p.item_kind === posts[0].item_kind);
    for (const p of same) expect((await call("POST", `/api/photos/posts/${p.id}/skip`)).status).toBe(200);
    expect((await call<BinList>("GET", "/api/bin")).json.items.map((i) => i.id).sort()).toEqual(same.map((p) => p.id).sort());

    // Its time comes and goes: nothing in the bin is sent.
    FakeFacebook.posted = [];
    const sent = await photoPostsTick(await hydrate(env), Date.parse(same[0].scheduled_at) + HOUR);
    expect(sent.posted).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM social_posts WHERE id IN (SELECT value FROM json_each(?)) AND status = 'skipped'").get(JSON.stringify(same.map((p) => p.id))) as { n: number }).n).toBe(same.length);

    // Bring one back: it is on the list again. Delete the others for good.
    expect((await call("POST", `/api/bin/photo/${same[0].id}/restore`)).status).toBe(200);
    expect((await call<PostsList>("GET", "/api/posts/upcoming")).json.posts.some((p) => p.id === same[0].id)).toBe(true);
    for (const p of same.slice(1)) expect((await call("DELETE", `/api/bin/photo/${p.id}`)).status).toBe(200);
    // The made piece is still needed by the one she brought back.
    for (const k of made) expect(await stored(k)).toBe(true);
    // A post that is planned again is not in the bin: the bin cannot delete it.
    expect((await call("DELETE", `/api/bin/photo/${same[0].id}`)).status).toBe(409);
    await call("POST", `/api/photos/posts/${same[0].id}/skip`);
    expect((await call("DELETE", `/api/bin/photo/${same[0].id}`)).status).toBe(200);
    // Now no post uses the made piece: it leaves storage. Her own photo stays.
    for (const k of made) expect(await stored(k)).toBe(false);
    expect(await stored(`packs/${pack}/in/pph_0`)).toBe(true);
    // For good: not in the bin, cannot be brought back or un-skipped, never sent, never planned again.
    expect((await call<BinList>("GET", "/api/bin")).json.items).toEqual([]);
    expect((await call("POST", `/api/bin/photo/${same[0].id}/restore`)).status).toBe(409);
    expect((await call("POST", `/api/photos/posts/${same[0].id}/unskip`)).status).toBe(409);
    expect((await call<{ planned: number }>("POST", `/api/photos/packs/${pack}/plan`)).json.planned).toBe(0);
    expect((await photoPostsTick(await hydrate(env), Date.now() + 30 * DAY)).posted).toBe(posts.length - same.length);
  });
});
