// Full videos straight to her own YouTube channel (owner decision, 26 Sep 2026). The pure rules,
// then the whole life on the real schema with the stand-in YouTube answering YouTube's real error
// bodies (shared/youtube-errors.json): upload → read back, Calendar move → publishAt, taken off →
// private and kept, 3 a day, quota, revoked sign-in, refused publish time, unverified thumbnail,
// kept private, an interrupted upload; the job's token endpoint; validator youtube-direct negatively.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { capNote, classifyError, intentFor, nextQuotaReset, quotaDay, reconcile, statusPart, verifyReadBack, YT_UPLOADS_PER_DAY, REMOVED_INTENT } from "@worker/domain/youtubeDirect";
import { reasonOf, readFake, writeFake, type FakeScenario } from "@worker/services/youtubeDirect";
import { buildUploadSpec, youtubeDirectSync } from "@worker/lib/youtubeDirect";
import { ytUploadJob } from "@worker/jobs/ytupload";
import { saveConnection } from "@worker/lib/connections";
import { fullVideoCards } from "@worker/lib/fullVideo";
import { jobStorageScope } from "@worker/lib/jobStorage";
import { posts as postsRoute } from "@worker/routes/posts";
import { clips as clipsRoute } from "@worker/routes/clips";
import { jobs as jobsRoute } from "@worker/routes/jobs";
import { hmacHex } from "@worker/lib/crypto";
import errors from "@shared/youtube-errors.json";
// @ts-expect-error plain .mjs validator, no types
import youtubeDirect, { checkYouTubeDirect } from "../../scripts/validators/youtube-direct.mjs";
import { ownerCookie } from "./helpers/owner-session";

const root = path.resolve(__dirname, "../..");
const NOW = new Date("2026-09-26T15:00:00Z");
const H = 3600_000;

