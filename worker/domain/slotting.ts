// Scheduling rules (section 10 + 10b), pure functions so the unit tests pin them:
//   - hard cap 10 per channel per week, caps per platform from Settings
//   - 10 unique clips a week: every approved clip → TikTok, best 7 also → Instagram,
//     best 5 also → YouTube, staggered by a few hours (each platform has its own slots)
//   - mix new + recycled; never two clips from the same source video back to back
//   - launch slots in the audience's local time, later replaced by her own data
import { HARD_CAP_PER_CHANNEL_PER_WEEK, LAUNCH_SLOTS, PLATFORMS, type Platform, type Slot } from "@shared/constants";

export interface SchedulableClip {
  id: string;
  asset_id: string;
  score: number;
  platforms: Platform[];
  door: "new" | "recycle";
  /** A full video for YouTube (the third door): at most one a week on the Calendar. */
  full?: boolean;
}

export interface PlannedPost {
  clip_id: string;
  platform: Platform;
  scheduled_at: string; // ISO UTC
}

/** Local wall-clock → UTC ISO, for the audience time zone. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): string {
  // Build the instant as if UTC, then correct by the zone's offset at that instant.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = zoneOffsetMs(guess, timeZone);
  const corrected = guess - offset;
  // A DST change between guess and corrected can shift the offset; correct once more.
  const offset2 = zoneOffsetMs(corrected, timeZone);
  return new Date(guess - offset2).toISOString();
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Monday 00:00 local → next Monday 00:00 local, as UTC ISO bounds. */
export function weekBounds(now: Date, timeZone: string, weekOffset = 0): { start: string; end: string } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const sinceMonday = (dayIdx + 6) % 7;
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  local.setUTCDate(local.getUTCDate() - sinceMonday + weekOffset * 7);
  const start = zonedToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), 0, 0, timeZone);
  const next = new Date(local);
  next.setUTCDate(next.getUTCDate() + 7);
  const end = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { start, end };
}

/** Slot list for one week, as UTC ISO strings sorted ascending, honouring caps. */
export function slotsForWeek(weekStartUtc: string, timeZone: string, caps: Record<Platform, number>, slots: Record<Platform, Slot[]> = LAUNCH_SLOTS): Record<Platform, string[]> {
  const out = {} as Record<Platform, string[]>;
  // weekStartUtc is Monday 00:00 local. Work out that local date.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(weekStartUtc)).map((x) => [x.type, x.value]));
  const monday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  for (const platform of PLATFORMS) {
    const cap = Math.min(caps[platform] ?? 0, HARD_CAP_PER_CHANNEL_PER_WEEK);
    const list = slots[platform]
      .map((s) => {
        const d = new Date(monday);
        d.setUTCDate(d.getUTCDate() + ((s.day + 6) % 7)); // Monday-based offset
        return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), s.hour, s.minute, timeZone);
      })
      .sort();
    out[platform] = list.slice(0, cap);
  }
  return out;
}

/**
 * Order clips for the week: best score first, but never two from the same source video
 * back to back, and alternate doors when both are present.
 */
export function orderForWeek(clips: SchedulableClip[]): SchedulableClip[] {
  const pool = [...clips].sort((a, b) => b.score - a.score);
  const out: SchedulableClip[] = [];
  while (pool.length) {
    const last = out[out.length - 1];
    let idx = pool.findIndex((c) => !last || (c.asset_id !== last.asset_id && c.door !== last.door));
    if (idx < 0) idx = pool.findIndex((c) => !last || c.asset_id !== last.asset_id);
    if (idx < 0) idx = 0;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Fill one week: TikTok gets the top N clips, Instagram the top M of those, YouTube the top K,
 * each at its own slot times. A clip that has a platform unticked is skipped for that platform.
 */
export function planWeek(clips: SchedulableClip[], weekStartUtc: string, timeZone: string, caps: Record<Platform, number>, slots?: Record<Platform, Slot[]>): PlannedPost[] {
  const ordered = orderForWeek(clips);
  const slotMap = slotsForWeek(weekStartUtc, timeZone, caps, slots);
  const posts: PlannedPost[] = [];
  for (const platform of PLATFORMS) {
    const times = slotMap[platform];
    const eligible = ordered.filter((c) => c.platforms.includes(platform)).slice(0, times.length);
    eligible.forEach((c, i) => posts.push({ clip_id: c.id, platform, scheduled_at: times[i] }));
  }
  return posts.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

/** Enforce the hard cap after any manual move: count per platform per local week. */
export function exceedsCap(existing: PlannedPost[], candidate: PlannedPost, timeZone: string, caps: Record<Platform, number>): boolean {
  const { start, end } = weekBounds(new Date(candidate.scheduled_at), timeZone);
  const n = existing.filter((p) => p.platform === candidate.platform && p.scheduled_at >= start && p.scheduled_at < end && p.clip_id !== candidate.clip_id).length;
  return n + 1 > Math.min(caps[candidate.platform] ?? 0, HARD_CAP_PER_CHANNEL_PER_WEEK);
}
