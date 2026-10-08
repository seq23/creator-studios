// 7 Oct 2026: Settings showed "Last buffer-sync run · OK · Wed, 07 Oct 2026 17:00:00 GMT", a raw
// GMT string, where every other date in the app reads "Wed, Oct 7, 1:00 PM" in her time zone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { laneOkNote } from "@worker/crons/index";

const AT = new Date("2026-10-07T17:00:00.000Z");

describe("the last-run note", () => {
  it("reads like the app's dates, in her audience time zone", () => {
    expect(laneOkNote(AT, "America/New_York")).toBe("OK · Wed, Oct 7, 1:00 PM");
    expect(laneOkNote(AT, "America/Los_Angeles")).toBe("OK · Wed, Oct 7, 10:00 AM");
  });
  it("never a raw GMT string, even with a broken time zone", () => {
    expect(laneOkNote(AT, "America/New_York")).not.toMatch(/GMT|2026|:00:00/);
    expect(laneOkNote(AT, "Not/AZone")).toBe("OK · Wed, Oct 7, 5:00 PM UTC");
  });
  it("every lane's note goes through it", () => {
    const src = readFileSync("worker/crons/index.ts", "utf8");
    expect(src).not.toMatch(/toUTCString|toGMTString|toISOString\(\)\}/);
    expect(src).toContain('laneOkNote(new Date(), tz)');
  });
});
