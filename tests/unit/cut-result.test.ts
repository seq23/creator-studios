import { readFileSync } from "node:fs";
// The cut job's result is the contract between jobs/cut.py and the Worker. The fixture is a real
// run of the Python pipeline (jobs/selftest_cut.py --write-fixture), so if either side drifts
// this file fails.
import fixtureJson from "./fixtures/cut-result.sample.json";
import { describe, expect, it } from "vitest";
import { allowedPlatformsFor, CutResultError, MAX_CLIPS_PER_DUMP, MAX_PARTS, normalizeHashtags, parseCutResult, plainFailure, targetClips, type CutResultClip } from "@worker/jobs/cut";
import { PLATFORMS, QUALITY_BAR, type Platform } from "@shared/constants";
import { cellCount, isGridLook } from "@worker/domain/looks";
import { CLIP_TYPE_IDS } from "@shared/clipWords";

const fixture = fixtureJson as unknown as {
  dump_id: string;
  assets: { id: string; r2_key: string; allowed_platforms: Platform[] }[];
  result: { clips: CutResultClip[]; engine: Record<string, string>; assets: { id: string; duration_s: number }[] };
};

function ctx(allowed: Platform[] = [...PLATFORMS]) {
  return {
    dumpId: fixture.dump_id,
    allowed: new Map(fixture.assets.map((a) => [a.id, allowed])),
    rawKeys: new Set(fixture.assets.map((a) => a.r2_key)),
  };
}

function one(over: Partial<CutResultClip>): { clips: CutResultClip[] } {
  return { clips: [{ ...fixture.result.clips[0], ...over }] };
}

