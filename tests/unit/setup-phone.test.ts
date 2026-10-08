// Setup at 390 px (7 Oct 2026 click-through of Hadiyah's live studio, reproduced locally with
// Playwright): the steps list was a grid with an implicit auto track, which grows to the longest
// unbroken line in any card (the studio's redirect address), so every card ran ~14 px past the
// phone screen. The track is minmax(0, 1fr) and the redirect addresses may wrap anywhere.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/styles/setup.css", "utf8");
const rule = (sel: string) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[2] ?? "";

describe("Setup fits a phone", () => {
  it("the steps grid has one track that can shrink below its content", () => {
    expect(rule(".setup-steps")).toMatch(/display:\s*grid/);
    expect(rule(".setup-steps")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
  it("both redirect addresses wrap anywhere", () => {
    expect(rule(".setup-url")).toMatch(/overflow-wrap:\s*anywhere/);
    const page = readFileSync("app/pages/Setup.tsx", "utf8");
    expect(page.match(/<code className="mono setup-url">\{view\.redirects\.(google|meta)\}<\/code>/g)?.length).toBe(2);
  });
});
