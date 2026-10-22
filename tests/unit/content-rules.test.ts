// Content rules (shared/contentRules.ts), enforced in code: never the word "insured", no street
// address or house number, prices only from the studio's one list, a face or house number the
// photo check could not hide never posts. Each rule is checked when a caption is written, edited
// AND again at the moment of posting (worker/lib/photoPosts.ts sendPost). A studio with no rules
// (Hadiyah, the samples) is not affected.
import { describe, expect, it } from "vitest";
import { NO_RULES, parseRules, textProblems, withAiLabel, AI_LABEL, type ContentRules } from "@shared/contentRules";

const PNP: ContentRules = parseRules(JSON.stringify({ banWords: ["insured"], blockAddresses: true, blockFaces: true, prices: [{ name: "Grand Holiday Porch", usd: 1050 }] }));

describe("never the word insured", () => {
  it.each(["We are insured.", "Fully INSURED and ready", "never uninsured", "insured-and-bonded"])("refuses %j", (t) => {
    expect(textProblems(t, PNP).join(" ")).toMatch(/insured/);
  });
  it("lets an ordinary caption through", () => {
    expect(textProblems("Fall front steps, ready for guests. #901", PNP)).toEqual([]);
  });
});

describe("never a street address or house number", () => {
  it.each(["Done at 1234 Oak Hollow Cv today", "4821 N. Main St.", "Loved this one on 55 Poplar Avenue", "house number 42 looked great", "home #17 is done", "apt 3 porch"])("refuses %j", (t) => {
    expect(textProblems(t, PNP).some((p) => /address or house number/.test(p))).toBe(true);
  });
  it.each(["Fall porch, 3 pumpkins and 2 mums", "Booking 2026 holiday dates now", "#901 #memphis"])("allows %j", (t) => {
    expect(textProblems(t, PNP)).toEqual([]);
  });
});

describe("prices only from the one config value", () => {
  it.each(["Grand Holiday Porch, $1,050", "Grand Holiday Porch $1050", "only 1,050 dollars", "$1,050.00"])("allows the listed price: %j", (t) => {
    expect(textProblems(t, PNP)).toEqual([]);
  });
  it.each(["Porch from $350", "$999 this week", "900 dollars", "USD 1200"])("refuses an invented price: %j", (t) => {
    const p = textProblems(t, PNP);
    expect(p.length).toBe(1);
    expect(p[0]).toMatch(/not on the price list.*Grand Holiday Porch \$1,050/);
  });
  it("a studio with rules but no price list refuses every price", () => {
    const r = { ...PNP, prices: [] };
    expect(textProblems("Only $1,050", r)[0]).toMatch(/no price list/);
  });
});

describe("a studio with no rules is untouched", () => {
  it("NO_RULES passes everything", () => {
    expect(textProblems("Insured, 1234 Oak St, $5", NO_RULES)).toEqual([]);
    expect(parseRules(undefined)).toEqual(NO_RULES);
    expect(parseRules("")).toEqual(NO_RULES);
  });
  it("a malformed rules value fails CLOSED (every rule on, no price allowed)", () => {
    const r = parseRules("{not json");
    expect(r.banWords).toContain("insured");
    expect(r.blockAddresses && r.blockFaces).toBe(true);
    expect(textProblems("$1,050", r).length).toBe(1);
  });
});

describe("Made with AI label", () => {
  it("is added once, only to AI-made pieces", () => {
    expect(withAiLabel("Fall steps", true)).toBe(`Fall steps\n\n${AI_LABEL}`);
    expect(withAiLabel(withAiLabel("Fall steps", true), true)).toBe(`Fall steps\n\n${AI_LABEL}`);
    expect(withAiLabel("Fall steps", false)).toBe("Fall steps");
    expect(withAiLabel("", true)).toBe(AI_LABEL);
  });
});
