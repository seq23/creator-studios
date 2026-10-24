// Calls to action are opt-in (owner, 23 Oct 2026, clip quality): no studio ever gets a default one.
// A clip carries a call to action only when the studio chose one in Settings → Your clips (or its
// registry entry), or wrote a short phrase in its Brand Profile's "ctas" section. A section that
// DESCRIBES how she takes enquiries ("For brand deals: email …") is not a chosen phrase: it never
// reaches an end card, a caption or a voice-over. jobs/tests/test_clip_quality.py pins the engine side.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chosenCtas, profileCtaPhrases, RULES_DEFAULT, studioRules } from "@shared/studioRules";
import { brandingFor } from "@worker/domain/looks";
import { starterScript } from "@worker/domain/autoVoice";
// @ts-expect-error plain .mjs module
import { envBlock } from "../../scripts/studio.mjs";

const ROOT = path.resolve(__dirname, "..", "..");
const DESCRIBED = "For brand deals: email someone@example.com with brand, category, timeline, goals. For content: ask questions in captions, encourage shares ('send this to the friend who...'), follow for more, shop via affiliate links.";
const themes = JSON.parse(readFileSync(path.join(ROOT, "studios", "themes.json"), "utf8"));

describe("no default call to action, anywhere", () => {
  it("the defaults carry none and no stand-in phrase exists", () => {
    expect(RULES_DEFAULT.cta_phrases).toEqual([]);
    expect(RULES_DEFAULT.cta_link).toBe("");
    const src = readFileSync(path.join(ROOT, "shared", "studioRules.ts"), "utf8");
    expect(src).not.toMatch(/FALLBACK_CTA|"Follow for more"/);
  });
  it("every studio without its own phrases in the registry has none; the ones that chose keep theirs", () => {
    const slugs = readdirSync(path.join(ROOT, "studios")).filter((f) => f.endsWith(".json") && f !== "themes.json").map((f) => f.replace(/\.json$/, ""));
    expect(slugs.length).toBeGreaterThanOrEqual(5);
    for (const slug of slugs) {
      const reg = JSON.parse(readFileSync(path.join(ROOT, "studios", `${slug}.json`), "utf8"));
      const rules = studioRules((envBlock(reg, themes) as { vars: Record<string, string> }).vars.STUDIO_RULES, null);
      const own = (reg.studioRules?.cta_phrases ?? []) as string[];
      expect(rules.cta_phrases, slug).toEqual(own);
    }
  });
  it("a described profile section is not a chosen call to action; a short phrase she wrote is", () => {
    expect(profileCtaPhrases(DESCRIBED)).toEqual([]);
    expect(profileCtaPhrases("Not in your docs yet.")).toEqual([]);
    expect(profileCtaPhrases("- Shop the look\n- DM me @handle\n- Link in bio: https://x.co")).toEqual(["Shop the look"]);
    expect(chosenCtas({ cta_phrases: [] }, DESCRIBED)).toEqual([]);
    expect(chosenCtas({ cta_phrases: ["Book your date"] }, DESCRIBED)).toEqual(["Book your date"]);
  });
  it("the end card never shows a described section; the last-resort voice-over asks for nothing", () => {
    expect(brandingFor({ who: "A creator @someone", ctas: DESCRIBED }, []).cta).toBeNull();
    expect(brandingFor({ who: "A creator", ctas: "Shop the look" }, []).cta).toBe("Shop the look");
    expect(starterScript({ hook_text: "", caption: "" }, null, 10)).not.toMatch(/follow/i);
  });
  it("every Worker prompt that writes a call to action reads only a chosen one", () => {
    for (const f of ["worker/lib/autoVoice.ts", "worker/routes/voice.ts"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/\|\| "follow for more"/i);
      expect(src, f).toContain("chosenCtas(");
    }
  });
});
