// The content engine's plan check (engine/src/plan.ts): the committed plan passes, and each hard
// rule refuses the piece that breaks it: no prices, real-only formats never take an AI scene, reels
// never silent, the request link in every caption, no bare "Made with AI" caption line on engine
// pieces (risk R-END-03 filler exception; the photo note's sentence is allowed, 24 Nov 2026), "our
// real setup" never over an AI scene, the posting window, no picture in two neighbouring pieces.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEVER_USE, aiScene, localToUtc, validatePlan, type Plan, type PlanPiece } from "../../engine/src/plan";
import { FORMATS } from "../../engine/src/library";
import { PHOTO_NOTE } from "../../engine/src/brand";
// @ts-expect-error plain .mjs script with no types
import { ACCOUNT_CEILING, ENGINE_NEURON_CAP, MODELS, accountsFrom, fits, usedToday } from "../../engine/imagine.mjs";

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

// Three pieces failed their second review on 20 Nov 2026 and were dropped from the plan, not forced
// (engine/README.md): the countdown and wait-for-it reels (22 Nov, 2 Dec) and the 1 Dec baby-shower set.
const DROPPED_FORMATS = new Set(["countdown", "wait-for-it"]);
describe("the committed plan", () => {
  it("passes every check, uses every format but the two dropped ones, and starts Sat 21 Nov in the Memphis evening", () => {
    expect(validatePlan(committed, BEFORE)).toEqual([]);
    expect(new Set(committed.pieces.map((p) => p.format))).toEqual(new Set(FORMATS.map((f) => f.id).filter((f) => !DROPPED_FORMATS.has(f))));
    const first = [...committed.pieces].sort((a, b) => a.at.localeCompare(b.at))[0];
    expect(localToUtc(first.at, committed.tz)).toBe("2026-11-22T00:30:00.000Z");
  });
  it("covers two weeks with one reel a day, except the two days whose reel was dropped", () => {
    const reelDays = [...new Set(committed.pieces.filter((p) => p.format !== "carousel").map((p) => p.at.slice(0, 10)))].sort();
    const want = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 10, 21 + i)).toISOString().slice(0, 10)).filter((d) => d !== "2026-11-22" && d !== "2026-12-02");
    expect(reelDays).toEqual(want);
  });
  it("every picture to be made is used by a piece or is another picture's reference", () => {
    const used = new Set(committed.pieces.flatMap((p) => p.pics.map((x) => x.src)).filter((s) => s.startsWith("gen:")).map((s) => s.slice(4)));
    const refs = new Set(Object.values(committed.generate ?? {}).flatMap((e) => (typeof e === "object" && e.ref ? [e.ref] : [])));
    expect(Object.keys(committed.generate ?? {}).filter((f) => !used.has(f) && !refs.has(f))).toEqual([]);
  });
});