describe("cut result from the real pipeline", () => {
  // Studio fix A+B (23 Oct 2026): the engine now makes DISTINCT cuts only (the Oct 22 cut gave the
  // same cut in several looks), so this one-video dump yields fewer clips than before, each typed,
  // scored 0..100 with its reasons, and ending on its hero. The pins below are that new truth.
  it("the fixture is a real studio-fix run: distinct typed clips, 0..100 scores with reasons, every engine stage reported", () => {
    const clips = fixture.result.clips as (CutResultClip & { voice_script?: string | null })[];
    expect(clips.length).toBeGreaterThanOrEqual(2);
    for (const c of clips) {
      expect(CLIP_TYPE_IDS as readonly string[], c.id).toContain(c.clip_type);
      expect(Number.isInteger(c.score) && c.score >= 0 && c.score <= 100, `${c.id} score ${c.score}`).toBe(true);
      expect((c.score_reasons ?? []).length, c.id).toBeGreaterThan(0);
      expect(c.hero_asset_id, c.id).toBe(fixture.assets[0].id);
      expect(c.words_pending, c.id).toBe(false);
      // The caption is final: body, blank line, CTA line, blank line, the hashtags (no AI picture here, so no note).
      expect(c.caption, c.id).toMatch(/\S\n\n\S[^\n]*\n\n#\S/);
      expect(c.caption).not.toMatch(/Made with AI/);
    }
    // No two clips are the same cut.
    expect(new Set(clips.map((c) => JSON.stringify(c.parts))).size).toBe(clips.length);
    for (const k of ["transcript", "picker", "crop", "subtitles"]) expect(fixture.result.engine[k], k).toBeTruthy();
    expect(fixture.result.assets[0].duration_s).toBeGreaterThan(50);
    const r = fixture.result as unknown as { asset_roles: Record<string, string>; clip_counts: { distinct: number } };
    expect(["arrival", "prep", "team", "process", "finished", "detail", "hero"]).toContain(r.asset_roles[fixture.assets[0].id]);
    expect(r.clip_counts.distinct).toBe(clips.length);
  });

  it("every clip comes back in a Look, with its parts; the dump's clips use several Looks", () => {
    const looks = fixture.result.clips.map((c) => c.look);
    expect(looks.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    expect(new Set(looks).size).toBe(fixture.result.clips.length);
    for (const c of fixture.result.clips) expect(Array.isArray(c.parts) && c.parts!.length >= 1, c.id).toBe(true);
    const { clips } = parseCutResult(fixture.result, ctx());
    expect(clips.map((c) => c.look)).toEqual(looks);
    for (const c of clips) expect(c.look && isGridLook(c.look) ? c.layout?.cells.length : null, c.id).toBe(c.look && isGridLook(c.look) ? cellCount(c.look) : null);
  });

  it("the Worker accepts every clip the pipeline made, unchanged in substance", () => {
    const { clips, dropped } = parseCutResult(fixture.result, ctx());
    expect(dropped).toBe(0);
    expect(clips).toHaveLength(fixture.result.clips.length);
    for (const [i, c] of clips.entries()) {
      const src = fixture.result.clips[i];
      expect(c.id).toBe(src.id);
      expect(c.r2_key).toBe(`clips/${fixture.dump_id}/${c.id}.mp4`);
      expect(c.cover_r2_key).toBe(`clips/${fixture.dump_id}/${c.id}.jpg`);
      expect(c.hook_text).toBe(src.hook_text);
      expect(c.hidden).toBe(c.score < QUALITY_BAR);
      expect(c.hashtags).toMatch(/^(#[\p{L}\p{N}_]+)( #[\p{L}\p{N}_]+)*$/u);
      expect(c.platforms).toEqual(src.platforms);
    }
  });
});

describe("cut result guard rails", () => {
  it("refuses a result with no clip list or too many clips", () => {
    expect(() => parseCutResult(null, ctx())).toThrow(CutResultError);
    expect(() => parseCutResult({ stub: true }, ctx())).toThrow(CutResultError);
    const many = { clips: Array.from({ length: MAX_CLIPS_PER_DUMP + 1 }, () => fixture.result.clips[0]) };
    expect(() => parseCutResult(many, ctx())).toThrow("too many clips");
  });

  it("drops a clip that points outside this dump's clip folder or at the raw upload (never the identical file)", () => {
    expect(parseCutResult(one({ r2_key: "clips/dmp_other/clp_aaaaaaaaaaaa.mp4" }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ r2_key: fixture.assets[0].r2_key }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ cover_r2_key: "raw/x.jpg" }), ctx()).dropped).toBe(1);
  });

  it("drops bad ids, duplicates, unknown assets, unknown recipes and empty hooks", () => {
    expect(parseCutResult(one({ id: "../../etc" }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ asset_id: "ast_notinthisdump" }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ recipe: "ai_video" as never }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ hook_text: "   " }), ctx()).dropped).toBe(1);
    const dup = { clips: [fixture.result.clips[0], fixture.result.clips[0]] };
    expect(parseCutResult(dup, ctx())).toMatchObject({ dropped: 1 });
  });

  it("enforces length: at least 3 s, at most the recipe's maximum plus 1 s", () => {
    expect(parseCutResult(one({ recipe: "talking_head", start_s: 0, end_s: 2 }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ recipe: "talking_head", start_s: 0, end_s: 46 }), ctx()).dropped).toBe(0);
    expect(parseCutResult(one({ recipe: "talking_head", start_s: 0, end_s: 46.5 }), ctx()).dropped).toBe(1);
    expect(parseCutResult(one({ recipe: "story", start_s: 10, end_s: 100 }), ctx()).dropped).toBe(0);
    expect(parseCutResult(one({ recipe: "story", start_s: 10, end_s: 102 }), ctx()).dropped).toBe(1);
  });

  it("re-applies the recycle cooldown: platforms the spec did not allow are unticked, none left means dropped", () => {
    const r = parseCutResult(one({ platforms: ["tiktok", "instagram", "youtube"] }), ctx(["instagram", "youtube"]));
    expect(r.clips[0].platforms).toEqual(["instagram", "youtube"]);
    expect(parseCutResult(one({ platforms: ["tiktok"] }), ctx(["instagram"])).dropped).toBe(1);
  });

  it("stores every score as an integer 0..100 and hides clips under the quality bar", () => {
    // The studio-fix engine scores 0..100 (it sends a clip type and reasons): stored as it is, clamped, whole.
    expect(parseCutResult(one({ score: 3 }), ctx()).clips[0]).toMatchObject({ score: 3, hidden: true });
    expect(parseCutResult(one({ score: 150 }), ctx()).clips[0]).toMatchObject({ score: 100, hidden: false });
    expect(parseCutResult(one({ score: -1 }), ctx()).clips[0]).toMatchObject({ score: 0, hidden: true });
    expect(parseCutResult(one({ score: 72.6 }), ctx()).clips[0].score).toBe(73);
    expect(parseCutResult(one({ score: QUALITY_BAR - 1 }), ctx()).clips[0].hidden).toBe(true);
    expect(parseCutResult(one({ score: QUALITY_BAR }), ctx()).clips[0].hidden).toBe(false);
    // The studio's own bar wins for the engine's results.
    expect(parseCutResult(one({ score: 69 }), { ...ctx(), bar: 70 }).clips[0].hidden).toBe(true);
    expect(parseCutResult(one({ score: 70 }), { ...ctx(), bar: 70 }).clips[0].hidden).toBe(false);
    // An older engine's 0..1 score (no clip type, no reasons) lands on the same 0..100 scale.
    const old = { clip_type: undefined, score_reasons: undefined };
    expect(parseCutResult(one({ ...old, score: 0.752 }), ctx()).clips[0]).toMatchObject({ score: 75, hidden: false });
    expect(parseCutResult(one({ ...old, score: 0.44 }), ctx()).clips[0]).toMatchObject({ score: 44, hidden: true });
    expect(parseCutResult(one({ score: Number.NaN }), ctx()).dropped).toBe(1);
    // An editor's finished cut was never scored here: the bar never hides it.
    expect(parseCutResult(one({ clip_type: "imported", score: 50 }), { ...ctx(), bar: 70 }).clips[0]).toMatchObject({ score: 50, hidden: false, hidden_reason: null });
  });

  it("keeps a words-pending clip that has no hook yet (the words pass writes it); an empty hook otherwise is dropped", () => {
    const r = parseCutResult(one({ hook_text: "", caption: "", words_pending: true, voice_script: "1. **Analyze the Request:** * **Format:** short" } as Partial<CutResultClip>), ctx());
    expect(r.dropped).toBe(0);
    expect(r.clips[0]).toMatchObject({ hook_text: "", caption: "", words_pending: true, voice_script: null });
    expect(parseCutResult(one({ hook_text: "", words_pending: false }), ctx()).dropped).toBe(1);
  });

  it("stores the engine's voice script only when it is fit to speak (the Oct 22 failure string is rejected)", () => {
    expect(parseCutResult(one({ voice_script: "Watch the room come together. Book your date." } as Partial<CutResultClip>), ctx()).clips[0].voice_script).toBe("Watch the room come together. Book your date.");
    expect(parseCutResult(one({ voice_script: "1. **Analyze the Request:** * **Format:** a voice over" } as Partial<CutResultClip>), ctx()).clips[0].voice_script).toBeNull();
  });

  it("normalizes hashtags from a list or a string, deduped, max 15", () => {
    expect(normalizeHashtags(["#Morning", "morning", "small biz!", ""])).toBe("#Morning #smallbiz");
    expect(normalizeHashtags("#a, #b #a")).toBe("#a #b");
    expect(normalizeHashtags(Array.from({ length: 30 }, (_, i) => `t${i}`)).split(" ")).toHaveLength(15);
    expect(normalizeHashtags(undefined)).toBe("");
  });
});

