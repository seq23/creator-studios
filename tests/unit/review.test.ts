// Review rules (section 9 and 12b): the #ad disclosure, reject reasons, platform ticks, tabs,
// and the 7-day Rejected window.
import { describe, expect, it } from "vitest";
import { cleanPlatforms, normalizeReason, purgeAt, tabStatus, withDisclosure } from "@worker/routes/clips";

describe("paid partnership disclosure", () => {
  it("appends #ad once, at the end", () => {
    expect(withDisclosure("New serum day", true)).toBe("New serum day #ad");
    expect(withDisclosure("New serum day #ad", true)).toBe("New serum day #ad");
    expect(withDisclosure("New serum day #ad #ad", true)).toBe("New serum day #ad");
    expect(withDisclosure("", true)).toBe("#ad");
  });
  it("removes only the trailing disclosure when switched off", () => {
    expect(withDisclosure("New serum day #ad", false)).toBe("New serum day");
    expect(withDisclosure("I #adore this", false)).toBe("I #adore this");
    expect(withDisclosure("I #adore this", true)).toBe("I #adore this #ad");
  });
});

describe("reject reasons", () => {
  it("keeps the fixed reasons, folds anything else into other, allows none", () => {
    expect(normalizeReason("Too long")).toBe("too long");
    expect(normalizeReason("bad hook")).toBe("bad hook");
    expect(normalizeReason("I just don't like it")).toBe("other");
    expect(normalizeReason("")).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
  });
});

describe("platform ticks", () => {
  it("keeps real platforms in fixed order and refuses none", () => {
    expect(cleanPlatforms(["youtube", "tiktok", "myspace"])).toEqual(["tiktok", "youtube"]);
    expect(cleanPlatforms([])).toBeNull();
    expect(cleanPlatforms("tiktok")).toBeNull();
  });
});

describe("tabs and retention", () => {
  it("maps tabs to statuses, defaulting to new", () => {
    expect(tabStatus("new")).toBe("draft");
    expect(tabStatus("approved")).toBe("approved");
    expect(tabStatus("rejected")).toBe("rejected");
    expect(tabStatus("deleted")).toBe("draft");
    expect(tabStatus(undefined)).toBe("draft");
  });
  it("a rejected clip is removed 7 days after she rejected it", () => {
    expect(purgeAt("2026-09-25T10:00:00.000Z")).toBe("2026-10-02T10:00:00.000Z");
    expect(purgeAt(null)).toBeNull();
  });
});
