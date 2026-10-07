// The cut job's result is the contract between jobs/cut.py and the Worker. The fixture is a real
// run of the Python pipeline (jobs/selftest_cut.py --write-fixture), so if either side drifts
// this file fails.
import fixtureJson from "./fixtures/cut-result.sample.json";
import { describe, expect, it } from "vitest";
import { allowedPlatformsFor, CutResultError, MAX_CLIPS_PER_DUMP, normalizeHashtags, parseCutResult, plainFailure, targetClips, type CutResultClip } from "@worker/jobs/cut";
import { PLATFORMS, QUALITY_BAR, type Platform } from "@shared/constants";
import { cellCount, isGridLook } from "@worker/domain/looks";

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
  it("the fixture is a real multi-recipe run with every engine stage reported", () => {
    expect(fixture.result.clips.length).toBeGreaterThanOrEqual(4);
    expect(new Set(fixture.result.clips.map((c) => c.recipe)).size).toBeGreaterThanOrEqual(3);
    for (const k of ["transcript", "picker", "crop", "subtitles"]) expect(fixture.result.engine[k], k).toBeTruthy();
    expect(fixture.result.assets[0].duration_s).toBeGreaterThan(50);
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

  it("clamps the score to 0..1 and hides clips under the quality bar", () => {
    expect(parseCutResult(one({ score: 3 }), ctx()).clips[0]).toMatchObject({ score: 1, hidden: false });
    expect(parseCutResult(one({ score: -1 }), ctx()).clips[0]).toMatchObject({ score: 0, hidden: true });
    expect(parseCutResult(one({ score: QUALITY_BAR - 0.01 }), ctx()).clips[0].hidden).toBe(true);
    expect(parseCutResult(one({ score: QUALITY_BAR }), ctx()).clips[0].hidden).toBe(false);
    expect(parseCutResult(one({ score: Number.NaN }), ctx()).dropped).toBe(1);
  });

  it("normalizes hashtags from a list or a string, deduped, max 15", () => {
    expect(normalizeHashtags(["#Morning", "morning", "small biz!", ""])).toBe("#Morning #smallbiz");
    expect(normalizeHashtags("#a, #b #a")).toBe("#a #b");
    expect(normalizeHashtags(Array.from({ length: 30 }, (_, i) => `t${i}`)).split(" ")).toHaveLength(15);
    expect(normalizeHashtags(undefined)).toBe("");
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
  it("makes 2–3× the weekly need", () => {
    expect(targetClips(10)).toEqual({ min: 20, max: 30 });
    expect(targetClips(0)).toEqual({ min: 2, max: 3 });
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
