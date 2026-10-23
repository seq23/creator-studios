// Studio intelligence layer 5 (owner's plan, 22 Oct 2026), the Worker's half: words that break a
// studio's rules hide the clip on import (the job checks too, the Worker never trusts it); the cut
// spec carries the rules; a clip with an AI voice over posts with "Made with AI".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCutResult, RULES_HIDDEN } from "@worker/jobs/cut";
import { NO_RULES, parseRules } from "@shared/contentRules";

const base = { id: "clp_abcdefgh12", asset_id: "ast_a", start_s: 0, end_s: 20, recipe: "montage", hook_text: "Look", caption: "Book your date.", hashtags: [], platforms: ["tiktok"], score: 0.7, r2_key: "clips/dmp_x/clp_abcdefgh12.mp4", cover_r2_key: null };
const ctx = (rules = parseRules(JSON.stringify({ banWords: ["insured"], blockAddresses: true, blockFaces: true, prices: [{ name: "Big", usd: 1050 }] }))) => ({ dumpId: "dmp_x", allowed: new Map([["ast_a", ["tiktok" as const]]]), rawKeys: new Set<string>(), rules });

describe("layer 5: protect", () => {
  it("a clip whose words break a rule is hidden with the reason", () => {
    for (const bad of [{ caption: "Fully insured" }, { hook_text: "Only $99" }, { hook_alt: "At 1234 Oak Hollow Cv" }]) {
      const c = parseCutResult({ clips: [{ ...base, ...bad }] }, ctx()).clips[0];
      expect(c).toMatchObject({ hidden: true, hidden_reason: RULES_HIDDEN });
    }
    expect(parseCutResult({ clips: [{ ...base, caption: "The big one, $1,050" }] }, ctx()).clips[0]).toMatchObject({ hidden: false, hidden_reason: null });
    // A studio with no rules is not held back by them.
    expect(parseCutResult({ clips: [{ ...base, caption: "Fully insured" }] }, ctx(NO_RULES)).clips[0].hidden_reason).toBeNull();
  });
  it("the owner's face rule: show unless set to blur; malformed rules blur every face", () => {
    expect(parseRules(JSON.stringify({ blockFaces: true })).ownerFace).toBe("show");
    expect(parseRules(JSON.stringify({ blockFaces: true, ownerFace: "blur" })).ownerFace).toBe("blur");
    expect(parseRules("{not json").ownerFace).toBe("blur");
  });
  it("the cut spec carries the rules, the import checks them, Buffer labels AI voice", () => {
    const cut = readFileSync("worker/jobs/cut.ts", "utf8");
    expect(cut).toMatch(/content_rules: contentRules\(env\)/);
    expect((cut.match(/, rules: contentRules\(env\)/g) ?? []).length).toBe(2); // the cut and the re-render imports
    const buf = readFileSync("worker/crons/buffer-sync.ts", "utf8");
    expect((buf.match(/withAiLabel\(\[[a-z]+\.caption, [a-z]+\.hashtags\][^)]*\)[^,]*, [a-z]+\.ai_voice > 0\)/g) ?? []).length).toBe(2);
  });
});
