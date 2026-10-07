// The full-video door (owner, 26 Sep 2026): "A full video for YouTube". The rules (chapters,
// description, tags, the storage rule, space, one a week) and the whole life on fakes against the
// real schema: Dump → its own job (never the cutter) → one Review item with three thumbnails →
// her edits and privacy → the Calendar (YouTube only, one a week, within the cap) → Buffer with
// her privacy → posted → "Finish in YouTube Studio" → the file removed 7 days later. Also: Buffer
// refuses → "Upload it yourself" and the link she pastes; unapproved → warned, then removed.
// Validator `full-video-uncut` reads the test named "a full-video dump never goes through the cutter".
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import {
  cleanTags,
  composeDescription,
  draftChapters,
  pendingRefusal,
  spaceLine,
  stamp,
  starterDraft,
  storageAction,
  studioLink,
  bufferCanTake,
  R2_FREE_BYTES,
  TAGS_MAX_CHARS,
  type Segment,
} from "@worker/domain/fullVideo";
import { fillWeek } from "@worker/domain/sync";
import { postMetadata, fakePostMetadata, resetFakeBuffer } from "@worker/services/buffer";
import { fullVideoJob, fullClipId, fullVideoKey } from "@worker/jobs/fullvideo";
import { cutJob } from "@worker/jobs/cut";
import { startDumpCut } from "@worker/lib/editorJobs";
import { jobStorageScope } from "@worker/lib/jobStorage";
import { fullVideoCards, fullVideoRetention } from "@worker/lib/fullVideo";
import { planAhead } from "@worker/routes/posts";
import { bufferSync } from "@worker/crons/buffer-sync";
import { saveConnection } from "@worker/lib/connections";
import { setSetting } from "@worker/lib/db";
import { dumps } from "@worker/routes/dumps";
import { clips as clipsRoute } from "@worker/routes/clips";
import { media } from "@worker/routes/media";
import { ownerCookie } from "./helpers/owner-session";

// ---------------------------------------------------------------- the rules

const segs = (n: number, every = 20): Segment[] => Array.from({ length: n }, (_, i) => ({ start: i * every, end: i * every + every - 2, text: `Step ${i + 1}: we set the plates and fold the napkins for brunch.` }));

describe("chapters, description and tags YouTube accepts", () => {
  it("stamps read the way YouTube reads them", () => {
    expect(stamp(0)).toBe("0:00");
    expect(stamp(65)).toBe("1:05");
    expect(stamp(3723)).toBe("1:02:03");
  });
  it("chapters: the first at 0:00, at least three, each at least 10 seconds, none for a short video", () => {
    const ch = draftChapters(segs(40), 800);
    expect(ch[0].t).toBe(0);
    expect(ch.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ch.length; i++) expect(ch[i].t - ch[i - 1].t).toBeGreaterThanOrEqual(10);
    expect(ch.every((c) => c.title.length > 0 && c.title.length <= 60)).toBe(true);
    expect(draftChapters(segs(4), 80)).toEqual([]);
    // the same words over and over (a looped intro, found on the staging proof, 26 Sep 2026): every name still differs
    const looped = Array.from({ length: 12 }, (_, i) => ({ start: i * 17, end: i * 17 + 15, text: "Here is the one thing I always do. Then the plates go down." }));
    const names = draftChapters(looped, 200).map((c) => c.title);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(draftChapters([], 900)).toEqual([]);
  });
  it("the description carries the chapters and at most three hashtags", () => {
    const d = composeDescription("A brunch table for twelve.", [{ t: 0, title: "Linens" }, { t: 60, title: "Plates" }, { t: 130, title: "Candles" }], ["brunch", "table scape", "hosting", "extra"]);
    expect(d).toBe("A brunch table for twelve.\n\nChapters\n0:00 Linens\n1:00 Plates\n2:10 Candles\n\n#brunch #tablescape #hosting");
    expect(composeDescription("x", [{ t: 0, title: "a" }], [])).toBe("x"); // fewer than 3 chapters: YouTube ignores them, so none
  });
  it("tags: cleaned, no duplicates, 500 characters at most", () => {
    expect(cleanTags(["#Brunch", "brunch", " table  scape ", ""])).toEqual(["Brunch", "table scape"]);
    const many = cleanTags(Array.from({ length: 100 }, (_, i) => `tag number ${i} that is long`));
    expect(many.join(",").length).toBeLessThanOrEqual(TAGS_MAX_CHARS);
    expect(cleanTags("a, b, c")).toEqual(["a", "b", "c"]);
  });
  it("a starter draft from her own words when the AI is busy; never empty", () => {
    const s = starterDraft(segs(5), "kitchen_tour.mov");
    expect(s.title.length).toBeGreaterThan(5);
    expect(s.body.length).toBeGreaterThan(10);
    expect(starterDraft([], "kitchen_tour.mov").title).toBe("kitchen tour");
  });
  it("Buffer posts YouTube Shorts only (proven on staging): vertical and 3 minutes or less, else she uploads it", () => {
    expect(bufferCanTake({ width: 1080, height: 1920, duration_s: 180 })).toBe(true);
    expect(bufferCanTake({ width: 1080, height: 1920, duration_s: 181 })).toBe(false);
    expect(bufferCanTake({ width: 1280, height: 720, duration_s: 60 })).toBe(false);
    expect(bufferCanTake({ width: 1080, height: 1080, duration_s: 60 })).toBe(false);
  });
  it("Studio: the video's own edit page when we know its id", () => {
    expect(studioLink("https://www.youtube.com/watch?v=abcdefghijk")).toBe("https://studio.youtube.com/video/abcdefghijk/edit");
    expect(studioLink(null)).toBe("https://studio.youtube.com/");
  });
});

