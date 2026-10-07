// Rate card, rate helper and negotiation math (worker/domain/ratecard.ts). The rule that matters
// most: the helper never states a number without its source, and says "no benchmark" when it
// has none.
import { describe, expect, it } from "vitest";
import { ADDON_BASIS, DEFAULT_ADDONS, SOURCES, counterOffer, engagementRate, leverScripts, quote, suggestPackage, suggestRate, threeOptions, tiktokTypicalEngagement, tierFor, type RatePackage } from "@worker/domain/ratecard";

const pkg = (p: Partial<RatePackage>): RatePackage => ({ id: "p", name: "Pkg", items: [{ key: "tiktok_video", qty: 1 }], startingAt: null, onRequest: false, floor: null, target: null, note: "", showOnKit: true, ...p });

describe("rate helper: never a made-up number", () => {
  it("her own agreed fees beat any benchmark, and the arithmetic is shown", () => {
    const s = suggestRate("tiktok_video", 12_400, [400, 600]);
    expect(s).toMatchObject({ kind: "own", startingAt: 500, target: 600, floor: 400, sources: [] });
    expect(s.formula).toContain("$400 + $600");
  });
  it("a published tier range is used only for a size the source covers, with the source named", () => {
    const nano = suggestRate("tiktok_video", 5_000);
    expect(nano).toMatchObject({ kind: "tier", startingAt: 200, target: 350, floor: 200 });
    expect(nano.sources).toEqual([SOURCES.later2026]);
    expect(nano.formula).toContain("($200 + $500) ÷ 2 = $350");
    expect(suggestRate("ig_reel", 12_400)).toMatchObject({ kind: "tier", startingAt: 800, target: 1650 });
  });
  it("a platform average says it is not by size and sets no floor", () => {
    const s = suggestRate("yt_short", 2_100);
    expect(s).toMatchObject({ kind: "platform", startingAt: 255, floor: null });
    expect(s.formula).toMatch(/not a figure for your size/);
    expect(s.sources).toEqual([SOURCES.collabstr2026]);
  });
  it("outside the sourced tiers, or with no numbers, it says plainly there is no benchmark", () => {
    for (const s of [suggestRate("tiktok_video", 500), suggestRate("tiktok_video", 250_000), suggestRate("ig_story_set", 20_000), suggestRate("tiktok_video", null)]) {
      expect(s.kind).toBe("none");
      expect(s.startingAt).toBeNull();
      expect(s.target).toBeNull();
      expect(s.sources).toEqual([]);
      expect(s.formula).toMatch(/[Nn]o (published )?benchmark/);
    }
    expect(tierFor(999)).toBeNull();
    expect(tierFor(1_000)).toBe("nano");
    expect(tierFor(99_999)).toBe("micro");
  });
  it("a package is suggested only when every item has a basis; the bundle discount is shown", () => {
    const s = suggestPackage([{ key: "tiktok_video", qty: 2 }, { key: "ig_reel", qty: 1 }], { tiktok: 5_000, instagram: 5_000 }, DEFAULT_ADDONS);
    expect(s.startingAt).toBe(540); // (2×200 + 200) × 0.9
    expect(s.formula).toContain("less your 10% bundle discount");
    const none = suggestPackage([{ key: "tiktok_video", qty: 1 }, { key: "ig_story_set", qty: 1 }], { tiktok: 5_000, instagram: 50_000 }, DEFAULT_ADDONS);
    expect(none.kind).toBe("none");
    expect(none.startingAt).toBeNull();
  });
  it("every source is a real https link with a checked date, and every add-on names its basis", () => {
    for (const s of Object.values(SOURCES)) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.checked).toBe("2026-09-25");
    }
    for (const [k, b] of Object.entries(ADDON_BASIS)) expect(b.text.length, k).toBeGreaterThan(10);
    expect(ADDON_BASIS.rushPct.text).toMatch(/No published benchmark/);
    expect(ADDON_BASIS.usagePctPer30d.sources.length).toBeGreaterThan(0);
  });
});

describe("quote with add-ons", () => {
  it("base covers 30 days; each add-on line shows its arithmetic", () => {
    const q = quote(500, { usageDays: 90, paidUsageDays: 30, exclusivityMonths: 2 }, DEFAULT_ADDONS);
    expect(q.lines.map((l) => l.amount)).toEqual([500, 300, 200, 250]);
    expect(q.lines[1].math).toBe("$500 × 30% × 2 × 30 days = $300");
    expect(q.total).toBe(1250);
    expect(quote(500, {}, DEFAULT_ADDONS).lines).toHaveLength(1);
  });
  it("rush is only charged when she set a rush fee", () => {
    expect(quote(400, { rush: true }, DEFAULT_ADDONS).total).toBe(400);
    expect(quote(400, { rush: true }, { ...DEFAULT_ADDONS, rushPct: 25 }).total).toBe(500);
  });
});

