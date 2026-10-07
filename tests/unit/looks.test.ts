// Looks: jobs/looks.json (what the cut job renders) and worker/domain/looks.ts (what the Worker and
// the app read) must agree field for field; the rotation must vary a dump's clips; her Settings >
// Editing switches must reach the job; grid cells, the voice cell and a re-render are checked
// the same way the Worker checks every job result.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  DEFAULT_EDITING,
  DEFAULT_FONT,
  FRAME,
  GRIDS,
  LOOKS,
  LOOK_IDS,
  brandingFor,
  cellCount,
  cleanEditing,
  cleanGridLayout,
  defaultGridLayout,
  editingFromStored,
  editingToStored,
  isGridLook,
  lookDistribution,
  lookForClip,
  pickVoiceCell,
  resolveLook,
  rotationFor,
  type LookId,
} from "@worker/domain/looks";
import { clipParts, clipSource, cleanParts, parseCutRef, parseCutResult, parseRerender, rerenderKeys, CutResultError, type CutResultClip } from "@worker/jobs/cut";
import { jobStorageScope, mayRead, mayWrite } from "@worker/lib/jobStorage";
import { lookChangeRefusal } from "@worker/routes/clips";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { cutJob } from "@worker/jobs/cut";
import type { Env } from "@worker/env";

const json = JSON.parse(readFileSync(path.join(__dirname, "../../jobs/looks.json"), "utf8")) as {
  frame: typeof FRAME;
  defaults: { brand: typeof DEFAULT_BRAND; font: string };
  grids: Record<string, { label: string; cells: number[][] }>;
  looks: Record<string, unknown>[];
};

/** Every Look by name, with what makes it that Look (the validator `looks` requires each id here). */
const EXPECTED: Record<LookId, { layout: string; cells: number; captions: string; hook: string }> = {
  "clean": { layout: "fill", cells: 1, captions: "clean", hook: "none" },
  "bold_hook": { layout: "fill", cells: 1, captions: "karaoke", hook: "top_bold" },
  "karaoke": { layout: "fill", cells: 1, captions: "karaoke", hook: "top_bold" },
  "brand_card": { layout: "fill", cells: 1, captions: "boxed", hook: "top_bold" },
  "cinematic": { layout: "blur_fill", cells: 1, captions: "clean", hook: "none" },
  "reaction": { layout: "pip", cells: 1, captions: "clean", hook: "top_bold" },
  "split": { layout: "grid", cells: 2, captions: "boxed", hook: "top_bold" },
  "side_by_side": { layout: "grid", cells: 2, captions: "boxed", hook: "top_bold" },
  "grid_four": { layout: "grid", cells: 4, captions: "boxed", hook: "top_bold" },
  "grid_six": { layout: "grid", cells: 6, captions: "boxed", hook: "top_bold" },
  "grid_eight": { layout: "grid", cells: 8, captions: "boxed", hook: "top_bold" },
  "hero_strip": { layout: "grid", cells: 4, captions: "clean", hook: "top_bold" },
};

describe("jobs/looks.json and worker/domain/looks.ts agree", () => {
  it("same Looks, same order, every field equal", () => {
    expect(json.looks.map((l) => l.id)).toEqual(LOOK_IDS);
    for (const [i, l] of LOOKS.entries()) expect(json.looks[i], l.id).toEqual({ ...l });
  });
  it("same grids, frame and defaults", () => {
    expect(json.frame).toEqual(FRAME);
    expect(json.defaults).toEqual({ brand: DEFAULT_BRAND, font: DEFAULT_FONT });
    expect(Object.keys(json.grids).sort()).toEqual(Object.keys(GRIDS).sort());
    for (const [k, g] of Object.entries(GRIDS)) expect(json.grids[k], k).toEqual({ label: g.label, cells: g.cells.map((c) => [...c]) });
  });
  it("6 to 8 single looks and the owner's grids (2 stacked, side by side, 2x2, 2x3, 2x4, hero + strip), each as described", () => {
    expect(Object.keys(EXPECTED)).toEqual(LOOK_IDS);
    for (const id of LOOK_IDS) {
      const l = LOOKS.find((x) => x.id === id)!;
      expect({ layout: l.layout, cells: cellCount(id), captions: l.captions, hook: l.hook }, id).toEqual(EXPECTED[id]);
      expect(l.description.length).toBeGreaterThanOrEqual(20);
    }
    const singles = LOOK_IDS.filter((id) => !isGridLook(id));
    expect(singles.length).toBeGreaterThanOrEqual(6);
    expect(singles.length).toBeLessThanOrEqual(8);
    expect(LOOK_IDS.filter(isGridLook).map(cellCount).sort((a, b) => a - b)).toEqual([2, 2, 4, 4, 6, 8]);
  });
});