describe("storage: posted 7 days, unapproved 14 days (warned 3 days before), one waiting per week", () => {
  const day = 86400_000;
  const t0 = new Date("2026-10-01T12:00:00Z");
  const at = (d: number) => new Date(t0.getTime() + d * day);
  const base = { status: "draft", created_at: t0.toISOString(), posted_at: null, file_deleted_at: null };
  it("unapproved: kept, warned from day 11, removed on day 14", () => {
    expect(storageAction(base, at(10))).toEqual({ do: "keep" });
    expect(storageAction(base, at(11))).toEqual({ do: "warn", deleteOn: at(14).toISOString() });
    expect(storageAction(base, at(14))).toEqual({ do: "delete", why: "unapproved" });
  });
  it("approved and waiting to post: kept however long", () => {
    expect(storageAction({ ...base, status: "approved" }, at(60))).toEqual({ do: "keep" });
  });
  it("posted: removed 7 days after it posted, not before", () => {
    const posted = { ...base, status: "approved", posted_at: at(20).toISOString() };
    expect(storageAction(posted, at(26))).toEqual({ do: "keep" });
    expect(storageAction(posted, at(27))).toEqual({ do: "delete", why: "posted" });
    expect(storageAction({ ...posted, file_deleted_at: at(27).toISOString() }, at(40))).toEqual({ do: "keep" });
  });
  it("one waiting full video per Calendar week; the space line before Dump", () => {
    expect(pendingRefusal(3, 4)).toBeNull();
    expect(pendingRefusal(4, 4)).toBe("You already have 4 full videos waiting, one for each of the next 4 weeks. Post or delete one first, so they don't fill your storage.");
    expect(spaceLine(1.5 * 1024 ** 3, 4 * 1024 ** 3)).toEqual({ line: "This video: 1.5 GB · free space left: 6.0 GB of 10 GB", fits: true });
    expect(spaceLine(2 * 1024 ** 3, R2_FREE_BYTES - 1024 ** 3).fits).toBe(false);
  });
});

