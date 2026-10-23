// Studio intelligence (owner's plan, 22 Oct 2026): every service label comes from the studio's own
// Brand Profile. Four unlike fixture businesses (tests/fixtures/businesses, also read by
// jobs/tests/test_see_plan.py) each get their own labels, and none of them appears in code.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { servicesOf } from "@shared/services";

const DIR = path.join("tests", "fixtures", "businesses");
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as { slug: string; profile: Record<string, string>; services: string[] });

describe("servicesOf: the services come from the Brand Profile", () => {
  it("reads four unlike businesses (Rule 0)", () => {
    expect(FIXTURES.map((f) => f.slug).sort()).toEqual(["car-detailer", "event-decor", "hair-salon", "talking-head"]);
  });
  it.each(FIXTURES.map((f) => [f.slug, f] as const))("%s gets its own service labels", (_slug, f) => {
    expect(servicesOf(f.profile)).toEqual(f.services);
  });
  it("no two businesses share a label", () => {
    const all = FIXTURES.flatMap((f) => f.services.map((s) => s.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
  });
  it("an empty or missing profile has no services (the studio says Not sure)", () => {
    expect(servicesOf(null)).toEqual([]);
    expect(servicesOf({ who: "", themes: "" })).toEqual([]);
  });
  it("the who-list ignores the words in brackets and stops at the sentence end", () => {
    expect(servicesOf({ who: "We do it all: alpha work (with extras), beta work and gamma work. Serving everywhere, always." })).toEqual(["alpha work", "beta work", "gamma work"]);
  });
  it("layer 1: the lines of 'What each service looks like' name the services, ahead of the who-list", () => {
    const profile = { who: "We do it all: alpha work and beta work.", service_looks: "• Gamma work: a tidy shelf\nDelta work (big ones): a long table, styled from above\nAll: bright light" };
    expect(servicesOf(profile)).toEqual(["Gamma work", "Delta work"]);
    // One line alone is a description, not a list: the who-list stays.
    expect(servicesOf({ ...profile, service_looks: "Gamma work: a tidy shelf" })).toEqual(["alpha work", "beta work"]);
  });
});
