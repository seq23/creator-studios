// Hooks are written headlines, never repeats (owner, 24 Oct 2026). The hourly words pass checks a new
// hook against every other hook in its dump with the TypeScript twin of jobs/clipmaker.py
// near_duplicate, and gives a clip its on-screen-words points back once its words are in (the cut
// caps a clip still waiting for words, so it is never scored high before it has a hook).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HOOK_STOP, nearDuplicateHook } from "@shared/clipWords";
import { scoreWithWords, WAITING_REASON, WORDS_HIT, WORDS_POINTS } from "@worker/lib/wordsPass";

const REAL = ["Latte art: everyday elegance", "Boat mornings, latte art, pure joy", "Boat mornings, latte art perfection", "Sailing sunrise, latte love", "Morning waves meet perfect latte art", "Sip, shuffle, and sparkle"];

describe("distinct hooks on the Worker side", () => {
  it("finds the same repeats as the clip engine (the real latte / boat set)", () => {
    expect(nearDuplicateHook(REAL[1], REAL[2])).toBe(true);
    expect(nearDuplicateHook(REAL[0], REAL[4])).toBe(true);
    expect(nearDuplicateHook("What I wear on a boat day", "My 5-minute glam before school pickup")).toBe(false);
    const dups = REAL.map((h, i) => (REAL.slice(0, i).some((p) => nearDuplicateHook(h, p)) ? i : -1)).filter((i) => i >= 0);
    expect(dups).toEqual([1, 2, 4]);
  });

  it("uses the engine's own stop words (one list each side, kept equal)", () => {
    const py = readFileSync("jobs/clipmaker.py", "utf8").match(/^HOOK_STOP = \{([^}]*)\}/m)![1];
    const words = [...py.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...HOOK_STOP].sort()).toEqual(words);
  });

  it("the words pass refuses a hook that repeats another in the dump", () => {
    const src = readFileSync("worker/lib/wordsPass.ts", "utf8");
    expect(src).toMatch(/used\.some\(\(u\) => nearDuplicateHook\(drafted\.hook_text, u\)\)/);
    expect(src).toContain("never a line someone says in the video");
    expect(src).toContain("latestPlaybook");
  });
});

describe("the score once the words are in", () => {
  it("gets the words points back and flips the reason", () => {
    const r = scoreWithWords(80, JSON.stringify([WAITING_REASON, "Sharp and steady throughout"]));
    expect(r.score).toBe(80 + WORDS_POINTS);
    expect(JSON.parse(r.score_reasons!)).toEqual(["Sharp and steady throughout", WORDS_HIT]);
    expect(scoreWithWords(95, JSON.stringify([WAITING_REASON])).score).toBe(100);
    // Already had its words: unchanged.
    const same = JSON.stringify(["Sharp and steady throughout"]);
    expect(scoreWithWords(77, same)).toEqual({ score: 77, score_reasons: same });
  });

  it("the engine caps a clip without its words at the cap the bump assumes", () => {
    const py = readFileSync("jobs/clipmaker.py", "utf8");
    expect(py).toMatch(/^WORDS_CAP = 80$/m);
    expect(py).toMatch(/^ECHO_CAP = \d+$/m);
    expect(py).toContain('"the words are still being written"');
    expect(WAITING_REASON.toLowerCase()).toBe("the words are still being written");
  });
});