describe("the Calendar: YouTube only, one full video a week, within the cap", () => {
  const monday = "2026-10-05T05:00:00.000Z";
  const next = "2026-10-12T05:00:00.000Z";
  const slots = { tiktok: [{ day: 2, hour: 10, minute: 0 }], instagram: [{ day: 2, hour: 11, minute: 0 }], youtube: [{ day: 2, hour: 12, minute: 0 }, { day: 4, hour: 12, minute: 0 }, { day: 5, hour: 12, minute: 0 }] };
  const clip = (id: string, full = false) => ({ id, asset_id: `a_${id}`, score: 1, door: "new" as const, platforms: full ? (["youtube"] as const).slice() : ["tiktok", "instagram", "youtube"], full });
  it("two full videos: one this week, the other waits; clips still fill the other slots", () => {
    const out = fillWeek({ clips: [clip("f1", true), clip("f2", true), clip("c1")] as never, existing: [], weekStart: monday, weekEnd: next, timeZone: "America/Chicago", caps: { tiktok: 10, instagram: 10, youtube: 10 }, slots, now: "2026-10-01T00:00:00Z" });
    const full = out.filter((p) => p.clip_id.startsWith("f"));
    expect(full).toHaveLength(1);
    expect(full[0].platform).toBe("youtube");
    expect(out.some((p) => p.clip_id === "c1" && p.platform === "tiktok")).toBe(true);
  });
  it("a full video already on the Calendar this week blocks another", () => {
    const out = fillWeek({ clips: [clip("f2", true)] as never, existing: [{ id: "p", clip_id: "f1", platform: "youtube", scheduled_at: "2026-10-06T17:00:00.000Z", status: "planned" }], weekStart: monday, weekEnd: next, timeZone: "America/Chicago", caps: { tiktok: 10, instagram: 10, youtube: 10 }, slots, now: "2026-10-01T00:00:00Z", fullClipIds: new Set(["f1", "f2"]) });
    expect(out).toEqual([]);
  });
  it("her privacy goes to YouTube (Buffer's YoutubePrivacy); notify subscribers only when public", () => {
    expect(postMetadata("youtube", "T", false, "unlisted")).toMatchObject({ youtube: { privacy: "unlisted", notifySubscribers: false } });
    expect(postMetadata("youtube", "T", false, "private")).toMatchObject({ youtube: { privacy: "private" } });
    expect(postMetadata("youtube", "T")).toMatchObject({ youtube: { privacy: "public", notifySubscribers: true } });
  });
});

// ---------------------------------------------------------------- the whole life, on fakes

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/dumps", dumps);
app.route("/api/clips", clipsRoute);
app.route("/media", media);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as T[];
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${path}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

async function dumpWith(files: number, size = 5_000): Promise<string> {
  const r = await call("POST", "/api/dumps", { door: "youtube", notes: "" });
  const id = r.json.id as string;
  for (let i = 0; i < files; i++) {
    db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES (?, ?, 'kitchen_tour.mov', 'video/quicktime', ?, ?, 'uploaded')").run(`ast_${id}_${i}`, id, size, `raw/${id}/ast_${i}`);
    await r2.FILES.put(`raw/${id}/ast_${i}`, new Uint8Array(size).fill(1), { httpMetadata: { contentType: "video/quicktime" } });
  }
  return id;
}
const jobsOf = (ref: string) => all<{ id: string; type: string }>("SELECT id, type FROM jobs WHERE ref_id = ?", ref);
async function runFull(dumpId: string) {
  const job = jobsOf(dumpId).find((j) => j.type === "fullvideo")!;
  await fullVideoJob.applyResult(env, job.id, dumpId, await fullVideoJob.fakeRun!(env, job.id, dumpId, {}));
}
type View = { id: string; status: string; media_url: string; platforms: string[]; full_video: { title: string; description: string; chapters: { t: number }[]; tags: string[]; thumbnails: { url: string }[]; thumb_pick: number; privacy: string; handoff: boolean; post: { status: string; url: string | null } | null } | null };
/** Make the drafted video vertical and short (a full video Buffer can post), as the job would have measured it. */
function makeVertical(clipId: string, seconds = 150) {
  const d = JSON.parse(one<{ youtube: string }>("SELECT youtube FROM clips WHERE id = ?", clipId).youtube);
  Object.assign(d, { width: 1080, height: 1920, duration_s: seconds, handoff: false });
  db.raw.prepare("UPDATE clips SET youtube = ?, end_s = ? WHERE id = ?").run(JSON.stringify(d), seconds, clipId);
}
async function reviewItem(dumpId: string, tab = "new"): Promise<View> {
  const list = await call("GET", `/api/clips?tab=${tab}&hidden=1`);
  return (list.json.groups as { dump: { id: string; door: string }; clips: View[] }[]).find((g) => g.dump.id === dumpId)!.clips[0];
}

beforeEach(async () => {
  db = sqliteD1();
  r2 = memoryR2();
  resetFakeBuffer();
  env = {
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
  } as unknown as Env;
  db.raw.exec(`INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"x","ctas":"Subscribe"}', 1, '2026-09-25T00:00:00Z', 'edited');
    INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`);
});

