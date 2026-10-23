// Camera sound, the built-in music, the stock voice, Try another version with notes, and Start over
// (owner, 22 Oct 2026). A dump of phone videos whose camera audio was only background talk came back
// with that talk as captions, no music (no songs uploaded) and no voice over (no recording yet).
// These pin: camera sound off reaches the cut; a muted clip counts as no talking and always has
// music; "any" music with no songs of hers is the built-in library; the stock voice makes voice overs
// with no recording; Try another version with notes re-cuts the clip in place; Start over removes only
// New clips and never her videos.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
import { cutJob, parseCutRef, parseCutResult, songKey, type CutSpec } from "@worker/jobs/cut";
import { voiceJob } from "@worker/jobs/voice";
import { jobStorageScope } from "@worker/lib/jobStorage";
import { againRefusal, clips as clipsRoute } from "@worker/routes/clips";
import { dumps as dumpsRoute } from "@worker/routes/dumps";
import { settings as settingsRoute } from "@worker/routes/settings";
import { notesWithStartOver, startOverPlan } from "@worker/domain/startOver";
import { setSetting } from "@worker/lib/db";
import { CAMERA_SOUNDS, MUSIC_LIBRARY, STOCK_VOICES, libraryTrack, soundSettings } from "@shared/sound";

const ROOT = path.resolve(__dirname, "..", "..");

describe("the built-in music and the stock voices are real files with an open licence", () => {
  it("6 to 10 CC0 tracks, each on disk where the cut job reads it", () => {
    expect(MUSIC_LIBRARY.length).toBeGreaterThanOrEqual(6);
    expect(MUSIC_LIBRARY.length).toBeLessThanOrEqual(10);
    for (const t of MUSIC_LIBRARY) {
      expect(t.licence).toMatch(/^CC0 1\.0/);
      expect(existsSync(path.join(ROOT, "jobs", "music", `${t.id}.mp3`)), t.id).toBe(true);
    }
    // Made here, so the licence is beyond doubt: the generator is in the repo and every track says so.
    const lib = JSON.parse(readFileSync(path.join(ROOT, "jobs", "music", "library.json"), "utf8")) as { tracks: { source: string }[] };
    expect(lib.tracks.every((t) => t.source.includes("scripts/make-music.py"))).toBe(true);
    expect(existsSync(path.join(ROOT, "scripts", "make-music.py"))).toBe(true);
  });
  it("stock voices are preset speakers (Apache-2.0) with a preview each: af_heart first, af_bella the alternate", () => {
    expect(STOCK_VOICES.map((v) => v.id)).toEqual(["af_heart", "af_bella"]);
    const voices = JSON.parse(readFileSync(path.join(ROOT, "jobs", "voices.json"), "utf8")) as { engine: { model_licence: string } };
    expect(voices.engine.model_licence).toMatch(/^Apache-2\.0/);
    for (const v of STOCK_VOICES) expect(existsSync(path.join(ROOT, "public", v.preview)), v.preview).toBe(true);
  });
  it("only a library key that exists is accepted from a job", () => {
    expect(libraryTrack(`library/${MUSIC_LIBRARY[0].id}`)?.id).toBe(MUSIC_LIBRARY[0].id);
    expect(libraryTrack("library/../../secrets")).toBeNull();
    expect(songKey("library/nope")).toBeNull();
    expect(songKey(`library/${MUSIC_LIBRARY[1].id}`)).toBe(`library/${MUSIC_LIBRARY[1].id}`);
    expect(songKey("music/upl_abcd1234")).toBe("music/upl_abcd1234");
  });
});

describe("Settings → Sound: registry defaults, then what she saved", () => {
  it("plain defaults keep the camera sound and her own voice", () => {
    expect(soundSettings("", null)).toEqual({ camera: "keep", voice_source: "mine", stock_voice: STOCK_VOICES[0].id });
  });
  it("the studio's registry default, then her saved choice; anything odd is dropped", () => {
    const reg = JSON.stringify({ cameraSound: "off", voice: { source: "stock", stock: "af_bella" } });
    expect(soundSettings(reg, null)).toEqual({ camera: "off", voice_source: "stock", stock_voice: "af_bella" });
    expect(soundSettings(reg, { camera: "auto" })).toMatchObject({ camera: "auto", voice_source: "stock" });
    expect(soundSettings(reg, { camera: "loud", stock_voice: "someone_real" })).toMatchObject({ camera: "off", stock_voice: "af_bella" });
    expect(soundSettings("{not json", null).camera).toBe("keep");
  });
  it("Porch & Party's registry: camera sound off, the first stock voice", () => {
    const reg = JSON.parse(readFileSync(path.join(ROOT, "studios", "sample1.json"), "utf8")) as { sound: { cameraSound: string; voice: { source: string; stock: string } } };
    expect(reg.sound.cameraSound).toBe("off");
    expect(reg.sound.voice).toEqual({ source: "stock", stock: STOCK_VOICES[0].id });
    const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain(`"STUDIO_SOUND": "{\\"cameraSound\\":\\"off\\"`);
    expect(CAMERA_SOUNDS).toEqual(["auto", "keep", "off"]);
  });
});