describe("grid geometry", () => {
  it("every cell is inside the 1080x1920 frame, even-sized, and no two cells overlap", () => {
    for (const [k, g] of Object.entries(GRIDS)) {
      for (const [x, y, w, h] of g.cells) {
        expect(x >= 0 && y >= 0 && x + w <= FRAME.w && y + h <= FRAME.h, `${k} ${x},${y}`).toBe(true);
        expect(w % 2 === 0 && h % 2 === 0, `${k} even`).toBe(true);
      }
      for (const [i, a] of g.cells.entries())
        for (const b of g.cells.slice(i + 1)) {
          const apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
          expect(apart, `${k} overlap`).toBe(true);
        }
    }
  });
  it("neighbouring cells are exactly one 12 px gutter apart, and the cells fill the frame", () => {
    for (const [k, g] of Object.entries(GRIDS)) {
      const area = g.cells.reduce((n, c) => n + c[2] * c[3], 0);
      expect(area / (FRAME.w * FRAME.h), k).toBeGreaterThan(0.95);
      for (const a of g.cells) {
        const right = g.cells.find((b) => b[1] === a[1] && b[0] > a[0]);
        if (right) expect(right[0] - (a[0] + a[2]), `${k} gutter`).toBe(FRAME.gutter);
      }
    }
    const [hero, ...strip] = GRIDS.hero_strip.cells;
    for (const s of strip) expect(hero[2] * hero[3]).toBeGreaterThan(4 * s[2] * s[3]);
  });
});

describe("rotation: a dump's clips never all look alike", () => {
  it("uses every enabled Look before any repeats, never the same Look twice in a row", () => {
    const rot = rotationFor(LOOK_IDS, "dmp_abc123");
    expect([...rot].sort()).toEqual([...LOOK_IDS].sort());
    for (let k = 0; k < 40; k++) expect(lookForClip(rot, k)).not.toBe(lookForClip(rot, k + 1));
  });
  it("singles and grids go two to one, so a dump is never mostly grids", () => {
    const rot = rotationFor(LOOK_IDS, "dmp_xyz");
    const first9 = rot.slice(0, 9);
    expect(first9.filter(isGridLook).length).toBe(3);
    expect(isGridLook(rot[0]) || isGridLook(rot[1])).toBe(false);
    expect(isGridLook(rot[2])).toBe(true);
  });
  it("28 clips (the owner's staging dump size) use all 12 Looks, none more than 3 times", () => {
    const rot = rotationFor(LOOK_IDS, "dmp_owner");
    const dist = lookDistribution(Array.from({ length: 28 }, (_, k) => lookForClip(rot, k)));
    expect(Object.keys(dist).length).toBe(12);
    expect(Math.max(...Object.values(dist))).toBeLessThanOrEqual(3);
  });
  it("is the same for the same dump and differs between dumps", () => {
    expect(rotationFor(LOOK_IDS, "dmp_a")).toEqual(rotationFor(LOOK_IDS, "dmp_a"));
    const orders = new Set(["dmp_a", "dmp_b", "dmp_c", "dmp_d"].map((d) => rotationFor(LOOK_IDS, d).join(",")));
    expect(orders.size).toBeGreaterThan(1);
  });
  it("only the Looks she left on; none on (never stored) falls back to Clean", () => {
    const on: LookId[] = ["karaoke", "grid_four", "cinematic"];
    expect([...rotationFor(on, "d")].sort()).toEqual([...on].sort());
    expect(rotationFor([], "d")).toEqual(["clean"]);
    expect(rotationFor(["grid_eight"], "d")).toEqual(["grid_eight"]);
  });
});

