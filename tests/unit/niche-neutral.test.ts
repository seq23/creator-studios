// Every studio shares this code, so nothing it shows a creator may assume one creator's niche.
// 7 Oct 2026 hostile click-through of Hadiyah's live studio: the codebase came from a home-hosting
// creator's dashboard, and Hadiyah's Deals, Voice overs, media kit and full-video screens still
// spoke about "your tables", tablescapes, brunch and candles. Practice-mode stand-ins (worker
// fakes, which say "demo" and "Sample Creator") are not screens' own copy and are not read here.
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
