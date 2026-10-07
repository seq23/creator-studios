// Learning loop (phase 8): her own best times replace the 10b launch slots only after 4 weeks.
import { describe, expect, it } from "vitest";
import { DEFAULT_WEEKLY_CAPS, LAUNCH_SLOTS } from "@shared/constants";
import { bucketByTime, historyDays, LEARN_MIN_DAYS, learnSlots, learningReady, localDayHour, rankRecipes, type Observation } from "@worker/domain/learning";

const TZ = "America/New_York";
// 2026-09-23 is a Wednesday. 20:00 local (EDT, UTC-4) = 00:00Z next day.
const at = (daysAgo: number, utcHour: number) => new Date(Date.UTC(2026, 8, 24, utcHour) - daysAgo * 86_400_000).toISOString();

function history(days: number, perDay = 1): Observation[] {
  const out: Observation[] = [];
  for (let d = 0; d < days; d++)
    for (let k = 0; k < perDay; k++) {
      const utcHour = k % 2 === 0 ? 0 : 13; // 8 pm or 9 am local
      out.push({ platform: "instagram", posted_at: at(d, utcHour), views: utcHour === 0 ? 5000 : 800 });
    }
  return out;
}

describe("local time", () => {
  it("reads weekday and hour in her audience's time zone", () => {
    expect(localDayHour("2026-09-24T00:00:00Z", TZ)).toEqual({ day: 3, hour: 20 }); // Wed 8 pm EDT
    expect(localDayHour("2026-09-24T00:00:00Z", "UTC")).toEqual({ day: 4, hour: 0 });
  });
});

describe("gate: 4 weeks of results before her times take over", () => {
  it("27 days of history is not enough; 28 is", () => {
    expect(learningReady(history(28), "instagram")).toBe(false); // spans 27 days
    expect(historyDays(history(29), "instagram")).toBe(28);
    expect(learningReady(history(29), "instagram")).toBe(true);
    expect(LEARN_MIN_DAYS).toBe(28);
  });
  it("a long span with too few posts is not enough", () => {
    const sparse: Observation[] = [0, 10, 20, 30, 40].map((d) => ({ platform: "tiktok", posted_at: at(d, 0), views: 100 }));
    expect(historyDays(sparse, "tiktok")).toBe(40);
    expect(learningReady(sparse, "tiktok")).toBe(false);
  });
  it("platforms without enough history are left out, so the planner keeps launch slots", () => {
    const learned = learnSlots(history(10), TZ, DEFAULT_WEEKLY_CAPS);
    expect(learned).toEqual({});
  });
});

describe("learned slots", () => {
  const obs = history(35, 2);
  const learned = learnSlots(obs, TZ, DEFAULT_WEEKLY_CAPS);

  it("returns exactly the weekly cap of slots for a ready platform", () => {
    expect(Object.keys(learned)).toEqual(["instagram"]);
    expect(learned.instagram).toHaveLength(DEFAULT_WEEKLY_CAPS.instagram);
  });
  it("puts her best (8 pm) buckets ahead of launch fill-ins", () => {
    const eights = learned.instagram!.filter((s) => s.hour === 20);
    expect(eights.length).toBe(7); // one per weekday, all beating the 9 am posts
  });
  it("never exceeds the hard cap and tops up from launch slots when she used few times", () => {
    const one: Observation[] = Array.from({ length: 30 }, (_, i) => ({ platform: "tiktok" as const, posted_at: at(i, 0), views: 1000 }));
    const l = learnSlots(one, TZ, { tiktok: 12, instagram: 0, youtube: 0 });
    expect(l.tiktok).toHaveLength(10);
    const fromLaunch = l.tiktok!.filter((s) => LAUNCH_SLOTS.tiktok.some((x) => x.day === s.day && x.hour === s.hour));
    expect(fromLaunch.length).toBeGreaterThan(0);
    expect(new Set(l.tiktok!.map((s) => `${s.day}:${s.hour}`)).size).toBe(10);
  });
  it("slots come back in week order starting Monday", () => {
    const order = learned.instagram!.map((s) => (s.day + 6) % 7);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("stats rankings", () => {
  it("buckets average views by weekday and hour, best first", () => {
    const b = bucketByTime(history(7, 2), TZ);
    expect(b[0].hour).toBe(20);
    expect(b[0].avg_views).toBe(5000);
    expect(b.at(-1)!.avg_views).toBe(800);
  });
  it("ranks cut styles by average views", () => {
    expect(rankRecipes([{ recipe: "story", views: 100 }, { recipe: "hook_first", views: 900 }, { recipe: "story", views: 300 }])).toEqual([
      { recipe: "hook_first", posts: 1, avg_views: 900 },
      { recipe: "story", posts: 2, avg_views: 200 },
    ]);
  });
});