describe("Settings > Editing reaches the job", () => {
  it("defaults: every Look on, captions and end card on, music off", () => {
    expect(DEFAULT_EDITING).toEqual({ looks: LOOK_IDS, captions: true, end_card: true, music: false });
    expect(editingFromStored({})).toEqual(DEFAULT_EDITING);
  });
  it("is stored as the Looks switched OFF, so a Look added later starts on", () => {
    const stored = editingToStored({ ...DEFAULT_EDITING, looks: LOOK_IDS.filter((x) => x !== "grid_eight") });
    expect(stored.looks_off).toEqual(["grid_eight"]);
    expect(editingFromStored({ ...stored, looks_off: ["grid_eight", "a_future_look"] }).looks).not.toContain("grid_eight");
    expect(editingFromStored({ looks_off: ["not_a_look"] }).looks).toEqual(LOOK_IDS);
  });
  it("cleanEditing keeps known Looks in order, refuses an empty mix, keeps booleans", () => {
    expect(cleanEditing({ looks: ["grid_four", "clean", "nope"] })!.looks).toEqual(["clean", "grid_four"]);
    expect(cleanEditing({ looks: [] })).toBeNull();
    expect(cleanEditing({ looks: "clean" })).toBeNull();
    expect(cleanEditing({ captions: false, music: "yes" })).toEqual({ ...DEFAULT_EDITING, captions: false });
  });
  it("resolveLook: captions off burns no words, end card off, music only with her songs", () => {
    const off = resolveLook("karaoke", { ...DEFAULT_EDITING, captions: false, end_card: false, music: true }, false);
    expect(off).toMatchObject({ id: "karaoke", captions: "none", hook: "top_bold", end_card: false, music: false });
    expect(resolveLook("brand_card", { ...DEFAULT_EDITING, music: true }, true)).toMatchObject({ captions: "boxed", end_card: true, music: true, progress_bar: true });
    expect(resolveLook("hero_strip", DEFAULT_EDITING, true)).toMatchObject({ layout: "grid", grid: "hero_strip", music: false });
  });
});

describe("grid cells and the voice", () => {
  it("the clearest speech is the voice; a tie goes to the first cell", () => {
    expect(pickVoiceCell([0.2, 0.9, 0.5])).toBe(1);
    expect(pickVoiceCell([0.7, 0.7])).toBe(0);
    expect(pickVoiceCell([])).toBe(0);
  });
  it("default grid: this clip first, then the dump's other clips, then closer shots", () => {
    expect(defaultGridLayout("grid_four", ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"])).toEqual({
      cells: [{ kind: "self" }, { kind: "clip", clip_id: "clp_aaaaaaaaaa" }, { kind: "clip", clip_id: "clp_bbbbbbbbbb" }, { kind: "zoom", zoom: 1.35 }],
      voice: 0,
    });
    expect(defaultGridLayout("grid_eight", []).cells).toHaveLength(8);
  });
  it("her picks are checked: the right number of cells, this clip in one, known zooms, a voice inside the grid", () => {
    const four = [{ kind: "self" }, { kind: "zoom", zoom: 1.7 }, { kind: "clip", clip_id: "clp_aaaaaaaaaa" }, { kind: "zoom", zoom: 2.1 }];
    expect(cleanGridLayout("grid_four", { cells: four, voice: 2 })).toEqual({ cells: four, voice: 2 });
    expect(cleanGridLayout("grid_four", { cells: four.slice(0, 3), voice: 0 })).toBeNull();
    expect(cleanGridLayout("grid_four", { cells: four.map(() => ({ kind: "zoom", zoom: 1.35 })), voice: 0 })).toBeNull();
    expect(cleanGridLayout("grid_four", { cells: [...four.slice(0, 3), { kind: "zoom", zoom: 9 }], voice: 0 })).toBeNull();
    expect(cleanGridLayout("grid_four", { cells: [...four.slice(0, 3), { kind: "clip", clip_id: "../x" }], voice: 0 })).toBeNull();
    expect(cleanGridLayout("grid_four", { cells: four, voice: 4 })).toBeNull();
    expect(cleanGridLayout("clean", { cells: [{ kind: "self" }], voice: 0 })).toBeNull();
  });
});

describe("branding for the end card", () => {
  it("her TikTok handle from Buffer, else any channel, else her Brand Profile; colours and font from the profile", () => {
    const b = brandingFor({ who: "Sam @fromprofile", ctas: "- Follow for more real days\n- Link in bio", do_dont: "Brand colours #AA3355 and #112233, headings in Playfair Display" }, [
      { platform: "instagram", handle: "@ig.handle" },
      { platform: "tiktok", handle: "@iamcindymercer" },
    ]);
    expect(b).toEqual({ colors: { primary: "#aa3355", ink: DEFAULT_BRAND.ink, paper: DEFAULT_BRAND.paper, accent: "#112233" }, font: "Playfair Display", handle: "@iamcindymercer", cta: "Follow for more real days" });
    expect(brandingFor({ who: "hi @fromprofile" }, []).handle).toBe("@fromprofile");
    expect(brandingFor(null, [{ platform: "youtube", handle: "Sample Studio" }]).handle).toBe("@SampleStudio");
  });
  it("defaults when she has nothing yet", () => {
    expect(brandingFor(null, [])).toEqual({ colors: { ...DEFAULT_BRAND }, font: null, handle: null, cta: null });
  });
});