describe("rules", () => {
  it("Public 15+ minutes ahead → private now, public at the slot; else public now; Unlisted/Private set directly", () => {
    const slot = new Date(NOW.getTime() + 2 * H).toISOString();
    expect(intentFor("public", slot, NOW)).toEqual({ privacyStatus: "private", publishAt: "2026-09-26T17:00:00.000Z" });
    expect(intentFor("public", new Date(NOW.getTime() + 14 * 60_000).toISOString(), NOW)).toEqual({ privacyStatus: "public", publishAt: null });
    expect(intentFor("public", new Date(NOW.getTime() - H).toISOString(), NOW)).toEqual({ privacyStatus: "public", publishAt: null });
    expect(intentFor("unlisted", slot, NOW)).toEqual({ privacyStatus: "unlisted", publishAt: null });
    expect(intentFor("private", slot, NOW)).toEqual({ privacyStatus: "private", publishAt: null });
  });

  it("the status part: madeForKids false, synthetic media only with an automatic voice over, publishAt only when set", () => {
    expect(statusPart({ privacyStatus: "private", publishAt: "2026-10-01T00:00:00.000Z" }, true)).toEqual({ privacyStatus: "private", publishAt: "2026-10-01T00:00:00.000Z", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
    expect(statusPart({ privacyStatus: "unlisted", publishAt: null }, false)).toEqual({ privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
  });

  it("every real failure body is named (the same file the job's tests read)", () => {
    for (const [name, f] of Object.entries(errors)) {
      if (name.startsWith("_")) continue;
      const fx = f as { http: number; body: unknown; kind: string; thumbnail?: boolean };
      expect(classifyError(fx.http, reasonOf(fx.body), { thumbnail: !!fx.thumbnail }), name).toBe(fx.kind);
    }
  });

  it("read-back: a match, a lost publish time, kept private, missing, rejected", () => {
    const sched = { privacyStatus: "private" as const, publishAt: "2026-10-01T00:00:00.000Z" };
    expect(verifyReadBack(sched, { privacyStatus: "private", publishAt: "2026-10-01T00:00:00Z" })).toEqual({ ok: true });
    expect(verifyReadBack(sched, { privacyStatus: "private", publishAt: null })).toMatchObject({ ok: false, why: "publish_at", guide: "move-or-remove-a-post" });
    expect(verifyReadBack({ privacyStatus: "public", publishAt: null }, { privacyStatus: "private", publishAt: null })).toMatchObject({ ok: false, why: "kept_private", guide: "upload-it-yourself" });
    expect(verifyReadBack(sched, null)).toMatchObject({ ok: false, why: "missing" });
    expect(verifyReadBack(sched, { privacyStatus: "private", publishAt: null, uploadStatus: "rejected", rejectionReason: "duplicate" })).toMatchObject({ ok: false, why: "rejected" });
  });

  it("the quota day is Pacific, and the next reset is its midnight (DST-safe)", () => {
    expect(quotaDay(new Date("2026-09-27T06:59:00Z"))).toBe("2026-09-26");
    expect(nextQuotaReset(new Date("2026-09-26T15:00:00Z"))).toBe("2026-09-27T07:00:00.000Z");
    expect(nextQuotaReset(new Date("2026-12-01T12:00:00Z"))).toBe("2026-12-02T08:00:00.000Z");
    expect(capNote(YT_UPLOADS_PER_DAY - 1)).toBeNull();
    expect(capNote(YT_UPLOADS_PER_DAY)).toMatch(/3 full videos a day/);
  });

  it("reconcile: moved → update, off the Calendar → private, back on → its time again, done → nothing", () => {
    const base = { status: "scheduled" as const, video_id: "AbCdEfGhIjK", privacy: "public" as const, intended: { privacyStatus: "private" as const, publishAt: "2026-09-27T00:00:00.000Z" }, posted: false };
    expect(reconcile({ ...base, post: { scheduled_at: "2026-09-27T00:00:00.000Z" } }, NOW)).toEqual({ do: "none" });
    expect(reconcile({ ...base, post: { scheduled_at: "2026-09-28T00:00:00.000Z" } }, NOW)).toEqual({ do: "update", intent: { privacyStatus: "private", publishAt: "2026-09-28T00:00:00.000Z" } });
    expect(reconcile({ ...base, post: null }, NOW)).toEqual({ do: "update", intent: REMOVED_INTENT });
    expect(reconcile({ ...base, status: "removed", intended: REMOVED_INTENT, post: null }, NOW)).toEqual({ do: "none" });
    expect(reconcile({ ...base, status: "removed", intended: REMOVED_INTENT, post: { scheduled_at: "2026-09-29T00:00:00.000Z" } }, NOW)).toMatchObject({ do: "update" });
    expect(reconcile({ ...base, post: { scheduled_at: "2026-09-26T14:00:00.000Z" }, intended: { privacyStatus: "private", publishAt: "2026-09-26T14:00:00.000Z" } }, NOW)).toEqual({ do: "read_back" });
    expect(reconcile({ ...base, posted: true, post: null }, NOW)).toEqual({ do: "none" });
  });
});

// ---------------------------------------------------------------- the whole life on fakes

const BASE_URL = "http://w.example";
const SECRET = "job-secret-for-tests";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("/api/posts/*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.use("/api/clips/*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/posts", postsRoute);
app.route("/api/clips", clipsRoute);
app.route("/api/jobs", jobsRoute);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
const call = async (method: string, p: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

let n = 0;
/** One approved full video on the Calendar `hoursAhead` from now, with her privacy. */
function seedVideo(privacy: "public" | "unlisted" | "private", hoursAhead: number): { dump: string; clip: string; post: string } {
  n++;
  const dump = `dmp_t${n}aaaa`;
  const clip = `clp_t${n}aaaaaafv`;
  const post = `pst_t${n}`;
  db.raw.prepare("INSERT INTO dumps (id, door, status, kind) VALUES (?, 'new', 'ready', 'full_video')").run(dump);
  db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES (?, ?, 'v.mp4', 'video/mp4', 10, ?, 'uploaded')").run(`ast_${n}`, dump, `raw/${dump}/a`);
  const details = { title: `TEST ${n}`, description: "My table.", chapters: [], tags: ["brunch"], thumbnails: [{ key: `full/${dump}/${clip}-t1.jpg`, t: 1 }], thumb_pick: 0, privacy, width: 1920, height: 1080, duration_s: 200, size_bytes: 10, studio_done_at: null, handoff: true };
  db.raw.prepare("INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, r2_key, status, full_video, platforms, youtube) VALUES (?, ?, ?, 0, 200, 'story', ?, '', ?, 'approved', 1, '[\"youtube\"]', ?)").run(clip, `ast_${n}`, dump, details.title, `full/${dump}/${clip}.mp4`, JSON.stringify(details));
  db.raw.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES (?, ?, 'youtube', ?, 'planned')").run(post, clip, new Date(Date.now() + hoursAhead * H).toISOString());
  return { dump, clip, post };
}

async function connect() {
  await saveConnection(env, "youtube", JSON.stringify({ access_token: "fake-youtube-token", refresh_token: "fake-refresh", expires_at: new Date(Date.now() + H).toISOString(), account_id: "UCx" }), "ok", { account: "Sample Creator", scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"] });
}
async function scenario(s: FakeScenario) {
  const f = await readFake(env);
  await writeFake(env, { ...f, scenario: s });
}
const upload = (clip: string) => one<{ status: string; video_id: string | null; privacy: string | null; publish_at: string | null; reason: string | null; note: string | null; thumbnail: string | null; not_before: string | null; job_id: string | null }>("SELECT * FROM youtube_uploads WHERE clip_id = ?", clip);
const light = () => one<{ light: string; note: string; fix_guide: string | null }>("SELECT light, note, fix_guide FROM health WHERE name = 'YouTube (full videos)'");

/** The dispatched ytupload job for a clip, run by the fake and answered as the real job would. */
async function runJob(v: { dump: string; clip: string }) {
  const job = upload(v.clip).job_id!;
  const ref = `${v.dump}/${v.clip}`;
  await ytUploadJob.applyResult(env, job, ref, await ytUploadJob.fakeRun!(env, job, ref, {}));
}

beforeEach(() => {
  db = sqliteD1();
  env = {
    DB: db.DB,
    FILES: memoryR2().FILES,
    OWNER_EMAIL: "owner@example.com",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    JOB_SHARED_SECRET: SECRET,
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
    AUDIENCE_TIMEZONE: "America/New_York",
  } as unknown as Env;
});

describe("upload → read back → follow the Calendar", () => {
  it("not connected: nothing happens here (the older path keeps working)", async () => {
    seedVideo("public", 2);
    expect(await youtubeDirectSync(env)).toEqual({ dispatched: 0, waiting: 0, reconciled: 0 });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM youtube_uploads").n).toBe(0);
  });

  it("Public, 2 hours ahead: uploaded private with publishAt, verified; no Studio or Upload-it-yourself card", async () => {
    await connect();
    const v = seedVideo("public", 2);
    expect((await youtubeDirectSync(env)).dispatched).toBe(1);
    const spec = await buildUploadSpec(env, upload(v.clip).job_id!, `${v.dump}/${v.clip}`);
    expect(JSON.stringify(spec)).not.toMatch(/token|refresh/i);
    expect(spec.metadata.status).toMatchObject({ privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    expect(spec.metadata.snippet).toMatchObject({ title: `TEST ${n}`, categoryId: "26", tags: ["brunch"] });
    expect(jobStorageScope("ytupload", "job_1", `${v.dump}/${v.clip}`)).toEqual({ read: ["jobs/job_1/", `full/${v.dump}/`], write: ["jobs/job_1/"] });
    await runJob(v);
    const u = upload(v.clip);
    expect(u).toMatchObject({ status: "scheduled", privacy: "private", thumbnail: "set" });
    expect(Date.parse(u.publish_at!)).toBeGreaterThan(Date.now());
    expect((await readFake(env)).videos[u.video_id!]).toMatchObject({ privacyStatus: "private", publishAt: u.publish_at });
    expect(one<{ status: string }>("SELECT status FROM posts WHERE id = ?", v.post).status).toBe("planned");
    // what videos.list answered is kept exactly (status fields only)
    expect(JSON.parse(one<{ detail: string }>("SELECT detail FROM events WHERE kind = 'ytdirect.readback' AND ref_id = ?", v.clip).detail)).toEqual({ video_id: u.video_id, found: true, privacyStatus: "private", publishAt: u.publish_at, uploadStatus: "uploaded", failureReason: null, rejectionReason: null });
    expect(await fullVideoCards(env)).toEqual([]);
    expect(light().light).toBe("green");
    // her words live on YouTube now: edits refuse with where to change them
    expect((await call("PATCH", `/api/clips/${v.clip}/youtube`, { title: "New" })).status).toBe(409);
  });

  it("moved on the Calendar → publishAt moves; taken off → private and kept; back on → scheduled again", async () => {
    await connect();
    const v = seedVideo("public", 3);
    await youtubeDirectSync(env);
    await runJob(v);
    const id = upload(v.clip).video_id!;
    const later = new Date(Date.now() + 26 * H).toISOString();
    expect((await call("PATCH", `/api/posts/${v.post}`, { scheduled_at: later })).status).toBe(200);
    expect((await readFake(env)).videos[id].publishAt).toBe(new Date(Math.floor(Date.parse(later) / 1000) * 1000).toISOString());
    expect(upload(v.clip).status).toBe("scheduled");
    // checked against videos.update's own answer; no videos.list right after (it lags an update)
    expect((await readFake(env)).calls.slice(-1)).toEqual(["videos.update"]);
    expect(JSON.parse(one<{ detail: string }>("SELECT detail FROM events WHERE kind = 'ytdirect.update_answer' ORDER BY rowid DESC LIMIT 1").detail)).toMatchObject({ video_id: id, privacyStatus: "private" });
    expect((await call("POST", `/api/posts/${v.post}/unschedule`)).status).toBe(200);
    expect((await readFake(env)).videos[id]).toMatchObject({ privacyStatus: "private", publishAt: null });
    expect(upload(v.clip)).toMatchObject({ status: "removed", privacy: "private", publish_at: null });
    // the take-off is confirmed with videos.list once YouTube caught up (the next sync, 2+ minutes on)
    expect(one<{ verified_at: string | null }>("SELECT verified_at FROM youtube_uploads WHERE clip_id = ?", v.clip).verified_at).toBeNull();
    db.raw.prepare("UPDATE youtube_uploads SET updated_at = ? WHERE clip_id = ?").run(new Date(Date.now() - 3 * 60_000).toISOString(), v.clip);
    await youtubeDirectSync(env);
    expect(one<{ status: string; verified_at: string | null }>("SELECT status, verified_at FROM youtube_uploads WHERE clip_id = ?", v.clip)).toMatchObject({ status: "removed", verified_at: expect.any(String) });
    const reads = db.raw.prepare("SELECT detail FROM events WHERE kind = 'ytdirect.readback' AND ref_id = ? ORDER BY rowid").all(v.clip) as { detail: string }[];
    expect(JSON.parse(reads[reads.length - 1].detail)).toMatchObject({ video_id: id, privacyStatus: "private", publishAt: null });
    expect(one<{ actual_privacy: string; actual_publish_at: string | null }>("SELECT actual_privacy, actual_publish_at FROM youtube_uploads WHERE clip_id = ?", v.clip)).toEqual({ actual_privacy: "private", actual_publish_at: null });
    expect(one<{ status: string }>("SELECT status FROM posts WHERE id = ?", v.post).status).toBe("unscheduled");
    expect((await readFake(env)).calls).not.toContain("videos.delete");
    // put back through the Calendar: its time again on YouTube at once, read back
    expect((await call("POST", "/api/posts", { clip_id: v.clip, platform: "youtube", scheduled_at: later })).status).toBe(200);
    expect(upload(v.clip).status).toBe("scheduled");
    expect((await readFake(env)).videos[id]).toMatchObject({ privacyStatus: "private", publishAt: new Date(Math.floor(Date.parse(later) / 1000) * 1000).toISOString() });
    expect((await readFake(env)).calls.filter((c) => c === "videos.insert")).toHaveLength(1); // never a second upload
  });

  it("its time comes → read back public → the post is Posted with its link", async () => {
    await connect();
    const v = seedVideo("public", 1);
    await youtubeDirectSync(env);
    await runJob(v);
    const f = await readFake(env);
    const id = upload(v.clip).video_id!;
    f.videos[id].publishAt = new Date(Date.now() - 60_000).toISOString();
    await writeFake(env, f);
    db.raw.prepare("UPDATE youtube_uploads SET publish_at = ? WHERE clip_id = ?").run(f.videos[id].publishAt, v.clip);
    db.raw.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(f.videos[id].publishAt, v.post);
    await youtubeDirectSync(env);
    expect(upload(v.clip)).toMatchObject({ status: "live", privacy: "public" });
    expect(one<{ status: string; url: string }>("SELECT status, url FROM posts WHERE id = ?", v.post)).toEqual({ status: "posted", url: `https://www.youtube.com/watch?v=${id}` });
  });

  it("Private or Unlisted: set directly, no publishAt, the post is done", async () => {
    await connect();
    const v = seedVideo("private", 2);
    await youtubeDirectSync(env);
    await runJob(v);
    const u = upload(v.clip);
    expect(u).toMatchObject({ status: "live", privacy: "private", publish_at: null });
    expect((await readFake(env)).videos[u.video_id!]).toMatchObject({ privacyStatus: "private", publishAt: null });
    expect(one<{ status: string }>("SELECT status FROM posts WHERE id = ?", v.post).status).toBe("posted");
  });

  it("3 a day: the fourth waits with a plain note; only within the 7-day window", async () => {
    await connect();
    const vs = [1, 2, 3, 4].map((h) => seedVideo("public", h));
    const far = seedVideo("public", 24 * 9);
    const r = await youtubeDirectSync(env);
    expect(r).toMatchObject({ dispatched: 3, waiting: 1 });
    expect(upload(vs[3].clip)).toMatchObject({ status: "queued", reason: "cap", note: expect.stringMatching(/3 full videos a day/) });
    expect(upload(far.clip)).toBeUndefined();
    expect((await fullVideoCards(env)).map((c) => c.kind)).toEqual(["youtube_note"]);
  });
});

describe("the failure shapes: named, lit, never silent", () => {
  it("quota exceeded → waits for tomorrow's allowance (yellow)", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await scenario("quota");
    await youtubeDirectSync(env);
    await runJob(v);
    const u = upload(v.clip);
    expect(u).toMatchObject({ status: "queued", reason: "quota", job_id: null });
    expect(Date.parse(u.not_before!)).toBeGreaterThan(Date.now());
    expect(light()).toMatchObject({ light: "yellow", note: expect.stringMatching(/allowance for today is used up/) });
  });

  it("sign-in revoked → red light, Reconnect YouTube, the video falls back to Upload it yourself; reconnect → it goes again", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await scenario("revoked");
    await youtubeDirectSync(env);
    await runJob(v);
    expect(upload(v.clip)).toMatchObject({ status: "failed", reason: "revoked" });
    expect(one<{ status: string }>("SELECT status FROM connections WHERE service = 'youtube'").status).toBe("error");
    expect(light()).toMatchObject({ light: "red", fix_guide: "reconnect-youtube" });
    expect((await fullVideoCards(env)).map((c) => c.kind)).toEqual(["upload_yourself"]);
    await scenario("ok");
    await connect();
    expect((await youtubeDirectSync(env)).dispatched).toBe(1);
    await runJob(v);
    expect(upload(v.clip).status).toBe("scheduled");
  });

  it("a sign-in from before force-ssl (upload + readonly) → red, Reconnect YouTube once, never a silent 403", async () => {
    await saveConnection(env, "youtube", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: new Date(Date.now() + H).toISOString(), account_id: "UCx" }), "ok", { account: "Dana Example", scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"] });
    seedVideo("public", 2);
    expect((await youtubeDirectSync(env)).dispatched).toBe(0);
    expect(one<{ status: string; last_error: string }>("SELECT status, last_error FROM connections WHERE service = 'youtube'")).toEqual({ status: "error", last_error: expect.stringMatching(/^Reconnect YouTube once so the dashboard can also move and hide/) });
    expect(light()).toMatchObject({ light: "red", fix_guide: "reconnect-youtube" });
  });

  it("videos.update refused for a missing permission (the real 403 body) → reconnect named, the failure recorded with its reason", async () => {
    await connect();
    const v = seedVideo("public", 3);
    await youtubeDirectSync(env);
    await runJob(v);
    // stand-in YouTube answers the next update with the real insufficientPermissions body
    const svc = await import("@worker/services/youtubeDirect");
    const orig = svc.getYouTubeDirect;
    const spy = vi.spyOn(svc, "getYouTubeDirect").mockImplementation((e) => ({ ...orig(e), updateStatus: async () => svc.fixtureFail("insufficient_scope") }));
    await call("POST", `/api/posts/${v.post}/unschedule`);
    spy.mockRestore();
    expect(JSON.parse(one<{ detail: string }>("SELECT detail FROM events WHERE kind = 'ytdirect.fail'").detail)).toEqual({ step: "update", kind: "scope", http: 403, reason: "insufficientPermissions" });
    expect(one<{ status: string }>("SELECT status FROM connections WHERE service = 'youtube'").status).toBe("error");
    expect(light()).toMatchObject({ light: "red", fix_guide: "reconnect-youtube" });
  });

  it("the job's token endpoint: only a running ytupload job, only a short-lived access token; 409 when revoked", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await youtubeDirectSync(env);
    const job = upload(v.clip).job_id!;
    const nonce = one<{ nonce: string }>("SELECT nonce FROM jobs WHERE id = ?", job).nonce;
    const ask = async (id: string, nn: string) => {
      const body = JSON.stringify({ purpose: "upload" });
      const ts = Math.floor(Date.now() / 1000);
      const res = await app.request(`${BASE_URL}/api/jobs/${id}/youtube-token`, { method: "POST", body, headers: { "x-job-timestamp": String(ts), "x-job-signature": await hmacHex(SECRET, `${ts}.${body}`), "x-job-nonce": nn } }, env);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const ok = await ask(job, nonce);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json).sort()).toEqual(["access_token", "expires_at"]);
    db.raw.prepare("INSERT INTO jobs (id, type, status, ref_id, nonce) VALUES ('job_cut', 'cut', 'running', 'dmp_x', 'n_cut')").run();
    expect((await ask("job_cut", "n_cut")).status).toBe(403);
    await scenario("revoked");
    expect((await ask(job, nonce)).status).toBe(409);
  });

  it("publish time refused → uploaded private, red with the Calendar fix; a new time on the Calendar sets it", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await scenario("publish_at_rejected");
    await youtubeDirectSync(env);
    await runJob(v);
    expect(upload(v.clip)).toMatchObject({ status: "mismatch", reason: "publish_at", privacy: "private", publish_at: null });
    expect(light()).toMatchObject({ light: "red", fix_guide: "move-or-remove-a-post" });
    await scenario("ok");
    await call("PATCH", `/api/posts/${v.post}`, { scheduled_at: new Date(Date.now() + 5 * H).toISOString() });
    expect(upload(v.clip).status).toBe("scheduled");
  });

  it("thumbnail refused (channel not verified) → uploaded anyway, a note with the verify link", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await scenario("thumb_unverified");
    await youtubeDirectSync(env);
    await runJob(v);
    expect(upload(v.clip)).toMatchObject({ status: "scheduled", thumbnail: "needs_verify" });
    const cards = await fullVideoCards(env);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "youtube_note", note: expect.stringContaining("Verify your channel's phone number in YouTube to use custom thumbnails"), link: { url: "https://www.youtube.com/verify" } });
    expect(light().light).toBe("yellow");
  });

  it("YouTube kept it private (read-back differs) → red with a named fix, never silently green", async () => {
    await connect();
    const v = seedVideo("unlisted", 2);
    await scenario("kept_private");
    await youtubeDirectSync(env);
    await runJob(v);
    expect(upload(v.clip)).toMatchObject({ status: "mismatch", reason: "kept_private" });
    expect(light()).toMatchObject({ light: "red", fix_guide: "upload-it-yourself" });
    expect((await fullVideoCards(env)).map((c) => c.kind)).toEqual(["youtube_note"]);
  });

  it("an interrupted upload that resumed is just uploaded (and counted)", async () => {
    await connect();
    const v = seedVideo("public", 2);
    await scenario("interrupted");
    await youtubeDirectSync(env);
    await runJob(v);
    expect(upload(v.clip).status).toBe("scheduled");
    expect(one<{ detail: string }>("SELECT detail FROM events WHERE kind = 'ytdirect.uploaded'").detail).toMatch(/"resumed":1/);
  });

  it("a job that died twice → Upload it yourself with a red light", async () => {
    await connect();
    const v = seedVideo("public", 2);
    for (let i = 0; i < 2; i++) {
      await youtubeDirectSync(env);
      await ytUploadJob.onFailure(env, upload(v.clip).job_id!, `${v.dump}/${v.clip}`, "boom");
    }
    expect(upload(v.clip)).toMatchObject({ status: "failed" });
    expect(light()).toMatchObject({ light: "red", fix_guide: "upload-it-yourself" });
    expect((await fullVideoCards(env)).map((c) => c.kind)).toEqual(["upload_yourself"]);
  });
});

describe("validator youtube-direct", () => {
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const good = () => ({
    job: read("jobs/ytupload.py"),
    lib: read("worker/lib/youtubeDirect.ts"),
    jobsRoute: read("worker/routes/jobs.ts"),
    service: read("worker/services/youtubeDirect.ts"),
    domain: read("worker/domain/youtubeDirect.ts"),
    oauth: read("worker/routes/oauth.ts"),
    cron: read("worker/crons/index.ts"),
    posts: read("worker/routes/posts.ts"),
    fixtures: read("shared/youtube-errors.json"),
    unit: read("tests/unit/youtube-direct.test.ts"),
    pyTest: read("jobs/tests/test_ytupload.py"),
  });

  it("passes on the repo", async () => {
    const r = await youtubeDirect({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(25);
  });

  it("fails on each broken rule", () => {
    const cases: [string, (g: ReturnType<typeof good>) => void, RegExp][] = [
      ["refresh token in the job", (g) => (g.job += "\nx = spec['refresh_token']\n"), /never mention a refresh token/],
      ["a delete", (g) => (g.service += '\nfetch(u, { method: "DELETE" });\n'), /never delete a video/],
      ["cap raised", (g) => (g.domain = g.domain.replace("YT_UPLOADS_PER_DAY = 3;", "YT_UPLOADS_PER_DAY = 6;")), /must be 3/],
      ["cap not enforced", (g) => (g.lib = g.lib.replace("const cap = capNote(today);", "const cap = null;")), /daily cap/],
      ["extra scope", (g) => (g.lib = g.lib.replace('"https://www.googleapis.com/auth/youtube.force-ssl"]', '"https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtube"]')), /exactly youtube\.upload/],
      ["update scope missing", (g) => (g.lib = g.lib.replace('"https://www.googleapis.com/auth/youtube.force-ssl"]', '"https://www.googleapis.com/auth/youtube.readonly"]')), /exactly youtube\.upload/],
      ["take off not followed", (g) => (g.posts = g.posts.replace("await followYouTube(c.env, [post.clip_id]);", "")), /follow YouTube/],
      ["hourly lane", (g) => (g.cron = g.cron.replace("await youtubeDirectSync(env);", "")), /hourly lane/],
      ["token endpoint leaks", (g) => (g.jobsRoute = g.jobsRoute.replace("c.json({ access_token: tok.access_token, expires_at: tok.expires_at }", "c.json({ ...tok }")), /only the access token/],
      ["fixture unnamed", (g) => (g.fixtures = g.fixtures.replace('"kind": "quota"', '"kind": "whatever"')), /quota_exceeded: needs http, body and a kind/],
    ];
    for (const [name, breakIt, want] of cases) {
      const g = good();
      breakIt(g);
      expect(checkYouTubeDirect(g).problems.join("\n"), name).toMatch(want);
    }
  });
});
