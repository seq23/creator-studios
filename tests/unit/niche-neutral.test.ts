// Studio intelligence (owner's plan, 22 Oct 2026): every studio shares this code, so the code that
// sees, plans and checks the footage must not assume one creator's business. (Screen copy and seed
// data are fixed where they are written, not pinned here: tests prove behaviour, never wording.)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Studio intelligence (owner's plan, 22 Oct 2026): the code that sees, plans and checks the footage
// carries NO business words. Every service word comes from a studio's Brand Profile. The guard reads
// the services of the six fixture businesses (tests/fixtures/businesses) and of a decor/party
// profile like the first live studio's, and fails on any of their words in these files.
const INTEL_FILES = ["jobs/see.py", "jobs/plan.py", "jobs/critic.py", "jobs/hear.py", "jobs/protect.py", "jobs/ai.py", "shared/services.ts", "shared/looksLike.ts", "shared/grounded.ts", "shared/grounded.json", "app/components/LooksLikeLine.tsx"];
const BUSINESS_DIR = path.join("tests", "fixtures", "businesses");
const BUSINESS_WORDS = [
  ...readdirSync(BUSINESS_DIR)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => (JSON.parse(readFileSync(path.join(BUSINESS_DIR, f), "utf8")) as { services: string[] }).services),
  "holiday porches", "romantic room setups", "grazing tables", "game rentals", "rose petals", "candles", "decorated", "undecorated",
]
  .flatMap((s) => s.toLowerCase().split(/[^a-z]+/))
  // Words too plain to be a service on their own ("tips", "color", "trims" ~ .trim()) are left out.
  .filter((w) => w.length >= 4 && !["tips", "color", "trims", "setups"].includes(w));
const BUSINESS = new RegExp(`\\b(${[...new Set(BUSINESS_WORDS)].map((w) => `${w}|${w.replace(/es$/, "")}|${w.replace(/s$/, "")}`).join("|")})\\b`, "i");

describe("studio intelligence code carries no business words", () => {
  it("the word list is read from the fixtures and bites (Rule 0)", () => {
    expect(BUSINESS_WORDS.length).toBeGreaterThan(15);
    for (const w of ["Empty porch? Watch it glow up!", "a silk press", "Ceramic coating", "balloon garland", "Career advice"]) expect(BUSINESS.test(w)).toBe(true);
    expect(BUSINESS.test("Before and after")).toBe(false);
  });
  it.each(INTEL_FILES)("%s names no business's services", (f) => {
    const hits = readFileSync(f, "utf8").split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => BUSINESS.test(l));
    expect(hits.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`)).toEqual([]);
  });
});