describe("studio intelligence fields (shot sheet, plan, critic)", () => {
  const twoAssets = () => {
    const c = ctx();
    c.allowed.set("ast_otherone", [...PLATFORMS]);
    return c;
  };
  it("keeps a clip's shape, service and what is on screen; an unknown shape is dropped to null", () => {
    const r = parseCutResult(one({ shape: "transformation", service: "alpha work", on_screen: "an empty corner · the finished corner" }), ctx());
    expect(r.clips[0]).toMatchObject({ shape: "transformation", service: "alpha work", on_screen: "an empty corner · the finished corner" });
    expect(parseCutResult(one({ shape: "dance" }), ctx()).clips[0]!.shape).toBeNull();
  });
  it("a clip joining several videos names each part's video, and only this dump's videos", () => {
    const c0 = fixture.result.clips[0]!;
    const parts: [number, number][] = [[0, 3], [c0.start_s, c0.end_s]];
    const ok = parseCutResult(one({ parts, part_assets: ["ast_otherone", c0.asset_id] }), twoAssets());
    expect(ok.clips[0]!.part_assets).toEqual(["ast_otherone", c0.asset_id]);
    expect(parseCutResult(one({ parts, part_assets: ["ast_notinthisdump", c0.asset_id] }), twoAssets()).clips[0]!.part_assets).toBeNull();
    expect(parseCutResult(one({ parts, part_assets: [c0.asset_id] }), twoAssets()).clips[0]!.part_assets).toBeNull();
  });
  it("a before -> after clip keeps all its parts (up to MAX_PARTS) and each part's video", () => {
    const c0 = fixture.result.clips[0]!;
    const parts: [number, number][] = [[0, 3], [1, 3], [0, 2.5], [0, 4], [5, 9], [c0.start_s, c0.start_s + 6]];
    const r = parseCutResult(one({ parts, part_assets: ["ast_otherone", "ast_otherone", "ast_otherone", c0.asset_id, c0.asset_id, c0.asset_id] }), twoAssets());
    expect(r.clips[0]!.parts).toEqual(parts);
    expect(r.clips[0]!.part_assets).toHaveLength(6);
    expect(MAX_PARTS).toBe(8);
  });
  it("a clip the critic hid stays hidden whatever its score, with the reason in plain words", () => {
    const r = parseCutResult(one({ score: 95, hidden_reason: "the words did not match the picture" }), ctx());
    expect(r.clips[0]).toMatchObject({ score: 95, hidden: true, hidden_reason: "the words did not match the picture" });
    expect(parseCutResult(one({ score: 95 }), ctx()).clips[0]!).toMatchObject({ score: 95, hidden: false });
  });
});