describe("pure rules", () => {
  it("Start over removes only New clips, never one in Buffer, never approved or posted ones", () => {
    const plan = startOverPlan({ status: "ready", kind: "clips" }, [
      { id: "a", status: "draft", in_buffer: false },
      { id: "b", status: "approved", in_buffer: false },
      { id: "c", status: "rejected", in_buffer: false },
      { id: "d", status: "draft", in_buffer: true },
      { id: "e", status: "deleted", in_buffer: false },
    ], 3);
    expect(plan).toEqual({ refusal: null, remove: ["a"], keep: 3 });
  });
  it("Start over refuses while cutting, on a full video, and when the videos were cleared", () => {
    expect(startOverPlan(null, [], 1).refusal?.status).toBe(404);
    expect(startOverPlan({ status: "cutting", kind: "clips" }, [], 1).refusal?.error).toMatch(/still being cut/);
    expect(startOverPlan({ status: "ready", kind: "full_video" }, [], 1).refusal?.status).toBe(409);
    expect(startOverPlan({ status: "ready", kind: "clips" }, [], 0).refusal?.error).toMatch(/cleared/);
  });
  it("her Start over notes join the dump's note", () => {
    expect(notesWithStartOver("Fun weekend", "  shorter  clips ")).toBe("Fun weekend\nshorter clips");
    expect(notesWithStartOver("Fun weekend", "")).toBe("Fun weekend");
    expect(notesWithStartOver("", "shorter")).toBe("shorter");
  });
  it("Try another version with notes: refused only for a reason she can act on", () => {
    const ok = { status: "draft" as const, pending_look: null, raw_deleted_at: null, in_buffer: false };
    expect(againRefusal(ok)).toBeNull();
    expect(againRefusal({ ...ok, in_buffer: true })?.error).toMatch(/Buffer/);
    expect(againRefusal({ ...ok, pending_look: "clean" })?.status).toBe(409);
    expect(againRefusal({ ...ok, raw_deleted_at: "2026-10-01" })?.error).toMatch(/cleared/);
    expect(againRefusal(null)?.status).toBe(404);
  });
  it("the again ref: its own clip, the dump's raw videos, writes only its dump's folder", () => {
    expect(parseCutRef("dmp_x/clp_abcdefgh12/again")).toEqual({ dumpId: "dmp_x", clipId: "clp_abcdefgh12", import: false, again: true });
    expect(parseCutRef("dmp_x/again")).toBeNull();
    const scope = jobStorageScope("cut", "job_1", "dmp_x/clp_abcdefgh12/again");
    expect(scope.write).toEqual(["jobs/job_1/", "clips/dmp_x/"]);
    expect(scope.read).toContain("music/");
  });
  it("a muted clip from the job counts as no talking, whatever speech it reports", () => {
    const base = { id: "clp_abcdefgh12", asset_id: "ast_a", start_s: 0, end_s: 20, recipe: "montage", hook_text: "Look", caption: "c", hashtags: [], platforms: ["tiktok"], score: 0.7, r2_key: "clips/dmp_x/clp_abcdefgh12.mp4", cover_r2_key: null };
    const r = parseCutResult({ clips: [{ ...base, muted: true, speech: 0.8, music: `library/${MUSIC_LIBRARY[0].id}` }] }, { dumpId: "dmp_x", allowed: new Map([["ast_a", ["tiktok"]]]), rawKeys: new Set() });
    expect(r.clips[0]).toMatchObject({ muted: true, speech: 0, music: `library/${MUSIC_LIBRARY[0].id}` });
    const kept = parseCutResult({ clips: [{ ...base, speech: 0.8 }] }, { dumpId: "dmp_x", allowed: new Map([["ast_a", ["tiktok"]]]), rawKeys: new Set() });
    expect(kept.clips[0]).toMatchObject({ muted: false, speech: 0.8 });
  });
});

