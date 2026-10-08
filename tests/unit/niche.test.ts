// A studio's niche comes from its own locked Brand Profile, never a hardcoded one
// (worker/domain/brandfit.ts nicheWords + themeHit). Found live on sample1, 7 Oct 2026: the brand
// finder searched hosting / tablescape / home decor for every studio, the offer reader counted any
// email mentioning "home", "table" or "gift" as on-theme, and the marketplace cards promised
// "tableware and decor you already show" to every creator.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nicheWords, themeHit } from "@worker/domain/brandfit";
import { MARKETPLACES } from "@worker/domain/marketplaces";

const HOST_NICHE = /hosting|tablescape|tableware|home decor|\bdecor\b|dinner part|your tables|home and lifestyle/i;

describe("her niche words come from her themes", () => {
  it("takes the words before each theme's colon, skipping filler and short words", () => {
    expect(nicheWords(["Strength training: from zero to a pull-up", "Meal prep for busy weeks", "Running"])).toEqual(["strength", "training", "meal", "prep", "busy", "weeks"]);
    expect(nicheWords(["Tablescapes: from bare cloth to candles lit", "Dinner parties"])).toEqual(["tablescapes", "dinner", "parties"]);
  });
  it("no themes means no niche words, never a borrowed one", () => {
    expect(nicheWords([])).toEqual([]);
  });
});

describe("an offer is on-theme only by HER themes", () => {
  it("a fitness creator's offer from a home brand is not on-theme; one about training is", () => {
    const themes = ["Strength training: at home", "Meal prep"];
    expect(themeHit("We'd love you to feature our new candle and tableware gift set", themes)).toBe(false);
    expect(themeHit("Our protein brand would love a video about your training", themes)).toBe(true);
  });
  it("the host-accounts studio keeps working from its own themes (stems: tablescape hits Tablescapes)", () => {
    expect(themeHit("A tablescape collab for our linen line", ["Tablescapes: from bare cloth to candles lit"])).toBe(true);
  });
  it("no themes: nothing is on-theme (the old home|table|gift fallback is gone)", () => {
    expect(themeHit("home table gift decor kitchen candle", [])).toBe(false);
  });
});

describe("no hardcoded niche in what every studio ships or searches", () => {
  it("marketplace cards speak to any creator", () => {
    expect(MARKETPLACES.length).toBeGreaterThan(5);
    for (const m of MARKETPLACES) expect(m.payoff, m.key).not.toMatch(HOST_NICHE);
  });
  it("the brand finder spec and the offer reader read the profile, not a fixed list", () => {
    const finder = readFileSync("worker/jobs/brand_finder.ts", "utf8");
    const spec = finder.slice(finder.indexOf("async buildSpec"), finder.indexOf("async applyResult"));
    expect(spec).toContain("niche_words: nicheWords(themeList(profile?.themes))");
    expect(spec).not.toMatch(HOST_NICHE);
    const deals = readFileSync("worker/routes/deals.ts", "utf8");
    expect(deals).toContain("themeHit(`${text} ${b.name}`, themeList(profile?.themes))");
    expect(deals).not.toMatch(/\(home\|host\|table/);
  });
});