describe("cut spec rules", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  it("Door A may go everywhere", () => {
    expect(allowedPlatformsFor({ original_platform: "tiktok", original_posted_at: "2026-09-20" }, [], "new", now, 90)).toEqual([...PLATFORMS]);
  });
  it("Door B waits 90 days on the platform it was posted to", () => {
    expect(allowedPlatformsFor({ original_platform: "tiktok", original_posted_at: "2026-08-01" }, [], "recycle", now, 90)).toEqual(["instagram", "youtube"]);
    expect(allowedPlatformsFor({ original_platform: "tiktok", original_posted_at: "2026-05-01" }, [], "recycle", now, 90)).toEqual([...PLATFORMS]);
  });
  it("Door B treats a known platform with an unknown date as recent, and counts our own earlier posts", () => {
    expect(allowedPlatformsFor({ original_platform: "instagram", original_posted_at: null }, [], "recycle", now, 90)).toEqual(["tiktok", "youtube"]);
    const ours = [{ platform: "youtube" as const, posted_at: "2026-09-01T00:00:00Z" }];
    expect(allowedPlatformsFor({ original_platform: "instagram", original_posted_at: null }, ours, "recycle", now, 90)).toEqual(["tiktok"]);
  });
  it("sizes the cut to the studio's own clips-per-dump setting, never to the calendar's need", () => {
    expect(targetClips({ clip_target: { min: 15, max: 30 } })).toEqual({ min: 15, max: 30 });
    expect(targetClips({ clip_target: { min: 8, max: 15 } })).toEqual({ min: 8, max: 15 });
    // The old "2–3 per open slot" sizing is gone from the spec builder.
    const cut = readFileSync("worker/jobs/cut.ts", "utf8");
    expect(cut).toMatch(/target_clips: steerTarget\(dumpCtl, targetClips\(rules\)\)/);
    expect(cut).not.toMatch(/targetClips\(need\)/);
  });
});

describe("plain failure words", () => {
  it("maps each job failure to a sentence with a next step, never echoing the raw error", () => {
    const cases: [string, RegExp][] = [
      ["NoUsableMoments", /usable moments/],
      ["CalledProcessError", /couldn't be read/],
      ["ClientError", /couldn't open your videos/],
      ["TimeoutExpired", /took too long/],
      ["CutResultError: result has no clip list", /something we couldn't use/],
      ["ZeroDivisionError", /Cutting stopped partway/],
    ];
    for (const [raw, want] of cases) {
      const out = plainFailure(raw);
      expect(out, raw).toMatch(want);
      expect(out).not.toContain(raw.split(":")[0]);
      expect(out.endsWith(".")).toBe(true);
    }
  });
});