// ---------------------------------------------------------------- through the real schema and routes

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/clips", clipsRoute);
app.route("/api/dumps", dumpsRoute);
app.route("/api/settings", settingsRoute);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as T[];
const call = async (method: string, p: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const lastJob = (type: string) => one<{ id: string; ref_id: string }>("SELECT id, ref_id FROM jobs WHERE type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", type);

async function runCut(ref: string) {
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE type = 'cut' AND ref_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", ref);
  await cutJob.applyResult(env, job.id, ref, await cutJob.fakeRun!(env, job.id, ref, { clips: 4 }));
}

beforeEach(async () => {
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
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
    STUDIO_SOUND: JSON.stringify({ cameraSound: "off", voice: { source: "stock", stock: "af_heart" } }),
  } as unknown as Env;
  await setSetting(env.DB, "features", { voice: true, deeper_research: false, weekly_recap: true, help_ask: false });
  db.raw.exec(`INSERT INTO brand_profile (sections, locked) VALUES ('{"voice":"warm","ctas":"Message us."}', 1);
    INSERT INTO research_briefs (body, status) VALUES ('{}', 'approved');
    INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_cs', 'new', '', 'cutting');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_cs', 'dmp_cs', 'a.mp4', 'video/mp4', 'raw/dmp_cs/ast', 'uploaded');`);
  await r2.FILES.put("raw/dmp_cs/ast", new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
});

describe("camera sound reaches the cut", () => {
  it("the studio default (off) is in the spec; her chip wins; with no songs, any music is the built-in library", async () => {
    let spec = (await cutJob.buildSpec(env, "job_1", "dmp_cs")) as CutSpec;
    expect(spec.camera).toBe("off");
    db.raw.exec(`UPDATE dumps SET steer = '{"camera":"keep","music":"any"}' WHERE id = 'dmp_cs'`);
    spec = (await cutJob.buildSpec(env, "job_2", "dmp_cs")) as CutSpec;
    expect(spec.camera).toBe("keep");
    expect(spec.music.length).toBe(MUSIC_LIBRARY.length);
    expect(spec.music.every((m) => m.r2_key.startsWith("library/"))).toBe(true);
    // Settings → Sound changes the studio default.
    expect((await call("PATCH", "/api/settings", { sound: { camera: "auto" } })).status).toBe(200);
    db.raw.exec(`UPDATE dumps SET steer = NULL WHERE id = 'dmp_cs'`);
    expect(((await cutJob.buildSpec(env, "job_3", "dmp_cs")) as CutSpec).camera).toBe("auto");
  });

  it("a muted cut: every clip muted, no talking, music on each, and the stock voice voices them with no recording", async () => {
    const { dispatchJob } = await import("@worker/services/github");
    const job = await dispatchJob(env, "cut", "dmp_cs");
    await cutJob.applyResult(env, job.jobId, "dmp_cs", await cutJob.fakeRun!(env, job.jobId, "dmp_cs", { clips: 4 }));
    const rows = all<{ id: string; muted: number; speech: number; music: string | null }>("SELECT id, muted, speech, music FROM clips WHERE dump_id = 'dmp_cs' AND status = 'draft'");
    expect(rows.length).toBe(4);
    for (const c of rows) {
      expect(c.muted).toBe(1);
      expect(c.speech).toBe(0);
      expect(c.music).toMatch(/^library\//);
    }
    // Automatic voice over with the stock voice: no recording of hers exists, and every clip gets one.
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations WHERE clip_id IN (SELECT id FROM clips WHERE dump_id = 'dmp_cs')").n).toBe(4);
    const vj = lastJob("voice");
    const vspec = (await voiceJob.buildSpec(env, vj.id, vj.ref_id)) as { stock_voice: string | null; sample_key: string | null };
    expect(vspec.stock_voice).toBe("af_heart");
    expect(vspec.sample_key).toBeNull();
  });
});

describe("Review: voice over for the whole dump, another version with notes, start over", () => {
  async function cutOnce() {
    const { dispatchJob } = await import("@worker/services/github");
    const job = await dispatchJob(env, "cut", "dmp_cs");
    await cutJob.applyResult(env, job.jobId, "dmp_cs", await cutJob.fakeRun!(env, job.jobId, "dmp_cs", { clips: 4 }));
  }

  it("Add voice over to all clips: voices the quiet clips still without one, and says when there are none", async () => {
    await setSetting(env.DB, "features", { voice: false, deeper_research: false, weekly_recap: true, help_ask: false });
    await cutOnce();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0); // automatic voice overs were off
    const r = await call("POST", "/api/dumps/dmp_cs/voice-all");
    expect(r.status).toBe(200);
    expect(r.json.clips).toBe(4);
    expect((await call("POST", "/api/dumps/dmp_cs/voice-all")).json.clips).toBe(0);
  });

  it("Add voice over to all clips with her own voice chosen and none recorded: a plain refusal", async () => {
    await call("PATCH", "/api/settings", { sound: { voice_source: "mine" } });
    await cutOnce();
    const r = await call("POST", "/api/dumps/dmp_cs/voice-all");
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/Pick a voice first/);
  });

  it("Try another version with notes re-cuts the clip in place; the current file plays until then", async () => {
    await cutOnce();
    const clip = one<{ id: string; r2_key: string; hook_text: string; start_s: number }>("SELECT id, r2_key, hook_text, start_s FROM clips WHERE dump_id = 'dmp_cs' ORDER BY id LIMIT 1");
    const r = await call("POST", `/api/clips/${clip.id}/another`, { notes: "start with the finished room, shorter" });
    expect(r.status).toBe(200);
    const job = lastJob("cut");
    expect(job.ref_id).toBe(`dmp_cs/${clip.id}/again`);
    // Meanwhile: same file, marked as working, a second try refused.
    expect(one<{ r2_key: string; pending_look: string | null; again_notes: string }>("SELECT r2_key, pending_look, again_notes FROM clips WHERE id = ?", clip.id)).toMatchObject({ r2_key: clip.r2_key, again_notes: "start with the finished room, shorter" });
    expect((await call("POST", `/api/clips/${clip.id}/another`, { notes: "again" })).status).toBe(409);
    const spec = (await cutJob.buildSpec(env, job.id, job.ref_id)) as CutSpec & { change_request: string; avoid_windows: unknown[]; assets: unknown[] };
    expect(spec.change_request).toBe("start with the finished room, shorter");
    expect(spec.avoid_windows.length).toBeGreaterThan(0);
    expect(spec.assets.length).toBe(1);
    expect(spec.target_clips).toEqual({ min: 1, max: 1 });
    await runCut(job.ref_id);
    const after = one<{ id: string; r2_key: string; pending_look: string | null; status: string; start_s: number }>("SELECT id, r2_key, pending_look, status, start_s FROM clips WHERE id = ?", clip.id);
    expect(after.r2_key).not.toBe(clip.r2_key);
    expect(after.pending_look).toBeNull();
    expect(after.status).toBe("draft");
    expect(after.start_s).not.toBe(clip.start_s);
    // Studio fix: the version it replaced is KEPT to compare (5 → 5b), file and all, until the clip goes.
    expect(await r2.FILES.head(clip.r2_key)).not.toBeNull();
    const kept = one<{ version: number; r2_key: string }>("SELECT version, r2_key FROM clip_versions WHERE clip_id = ?", clip.id);
    expect(kept).toMatchObject({ version: 1, r2_key: clip.r2_key });
    expect(one<{ version: number; number: number }>("SELECT version, number FROM clips WHERE id = ?", clip.id).version).toBe(2);
    // Deleting the clip removes every version's file too.
    expect((await call("DELETE", `/api/clips/${clip.id}`)).status).toBe(200);
    expect(await r2.FILES.head(clip.r2_key)).toBeNull();
    expect(await r2.FILES.head(after.r2_key)).toBeNull();
  });

  it("Try another version with no notes is the old behaviour: a new look, same moment", async () => {
    await cutOnce();
    const clip = one<{ id: string }>("SELECT id FROM clips WHERE dump_id = 'dmp_cs' ORDER BY id LIMIT 1");
    expect((await call("POST", `/api/clips/${clip.id}/another`, {})).status).toBe(200);
    expect(lastJob("cut").ref_id).toBe(`dmp_cs/${clip.id}`);
  });

  it("Start over: New clips go, the approved one and her video stay, the same video is cut again with her notes", async () => {
    await cutOnce();
    const ids = all<{ id: string; r2_key: string }>("SELECT id, r2_key FROM clips WHERE dump_id = 'dmp_cs' ORDER BY id");
    db.raw.prepare("UPDATE clips SET status = 'approved' WHERE id = ?").run(ids[0].id);
    const r = await call("POST", "/api/dumps/dmp_cs/start-over", { notes: "shorter clips" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ removed: 3, kept: 1 });
    expect(all("SELECT id FROM clips WHERE dump_id = 'dmp_cs' AND status = 'draft'")).toEqual([]);
    expect(one<{ status: string }>("SELECT status FROM clips WHERE id = ?", ids[0].id).status).toBe("approved");
    for (const c of ids.slice(1)) expect(await r2.FILES.head(c.r2_key)).toBeNull();
    expect(await r2.FILES.head("raw/dmp_cs/ast")).not.toBeNull(); // her video is never touched
    expect(one<{ status: string; notes: string }>("SELECT status, notes FROM dumps WHERE id = 'dmp_cs'")).toEqual({ status: "cutting", notes: "shorter clips" });
    expect(lastJob("cut").ref_id).toBe("dmp_cs");
    // A second Start over while it cuts is refused in plain words.
    expect((await call("POST", "/api/dumps/dmp_cs/start-over")).status).toBe(409);
    await runCut("dmp_cs");
    expect(all("SELECT id FROM clips WHERE dump_id = 'dmp_cs' AND status = 'draft'").length).toBe(4);
  });
});