const clipBase: CutResultClip = {
  id: "clp_aaaaaaaaaaaa",
  asset_id: "ast_1",
  start_s: 10,
  end_s: 40,
  recipe: "talking_head",
  hook_text: "Hook",
  hook_alt: null,
  caption: "c",
  hashtags: "#a",
  platforms: ["tiktok"],
  score: 0.8,
  r2_key: "clips/dmp_test/clp_aaaaaaaaaaaa.mp4",
  cover_r2_key: "clips/dmp_test/clp_aaaaaaaaaaaa.jpg",
};
const ctx = { dumpId: "dmp_test", allowed: new Map([["ast_1", ["tiktok" as const]]]), rawKeys: new Set<string>() };

describe("a cut result carries each clip's look, parts and grid, checked", () => {
  it("keeps a known look with its parts and cells", () => {
    const layout = { cells: [{ kind: "self" }, { kind: "clip", clip_id: "clp_bbbbbbbbbbbb" }], voice: 1 };
    const { clips } = parseCutResult({ clips: [{ ...clipBase, look: "split", parts: [[12, 14], [10, 40]], layout }] }, ctx);
    expect(clips[0]).toMatchObject({ look: "split", parts: [[12, 14], [10, 40]], layout });
  });
  it("an unknown look is dropped to none, bad parts fall back to start-end, a bad grid to the default", () => {
    const { clips } = parseCutResult({ clips: [{ ...clipBase, look: "ai_magic", parts: [[5, 2]] }] }, ctx);
    expect(clips[0]).toMatchObject({ look: null, parts: [[10, 40]], layout: null });
    const g = parseCutResult({ clips: [{ ...clipBase, look: "grid_four", layout: { cells: [], voice: 0 } }] }, ctx).clips[0];
    expect(g.layout).toEqual(defaultGridLayout("grid_four", []));
    expect(cleanParts([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]], 0, 10)).toEqual([[0, 10]]);
  });
});