describe("hard rules", () => {
  it("accepts a clean piece", () => expect(validatePlan(plan([base()]), BEFORE)).toEqual([]));
  it("no prices on screen or in captions", () => {
    expect(validatePlan(plan([base({ hook: "Porches from $350" })]), BEFORE).join()).toMatch(/no prices/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Only $350. porchandparty901.com/request" } })]), BEFORE).join()).toMatch(/no prices/);
  });
  it("her seven never-use photos (24 Nov 2026) are refused under any prefix; her porch picks pass", () => {
    expect(NEVER_USE.length).toBe(7);
    for (const f of NEVER_USE) for (const k of ["ai", "real", "gen"]) expect(validatePlan(plan([base({ pics: [{ src: `${k}:${f}` }] })]), BEFORE).join()).toMatch(/never to use/);
    expect(validatePlan(plan([base({ pics: [{ src: "ai:porch/bartlett-small-front-porch-styling-under-500.jpg" }] })]), BEFORE)).toEqual([]);
    expect(committed.pieces.flatMap((p) => p.pics).filter((x) => NEVER_USE.includes(x.src.slice(x.src.indexOf(":") + 1)))).toEqual([]);
  });
  it('"Connect Four" (Hasbro) is refused on screen and in captions; "giant four-in-a-row" passes', () => {
    expect(validatePlan(plan([base({ hook: "Cornhole or Giant Connect Four?" })]), BEFORE).join()).toMatch(/Hasbro/);
    expect(validatePlan(plan([base({ pics: [{ src: "ai:porch/x.webp", label: "connect-4" }] })]), BEFORE).join()).toMatch(/Hasbro/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Giant Connect 4 for the yard. porchandparty901.com/request" } })]), BEFORE).join()).toMatch(/Hasbro/);
    expect(validatePlan(plan([base({ hook: "Cornhole or giant four-in-a-row?" })]), BEFORE)).toEqual([]);
  });
  it("a real-work format never takes an AI scene", () => {
    const pics = [1, 2, 3, 4].map((i) => ({ src: `real:p${i}.jpg` }));
    expect(validatePlan(plan([base({ format: "real-montage", lines: [], pics })]), BEFORE)).toEqual([]);
    expect(validatePlan(plan([base({ format: "real-montage", lines: [], pics: [...pics.slice(0, 3), { src: "ai:x.webp" }] })]), BEFORE).join()).toMatch(/real photos only/);
  });
  it("a reel is never silent; every caption carries the request link and no bare 'Made with AI' line", () => {
    expect(validatePlan(plan([base({ music: undefined })]), BEFORE).join()).toMatch(/silent/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Tell us the date." } })]), BEFORE).join()).toMatch(/must carry/);
    for (const tail of ["Made with AI", "made with ai.", "—\nMade with AI", "- Made with AI ✨"]) {
      expect(validatePlan(plan([base({ captions: { tiktok: `Idea. porchandparty901.com/request\n\n${tail}` } })]), BEFORE).join(), tail).toMatch(/Made with AI/);
    }
  });
  it("the photo note's own sentence may sit in a caption (24 Nov 2026)", () => {
    expect(validatePlan(plan([base({ captions: { tiktok: `Idea for your porch. porchandparty901.com/request\n\n${PHOTO_NOTE}.` } })]), BEFORE)).toEqual([]);
  });
  it("'our real setup' is for our own jobs: refused over an AI scene, fine over real photos", () => {
    const realPics = [{ src: "real:hotel-1.jpg" }, { src: "real:shower-1.jpg" }];
    const says = "Our real setup from last weekend. porchandparty901.com/request";
    // caption, hook, line and end line over a piece with an AI scene (ai: and gen: alike)
    expect(validatePlan(plan([base({ captions: { tiktok: says } })]), BEFORE).join()).toMatch(/caption calls an AI scene our real setup/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Our real set-up. porchandparty901.com/request" } })]), BEFORE).join()).toMatch(/our real setup/);
    expect(validatePlan(plan([base({ hook: "Our real setup" })]), BEFORE).join()).toMatch(/on-screen words call an AI scene/);
    expect(validatePlan(plan([base({ lines: ["Real setups, Memphis"] })]), BEFORE).join()).toMatch(/on-screen words call an AI scene/);
    expect(validatePlan(plan([base({ endLine: "Our real setup" })]), BEFORE).join()).toMatch(/on-screen words call an AI scene/);
    const mixed = base({ format: "carousel", lines: [], music: undefined, pics: [{ src: "real:hotel-1.jpg", label: "Our real setup" }, { src: "ai:porch/x.webp", label: "Our real setup" }] });
    expect(validatePlan(plan([mixed]), BEFORE).join()).toMatch(/on-screen words call an AI scene/);
    // the same words over our own photos pass; a real photo's own label may say it in a mixed set
    expect(validatePlan(plan([base({ pics: realPics, hook: "Our real setup", captions: { tiktok: says } })]), BEFORE)).toEqual([]);
    const labelled = base({ format: "carousel", lines: [], music: undefined, pics: [{ src: "real:hotel-1.jpg", label: "Our real setup" }, { src: "ai:porch/x.webp", label: "What we can set up for you" }] });
    expect(validatePlan(plan([labelled]), BEFORE)).toEqual([]);
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
  it("one real setup at most once a week across pieces (other shots of it count)", () => {
    const a = base({ id: "piece-a", at: "2026-11-21 18:30", pics: [{ src: "real:hotel-28-balloons-1.png" }] });
    const c = base({ id: "piece-c", at: "2026-11-22 18:30" });
    const near = base({ id: "piece-b", at: "2026-11-23 18:30", pics: [{ src: "real:hotel-28-balloons-2.png" }] });
    const week = base({ id: "piece-b", at: "2026-11-28 18:30", pics: [{ src: "real:hotel-28-balloons-2.png" }] });
    expect(validatePlan(plan([a, c, near]), BEFORE).join()).toMatch(/real setup "hotel-28-balloons" was in piece-a/);
    expect(validatePlan(plan([a, c, week]), BEFORE)).toEqual([]);
  });
  it("marks a piece with any AI picture as an AI scene (TikTok's switch), a real-only piece not", () => {
    expect(aiScene(base())).toBe(true);
    expect(aiScene(base({ pics: [{ src: "real:a.jpg" }] }))).toBe(false);
  });
});

describe("new scenes on Workers AI (engine/imagine.mjs): metered, fail closed", () => {
  it("a gen: picture needs its prompt in the plan, and counts as an AI scene", () => {
    const p = base({ pics: [{ src: "gen:porch.jpg" }] });
    expect(validatePlan(plan([p]), BEFORE).join()).toMatch(/no prompt/);
    expect(validatePlan({ ...plan([p]), generate: { "porch.jpg": "a porch" } }, BEFORE)).toEqual([]);
    expect(aiScene(p)).toBe(true);
  });
  it("usage that cannot be read makes nothing", async () => {
    expect(await usedToday({ account: "a", token: "t", fetchImpl: async () => new Response("{}", { status: 403 }) })).toBeNull();
    expect(await usedToday({ account: "a", token: "t", fetchImpl: async () => { throw new Error("offline"); } })).toBeNull();
  });
  it("stops at the engine's 1,500 neurons a day and before the account passes 9,000", async () => {
    const used = await usedToday({ account: "a", token: "t", fetchImpl: async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 1400 }, dimensions: { modelId: "@cf/black-forest-labs/flux-2-klein-9b" } }, { sum: { totalNeurons: 3000 }, dimensions: { modelId: "@cf/other" } }] }] } } })) });
    expect(used).toEqual({ mine: 1400, all: 4400 });
    expect(ENGINE_NEURON_CAP).toBe(1500);
    expect(fits(used, 0, 150)).toBe(false);
    expect(fits({ mine: 0, all: 0 }, 1400, 150)).toBe(false); // this run's own calls count before analytics catches up
    expect(fits({ mine: 100, all: ACCOUNT_CEILING - 100 }, 0, 150)).toBe(false);
    expect(fits({ mine: 100, all: 2000 }, 0, 150)).toBe(true);
    // FLUX.2 klein 9B measured ~1,705 a picture: it never fits the engine's day
    expect(fits({ mine: 0, all: 0 }, 0, MODELS["@cf/black-forest-labs/flux-2-klein-9b"].worst)).toBe(false);
  });
  it("falls back to the second, engine-only account, which still stops before 9,000", () => {
    expect(accountsFrom({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }).map((x: { name: string }) => x.name)).toEqual(["main"]);
    const both = accountsFrom({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", CF2_ACCOUNT_ID: "b", CF2_WORKERS_AI_TOKEN: "u" });
    expect(both.map((x: { name: string; account: string; cap: number }) => [x.name, x.account, x.cap])).toEqual([["main", "a", ENGINE_NEURON_CAP], ["second", "b", ACCOUNT_CEILING]]);
    const klein = MODELS["@cf/black-forest-labs/flux-2-klein-9b"].worst;
    expect(fits({ mine: 0, all: 0 }, 0, klein, both[1].cap)).toBe(true);
    expect(fits({ mine: 7500, all: 7500 }, 0, klein, both[1].cap)).toBe(false);
    // the same account twice is never a fallback
    expect(accountsFrom({ CLOUDFLARE_ACCOUNT_ID: "a", CF2_ACCOUNT_ID: "a", CF2_WORKERS_AI_TOKEN: "u" })).toHaveLength(1);
  });
});
