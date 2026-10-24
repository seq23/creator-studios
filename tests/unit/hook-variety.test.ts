// Varied hooks and scores that differ (owner, 24 Oct 2026). Three Porch & Party clips refused three
// hourly tries running: every refusal was the repeat check, the model was never told why, and only the
// first 30 of the dump's 37 hooks (rejected ones included) were shown to it. And Mercedes's hooks read
// alike (five "POV:", "glow" five times, "instant" six) because the repeat check only caught
// near-duplicates; most clips scored 90. Pins: the variety check (both sides, one list in
// jobs/playbook.json), the asked-again-with-the-reason retry, rejected hooks not counted, and the
// graded hook points restored on the uncapped score.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { harness } from "./helpers/studio-fix-env";
import { saveConnection } from "@worker/lib/connections";
import { scoreWithWords, wordsPass, WORDS_ASKS_PER_CLIP } from "@worker/lib/wordsPass";
import { scoreWithoutWords } from "@worker/lib/rewriteWords";
import { crowdedHookParts, HOOK_OPENING_MAX, HOOK_SHAPES, HOOK_WORD_MAX, hookOpening, hookPatternFor, hookPoints, hookStem, hookVarietyProblem } from "@shared/clipWords";

// Mercedes's hooks for one dump, 24 Oct 2026 (the cut's own words).
const MERCEDES = [
  "This latte art pour is everything", "Street walk, instant glam", "POV: the moment the whole room lights up", "From bus seat to runway glow",
  "Step inside, hear the soul", "Watch me turn everyday into runway magic", "POV: the glow that says I belong here", "Open the bottle, unleash your glow",
  "How I look stunning on a moving boat", "This is my go-to Brooklyn mom outfit", "Watch me shine on the boat instantly", "POV: the second you feel the boat breeze",
  "Sipping sunshine, radiating style", "Instant confidence, effortless style", "Black sweatshirt, red logo, instant power", "See your glow instantly",
  "POV: the instant the club comes alive", "The secret to a party that never stops", "Orange top. Black shorts. Instant room glow.",
];

afterEach(() => vi.unstubAllGlobals());

describe("hook variety in one dump", () => {
  it("refuses a third hook with the same opening, a word two others use, and a near repeat; place words are free", () => {
    expect(HOOK_OPENING_MAX).toBe(2);
    expect(HOOK_WORD_MAX).toBe(2);
    expect(hookOpening("POV: the glow")).toBe("pov");
    expect(hookOpening("How I pack for a boat day")).toBe("how i");
    expect(hookStem("instantly")).toBe(hookStem("instant"));
    expect(hookStem("glows")).toBe("glow");
    expect(hookStem("welcomes")).toBe(hookStem("welcome"));
    expect(hookVarietyProblem("POV: you finally get it", ["POV: one", "Something else"])).toBeNull();
    expect(hookVarietyProblem("POV: you finally get it", ["POV: one", "POV: two"])).toMatch(/2 hooks already open with “pov”/);
    expect(hookVarietyProblem("Your glow, upgraded", ["Runway glow", "Glow up"])).toMatch(/already use “glow”/);
    expect(hookVarietyProblem("Instantly ready", ["Instant glam", "Street, instant"])).toMatch(/already use “instantly”/);
    expect(hookVarietyProblem("Birthday magic in Memphis tonight", ["Birthday magic in Memphis"])).toMatch(/nearly the same/);
    expect(hookVarietyProblem("Candles at dusk, Memphis", ["Memphis porch", "Memphis door"], ["Memphis", "Germantown"])).toBeNull();
    expect(hookVarietyProblem("Candles at dusk, Memphis", ["Memphis porch", "Memphis door"])).toMatch(/memphis/);
  });

  it("would have kept Mercedes's dump varied: the crowded openings and words are named for the model", () => {
    const crowd = crowdedHookParts(MERCEDES);
    expect(crowd.openings).toEqual(expect.arrayContaining(["pov", "watch me"]));
    expect(crowd.words).toEqual(expect.arrayContaining(["glow", "instant", "runway", "boat"]));
    // Taken in turn, the later "POV:" / glow / instant hooks are refused.
    const kept: string[] = [];
    const refused: string[] = [];
    for (const h of MERCEDES) (hookVarietyProblem(h, kept) ? refused : kept).push(h);
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(kept.filter((h) => hookOpening(h) === "pov").length).toBeLessThanOrEqual(2);
    expect(kept.filter((h) => /glow/i.test(h)).length).toBeLessThanOrEqual(2);
  });

  it("steers each clip to a varied pattern, skipping a crowded opening", () => {
    expect(HOOK_SHAPES.length).toBeGreaterThanOrEqual(8);
    const niche = ["POV: ... the instant you see the finished look", "How I ... in under a minute"];
    expect(hookPatternFor(0, niche, ["pov"])).toBe(niche[1]);
    const seen = new Set(Array.from({ length: 8 }, (_, k) => hookPatternFor(k, niche, [])));
    expect(seen.size).toBe(8);
  });

  it("is one rule on both sides: the Python twin gives the same answers", () => {
    const cases = [
      ...MERCEDES.map((h, i) => ({ hook: h, others: MERCEDES.slice(0, i), exempt: [] as string[] })),
      { hook: "Candles at dusk, Memphis", others: ["Memphis porch", "Memphis door"], exempt: ["Memphis"] },
    ];
    const py = spawnSync("python3", ["-c", `
import json, sys
sys.path.insert(0, "jobs")
import clipmaker as CM
cases = json.loads(sys.stdin.read())
print(json.dumps([[CM.hook_opening(c["hook"]), CM.hook_variety_problem(c["hook"], c["others"], c["exempt"]), CM.hook_points(c["hook"])] for c in cases]))
`], { input: JSON.stringify(cases), encoding: "utf8" });
    expect(py.status, py.stderr).toBe(0);
    const ts = cases.map((c) => [hookOpening(c.hook), hookVarietyProblem(c.hook, c.others, c.exempt), hookPoints(c.hook)]);
    expect(JSON.parse(py.stdout)).toEqual(ts);
    // The cut uses it too (a crowded hook is rewritten like a repeat).
    const cut = readFileSync("jobs/cut.py", "utf8");
    expect(cut).toContain("crowded = set(CM.crowded_hooks(hooks, place)) - dups");
    expect(cut).toContain("CM.hook_variety_problem(h, kept, place) is None");
  });
});