describe("three options, anchored high", () => {
  it("full (with usage) first, then standard, then entry; on-request stays on request", () => {
    const opts = threeOptions([pkg({ id: "a", name: "One TikTok", startingAt: 300 }), pkg({ id: "b", name: "Bundle", items: [{ key: "tiktok_video", qty: 3 }], startingAt: 750 }), pkg({ id: "c", name: "UGC", items: [{ key: "ugc_video", qty: 1 }], startingAt: 180 }), pkg({ id: "d", name: "Story", onRequest: true })], DEFAULT_ADDONS)!;
    expect(opts.map((o) => o.tier)).toEqual(["full", "standard", "entry"]);
    expect(opts[0]).toMatchObject({ name: "Bundle", price: 1200 }); // 750 + 90 days usage (60 extra days × 30% × 2)
    expect(opts[2]).toMatchObject({ name: "UGC", price: 180 });
    expect(opts[0].price!).toBeGreaterThan(opts[1].price!);
  });
  it("no priced packages: no options (the email says rates on request instead)", () => {
    expect(threeOptions([], DEFAULT_ADDONS)).toBeNull();
    expect(threeOptions([pkg({ startingAt: null })], DEFAULT_ADDONS)).toBeNull();
  });
});

describe("counter-offer calculator", () => {
  const p = pkg({ name: "Bundle", items: [{ key: "tiktok_video", qty: 3 }], floor: 600, target: 900 });
  it("at or above target: say yes", () => expect(counterOffer(900, p)).toMatchObject({ verdict: "accept", counter: 900 }));
  it("between floor and target: counter at target, with the gap shown", () => {
    const r = counterOffer(700, p);
    expect(r).toMatchObject({ verdict: "counter", counter: 900 });
    expect(r.math[0]).toContain("22% under your target $900");
  });
  it("under the floor: trade scope, not price (pieces at the per-piece floor)", () => {
    const r = counterOffer(450, p);
    expect(r).toMatchObject({ verdict: "trim", counter: 400 });
    expect(r.math[1]).toContain("$600 ÷ 3 = $200");
    expect(r.line).toMatch(/Trade the scope, not the price/);
  });
  it("under one piece at the floor: walk away politely", () => expect(counterOffer(150, p).verdict).toBe("walk"));
  it("no floor or target set: asks her to set them, never guesses", () => expect(counterOffer(500, pkg({ floor: null, target: 800 }))).toMatchObject({ verdict: "no_floor", counter: null }));
});

describe("engagement for the kit", () => {
  const v = (views: number, acts: number, days = 5) => ({ platform: "tiktok" as const, views, likes: acts, comments: 0, shares: 0, saves: 0, posted_at: new Date(Date.UTC(2026, 8, 25) - days * 86400_000).toISOString() });
  const now = new Date("2026-09-25T00:00:00Z");
  it("is (likes+comments+shares+saves) ÷ views over 90 days, from 3 videos up", () => {
    expect(engagementRate([v(1000, 50), v(1000, 30), v(2000, 20)], "tiktok", now)).toEqual({ rate: 2.5, videos: 3 });
    expect(engagementRate([v(1000, 50), v(1000, 30)], "tiktok", now)).toBeNull();
    expect(engagementRate([v(1000, 50), v(1000, 30), v(1000, 30, 120)], "tiktok", now)).toBeNull();
  });
  it("the typical-rate comparison exists only for TikTok bands the source covers", () => {
    expect(tiktokTypicalEngagement(12_400)).toMatchObject({ rate: 3.9, band: "10K–50K followers" });
    expect(tiktokTypicalEngagement(900)).toBeNull();
    expect(tiktokTypicalEngagement(80_000)).toBeNull();
  });
});

describe("what to say when they push", () => {
  it("one script per lever, with her own terms filled in", () => {
    const l = leverScripts({ ...DEFAULT_ADDONS, netDays: 30, exclusivityPctPerMonth: 25 });
    expect(l.map((x) => x.key)).toEqual(["price", "usage", "exclusivity", "payment", "revisions", "rush"]);
    expect(l.find((x) => x.key === "exclusivity")!.say).toContain("25% of the fee per month");
    expect(l.find((x) => x.key === "payment")!.say).toContain("net-30");
    expect(l.find((x) => x.key === "price")!.say).toMatch(/trimming the scope/);
  });
});