describe("Dump → its own job → one Review item", () => {
  it("a full-video dump never goes through the cutter (validator)", async () => {
    const id = await dumpWith(1);
    expect(one<{ door: string; kind: string }>("SELECT door, kind FROM dumps WHERE id = ?", id)).toEqual({ door: "new", kind: "full_video" });
    const sent = await call("POST", `/api/dumps/${id}/dump`);
    expect(sent.status).toBe(200);
    expect(jobsOf(id).map((j) => j.type)).toEqual(["fullvideo"]);
    // every other road to the cutter refuses it too
    await expect(cutJob.buildSpec(env, "job_x", id)).rejects.toThrow("a full video is never cut");
    expect(await startDumpCut(env, id, BASE_URL)).toMatchObject({ dispatched: false });
    expect(jobsOf(id).map((j) => j.type)).toEqual(["fullvideo"]);
    // the job may write only its own full/<dump>/ folder
    const scope = jobStorageScope("fullvideo", "job_1", id);
    expect(scope.write).toEqual(["jobs/job_1/", `full/${id}/`]);
    expect(scope.read).toEqual(["jobs/job_1/", `raw/${id}/`]);
  });

  it("one video only; the space line; one waiting per week", async () => {
    const two = await dumpWith(2);
    const r = await call("POST", `/api/dumps/${two}/dump`);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("A full video for YouTube is one video. Remove the others, or dump them as new videos.");
    const id = await dumpWith(1, 3_000);
    const s = await call("GET", `/api/dumps/${id}/space`);
    expect(s.json).toMatchObject({ upload_bytes: 3_000, fits: true, line: expect.stringMatching(/^This video: 1 MB · free space left: 10\.0 GB of 10 GB$/) });
    for (let i = 0; i < 4; i++) db.raw.prepare("INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, status, full_video, platforms) VALUES (?, ?, ?, 0, 600, 'story', 'k', 'approved', 1, '[\"youtube\"]')").run(`clp_wait${i}aaaa`, `ast_${id}_0`, id);
    const refused = await call("POST", `/api/dumps/${id}/dump`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/^You already have 4 full videos waiting/);
  });

  it("the job's result: one item, YouTube only, title, description with chapters, tags, three thumbnails; the upload is removed", async () => {
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id);
    const row = one<{ id: string; full_video: number; platforms: string; r2_key: string; status: string }>("SELECT id, full_video, platforms, r2_key, status FROM clips WHERE dump_id = ?", id);
    expect(row).toMatchObject({ id: fullClipId(id), full_video: 1, platforms: '["youtube"]', r2_key: fullVideoKey(id, fullClipId(id)), status: "draft" });
    expect(await r2.FILES.head(`raw/${id}/ast_0`)).toBeNull(); // stored once
    expect(one<{ status: string; clips_made: number }>("SELECT status, clips_made FROM dumps WHERE id = ?", id)).toEqual({ status: "ready", clips_made: 1 });
    const v = await reviewItem(id);
    expect(v.platforms).toEqual(["youtube"]);
    expect(v.full_video!.chapters.length).toBeGreaterThanOrEqual(3);
    expect(v.full_video!.description.length).toBeGreaterThan(10);
    expect(v.full_video!.thumbnails).toHaveLength(3);
    expect(v.full_video!.privacy).toBe("public");
    for (const t of v.full_video!.thumbnails) expect((await app.request(`${BASE_URL}${t.url}`, {}, env)).headers.get("content-type")).toBe("image/jpeg");
    const list = await call("GET", "/api/clips?tab=new&hidden=1");
    expect((list.json.groups as { dump: { id: string; door: string } }[]).find((g) => g.dump.id === id)!.dump.door).toBe("youtube");
  });

  it("Review: her edits, thumbnail and privacy; the cut-only actions refuse in plain words", async () => {
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id);
    const cid = fullClipId(id);
    const e = await call("PATCH", `/api/clips/${cid}/youtube`, { title: "  Brunch for twelve  ", description: "My table.", tags: "brunch, hosting", thumb_pick: 2, privacy: "unlisted" });
    expect(e.status).toBe(200);
    const v = (e.json as unknown as View).full_video!;
    expect(v).toMatchObject({ title: "Brunch for twelve", tags: ["brunch", "hosting"], thumb_pick: 2, privacy: "unlisted" });
    expect(one<{ hook_text: string; caption: string }>("SELECT hook_text, caption FROM clips WHERE id = ?", cid)).toMatchObject({ hook_text: "Brunch for twelve", caption: expect.stringMatching(/^My table\.\n\nChapters\n0:00 /) });
    expect((await call("PATCH", `/api/clips/${cid}/youtube`, { privacy: "friends" })).status).toBe(422);
    expect((await call("PATCH", `/api/clips/${cid}/youtube`, { thumb_pick: 3 })).status).toBe(422);
    for (const path of ["look", "music", "another", "voice-over", "voice-over/draft"]) {
      const r = await call("POST", `/api/clips/${cid}/${path}`, { look: "cinematic", music: "none", script: "hello there friends" });
      expect(r.status, path).toBe(409);
      expect(r.json.error).toMatch(/^This is your full video for YouTube: it goes up whole/);
    }
  });
});