describe("scores that differ", () => {
  it("grades the hook instead of one flat 10", () => {
    expect(hookPoints("")).toBe(0);
    expect(hookPoints("This is a hook far too long to read on the screen")).toBe(0);
    expect(hookPoints("Instant confidence, effortless style")).toBe(7);
    expect(hookPoints("What I wear on a boat day")).toBe(10);
    expect(hookPoints("3 details nobody notices first")).toBe(10);
    const pts = MERCEDES.map((h) => hookPoints(h));
    expect(Math.max(...pts) - Math.min(...pts)).toBeGreaterThanOrEqual(3);
  });

  it("gives a rewritten clip its graded points back on the uncapped score, not from the cap of 80", () => {
    const strong = JSON.stringify(["Sharp and steady throughout", "Short, readable on-screen words"]);
    const off = scoreWithoutWords(100, strong);
    expect(off).toMatchObject({ score: 80, base: 90 });
    expect(scoreWithWords(off.score, off.score_reasons, "3 details nobody notices first", off.base).score).toBe(100);
    const weak = scoreWithWords(off.score, off.score_reasons, "Instant confidence, effortless style", off.base);
    expect(weak.score).toBe(97);
    expect(JSON.parse(weak.score_reasons!)[0]).toBe("The hook could be more specific");
    const low = scoreWithoutWords(86, strong);
    expect(scoreWithWords(low.score, low.score_reasons, "Instant confidence, effortless style", low.base).score).toBe(83);
  });

  it("the engine grades payoff timing and pacing too", () => {
    const py = spawnSync("python3", ["-c", `
import json, sys
sys.path.insert(0, "jobs")
import clipmaker as CM, playbook as PB
def f(parts, t="finished_walkthrough"):
    return {"clip_type": t, "parts": parts, "hook": "What I wear on a boat day", "caption": "Done.", "cta_link": "", "cta_phrases": [], "end_card": True, "overlap": 0.0, "repeats": False, "words_pending": False}
first = [{"stage": "finished", "start": 0, "end": 3, "quality": 1}, {"stage": "detail", "start": 0, "end": 3, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}]
late = [{"stage": "process", "start": 0, "end": 1.5, "quality": 1}, {"stage": "finished", "start": 0, "end": 3, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}]
slow = [{"stage": "finished", "start": 0, "end": 6, "quality": 1}, {"stage": "detail", "start": 0, "end": 6, "quality": 1}, {"stage": "hero", "start": 0, "end": 3, "quality": 1}]
print(json.dumps([CM.score_clip(f(first), PB.load({})), CM.score_clip(f(late, "pov_walk_in"), PB.load({})), CM.score_clip(f(slow), PB.load({}))]))
`], { encoding: "utf8" });
    expect(py.status, py.stderr).toBe(0);
    const [[a], [b, whyB], [c, whyC]] = JSON.parse(py.stdout) as [number, string[]][];
    expect(a).toBe(100);
    expect(b).toBeLessThan(a);
    expect(whyB[0]).toMatch(/payoff lands at 1\.5 s/);
    expect(c).toBeLessThan(a);
    expect(whyC.join(" ")).toMatch(/near, not on, its type's pace/);
  });
});

describe("the words pass asks again with the reason", () => {
  it("a refused hook is asked again once, told why; the second lands; rejected clips' hooks are not counted", async () => {
    const h = await harness({ FAKE_SERVICES: "0" } as never);
    await saveConnection(h.env, "openrouter", "sk-test", "ok", {});
    await h.dumpWith("dmp_v", [{ id: "ast_v", name: "a.mp4", mime: "video/mp4" }]);
    h.db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status, words_pending, number)
      VALUES ('clp_vvvvvvvv01', 'ast_v', 'dmp_v', 0, 20, 'montage', 'Walk in to a birthday surprise', 'c', '', '["tiktok"]', 90, 'clips/dmp_v/1.mp4', 'draft', 0, 1),
             ('clp_vvvvvvvv02', 'ast_v', 'dmp_v', 0, 20, 'montage', 'Candlelight curls across the floor', 'c', '', '["tiktok"]', 90, 'clips/dmp_v/2.mp4', 'rejected', 0, 2),
             ('clp_vvvvvvvv03', 'ast_v', 'dmp_v', 0, 20, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_v/3.mp4', 'draft', 1, 3)`);
    const answers = ["Birthday surprise, start to finish", "Candlelight curls on the bed"];
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
      prompts.push(body.messages[1].content);
      const hook = answers[Math.min(prompts.length - 1, answers.length - 1)];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ hook, caption: "Ready when you walk in.", hashtags: ["#memphis"], voice: "Ready." }) }, finish_reason: "stop" }] }), { status: 200 });
    }));
    const r = await wordsPass(h.env, new Date("2026-10-24T09:00:00Z"));
    expect(WORDS_ASKS_PER_CLIP).toBe(2);
    expect(r.written).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Walk in to a birthday surprise");
    expect(prompts[0]).not.toContain("Candlelight curls across the floor"); // a rejected clip's hook takes no words away
    expect(prompts[0]).toMatch(/Hook pattern for this clip: /);
    expect(prompts[1]).toMatch(/Your last answer could not be used: It says nearly the same as “Walk in to a birthday surprise”/);
    expect(h.one<{ hook_text: string; words_pending: number }>("SELECT hook_text, words_pending FROM clips WHERE id = 'clp_vvvvvvvv03'")).toEqual({ hook_text: "Candlelight curls on the bed", words_pending: 0 });
  });

  it("two refusals in a run leave it waiting for the next hourly try (never a third ask)", async () => {
    const h = await harness({ FAKE_SERVICES: "0" } as never);
    await saveConnection(h.env, "openrouter", "sk-test", "ok", {});
    await h.dumpWith("dmp_w", [{ id: "ast_w", name: "a.mp4", mime: "video/mp4" }]);
    h.db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status, words_pending, number)
      VALUES ('clp_wwwwwwww01', 'ast_w', 'dmp_w', 0, 20, 'montage', 'Walk in to a birthday surprise', 'c', '', '["tiktok"]', 90, 'clips/dmp_w/1.mp4', 'draft', 0, 1),
             ('clp_wwwwwwww03', 'ast_w', 'dmp_w', 0, 20, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_w/3.mp4', 'draft', 1, 3)`);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ hook: "Birthday surprise, start to finish", caption: "Ready.", hashtags: [], voice: "" }) }, finish_reason: "stop" }] }), { status: 200 });
    }));
    const r = await wordsPass(h.env, new Date("2026-10-24T09:00:00Z"));
    expect(r).toMatchObject({ written: 0, waiting: 1 });
    expect(r.misses.refused).toBe(1);
    expect(calls).toBe(WORDS_ASKS_PER_CLIP);
  });
});
