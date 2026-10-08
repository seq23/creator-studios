// Every studio shares this code, so nothing it shows a creator may assume one creator's niche.
// 7 Oct 2026 hostile click-through of Hadiyah's live studio: the codebase came from a home-hosting
// creator's dashboard, and Hadiyah's Deals, Voice overs, media kit and full-video screens still
// spoke about "your tables", tablescapes, brunch and candles. Second pass the same day: the
// practice-mode stand-ins (Brand Profile, research brief, brand suggestions, YouTube titles, the
// full-video transcript, the email fallbacks) still described "Table & Gather", a home-hosting brand,
// to every studio still in practice. They are read below with a stricter list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NICHE = /tablescap|brunch|candles?\b|dinner part|your tables?\b|chargers?\b|linens?\b|napkins?|hosting brand|home and lifestyle|Kitchen \d/i;

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(f) ? [p] : [];
  });
}

const FILES = [
  ...walk("app", /\.(tsx?|md)$/),
  ...walk("help/guides", /\.md$/),
  "help/index.json",
  "shared/setup.ts",
  "worker/domain/marketplaces.ts",
];

describe("screen copy is niche-neutral", () => {
  it("reads every screen, guide and the marketplace list (Rule 0)", () => {
    expect(FILES.length).toBeGreaterThan(80);
    expect(FILES).toContain(path.join("app", "content", "voice-script.md"));
  });
  it.each(FILES)("%s says nothing about one creator's niche", (f) => {
    const hits = readFileSync(f, "utf8").split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => NICHE.test(l));
    expect(hits.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`)).toEqual([]);
  });
});

// Practice mode is what every new studio sees first, so its stand-ins are held to a stricter list
// ("hosting", "tableware" and the old brand count here).
const PRACTICE_NICHE = new RegExp(`${NICHE.source}|table ?& ?gather|tableandgather|tableware|hosting|supper|kitchenware|home decor|serving boards?|stoneware|placemats?|centerpiece`, "i");
const PRACTICE_FILES = [
  "worker/domain/profile.ts",
  "worker/domain/emails.ts",
  "worker/jobs/extract.ts",
  "worker/jobs/research_fake.ts",
  "worker/jobs/brand_finder.ts",
  "worker/jobs/fullvideo.ts",
  "worker/services/youtube.ts",
  "worker/services/buffer.ts",
  "worker/lib/youtubeDirect.ts",
];

describe("practice-mode stand-ins are niche-neutral", () => {
  it("the stricter list catches what the 7 Oct practice data said (proves the guard bites)", () => {
    for (const was of ["the host behind Table & Gather, a home hosting brand", "Golden Hour Tableware", "@tableandgather", "Set a Sunday brunch table in 60 seconds", "Make-ahead menus and hosting tips"]) expect(PRACTICE_NICHE.test(was)).toBe(true);
    expect(PRACTICE_NICHE.test("Sample Creator makes short, practical videos")).toBe(false);
  });
  it.each(PRACTICE_FILES)("%s says nothing about one creator's niche", (f) => {
    const hits = readFileSync(f, "utf8").split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => PRACTICE_NICHE.test(l));
    expect(hits.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`)).toEqual([]);
  });
});