describe("Calendar → Buffer → posted → Finish in YouTube Studio → the file goes after 7 days", () => {
  it("landscape or over 3 minutes: never sent to Buffer; Upload it yourself on its day; the link she pastes marks it posted", async () => {
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id); // the fake job's video is 1920x1080, 10 minutes
    const cid = fullClipId(id);
    expect((await reviewItem(id)).full_video!.handoff).toBe(true);
    expect(await fullVideoCards(env)).toEqual([]); // nothing asked of her before she approves
    await call("POST", `/api/clips/${cid}/approve`);
    await planAhead(env, { respectHeld: true });
    db.raw.prepare("UPDATE posts SET scheduled_at = ? WHERE clip_id = ?").run(new Date(Date.now() + 3600_000).toISOString(), cid);
    await saveConnection(env, "buffer", "good-key-000000", "ok", {});
    await bufferSync(env, { force: true });
    expect(one<{ status: string; buffer_post_id: string | null; retries: number }>("SELECT status, buffer_post_id, retries FROM posts WHERE clip_id = ?", cid)).toEqual({ status: "planned", buffer_post_id: null, retries: 0 });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent WHERE kind = 'posting_problem'").n).toBe(0);
    const tok = one<{ media_token: string }>("SELECT media_token FROM clips WHERE id = ?", cid).media_token;
    expect(await fullVideoCards(env)).toEqual([expect.objectContaining({ kind: "upload_yourself", download_url: `/media/${tok}?download=1`, studio_url: "https://www.youtube.com/upload" })]);
    const dl = await app.request(`${BASE_URL}/media/${tok}?download=1`, {}, env);
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="studio-youtube.mp4"');
    const ok = await call("POST", `/api/clips/${cid}/youtube/posted`, { url: "https://youtu.be/abcdefghijk" });
    expect(ok.json).toMatchObject({ ok: true, url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(one<{ status: string }>("SELECT status FROM posts WHERE clip_id = ?", cid).status).toBe("posted");
  });

  it("vertical and 3 minutes or less: the whole way through Buffer, with her privacy", async () => {
    await setSetting(env.DB, "features", { voice: false, deeper_research: false, weekly_recap: true, help_ask: false });
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id);
    const cid = fullClipId(id);
    makeVertical(cid);
    await call("PATCH", `/api/clips/${cid}/youtube`, { privacy: "private" });
    expect((await call("POST", `/api/clips/${cid}/approve`)).status).toBe(200);
    await planAhead(env, { respectHeld: true });
    const posts = all<{ id: string; platform: string }>("SELECT id, platform FROM posts WHERE clip_id = ?", cid);
    expect(posts.map((p) => p.platform)).toEqual(["youtube"]);
    // due soon, so the hourly lane loads it into Buffer
    db.raw.prepare("UPDATE posts SET scheduled_at = ? WHERE clip_id = ?").run(new Date(Date.now() + 3600_000).toISOString(), cid);
    await saveConnection(env, "buffer", "good-key-000000", "ok", {});
    await bufferSync(env, { force: true });
    const p = one<{ status: string; buffer_post_id: string }>("SELECT status, buffer_post_id FROM posts WHERE clip_id = ?", cid);
    expect(p.status).toBe("in_buffer");
    expect(fakePostMetadata(p.buffer_post_id)).toMatchObject({ youtube: { privacy: "private", title: expect.any(String) } });

    // posted: Home asks her to finish it in YouTube Studio (thumbnail + tags)
    const postedAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    db.raw.prepare("UPDATE posts SET status = 'posted', url = 'https://www.youtube.com/watch?v=abcdefghijk', posted_at = ? WHERE clip_id = ?").run(postedAt, cid);
    const cards = await fullVideoCards(env);
    expect(cards).toEqual([expect.objectContaining({ kind: "finish_in_studio", clip_id: cid, studio_url: "https://studio.youtube.com/video/abcdefghijk/edit", thumbnail_url: expect.stringMatching(/\?thumb=1&download=1$/) })]);
    expect((await call("POST", `/api/clips/${cid}/youtube/studio-done`)).status).toBe(200);
    expect(await fullVideoCards(env)).toEqual([]);

    // 8 days after it posted: the file goes, the thumbnail and words stay
    expect(await fullVideoRetention(env)).toEqual({ deleted: 1 });
    expect(await r2.FILES.head(fullVideoKey(id, cid))).toBeNull();
    expect(one<{ status: string; file_deleted_at: string | null }>("SELECT status, file_deleted_at FROM clips WHERE id = ?", cid)).toMatchObject({ status: "approved", file_deleted_at: expect.any(String) });
    const v = await reviewItem(id, "approved");
    expect(v.full_video!.thumbnails).toHaveLength(3);
    const tok = v.media_url.split("/media/")[1].split("?")[0];
    expect((await app.request(`${BASE_URL}/media/${tok}`, {}, env)).status).toBe(410);
    expect((await app.request(`${BASE_URL}/media/${tok}?thumb=1`, {}, env)).status).toBe(200);
  });

  it("a vertical one Buffer still refuses: Upload it yourself; the link she pastes marks it posted", async () => {
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id);
    const cid = fullClipId(id);
    makeVertical(cid);
    await call("POST", `/api/clips/${cid}/approve`);
    await planAhead(env, { respectHeld: true });
    // the fake Buffer refuses a media link with "reject" in it, like a too-long video
    db.raw.prepare("UPDATE clips SET media_token = 'rejectrejectrejectrejectrejectreject' WHERE id = ?").run(cid);
    db.raw.prepare("UPDATE posts SET scheduled_at = ?, retries = 2 WHERE clip_id = ?").run(new Date(Date.now() + 3600_000).toISOString(), cid);
    await saveConnection(env, "buffer", "good-key-000000", "ok", {});
    await bufferSync(env, { force: true });
    expect(one<{ status: string }>("SELECT status FROM posts WHERE clip_id = ?", cid).status).toBe("failed");
    expect((await reviewItem(id, "approved")).full_video!.handoff).toBe(true);
    expect(await fullVideoCards(env)).toEqual([expect.objectContaining({ kind: "upload_yourself", download_url: "/media/rejectrejectrejectrejectrejectreject?download=1", studio_url: "https://www.youtube.com/upload" })]);
    expect((await call("POST", `/api/clips/${cid}/youtube/posted`, { url: "not a link" })).status).toBe(422);
    const ok = await call("POST", `/api/clips/${cid}/youtube/posted`, { url: "https://youtu.be/abcdefghijk" });
    expect(ok.json).toMatchObject({ ok: true, url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(one<{ status: string; url: string }>("SELECT status, url FROM posts WHERE clip_id = ?", cid)).toEqual({ status: "posted", url: "https://www.youtube.com/watch?v=abcdefghijk" });
  });

  it("never approved: warned on Home 3 days before, removed after 14 days", async () => {
    const id = await dumpWith(1);
    await call("POST", `/api/dumps/${id}/dump`);
    await runFull(id);
    const cid = fullClipId(id);
    db.raw.prepare("UPDATE clips SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 12 * 86400_000).toISOString(), cid);
    expect(await fullVideoCards(env)).toEqual([expect.objectContaining({ kind: "removal_soon", clip_id: cid, delete_on: expect.any(String) })]);
    expect(await fullVideoRetention(env)).toEqual({ deleted: 0 });
    db.raw.prepare("UPDATE clips SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 15 * 86400_000).toISOString(), cid);
    expect(await fullVideoRetention(env)).toEqual({ deleted: 1 });
    expect(one<{ status: string }>("SELECT status FROM clips WHERE id = ?", cid).status).toBe("deleted");
  });
});
