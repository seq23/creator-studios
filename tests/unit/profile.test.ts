// Brand Profile drafting (section 5): nine fixed sections, tolerant parsing, realistic fake.
import { describe, expect, it } from "vitest";
import { BRAND_PROFILE_SECTIONS } from "@shared/constants";
import { cleanSections, FAKE_PROFILE, filledCount, parseProfileAnswer, PROFILE_SYSTEM, SECTION_MAX_CHARS } from "@worker/domain/profile";
import { UNREADABLE_SENTENCE } from "@worker/jobs/extract";

describe("brand profile", () => {
  it("the prompt names all nine sections", () => {
    for (const s of BRAND_PROFILE_SECTIONS) expect(PROFILE_SYSTEM).toContain(`"${s.key}"`);
  });
  it("the fake profile fills every section and is a niche-neutral Sample Creator", () => {
    expect(filledCount(FAKE_PROFILE)).toBe(9);
    expect(FAKE_PROFILE.who).toMatch(/^Sample Creator makes short, practical videos/);
    expect(FAKE_PROFILE.themes).toMatch(/How-tos/);
    expect(Object.values(FAKE_PROFILE).join("\n")).not.toMatch(/Table & Gather|host|table|brunch|candle|dinner/i);
  });
  it("keeps only the nine keys, turns lists into bullets and bounds length", () => {
    const s = cleanSections({ who: "  Sam  ", themes: ["Yachts", "Galas"], extra: "dropped", voice: "x".repeat(SECTION_MAX_CHARS + 50) });
    expect(Object.keys(s).sort()).toEqual(BRAND_PROFILE_SECTIONS.map((x) => x.key).sort());
    expect(s.who).toBe("Sam");
    expect(s.themes).toBe("• Yachts\n• Galas");
    expect(s.voice).toHaveLength(SECTION_MAX_CHARS);
    expect(s.goals).toBe("");
  });
  it("parses a fenced JSON answer, refuses a thin or broken one", () => {
    const full = Object.fromEntries(BRAND_PROFILE_SECTIONS.map((x) => [x.key, `about ${x.key}`]));
    expect(parseProfileAnswer("```json\n" + JSON.stringify(full) + "\n```")?.deal_fit).toBe("about deal_fit");
    expect(parseProfileAnswer(JSON.stringify({ who: "a", audience: "b" }))).toBeNull();
    expect(parseProfileAnswer("sorry, no")).toBeNull();
    expect(parseProfileAnswer("{not json")).toBeNull();
  });
  it("every unreadable reason is a plain sentence that says what to do", () => {
    for (const s of Object.values(UNREADABLE_SENTENCE)) expect(s).toMatch(/\.$/);
    expect(Object.keys(UNREADABLE_SENTENCE).sort()).toEqual(["corrupt", "locked", "missing", "no_text", "unsupported"]);
  });
});
