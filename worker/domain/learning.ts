// Learning loop (BUILD_PLAN.md sections 3 step 8, 10b, phase 8). Pure functions over "what
// was posted when, and how many views it got", so the Stats page and the learned posting
// slots read the same numbers.
//
// Rule from 10b: the launch slots are averages across many accounts. After about 4 weeks her
// own numbers take over. `learnSlots` returns slots for a platform only when that platform has
// at least LEARN_MIN_DAYS of posted history and LEARN_MIN_POSTS results; otherwise the
// platform is left out and the planner keeps the launch slots.
import { LAUNCH_SLOTS, PLATFORMS, type Platform, type Slot } from "@shared/constants";

export const LEARN_MIN_DAYS = 28;
export const LEARN_MIN_POSTS = 8;

export interface Observation {
  platform: Platform;
  posted_at: string; // ISO
  views: number;
}

export interface TimeBucket {
  platform: Platform;
  day: number; // 0 = Sunday
  hour: number;
  posts: number;
  avg_views: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day of week and hour of an instant in the audience's time zone. */
export function localDayHour(iso: string, timeZone: string): { day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { day: WEEKDAYS.indexOf(parts.weekday), hour: Number(parts.hour) % 24 };
}

/** Group results by (weekday, hour) per platform with average views, best first. */
export function bucketByTime(obs: Observation[], timeZone: string): TimeBucket[] {
  const map = new Map<string, { platform: Platform; day: number; hour: number; n: number; sum: number }>();
  for (const o of obs) {
    if (!o.posted_at || Number.isNaN(Date.parse(o.posted_at))) continue;
    const { day, hour } = localDayHour(o.posted_at, timeZone);
    const k = `${o.platform}:${day}:${hour}`;
    const cur = map.get(k) ?? { platform: o.platform, day, hour, n: 0, sum: 0 };
    cur.n++;
    cur.sum += Math.max(0, o.views);
    map.set(k, cur);
  }
  return [...map.values()]
    .map((b) => ({ platform: b.platform, day: b.day, hour: b.hour, posts: b.n, avg_views: Math.round(b.sum / b.n) }))
    .sort((a, b) => b.avg_views - a.avg_views || b.posts - a.posts || a.day - b.day || a.hour - b.hour);
}

/** Days between the first and last posted result for a platform (0 with fewer than 2). */
export function historyDays(obs: Observation[], platform: Platform): number {
  const ts = obs.filter((o) => o.platform === platform && !Number.isNaN(Date.parse(o.posted_at))).map((o) => Date.parse(o.posted_at));
  if (ts.length < 2) return 0;
  return Math.floor((Math.max(...ts) - Math.min(...ts)) / 86_400_000);
}

export function learningReady(obs: Observation[], platform: Platform): boolean {
  return historyDays(obs, platform) >= LEARN_MIN_DAYS && obs.filter((o) => o.platform === platform).length >= LEARN_MIN_POSTS;
}

const sortSlots = (a: Slot, b: Slot) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || a.hour - b.hour || a.minute - b.minute;

/**
 * Her best slots per platform, `caps[platform]` of them: her top (weekday, hour) buckets by
 * average views, topped up from the launch slots when she has posted in fewer distinct
 * times than she needs. Platforms without enough history are omitted.
 */
export function learnSlots(obs: Observation[], timeZone: string, caps: Record<Platform, number>): Partial<Record<Platform, Slot[]>> {
  const buckets = bucketByTime(obs, timeZone);
  const out: Partial<Record<Platform, Slot[]>> = {};
  for (const p of PLATFORMS) {
    if (!learningReady(obs, p)) continue;
    const need = Math.max(0, Math.min(caps[p] ?? 0, 10));
    if (need === 0) continue;
    const chosen: Slot[] = [];
    const key = (s: { day: number; hour: number }) => `${s.day}:${s.hour}`;
    const taken = new Set<string>();
    for (const b of buckets.filter((x) => x.platform === p)) {
      if (chosen.length >= need) break;
      chosen.push({ day: b.day, hour: b.hour, minute: 0 });
      taken.add(key(b));
    }
    for (const s of LAUNCH_SLOTS[p]) {
      if (chosen.length >= need) break;
      if (taken.has(key(s))) continue;
      chosen.push({ ...s });
      taken.add(key(s));
    }
    out[p] = chosen.sort(sortSlots);
  }
  return out;
}

export interface RecipeRow {
  recipe: string;
  posts: number;
  avg_views: number;
}

/** Average views per cut style, best first. */
export function rankRecipes(rows: { recipe: string; views: number }[]): RecipeRow[] {
  const m = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    const cur = m.get(r.recipe) ?? { n: 0, sum: 0 };
    cur.n++;
    cur.sum += Math.max(0, r.views);
    m.set(r.recipe, cur);
  }
  return [...m.entries()].map(([recipe, v]) => ({ recipe, posts: v.n, avg_views: Math.round(v.sum / v.n) })).sort((a, b) => b.avg_views - a.avg_views || b.posts - a.posts);
}
