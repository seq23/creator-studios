// Steering a dump (worker/domain/steer.ts): notes read into controls (fixtures from how creators
// write), chips and notes combined, and every control mapped into what the cut job renders. The
// promise under test: an instruction is followed, or the dump says why not; never dropped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanControls, describe as sayIt, mergeControls, parseNotes, planLine, quickFix, recipesAllowed, steerLook, steerMusic, steerPlatforms, steerRecipes, steerTarget, whatWeTried } from "@worker/domain/steer";
import { sayBack } from "@worker/lib/steerStore";
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
  cases: { note: string; controls: Record<string, unknown>; not_followed: string[]; leftover?: string[] }[];
};

describe("notes read into controls (fixtures)", () => {
  for (const c of FX.cases) {
    it(c.note, () => {
      const u = parseNotes(c.note, FX.tracks);
      expect(u.controls).toEqual(c.controls);
      expect(u.not_followed.map((x) => x.what)).toEqual(c.not_followed);
      expect(u.said.length).toBe(Object.keys(c.controls).length);
      // Never dropped in silence: every part that asks for something unreadable is said back, in her words.
      expect(u.leftover).toEqual(c.leftover ?? []);
      // Always one line said back, whatever she wrote.
      expect(u.plan).toMatch(/^I'll make /);
    });
  }
  it("the misreads the hostile test found (13 Nov 2026) stay fixed", () => {
    // "not too long" was read as Long (45-90 s)
    expect(parseNotes("just one video please, not too long", FX.tracks).controls.length).not.toBe("long");
    // "one" was lost because the number did not touch the noun
    expect(parseNotes("one 15 second reel of the balloon arch going up", FX.tracks).controls.count).toBe(1);
    // a number of seconds or a grid is never a count
    expect(parseNotes("30 second clips", FX.tracks).controls.count).toBeUndefined();
    expect(parseNotes("2 by 4 grid videos", FX.tracks).controls.count).toBeUndefined();
    // a negation never turns the thing on
    expect(parseNotes("not fast", FX.tracks).controls.pace).toBe("normal");
    expect(parseNotes("nothing too long", FX.tracks).controls).toEqual({ length: "short" });
  });
  it("every control is covered by at least one fixture", () => {
    const seen = new Set(FX.cases.flatMap((c) => Object.keys(c.controls)));
    for (const k of STEER_KEYS) expect(seen.has(k), k).toBe(true);
  });
  it("music asked for with no songs uploaded plays the built-in music, and says so", () => {
    for (const note of ["use my upbeat song", "add music", "use my song \"Sunrise\" track"]) {
      const u = parseNotes(note, []);
      expect(u.controls.music, note).toBe("any");
      expect(u.not_followed.map((x) => x.why), note).toEqual([expect.stringMatching(/haven't added songs yet.*built-in music was used/)]);
      expect(u.said, note).toContain("Music: the studio's built-in music");
    }
  });
  it("\"any\" music with no songs of hers is the built-in library, one track per clip; none stays none", () => {
    expect(steerMusic({ music: "any" }, [], []).length).toBeGreaterThanOrEqual(6);
    expect(steerMusic({ music: "any" }, [], []).every((t) => /^library\/[a-z0-9-]+$/.test(t.r2_key))).toBe(true);
    expect(steerMusic({ music: "none" }, [], [])).toEqual([]);
  });
  it("camera sound from a note, a chip, and never from anything else", () => {
    expect(parseNotes("mute the videos, music only", []).controls.camera).toBe("off");
    expect(parseNotes("keep the sound, I talk in these", []).controls.camera).toBe("keep");
    expect(parseNotes("no music, fast", []).controls.camera).toBeUndefined();
    expect(cleanControls({ camera: "off" }, []).controls.camera).toBe("off");
    expect(cleanControls({ camera: "loud" }, []).controls.camera).toBeUndefined();
  });
});

describe("chips, the dump's note and a video's note combine", () => {
  it("video note > what she typed > a tap > surprise; the clash is said before the cut, in plain words", () => {
    const m = mergeControls({ pace: "calm", looks: ["clean"] }, { pace: "fast", count: 5, avoid: ["cough"] }, { looks: ["grid_eight"] });
    expect(m.controls).toEqual({ pace: "fast", looks: ["grid_eight"], count: 5, avoid: ["cough"] });
    expect(m.clashes).toEqual(["You tapped one thing for the pace and wrote another. I'll go with what you wrote."]);
    // nothing about it is left for after the cut
    expect(m.not_followed).toEqual([]);
    // agreeing, or only one of them saying it, is no clash
    expect(mergeControls({ pace: "fast" }, { pace: "fast", count: 2 }).clashes).toEqual([]);
    // "Let me pick in Review" tapped and "no voice over" written make the same thing (none now): no false alarm
    expect(mergeControls({ voice: "pick" }, { voice: "none" })).toMatchObject({ controls: { voice: "none" }, clashes: [] });
    expect(mergeControls({ voice: "none" }, { voice: "pick" }).clashes).toEqual([]);
    // a voice over on quiet clips tapped, none written: that one is a real clash
    expect(mergeControls({ voice: "quiet" }, { voice: "none" }).clashes).toEqual(["You tapped one thing for the voice over and wrote another. I'll go with what you wrote."]);
    expect(mergeControls({ count: 5 }, {}).controls.count).toBe(5);
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
});

describe("what was made and what is said back", () => {
  it("what was made, in her words: kinds of post, videos that could not be used, and what to add", () => {
    const made = [{ clip_type: "team_working" }, { clip_type: "team_working" }, { clip_type: "set_up_with_me" }, { clip_type: "pov_walk_in" }];
    const six = Array.from({ length: 6 }, () => ({ why: "unsteady" as const }));
    expect(whatWeTried(made, six)).toBe("4 posts: 2 of the team working, 1 set-up, 1 walk-in; 6 videos weren't steady enough.");
    expect(whatWeTried([{ clip_type: "payoff_first" }], [{ why: "short" }, { why: "short" }, { why: "spare" }])).toBe("1 post: 1 before and after. These 2 videos are too short for a reel. Add videos of 8 seconds or more.");
    expect(whatWeTried([], [{ why: "short" }])).toBe("This video is too short for a reel. Add videos of 8 seconds or more.");
    // never a list of looks, grids or songs she did not ask about
    expect(whatWeTried(made, six)).not.toMatch(/look|grid|music|clip/i);
    expect(whatWeTried([], [])).toBe("");
  });
  it("the one line said back, always, and the one-tap fixes under it", () => {
    expect(planLine({}, [], 4)).toBe("I'll make about 4 posts, a mix of kinds.");
    expect(planLine({}, [])).toBe("I'll make a mix of posts.");
    expect(planLine({ count: 1, length: "short", captions: "none", platforms: ["instagram"] }, [])).toBe("I'll make 1 post: short (under 20 seconds), no words on screen, Instagram only.");
    expect(quickFix({}, "fewer", 8).count).toBe(4);
    expect(quickFix({ count: 2 }, "fewer", 2).count).toBe(1);
    expect(quickFix({ count: 1 }, "fewer", 1).count).toBe(1);
    expect(quickFix({}, "more", 4).count).toBe(6);
    expect(quickFix({ count: 28 }, "more", 28).count).toBe(30);
    expect(quickFix({ count: 9 }, "one", 9).count).toBe(1);
    expect(quickFix({}, "no_words", 4).captions).toBe("none");
    expect(quickFix({}, "instagram_only", 4).platforms).toEqual(["instagram"]);
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
  it("her note wins over a tap, the clash is NOT repeated after the cut, and the dump says what was made", async () => {
    const { env, db } = await dumpEnv({ pace: "calm" }, "3x3 grid, fast, more like the last one I approved");
    const spec = (await cutJob.buildSpec(env, "job_s4", "dmp_s1")) as CutSpec;
    const result = (await cutJob.fakeRun!(env, "job_s4", "dmp_s1", { clips: 4 })) as { clips: unknown[]; steer_report?: unknown; unused?: unknown };
    result.steer_report = [{ what: '"kitchen"', why: "we never heard it in these videos, so no clip could include it" }];
    result.unused = [{ asset_id: "ast_s2", why: "unsteady" }, { asset_id: "ast_someone_elses", why: "short" }, { asset_id: "ast_s1", why: "made up" }];
    await cutJob.applyResult(env, "job_s4", "dmp_s1", result);
    const d = db.raw.prepare("SELECT not_followed, tried FROM dumps WHERE id = 'dmp_s1'").get() as { not_followed: string; tried: string };
    expect(JSON.parse(d.not_followed).map((x: { what: string }) => x.what)).toEqual(["a 3 by 3 grid", '"more like the last one I approved"', '"kitchen"']);
    // only this upload's own videos, only the known reasons
    expect(d.tried).toMatch(/^4 posts: .*; 1 video wasn't steady enough\.$/);
    expect(spec.looks[spec.rotation[0]]!.punch_in).toBe(true); // what she typed (fast) won over the tap (calm)
  });
  it("a look is reported as not followed only when she asked for it; her length reaches the planner", async () => {
    const asked = (await cutJob.buildSpec((await dumpEnv({ looks: ["grid_eight"], length: "short" }, "")).env, "job_s5", "dmp_s1")) as CutSpec;
    expect(asked.steer.looks_asked).toBe(true);
    expect(asked.steer.length).toEqual({ minS: 8, maxS: 20 });
    const surprise = (await cutJob.buildSpec((await dumpEnv({}, "")).env, "job_s6", "dmp_s1")) as CutSpec;
    expect(surprise.steer.looks_asked).toBe(false);
    expect(surprise.steer.length).toBeNull();
  });
  it("said back before the cut: her note, her taps, what could not be used, and one-tap fixes that her typing overrides", async () => {
    const { env } = await dumpEnv({ pace: "calm", count: 5 }, "");
    const first = await sayBack(env, { text: "fast please. make a carousel", chips: { pace: "calm", count: 5 }, dumpId: "dmp_s1" });
    expect(first.plan).toBe("I'll make 5 posts: quick cuts.");
    expect(first.leftover).toEqual(["make a carousel"]);
    expect(first.clashes).toEqual(["You tapped one thing for the pace and wrote another. I'll go with what you wrote."]);
    // no note at all: still one line, sized to what she uploaded (2 videos)
    const empty = await sayBack(env, { text: "", chips: {}, dumpId: "dmp_s1" });
    expect(empty.plan).toBe("I'll make about 2 posts, a mix of kinds.");
    // a tap on "Just one" changes it; it is kept while her note says nothing else about how many
    const one = await sayBack(env, { text: "", chips: {}, dumpId: "dmp_s1", prevNote: empty.note_controls, fixed: empty.fixed, fix: "one" });
    expect(one.plan).toBe("I'll make 1 post.");
    expect(one.controls.count).toBe(1);
    const still = await sayBack(env, { text: "no music", chips: {}, dumpId: "dmp_s1", prevNote: one.note_controls, fixed: one.fixed });
    expect(still.controls).toEqual({ music: "none", count: 1 });
    // then she types a number: what she typed wins over the earlier tap
    const typed = await sayBack(env, { text: "no music, 3 posts", chips: {}, dumpId: "dmp_s1", prevNote: still.note_controls, fixed: still.fixed });
    expect(typed.controls.count).toBe(3);
    expect(typed.fixed).toEqual({});
    expect(typed.plan).toBe("I'll make 3 posts: no music.");
    // a made-up fix or a made-up fixed value does nothing
    const junk = await sayBack(env, { text: "", chips: {}, dumpId: "dmp_s1", fixed: { count: "lots", looks: ["grid_eight"] }, fix: "explode" });
    expect(junk.fixed).toEqual({});
  });
});
