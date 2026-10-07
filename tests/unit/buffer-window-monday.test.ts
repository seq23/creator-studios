// Why tests/e2e/calendar.spec.ts seeds its own posts inside the Buffer window (2 Oct 2026).
//
// The spec fills NEXT week (start_week: 1) at the launch slots and then expected the hourly run
// to hand some of those posts to Buffer, so that "next run after their time" could read them
// back as posted. That only holds when some of next week's slots fall inside the 7-day Buffer
// window — and on a Monday before the first launch slot (TikTok 15:00 ET) none do: the window
// ends next Monday at the same wall-clock minute, hours before that first slot. The scheduled run
// at 08:28 UTC on Monday 28 Sep 2026 (03:28 ET) failed exactly there (posted = 0: the only
// in_buffer post was the hand-placed failing clip); the same code passed on Sunday 27 Sep
// (08:19 UTC) and Friday 2 Oct (13:24 UTC). This pins that arithmetic with the real instants from
// those runs, so the spec never again depends on the weekday it runs on.
import { describe, expect, it } from "vitest";
import { choosePostsToLoad } from "@worker/domain/sync";
import { slotsForWeek, weekBounds } from "@worker/domain/slotting";
import { BUFFER_WINDOW_DAYS, DEFAULT_WEEKLY_CAPS, LAUNCH_SLOTS, PLATFORMS, type Platform } from "@shared/constants";

const TZ = "America/New_York";
const ready = Object.fromEntries(PLATFORMS.map((p) => [p, true])) as Record<Platform, boolean>;

/** What the hourly run would hand to Buffer at `now` from a calendar filled for next week. */
function loadedFromNextWeek(now: string): number {
  const { start } = weekBounds(new Date(now), TZ, 1);
  const slots = slotsForWeek(start, TZ, DEFAULT_WEEKLY_CAPS, LAUNCH_SLOTS);
  const planned = PLATFORMS.flatMap((platform) => slots[platform].map((scheduled_at, i) => ({ id: `${platform}${i}`, platform, scheduled_at })));
  return choosePostsToLoad(planned, {}, ready, now).load.length;
}

describe("the Buffer window against next week's launch slots", () => {
  it("Monday 28 Sep 2026 08:28 UTC (the red scheduled run): nothing from next week is inside the window", () => {
    expect(loadedFromNextWeek("2026-09-28T08:28:02.000Z")).toBe(0);
  });
  it("Sunday 27 Sep 08:19 UTC and Friday 2 Oct 13:24 UTC (green runs): next week's posts are inside it", () => {
    expect(loadedFromNextWeek("2026-09-27T08:19:06.000Z")).toBeGreaterThan(0);
    expect(loadedFromNextWeek("2026-10-02T13:24:03.000Z")).toBeGreaterThan(0);
  });
  it("every Monday is empty until the first launch slot (TikTok 15:00 ET), then fills — the weekday, not the hour, decided it", () => {
    const first = Math.min(...PLATFORMS.flatMap((p) => LAUNCH_SLOTS[p].filter((s) => s.day === 1).map((s) => s.hour * 60 + s.minute)));
    expect(first).toBe(15 * 60);
    for (const h of [0, 4, 8, 12, 14]) expect(loadedFromNextWeek(`2026-10-05T${String(h + 4).padStart(2, "0")}:30:00.000Z`), `Monday ${h}:30 ET`).toBe(0); // EDT = UTC-4
    expect(loadedFromNextWeek("2026-10-05T19:30:00.000Z"), "Monday 15:30 ET").toBeGreaterThan(0);
  });
  it("the window is the 7 days the sync uses, so a post placed 2 hours out is always inside it", () => {
    const now = "2026-10-05T08:30:00.000Z";
    const soon = new Date(Date.parse(now) + 2 * 3600_000).toISOString();
    expect(choosePostsToLoad([{ id: "x", platform: "tiktok", scheduled_at: soon }], {}, ready, now).load).toHaveLength(1);
    expect(BUFFER_WINDOW_DAYS).toBe(7);
  });
});
