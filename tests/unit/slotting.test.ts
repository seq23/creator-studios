import { describe, expect, it } from "vitest";
import { exceedsCap, orderForWeek, planWeek, slotsForWeek, weekBounds, zonedToUtc, type SchedulableClip } from "@worker/domain/slotting";
import { DEFAULT_WEEKLY_CAPS, HARD_CAP_PER_CHANNEL_PER_WEEK, LAUNCH_SLOTS } from "@shared/constants";

const TZ = "America/New_York";

function clip(i: number, extra: Partial<SchedulableClip> = {}): SchedulableClip {
  return { id: `c${i}`, asset_id: `a${Math.floor(i / 3)}`, score: 1 - i / 100, platforms: ["tiktok", "instagram", "youtube"], door: i % 2 ? "recycle" : "new", ...extra };
}

describe("zonedToUtc", () => {
  it("converts New York wall-clock to UTC across DST", () => {
    expect(zonedToUtc(2026, 1, 15, 15, 0, TZ)).toBe("2026-01-15T20:00:00.000Z"); // EST −5
    expect(zonedToUtc(2026, 7, 15, 15, 0, TZ)).toBe("2026-07-15T19:00:00.000Z"); // EDT −4
  });
});

describe("weekBounds", () => {
  it("runs Monday 00:00 local to next Monday 00:00 local", () => {
    const { start, end } = weekBounds(new Date("2026-09-25T18:00:00Z"), TZ); // a Friday
    expect(start).toBe("2026-09-21T04:00:00.000Z");
    expect(end).toBe("2026-09-28T04:00:00.000Z");
  });
  it("handles Sunday as the last day of the week, not the first", () => {
    const { start } = weekBounds(new Date("2026-09-27T20:00:00Z"), TZ); // Sunday 4pm NY
    expect(start).toBe("2026-09-21T04:00:00.000Z");
  });
});

describe("slotsForWeek", () => {
  const monday = "2026-09-21T04:00:00.000Z";
  it("gives the launch defaults 10 / 7 / 5 slots", () => {
    const s = slotsForWeek(monday, TZ, DEFAULT_WEEKLY_CAPS);
    expect(s.tiktok).toHaveLength(10);
    expect(s.instagram).toHaveLength(7);
    expect(s.youtube).toHaveLength(5);
  });
  it("never exceeds the hard cap even if settings ask for more", () => {
    const s = slotsForWeek(monday, TZ, { tiktok: 50, instagram: 50, youtube: 50 });
    for (const list of Object.values(s)) expect(list.length).toBeLessThanOrEqual(HARD_CAP_PER_CHANNEL_PER_WEEK);
  });
  it("keeps every slot inside the week and in local time", () => {
    const s = slotsForWeek(monday, TZ, DEFAULT_WEEKLY_CAPS);
    const { start, end } = weekBounds(new Date(monday), TZ);
    for (const list of Object.values(s)) for (const t of list) expect(t >= start && t < end).toBe(true);
    // Monday 3 pm New York in September = 19:00 UTC
    expect(s.tiktok[0]).toBe("2026-09-21T19:00:00.000Z");
  });
  it("the launch slot table itself has the right counts", () => {
    expect(LAUNCH_SLOTS.tiktok).toHaveLength(10);
    expect(LAUNCH_SLOTS.instagram).toHaveLength(7);
    expect(LAUNCH_SLOTS.youtube).toHaveLength(5);
  });
});

describe("orderForWeek", () => {
  it("never puts two clips from the same source video back to back when avoidable", () => {
    const clips = [clip(0), clip(1), clip(2), clip(3), clip(4), clip(5)];
    const out = orderForWeek(clips);
    for (let i = 1; i < out.length; i++) expect(out[i].asset_id).not.toBe(out[i - 1].asset_id);
  });
  it("puts the best clip first", () => {
    const out = orderForWeek([clip(5), clip(0), clip(9)]);
    expect(out[0].id).toBe("c0");
  });
});

describe("planWeek", () => {
  const monday = "2026-09-21T04:00:00.000Z";
  it("fills 22 posts from 10 unique clips at launch caps", () => {
    const clips = Array.from({ length: 30 }, (_, i) => clip(i, { asset_id: `a${i}` }));
    const posts = planWeek(clips, monday, TZ, DEFAULT_WEEKLY_CAPS);
    expect(posts).toHaveLength(22);
    const unique = new Set(posts.map((p) => p.clip_id));
    expect(unique.size).toBe(10);
    expect(posts.filter((p) => p.platform === "tiktok")).toHaveLength(10);
    expect(posts.filter((p) => p.platform === "instagram")).toHaveLength(7);
    expect(posts.filter((p) => p.platform === "youtube")).toHaveLength(5);
  });
  it("skips a platform the clip has unticked", () => {
    const clips = Array.from({ length: 12 }, (_, i) => clip(i, { asset_id: `a${i}`, platforms: i === 0 ? ["tiktok"] : ["tiktok", "instagram", "youtube"] }));
    const posts = planWeek(clips, monday, TZ, DEFAULT_WEEKLY_CAPS);
    expect(posts.some((p) => p.clip_id === "c0" && p.platform !== "tiktok")).toBe(false);
    expect(posts.some((p) => p.clip_id === "c0" && p.platform === "tiktok")).toBe(true);
  });
  it("uses fewer posts when fewer clips are approved", () => {
    const posts = planWeek([clip(0, { asset_id: "a0" }), clip(1, { asset_id: "a1" })], monday, TZ, DEFAULT_WEEKLY_CAPS);
    expect(posts).toHaveLength(6);
  });
});

describe("exceedsCap", () => {
  it("refuses the 11th TikTok post in a week", () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({ clip_id: `c${i}`, platform: "tiktok" as const, scheduled_at: `2026-09-2${1 + (i % 5)}T19:00:00.000Z` }));
    expect(exceedsCap(existing, { clip_id: "x", platform: "tiktok", scheduled_at: "2026-09-26T19:00:00.000Z" }, TZ, DEFAULT_WEEKLY_CAPS)).toBe(true);
    expect(exceedsCap(existing, { clip_id: "x", platform: "instagram", scheduled_at: "2026-09-26T19:00:00.000Z" }, TZ, DEFAULT_WEEKLY_CAPS)).toBe(false);
  });
  it("does not count the clip being moved against itself", () => {
    const existing = [{ clip_id: "c1", platform: "youtube" as const, scheduled_at: "2026-09-22T20:00:00.000Z" }];
    expect(exceedsCap(existing, { clip_id: "c1", platform: "youtube", scheduled_at: "2026-09-23T20:00:00.000Z" }, TZ, { tiktok: 10, instagram: 7, youtube: 1 })).toBe(false);
  });
});
