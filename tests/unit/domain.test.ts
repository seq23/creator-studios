import { describe, expect, it } from "vitest";
import { runwayLow, runwayWeeks, weeklyNeed } from "@worker/domain/runway";
import { inCooldown, rankRecycle, recyclePlatforms } from "@worker/domain/cooldown";
import { canTransition, rejectedExpired, schedulable } from "@worker/domain/approval";
import { canMove, nextFollowup } from "@worker/domain/deals";
import { DEFAULT_WEEKLY_CAPS } from "@shared/constants";

describe("runway", () => {
  it("needs the max cap in unique clips, not the sum", () => {
    expect(weeklyNeed(DEFAULT_WEEKLY_CAPS)).toBe(10);
  });
  it("32 approved clips at 10 a week is 3.2 weeks", () => {
    expect(runwayWeeks(32, 10)).toBe(3.2);
  });
  it("emails under 2 weeks (20 clips) and not at 20", () => {
    expect(runwayLow(19, DEFAULT_WEEKLY_CAPS, 2)).toBe(true);
    expect(runwayLow(20, DEFAULT_WEEKLY_CAPS, 2)).toBe(false);
  });
  it("zero caps never nag", () => {
    expect(runwayLow(0, { tiktok: 0, instagram: 0, youtube: 0 }, 2)).toBe(false);
  });
});

describe("cooldown", () => {
  const now = new Date("2026-09-25T00:00:00Z");
  it("blocks the same platform inside 90 days and allows it after", () => {
    const prior = [{ platform: "tiktok" as const, posted_at: "2026-08-01T00:00:00Z" }];
    expect(inCooldown(prior, "tiktok", now, 90)).toBe(true);
    expect(inCooldown(prior, "instagram", now, 90)).toBe(false);
    expect(inCooldown(prior, "tiktok", new Date("2026-11-15T00:00:00Z"), 90)).toBe(false);
  });
  it("recyclePlatforms filters the blocked ones", () => {
    const prior = [{ platform: "tiktok" as const, posted_at: "2026-09-01T00:00:00Z" }];
    expect(recyclePlatforms(prior, ["tiktok", "instagram", "youtube"], now, 90)).toEqual(["instagram", "youtube"]);
  });
  it("ranks best past performers first, unknown views last", () => {
    const out = rankRecycle([
      { id: "a", original_views: null, original_posted_at: "2026-01-01" },
      { id: "b", original_views: 5000, original_posted_at: "2025-01-01" },
      { id: "c", original_views: 12000, original_posted_at: "2024-01-01" },
    ]);
    expect(out.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});

describe("approval", () => {
  it("only approved clips can be scheduled", () => {
    expect(schedulable("approved")).toBe(true);
    for (const s of ["draft", "rejected", "deleted"] as const) expect(schedulable(s)).toBe(false);
  });
  it("deleted is final", () => {
    for (const to of ["draft", "approved", "rejected"] as const) expect(canTransition("deleted", to)).toBe(false);
  });
  it("a rejection can be undone within 7 days", () => {
    expect(canTransition("rejected", "approved")).toBe(true);
    expect(rejectedExpired("2026-09-10T00:00:00Z", new Date("2026-09-16T00:00:00Z"), 7)).toBe(false);
    expect(rejectedExpired("2026-09-10T00:00:00Z", new Date("2026-09-18T00:00:00Z"), 7)).toBe(true);
  });
});

describe("deals", () => {
  it("moves one step at a time along the pipeline; skipping is refused", () => {
    expect(canMove("find_contact", "pitch")).toBe(true);
    expect(canMove("find_contact", "follow_up")).toBe(false);
    expect(canMove("pitch", "follow_up")).toBe(true);
    expect(canMove("negotiating", "agreed")).toBe(true);
    expect(canMove("pitch", "agreed")).toBe(false);
    expect(canMove("agreed", "paid")).toBe(false);
    expect(canMove("pitch", "declined")).toBe(true);
    expect(canMove("paid", "lost")).toBe(false);
    expect(canMove("done", "declined")).toBe(false);
  });
  it("follow-ups land on day 5, day 12 and day 19, then stop", () => {
    expect(nextFollowup("2026-09-01T12:00:00.000Z", 0)).toBe("2026-09-06T12:00:00.000Z");
    expect(nextFollowup("2026-09-01T12:00:00.000Z", 1)).toBe("2026-09-13T12:00:00.000Z");
    expect(nextFollowup("2026-09-01T12:00:00.000Z", 2)).toBe("2026-09-20T12:00:00.000Z");
    expect(nextFollowup("2026-09-01T12:00:00.000Z", 3)).toBeNull();
  });
});
