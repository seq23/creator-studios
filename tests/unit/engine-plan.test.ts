// The content engine's plan check (engine/src/plan.ts): the committed plan passes, and each hard
// rule refuses the piece that breaks it: no prices, real-only formats never take an AI scene, reels
// never silent, the request link in every caption, no "Made with AI" caption line on engine pieces
// (risk R-END-03 filler exception), the posting window, no picture in two neighbouring pieces.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aiScene, localToUtc, validatePlan, type Plan, type PlanPiece } from "../../engine/src/plan";
import { FORMATS } from "../../engine/src/library";

const committed = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "engine", "plans", "pnp-2026-11-21.json"), "utf8")) as Plan;
const BEFORE = Date.parse("2026-11-20T12:00:00.000Z");

const base = (over: Partial<PlanPiece> = {}): PlanPiece => ({
  id: "test-piece",
  format: "pov",
  at: "2026-11-21 18:30",
  platforms: ["tiktok"],
  music: "slow-glow",
  pics: [{ src: "ai:porch/x.webp" }],
  hook: "POV: the porch is done",
  lines: ["One form"],
  captions: { tiktok: "Tell us the date. porchandparty901.com/request" },
  ...over,
});
const plan = (pieces: PlanPiece[]): Plan => ({ studio: "sample1", brand: "pnp", tz: "America/Chicago", window: [17, 21], cta: "porchandparty901.com/request", pieces });

describe("the committed plan", () => {
  it("passes every check, uses all 15 formats, and starts Sat 21 Nov in the Memphis evening", () => {
    expect(validatePlan(committed, BEFORE)).toEqual([]);
    expect(new Set(committed.pieces.map((p) => p.format))).toEqual(new Set(FORMATS.map((f) => f.id)));
    const first = [...committed.pieces].sort((a, b) => a.at.localeCompare(b.at))[0];
    expect(localToUtc(first.at, committed.tz)).toBe("2026-11-22T00:30:00.000Z");
  });
  it("covers two weeks with one reel a day", () => {
    const reelDays = new Set(committed.pieces.filter((p) => p.format !== "carousel").map((p) => p.at.slice(0, 10)));
    expect(reelDays.size).toBe(14);
  });
});

describe("hard rules", () => {
  it("accepts a clean piece", () => expect(validatePlan(plan([base()]), BEFORE)).toEqual([]));
  it("no prices on screen or in captions", () => {
    expect(validatePlan(plan([base({ hook: "Porches from $350" })]), BEFORE).join()).toMatch(/no prices/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Only $350. porchandparty901.com/request" } })]), BEFORE).join()).toMatch(/no prices/);
  });
  it("a real-work format never takes an AI scene", () => {
    const pics = [1, 2, 3, 4].map((i) => ({ src: `real:p${i}.jpg` }));
    expect(validatePlan(plan([base({ format: "real-montage", lines: [], pics })]), BEFORE)).toEqual([]);
    expect(validatePlan(plan([base({ format: "real-montage", lines: [], pics: [...pics.slice(0, 3), { src: "ai:x.webp" }] })]), BEFORE).join()).toMatch(/real photos only/);
  });
  it("a reel is never silent; every caption carries the request link and no 'Made with AI' line", () => {
    expect(validatePlan(plan([base({ music: undefined })]), BEFORE).join()).toMatch(/silent/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Tell us the date." } })]), BEFORE).join()).toMatch(/must carry/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Idea. porchandparty901.com/request\n\nMade with AI" } })]), BEFORE).join()).toMatch(/Made with AI/);
  });
  it("posts only inside the window and in the future", () => {
    expect(validatePlan(plan([base({ at: "2026-11-21 11:00" })]), BEFORE).join()).toMatch(/window/);
    expect(validatePlan(plan([base({ at: "2026-11-19 18:30" })]), BEFORE).join()).toMatch(/future/);
  });
  it("no picture in two neighbouring pieces", () => {
    const a = base({ id: "piece-a", at: "2026-11-21 18:30" });
    const b = base({ id: "piece-b", at: "2026-11-22 18:30" });
    expect(validatePlan(plan([a, b]), BEFORE).join()).toMatch(/repeats ai:porch\/x.webp/);
  });
  it("marks a piece with any AI picture as an AI scene (TikTok's switch), a real-only piece not", () => {
    expect(aiScene(base())).toBe(true);
    expect(aiScene(base({ pics: [{ src: "real:a.jpg" }] }))).toBe(false);
  });
});
