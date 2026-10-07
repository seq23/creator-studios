// Steering a dump (worker/domain/steer.ts): notes read into controls (fixtures from how creators
// write), chips and notes combined, and every control mapped into what the cut job renders. The
// promise under test: an instruction is followed, or the dump says why not; never dropped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanControls, describe as sayIt, mergeControls, parseNotes, recipesAllowed, steerLook, steerMusic, steerPlatforms, steerRecipes, steerTarget, whatWeTried } from "@worker/domain/steer";
import { resolveLook, DEFAULT_EDITING } from "@worker/domain/looks";
import { RECIPES } from "@shared/constants";
import { STEER_KEYS } from "@shared/steer";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { cutJob, type CutSpec } from "@worker/jobs/cut";
import { setSetting } from "@worker/lib/db";
import type { Env } from "@worker/env";

const FX = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "steer-notes.json"), "utf8")) as {
  tracks: { id: string; name: string }[];
  cases: { note: string; controls: Record<string, unknown>; not_followed: string[] }[];
};

describe("notes read into controls (fixtures)", () => {
  for (const c of FX.cases) {
    it(c.note, () => {
      const u = parseNotes(c.note, FX.tracks);
      expect(u.controls).toEqual(c.controls);
      expect(u.not_followed.map((x) => x.what)).toEqual(c.not_followed);
      expect(u.said.length).toBe(Object.keys(c.controls).length);
    });
  }
  it("every control is covered by at least one fixture", () => {
    const seen = new Set(FX.cases.flatMap((c) => Object.keys(c.controls)));
    for (const k of STEER_KEYS) expect(seen.has(k), k).toBe(true);
  });
  it("music asked for with no songs uploaded is said, not silently dropped", () => {
    const u = parseNotes("use my upbeat song", []);
    expect(u.controls.music).toBeUndefined();
    expect(u.not_followed[0].why).toMatch(/haven't added songs yet/);
  });
});

describe("chips, the dump's note and a video's note combine", () => {
  it("video note > chip > dump note > surprise; a clash is said", () => {
    const m = mergeControls({ pace: "calm", looks: ["clean"] }, { pace: "fast", count: 5, avoid: ["cough"] }, { looks: ["grid_eight"] });
    expect(m.controls).toEqual({ pace: "calm", looks: ["grid_eight"], count: 5, avoid: ["cough"] });
    expect(m.not_followed.map((x) => x.what)).toEqual(["your note's pace"]);
  });
  it("cleanControls keeps what is real and says what is not", () => {
    const r = cleanControls({ looks: ["grid_eight", "sparkle"], music: "track:gone", count: 99, pace: "warp", platforms: ["tiktok", "myspace"] }, FX.tracks);
    expect(r.controls).toEqual({ looks: ["grid_eight"], count: 30, platforms: ["tiktok"] });
    expect(r.not_followed.map((x) => x.what)).toEqual(['the look "sparkle"', "that song", "99 clips"]);
  });
});

describe("controls reach what the job renders", () => {
  const karaoke = resolveLook("karaoke", DEFAULT_EDITING, true);
  it("captions, pace and music override the Look", () => {
    expect(steerLook(karaoke, { captions: "none", pace: "calm", music: "none" })).toMatchObject({ captions: "none", punch_in: false, crossfade: true, music: false });
    expect(steerLook(resolveLook("clean", DEFAULT_EDITING, false), { pace: "fast", music: "any" })).toMatchObject({ punch_in: true, crossfade: false, music: true });
    expect(steerLook(karaoke, {})).toEqual(karaoke);
  });
  it("music: none, all her songs, one song, else Settings", () => {
    const tr = [{ id: "a", r2_key: "music/a" }, { id: "b", r2_key: "music/b" }];
    expect(steerMusic({ music: "none" }, tr, [{ r2_key: "music/a" }])).toEqual([]);
    expect(steerMusic({ music: "any" }, tr, [])).toEqual([{ r2_key: "music/a" }, { r2_key: "music/b" }]);
    expect(steerMusic({ music: "track:b" }, tr, [])).toEqual([{ r2_key: "music/b" }]);
    expect(steerMusic({}, tr, [{ r2_key: "music/a" }])).toEqual([{ r2_key: "music/a" }]);
  });
  it("length squeezes every recipe into the range, never past its own maximum; long keeps only recipes that reach it", () => {
    const s = steerRecipes({ length: "short" });
    for (const [k, b] of Object.entries(s)) expect(b.maxS <= 20 && b.minS >= 8 && b.maxS <= RECIPES[k as keyof typeof RECIPES].maxS, k).toBe(true);
    expect(recipesAllowed({ length: "long" }).sort()).toEqual(["hook_first", "recycle", "story"]);
    expect(recipesAllowed({}).length).toBe(Object.keys(RECIPES).length);
  });
  it("how many and platforms", () => {
    expect(steerTarget({ count: 5 }, { min: 20, max: 30 })).toEqual({ min: 5, max: 5 });
    expect(steerTarget({}, { min: 20, max: 30 })).toEqual({ min: 20, max: 30 });
    expect(steerPlatforms(["tiktok", "instagram", "youtube"], { platforms: ["tiktok"] })).toEqual(["tiktok"]);
  });
  it("says it back in plain words", () => {
    expect(sayIt({ looks: ["grid_eight"], music: "none", pace: "fast" }, [])).toEqual(["Look: Grid of eight (8 cells)", "Music: none", "Pace: fast"]);
  });
  it("What we tried sums up a Surprise me batch", () => {
    expect(whatWeTried([{ look: "grid_eight", music: "music/a" }, { look: "clean", music: null }, { look: "karaoke", music: "music/a" }], [{ r2_key: "music/a", name: "Upbeat summer.mp3" }])).toBe(
      "What we tried: 3 clips in 3 looks (Grid of eight, Clean, Karaoke captions), 1 grid, music on 2 (Upbeat summer.mp3).",
    );
  });
});

// ---------------------------------------------------------------- the cut job's spec honors every control (real schema)


async function dumpEnv(steer: object, note: string, assetNote: string | null = null) {
  const db = sqliteD1();
  const env = { DB: db.DB, FILES: memoryR2().FILES, FAKE_SERVICES: "1", PUBLIC_BASE_URL: "http://w.example", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", OWNER_EMAIL: "o@example.com" } as unknown as Env;
  await setSetting(env.DB, "editing", { looks_off: [], captions: true, end_card: true, music: true });
  const noteU = note ? JSON.stringify(parseNotes(note, FX.tracks)) : null;
  const assetU = assetNote ? JSON.stringify(parseNotes(assetNote, FX.tracks)) : null;
  db.raw.prepare("INSERT INTO dumps (id, door, notes, status, steer, steer_notes) VALUES ('dmp_s1', 'new', ?, 'cutting', ?, ?)").run(note, JSON.stringify(steer), noteU);
  db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status, file_note, steer_notes) VALUES ('ast_s1', 'dmp_s1', 'a.mp4', 'video/mp4', 'raw/dmp_s1/ast_s1', 'uploaded', ?, ?)").run(assetNote, assetU);
  db.raw.exec("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_s2', 'dmp_s1', 'b.mp4', 'video/mp4', 'raw/dmp_s1/ast_s2', 'uploaded')");
  for (const t of FX.tracks) db.raw.prepare("INSERT INTO music_tracks (id, file_name, r2_key, mime_type) VALUES (?, ?, ?, 'audio/mpeg')").run(t.id, t.name, `music/${t.id}`);
  return { db, env };
}

describe("the note \"2x4 grid, no music, fast\" reaches the cut job", () => {
  it("every clip a 2x4 grid, no song, punch-in on", async () => {
    const { env } = await dumpEnv({}, "2x4 grid, no music, fast");
    const spec = (await cutJob.buildSpec(env, "job_s1", "dmp_s1")) as CutSpec;
    expect(spec.rotation).toEqual(["grid_eight"]);
    expect(spec.music).toEqual([]);
    expect(spec.looks.grid_eight).toMatchObject({ layout: "grid", grid: "grid_2x4", punch_in: true, music: false });
  });
  it("chips: how many, length, platforms, captions, one song", async () => {
    const { env } = await dumpEnv({ count: 5, length: "short", platforms: ["tiktok"], captions: "none", music: "track:upl_chill0002", looks: ["clean", "karaoke"] }, "");
    const spec = (await cutJob.buildSpec(env, "job_s2", "dmp_s1")) as CutSpec;
    expect(spec.target_clips).toEqual({ min: 5, max: 5 });
    for (const b of Object.values(spec.recipes)) expect(b.maxS).toBeLessThanOrEqual(20);
    expect(spec.assets.every((a) => JSON.stringify(a.allowed_platforms) === '["tiktok"]')).toBe(true);
    expect(new Set(spec.rotation)).toEqual(new Set(["clean", "karaoke"]));
    expect(Object.values(spec.looks).every((l) => l!.captions === "none" && l!.music === true)).toBe(true);
    expect(spec.music).toEqual([{ r2_key: "music/upl_chill0002" }]);
  });
  it("a video's own note steers that video only; include/avoid reach the job", async () => {
    const { env } = await dumpEnv({}, "make sure you include the cake reveal", "karaoke look, use my upbeat song");
    const spec = (await cutJob.buildSpec(env, "job_s3", "dmp_s1")) as CutSpec;
    const a1 = spec.assets.find((a) => a.id === "ast_s1")!;
    const a2 = spec.assets.find((a) => a.id === "ast_s2")!;
    expect(a1.steer!.rotation).toEqual(["karaoke"]);
    expect(a1.steer!.music).toEqual([{ r2_key: "music/upl_upbeat001" }]);
    expect(a1.steer!.include).toEqual(["cake reveal"]);
    expect(a2.steer).toBeUndefined();
    expect(spec.steer.include).toEqual(["cake reveal"]);
  });
  it("after the cut: what couldn't be followed (note, clash, job report) and What we tried are on the dump", async () => {
    const { env, db } = await dumpEnv({ pace: "calm" }, "3x3 grid, fast");
    const spec = (await cutJob.buildSpec(env, "job_s4", "dmp_s1")) as CutSpec;
    const result = (await cutJob.fakeRun!(env, "job_s4", "dmp_s1", { clips: 4 })) as { clips: unknown[]; steer_report?: unknown };
    result.steer_report = [{ what: '"kitchen"', why: "we never heard it in these videos, so no clip could include it" }];
    await cutJob.applyResult(env, "job_s4", "dmp_s1", result);
    const d = db.raw.prepare("SELECT not_followed, tried FROM dumps WHERE id = 'dmp_s1'").get() as { not_followed: string; tried: string };
    expect(JSON.parse(d.not_followed).map((x: { what: string }) => x.what)).toEqual(["a 3 by 3 grid", "your note's pace", '"kitchen"']);
    expect(d.tried).toMatch(/^What we tried: \d+ clips in /);
    expect(spec.looks[spec.rotation[0]]!.punch_in).toBe(false); // the chip (calm) won over the note (fast)
  });
});