describe("re-rendering one clip", () => {
  it("a cut ref is a dump or a dump/clip; anything else is refused", () => {
    expect(parseCutRef("dmp_abcd1234")).toEqual({ dumpId: "dmp_abcd1234", clipId: null, import: false });
    expect(parseCutRef("dmp_abcd1234/clp_aaaaaaaaaaaa")).toEqual({ dumpId: "dmp_abcd1234", clipId: "clp_aaaaaaaaaaaa", import: false });
    for (const bad of [null, "", "dmp_abcd/../x", "../raw", "dmp_a.b", "dmp_abcd1234/clp_aaaaaaaaaaaa/x", "dmp_abcd1234/ast_aaaaaaaaaaaa"]) expect(parseCutRef(bad), String(bad)).toBeNull();
  });
  it("storage: a re-render may read any upload, clip file or song, and writes only its own dump's folder", () => {
    const s = jobStorageScope("cut", "job_1", "dmp_abcd1234/clp_aaaaaaaaaaaa");
    expect(mayRead(s, "raw/dmp_other/ast_1")).toBe(true);
    expect(mayRead(s, "clips/dmp_other/clp_bbbbbbbbbbbb.mp4")).toBe(true);
    expect(mayRead(s, "music/upl_1")).toBe(true);
    expect(mayRead(s, "brain/doc_1")).toBe(false);
    expect(mayWrite(s, "clips/dmp_abcd1234/clp_aaaaaaaaaaaa-v1.mp4")).toBe(true);
    expect(mayWrite(s, "clips/dmp_other/x.mp4")).toBe(false);
    const dump = jobStorageScope("cut", "job_2", "dmp_abcd1234");
    expect(mayRead(dump, "raw/dmp_other/ast_1")).toBe(false);
    expect(mayRead(dump, "music/upl_1")).toBe(true);
    expect(mayRead(dump, "clips/dmp_other/x.mp4")).toBe(false);
  });
  it("new file names per version; the answer must be for its own clip, look and files", () => {
    const k = rerenderKeys("dmp_abcd1234", "clp_aaaaaaaaaaaa", 2);
    expect(k).toEqual({ mp4: "clips/dmp_abcd1234/clp_aaaaaaaaaaaa-v2.mp4", jpg: "clips/dmp_abcd1234/clp_aaaaaaaaaaaa-v2.jpg" });
    const expect_ = { clipId: "clp_aaaaaaaaaaaa", look: "karaoke", ...k };
    const ok = { rerender: { clip_id: "clp_aaaaaaaaaaaa", look: "karaoke", r2_key: k.mp4, cover_r2_key: k.jpg, duration_s: 12.5, voice: null } };
    expect(parseRerender(ok, expect_)).toEqual({ duration_s: 12.5, voice: null, music: null });
    expect(parseRerender({ rerender: { ...ok.rerender, music: "music/upl_song0001" } }, expect_).music).toBe("music/upl_song0001");
    expect(parseRerender({ rerender: { ...ok.rerender, music: "raw/elsewhere" } }, expect_).music).toBeNull();
    expect(() => parseRerender({ rerender: { ...ok.rerender, r2_key: "clips/dmp_other/x.mp4" } }, expect_)).toThrow(CutResultError);
    expect(() => parseRerender({ rerender: { ...ok.rerender, look: "clean" } }, expect_)).toThrow(CutResultError);
    expect(() => parseRerender({ clips: [] }, expect_)).toThrow(CutResultError);
  });
  it("sources: saved parts, else start-end; the raw upload while kept, else the clip's own file", () => {
    expect(clipParts({ start_s: 1, end_s: 9, parts: "[[3,5],[1,9]]" })).toEqual([[3, 5], [1, 9]]);
    expect(clipParts({ start_s: 1, end_s: 9, parts: null })).toEqual([[1, 9]]);
    expect(clipSource({ raw_key: "raw/d/a", raw_deleted_at: null, r2_key: "clips/d/c.mp4", start_s: 20, end_s: 50 }, 10)).toEqual({ src: "raw/d/a", start: 20, end: 30 });
    expect(clipSource({ raw_key: "raw/d/a", raw_deleted_at: "2026-09-20", r2_key: "clips/d/c.mp4", start_s: 20, end_s: 25 }, 10)).toEqual({ src: "clips/d/c.mp4", start: 0, end: 5 });
  });
  it("Change look says plainly why it can't, and otherwise goes ahead", () => {
    const ok = { status: "draft" as const, look: "clean", pending_look: null, raw_deleted_at: null, in_buffer: false };
    expect(lookChangeRefusal(ok, "karaoke", false)).toBeNull();
    expect(lookChangeRefusal(null, "karaoke", false)?.status).toBe(404);
    expect(lookChangeRefusal(ok, "sparkles", false)?.status).toBe(422);
    expect(lookChangeRefusal({ ...ok, in_buffer: true }, "karaoke", false)?.error).toMatch(/Buffer/);
    expect(lookChangeRefusal({ ...ok, pending_look: "cinematic" }, "karaoke", false)?.error).toMatch(/about a minute/);
    expect(lookChangeRefusal({ ...ok, raw_deleted_at: "2026-09-18" }, "karaoke", false)?.error).toMatch(/cleared after 7 days/);
    expect(lookChangeRefusal(ok, "clean", false)?.error).toMatch(/already has that look/);
    // the same grid with different cells is a real change
    expect(lookChangeRefusal({ ...ok, look: "grid_four" }, "grid_four", false)).toBeNull();
    expect(lookChangeRefusal({ ...ok, look: "grid_four" }, "grid_four", true)?.status).toBe(409);
    // Change music keeps the look on purpose
    expect(lookChangeRefusal(ok, "clean", false, true)).toBeNull();
    expect(lookChangeRefusal({ ...ok, pending_look: "clean" }, "clean", false, true)?.status).toBe(409);
  });
});

// ---------------------------------------------------------------- a Change look, end to end on the real schema


