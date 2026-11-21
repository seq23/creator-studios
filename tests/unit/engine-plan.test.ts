// The content engine's plan check (engine/src/plan.ts): the committed plan passes, and each hard
// rule refuses the piece that breaks it: no prices, real-only formats never take an AI scene, reels
// never silent, the request link in every caption, no "Made with AI" caption line on engine pieces
// (risk R-END-03 filler exception), the posting window, no picture in two neighbouring pieces.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aiScene, localToUtc, validatePlan, type Plan, type PlanPiece } from "../../engine/src/plan";
// @ts-expect-error plain .mjs script with no types
import { ACCOUNT_CEILING, ENGINE_NEURON_CAP, MODELS, accountsFrom, fits, usedToday } from "../../engine/imagine.mjs";

const committed = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "engine", "plans", "pnp-2026-11-21.json"), "utf8")) as Plan;
const BEFORE = Date.parse("2026-11-20T12:00:00.000Z");

const base = (over: Partial<PlanPiece> = {}): PlanPiece => ({
  id: "test-piece",
  service: "event",
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
/** A rule's test plan with the rest of each week's range filled in (a romantic and a celebration set on every
 *  day used, on platforms and at a time the pieces under test do not use), so only the rule under test speaks. */
const full = (pieces: PlanPiece[]): Plan => {
  const days = [...new Set(pieces.map((p) => p.at.slice(0, 10)))];
  const set = (day: string, service: "romantic" | "celebration", platform: "facebook" | "instagram"): PlanPiece =>
    base({ id: `fill-${service}-${day}`, service, format: "carousel", at: `${day} 20:30`, platforms: [platform], music: undefined, lines: [], pics: [{ src: `ai:fill/${service}-${day}-a.webp` }, { src: `ai:fill/${service}-${day}-b.webp` }], captions: { [platform]: "Ideas. porchandparty901.com/request" } });
  return plan([...pieces, ...days.flatMap((d) => [set(d, "romantic", "facebook"), set(d, "celebration", "instagram")])]);
};

describe("the committed plan", () => {
  it("passes every check and starts Sat 21 Nov in the Memphis evening", () => {
    expect(validatePlan(committed, BEFORE)).toEqual([]);
    const first = [...committed.pieces].sort((a, b) => a.at.localeCompare(b.at))[0];
    expect(localToUtc(first.at, committed.tz)).toBe("2026-11-22T00:30:00.000Z");
  });
  it("runs through 30 Dec", () => {
    const last = [...committed.pieces].sort((a, b) => b.at.localeCompare(a.at))[0];
    expect(last.at.slice(0, 10)).toBe("2026-12-30");
  });
  it("an AI picture is an idea, never a job: only her real photos say we set it up", () => {
    const say = (where: Partial<PlanPiece>) => validatePlan(full([base(where)]), BEFORE).join();
    expect(say({ captions: { tiktok: "An idea for a porch. porchandparty901.com/request" } })).toBe("");
    expect(say({ hook: "A room we set up" })).toMatch(/AI picture but says "A room we set up"/);
    expect(say({ captions: { tiktok: "From a baby shower we did. porchandparty901.com/request" } })).toMatch(/we did/);
    expect(say({ pics: [{ src: "real:a.jpg" }], hook: "A room we set up" })).toBe("");
    // an offer of the service is not a claim of a past job
    expect(say({ captions: { tiktok: "We set up the porch and the table; let the table be our job. porchandparty901.com/request" } })).toBe("");
  });
  it("every picture to be made is used by a piece or is another picture's reference", () => {
    const used = new Set(committed.pieces.flatMap((p) => p.pics.map((x) => x.src)).filter((s) => s.startsWith("gen:")).map((s) => s.slice(4)));
    const refs = new Set(Object.values(committed.generate ?? {}).flatMap((e) => (typeof e === "object" && e.ref ? [e.ref] : [])));
    expect(Object.keys(committed.generate ?? {}).filter((f) => !used.has(f) && !refs.has(f))).toEqual([]);
  });
});

describe("hard rules", () => {
  it("accepts a clean piece", () => expect(validatePlan(full([base()]), BEFORE)).toEqual([]));
  it("every week shows the full range: a romantic, a celebration and an event piece, porch at most 2 of 7", () => {
    const day = (d: number, service: PlanPiece["service"], i: number) => base({ id: `p-${i}`, service, at: `2026-11-${String(d).padStart(2, "0")} 18:30`, pics: [{ src: `ai:x/${i}.webp` }] });
    const week = [day(21, "romantic", 1), day(22, "celebration", 2), day(23, "event", 3), day(24, "porch", 4), day(25, "porch", 5), day(26, "event", 6), day(27, "event", 7)];
    expect(validatePlan(plan(week), BEFORE)).toEqual([]);
    expect(validatePlan(plan(week.map((p) => (p.service === "romantic" ? { ...p, service: "event" as const } : p))), BEFORE).join()).toMatch(/week of 2026-11-21: no romantic piece/);
    expect(validatePlan(plan(week.map((p) => (p.service === "celebration" ? { ...p, service: "porch" as const } : p))), BEFORE).join()).toMatch(/no celebration piece/);
    expect(validatePlan(plan(week.map((p, i) => (i === 6 ? { ...p, service: "porch" as const } : p))), BEFORE).join()).toMatch(/3 porch pieces of 7/);
    // the second week is held to the same floor, short or not
    expect(validatePlan(plan([...week, day(28, "event", 8)]), BEFORE).join()).toMatch(/week of 2026-11-28: no romantic piece/);
    expect(validatePlan(plan([{ ...week[0], service: "party" as never }, ...week.slice(1)]), BEFORE).join()).toMatch(/service must be one of/);
  });
  it("no prices on screen or in captions", () => {
    expect(validatePlan(plan([base({ hook: "Porches from $350" })]), BEFORE).join()).toMatch(/no prices/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Only $350. porchandparty901.com/request" } })]), BEFORE).join()).toMatch(/no prices/);
  });
  it("a real-work format never takes an AI scene", () => {
    const pics = [1, 2, 3, 4].map((i) => ({ src: `real:p${i}.jpg` }));
    expect(validatePlan(full([base({ format: "real-montage", lines: [], pics })]), BEFORE)).toEqual([]);
    expect(validatePlan(plan([base({ format: "real-montage", lines: [], pics: [...pics.slice(0, 3), { src: "ai:x.webp" }] })]), BEFORE).join()).toMatch(/real photos only/);
  });
  it("a reel is never silent; every caption carries the request link and no 'Made with AI' line", () => {
    expect(validatePlan(plan([base({ music: undefined })]), BEFORE).join()).toMatch(/silent/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Tell us the date." } })]), BEFORE).join()).toMatch(/must carry/);
    expect(validatePlan(plan([base({ captions: { tiktok: "Idea. porchandparty901.com/request\n\nMade with AI" } })]), BEFORE).join()).toMatch(/Made with AI/);
  });
  it("a set hook height stays inside the safe area", () => {
    expect(validatePlan(full([base({ hookY: 0.55 })]), BEFORE)).toEqual([]);
    expect(validatePlan(plan([base({ hookY: 0.8 })]), BEFORE).join()).toMatch(/hookY sits between/);
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
    expect(validatePlan(full([a, c, week]), BEFORE)).toEqual([]);
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
    expect(validatePlan({ ...full([p]), generate: { "porch.jpg": "a porch" } }, BEFORE)).toEqual([]);
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