describe("a re-render swaps the file in, keeps the old one until then, and re-mixes her voice over", () => {
  it("fake re-render → new file live, version bumped, old files gone, the attached voice over mixed again", async () => {
    const db = sqliteD1();
    const r2 = memoryR2();
    const env = { DB: db.DB, FILES: r2.FILES, FAKE_SERVICES: "1", PUBLIC_BASE_URL: "http://w.example", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", OWNER_EMAIL: "o@example.com" } as unknown as Env;
    db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_r1', 'new', '', 'ready');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_r1', 'dmp_r1', 'a.mp4', 'video/mp4', 'raw/dmp_r1/ast_r1', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, score, r2_key, cover_r2_key, media_token, status, look, pending_look, parts)
        VALUES ('clp_rrrrrrrrrrrr', 'ast_r1', 'dmp_r1', 5, 35, 'talking_head', 'Hook', 0.8, 'clips/dmp_r1/clp_rrrrrrrrrrrr.mp4', 'clips/dmp_r1/clp_rrrrrrrrrrrr.jpg', '${"t".repeat(40)}', 'draft', 'clean', 'karaoke', '[[5,35]]');
      INSERT INTO narrations (id, script, status, r2_key, clip_id, mixed_r2_key, mix_status) VALUES ('nar_r1', 'hi', 'ready', 'voice/narrations/nar_r1.wav', 'clp_rrrrrrrrrrrr', 'voice/mixed/nar_r1.mp4', 'ready');`);
    for (const k of ["clips/dmp_r1/clp_rrrrrrrrrrrr.mp4", "clips/dmp_r1/clp_rrrrrrrrrrrr.jpg", "voice/mixed/nar_r1.mp4"]) await r2.FILES.put(k, new Uint8Array(8));
    const spec = (await cutJob.buildSpec(env, "job_r1", "dmp_r1/clp_rrrrrrrrrrrr")) as { mode: string; look_id: string; parts: { src: string; start: number; end: number }[]; output_key: string };
    expect(spec).toMatchObject({ mode: "rerender", look_id: "karaoke", parts: [{ src: "raw/dmp_r1/ast_r1", start: 5, end: 35 }], output_key: "clips/dmp_r1/clp_rrrrrrrrrrrr-v1.mp4" });
    const result = await cutJob.fakeRun!(env, "job_r1", "dmp_r1/clp_rrrrrrrrrrrr", {});
    await cutJob.applyResult(env, "job_r1", "dmp_r1/clp_rrrrrrrrrrrr", result);
    const c = db.raw.prepare("SELECT look, pending_look, r2_key, media_version FROM clips").get();
    expect(c).toEqual({ look: "karaoke", pending_look: null, r2_key: "clips/dmp_r1/clp_rrrrrrrrrrrr-v1.mp4", media_version: 1 });
    expect(r2.objects.has("clips/dmp_r1/clp_rrrrrrrrrrrr.mp4")).toBe(false);
    expect(r2.objects.has("clips/dmp_r1/clp_rrrrrrrrrrrr-v1.mp4")).toBe(true);
    expect(db.raw.prepare("SELECT mix_status, mixed_r2_key FROM narrations").get()).toEqual({ mix_status: "mixing", mixed_r2_key: null });
    expect(r2.objects.has("voice/mixed/nar_r1.mp4")).toBe(false);
    expect(db.raw.prepare("SELECT type, ref_id FROM jobs WHERE type = 'voice'").get()).toEqual({ type: "voice", ref_id: "nar_r1" });
  });

  it("a failed re-render keeps the old file and says so on the clip", async () => {
    const db = sqliteD1();
    const env = { DB: db.DB, FILES: memoryR2().FILES, FAKE_SERVICES: "1" } as unknown as Env;
    db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_r2', 'new', '', 'ready');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_r2', 'dmp_r2', 'a.mp4', 'video/mp4', 'raw/dmp_r2/ast_r2', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, score, r2_key, media_token, status, look, pending_look, rerender_job_id)
        VALUES ('clp_ssssssssssss', 'ast_r2', 'dmp_r2', 0, 20, 'talking_head', 'Hook', 0.8, 'clips/dmp_r2/clp_ssssssssssss.mp4', '${"u".repeat(40)}', 'draft', 'clean', 'grid_four', 'job_r2');`);
    await cutJob.onFailure(env, "job_r2", "dmp_r2/clp_ssssssssssss", "ffmpeg exited 1");
    expect(db.raw.prepare("SELECT look, pending_look, r2_key, rerender_error FROM clips").get()).toEqual({
      look: "clean",
      pending_look: null,
      r2_key: "clips/dmp_r2/clp_ssssssssssss.mp4",
      rerender_error: "The new look didn't finish, so your clip is unchanged. Try Change look again.",
    });
  });
});
