// Pure decisions behind the Calendar and the hourly Buffer sync (sections 10, 10b, 11).
// No database, no network: the route and the cron gather rows, call these, and write back.
// tests/unit/buffer-sync.test.ts pins every rule here.
import { BUFFER_MAX_RETRIES, BUFFER_QUEUE_LIMIT_PER_CHANNEL, BUFFER_WINDOW_DAYS, HARD_CAP_PER_CHANNEL_PER_WEEK, LAUNCH_SLOTS, PLATFORMS, type Platform, type Slot } from "@shared/constants";
import { orderForWeek, slotsForWeek, type PlannedPost, type SchedulableClip } from "./slotting";

/** Post statuses that hold a slot (count toward the cap and block a second post on a platform). */
export const ACTIVE_STATUSES = ["planned", "in_buffer", "posted", "failed"] as const;
export type PostStatus = (typeof ACTIVE_STATUSES)[number] | "unscheduled";

export interface ExistingPost {
  id: string;
  clip_id: string;
  platform: Platform;
  scheduled_at: string;
  status: PostStatus;
}

// ---------------------------------------------------------------- slot table

/**
 * Which posting times to use. The approved research brief's best times win when they give at
 * least one slot for every platform; otherwise the launch baseline (section 10b).
 */
export function pickSlotTable(briefBestTimes: unknown): { slots: Record<Platform, Slot[]>; source: "brief" | "launch" } {
  if (!briefBestTimes || typeof briefBestTimes !== "object") return { slots: LAUNCH_SLOTS, source: "launch" };
  const bt = briefBestTimes as Record<string, unknown>;
  const out = {} as Record<Platform, Slot[]>;
  for (const p of PLATFORMS) {
    const list = Array.isArray(bt[p]) ? (bt[p] as unknown[]) : [];
    const clean = list
      .map((s) => s as Partial<Slot>)
      .filter((s) => isInt(s.day, 0, 6) && isInt(s.hour, 0, 23) && isInt(s.minute ?? 0, 0, 59))
      .map((s) => ({ day: s.day as number, hour: s.hour as number, minute: (s.minute ?? 0) as number }));
    // de-duplicate identical times; a brief that repeats a slot must not double-book it
    const seen = new Set<string>();
    out[p] = clean.filter((s) => {
      const k = `${s.day}-${s.hour}-${s.minute}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!out[p].length) return { slots: LAUNCH_SLOTS, source: "launch" };
  }
  return { slots: out, source: "brief" };
}

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// ---------------------------------------------------------------- planning ahead

/**
 * Fill the open slots of one week without touching what is already there.
 *  - never more than the platform's cap (and never more than the hard cap of 10)
 *  - never a clip twice on one platform, ever
 *  - "10 unique clips a week": a clip that already has posts only fills slots in that same
 *    week (so its TikTok, Instagram and YouTube posts stay staggered inside one week)
 *  - never a slot in the past
 *  - order by orderForWeek (best first, doors blended, no same source back to back)
 */
export function fillWeek(input: {
  clips: SchedulableClip[];
  existing: ExistingPost[]; // every active post, any week
  weekStart: string;
  weekEnd: string;
  timeZone: string;
  caps: Record<Platform, number>;
  slots: Record<Platform, Slot[]>;
  now: string;
  /** Full videos (any, including ones already planned): at most one a week, inside the YouTube cap. */
  fullClipIds?: ReadonlySet<string>;
}): PlannedPost[] {
  const { clips, weekStart, weekEnd, timeZone, caps, slots, now } = input;
  const full = new Set([...(input.fullClipIds ?? []), ...clips.filter((c) => c.full).map((c) => c.id)]);
  const active = input.existing.filter((p) => p.status !== "unscheduled");
  const onPlatform = new Set(active.map((p) => `${p.clip_id}|${p.platform}`));
  const weekOf = new Map<string, Set<string>>(); // clip → weeks it has posts in (by start)
  for (const p of active) {
    const inThis = p.scheduled_at >= weekStart && p.scheduled_at < weekEnd;
    const set = weekOf.get(p.clip_id) ?? new Set<string>();
    set.add(inThis ? "this" : "other");
    weekOf.set(p.clip_id, set);
  }
  const eligibleClip = (c: SchedulableClip) => {
    const w = weekOf.get(c.id);
    return !w || !w.has("other");
  };

  const slotMap = slotsForWeek(weekStart, timeZone, caps, slots);
  const ordered = orderForWeek(clips.filter(eligibleClip));
  const out: PlannedPost[] = [];
  for (const platform of PLATFORMS) {
    const inWeek = active.filter((p) => p.platform === platform && p.scheduled_at >= weekStart && p.scheduled_at < weekEnd);
    const cap = Math.min(caps[platform] ?? 0, HARD_CAP_PER_CHANNEL_PER_WEEK);
    let room = cap - inWeek.length;
    if (room <= 0) continue;
    const taken = new Set(inWeek.map((p) => p.scheduled_at));
    const free = slotMap[platform].filter((t) => t > now && !taken.has(t));
    let fullThisWeek = inWeek.filter((p) => full.has(p.clip_id)).length;
    for (const c of ordered) {
      if (room <= 0 || !free.length) break;
      if (!c.platforms.includes(platform) || onPlatform.has(`${c.id}|${platform}`)) continue;
      if (full.has(c.id)) {
        if (platform !== "youtube" || fullThisWeek >= 1) continue; // a full video is YouTube only, one a week
        fullThisWeek++;
      }
      out.push({ clip_id: c.id, platform, scheduled_at: free.shift() as string });
      onPlatform.add(`${c.id}|${platform}`);
      room--;
    }
  }
  return out.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

/** Plain-words refusal when a move or placement would break the cap; null when it fits. */
export function capRefusal(platformLabel: string, countInWeek: number, cap: number): string | null {
  const limit = Math.min(cap, HARD_CAP_PER_CHANNEL_PER_WEEK);
  if (countInWeek + 1 <= limit) return null;
  return `${platformLabel} already has ${countInWeek} posts that week and your limit is ${limit}. Move one of them out first, or pick another week.`;
}

/** Wall-clock parts of an instant in the audience time zone. */
export function localParts(iso: string, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the audience time zone. */
export function localDate(iso: string, timeZone: string): string {
  const p = localParts(iso, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Move a post to another local date, keeping its local time of day. */
export function moveToDate(iso: string, date: string, timeZone: string, toUtc: (y: number, m: number, d: number, h: number, min: number, tz: string) => string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const t = localParts(iso, timeZone);
  return toUtc(Number(m[1]), Number(m[2]), Number(m[3]), t.hour, t.minute, timeZone);
}

// ---------------------------------------------------------------- Buffer loading

export interface LoadCandidate {
  id: string;
  platform: Platform;
  scheduled_at: string;
}

export interface LoadPlan {
  load: LoadCandidate[];
  waitingNoRoom: number; // inside the window but the channel queue is full
  waitingDisconnected: number; // inside the window but Buffer or the channel is not connected
}

/**
 * What to hand to Buffer this hour: planned posts inside the next BUFFER_WINDOW_DAYS, earliest
 * first, only on connected channels, never past BUFFER_QUEUE_LIMIT_PER_CHANNEL queued per channel.
 */
export function choosePostsToLoad(
  planned: LoadCandidate[],
  queueUsed: Partial<Record<Platform, number>>,
  channelReady: Partial<Record<Platform, boolean>>,
  now: string,
  windowDays = BUFFER_WINDOW_DAYS,
  limit = BUFFER_QUEUE_LIMIT_PER_CHANNEL,
): LoadPlan {
  const horizon = new Date(new Date(now).getTime() + windowDays * 86400_000).toISOString();
  const inWindow = planned.filter((p) => p.scheduled_at < horizon).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const used: Record<string, number> = { ...queueUsed };
  const out: LoadPlan = { load: [], waitingNoRoom: 0, waitingDisconnected: 0 };
  for (const p of inWindow) {
    if (!channelReady[p.platform]) {
      out.waitingDisconnected++;
      continue;
    }
    if ((used[p.platform] ?? 0) >= limit) {
      out.waitingNoRoom++;
      continue;
    }
    used[p.platform] = (used[p.platform] ?? 0) + 1;
    out.load.push(p);
  }
  return out;
}

/** Buffer's due time: the planned time, or a few minutes from now when that has passed. */
export function bufferDueAt(scheduledAt: string, now: string, leadMinutes = 10): string {
  const min = new Date(new Date(now).getTime() + leadMinutes * 60_000).toISOString();
  return scheduledAt > min ? scheduledAt : min;
}

// ---------------------------------------------------------------- request budget
// Buffer's free API allows 3,000 requests per 30 days (about 100 a day, 4 an hour). The sync
// therefore checks the key and the queues every few hours, counts its own queued posts in
// between, and reads a post back only once its time has come.

export const BUFFER_CHECK_EVERY_HOURS = 6;

/** Re-check the key/channels when forced, when the last check is stale, or while something is broken. */
export function shouldCheckBuffer(lastCheckedAt: string | null, now: string, somethingBroken: boolean, force = false, everyHours = BUFFER_CHECK_EVERY_HOURS): boolean {
  if (force || somethingBroken || !lastCheckedAt) return true;
  return new Date(now).getTime() - new Date(lastCheckedAt).getTime() >= everyHours * 3600_000 - 60_000;
}

/** Queue slots in use per channel: our own queued posts, or Buffer's count when it is higher. */
export function queueUsed(localInBuffer: Partial<Record<Platform, number>>, remote: Partial<Record<Platform, number>>): Record<Platform, number> {
  return Object.fromEntries(PLATFORMS.map((p) => [p, Math.max(localInBuffer[p] ?? 0, remote[p] ?? 0)])) as Record<Platform, number>;
}

/** Only posts whose time has come are read back; Buffer cannot have published the rest. */
export function dueForReadBack<T extends { scheduled_at: string }>(inBuffer: T[], now: string): T[] {
  return inBuffer.filter((p) => p.scheduled_at <= now);
}

// ---------------------------------------------------------------- read back + retries

export type ReadBack =
  | { next: "in_buffer" }
  | { next: "posted"; url: string | null }
  | { next: "retry"; retries: number }
  | { next: "failed"; email: boolean };

/**
 * One in_buffer post's status from Buffer → what the dashboard does. A failure is re-created
 * up to BUFFER_MAX_RETRIES times; after that the post is failed and she gets one email.
 */
export function readBackDecision(bufferStatus: "queued" | "posted" | "failed" | "unknown", url: string | null, retries: number, alreadyEmailed: boolean, maxRetries = BUFFER_MAX_RETRIES): ReadBack {
  if (bufferStatus === "queued" || bufferStatus === "unknown") return { next: "in_buffer" };
  if (bufferStatus === "posted") return { next: "posted", url };
  if (retries < maxRetries) return { next: "retry", retries: retries + 1 };
  return { next: "failed", email: !alreadyEmailed };
}

/** A post that failed to be created at all (Buffer refused it) follows the same retry budget. */
export function createFailureDecision(retries: number, alreadyEmailed: boolean, maxRetries = BUFFER_MAX_RETRIES): { status: "planned" | "failed"; retries: number; email: boolean } {
  if (retries < maxRetries) return { status: "planned", retries: retries + 1, email: false };
  return { status: "failed", retries, email: !alreadyEmailed };
}

// ---------------------------------------------------------------- connection flips

export type ConnState = "ok" | "bad" | "off";

/**
 * "Connection needs you" fires once per flip: a connection that was ok last run and is bad
 * now. Staying bad does not re-send; going off (never connected / she disconnected it) does
 * not send either, because she did that herself.
 */
export function connectionFlips(prev: Record<string, ConnState>, next: Record<string, ConnState>): string[] {
  return Object.keys(next)
    .filter((k) => next[k] === "bad" && prev[k] === "ok")
    .sort();
}

export interface ChannelSeen {
  connected: boolean;
  paused?: boolean;
  handle: string;
}

/**
 * Health light for one Buffer channel. Not added in Buffer yet is yellow (nothing is broken,
 * posts wait safely); disconnected or a post that failed after retries is red.
 */
export function channelHealth(label: string, ch: ChannelSeen | null, failedPosts: number, lastPostedAt: string | null): { light: "green" | "yellow" | "red"; note: string; fix: string | null; state: ConnState } {
  if (!ch) return { light: "yellow", note: `Not added in Buffer yet · ${label} posts wait safely`, fix: "add-channels-in-buffer", state: "off" };
  if (!ch.connected) return { light: "red", note: "Disconnected in Buffer · reconnect it there", fix: "reconnect-an-account", state: "bad" };
  if (failedPosts > 0) return { light: "red", note: `${failedPosts} post${failedPosts === 1 ? "" : "s"} did not go out`, fix: "a-post-failed", state: "ok" };
  if (ch.paused) return { light: "yellow", note: "Queue paused in Buffer · press Resume there", fix: "reconnect-an-account", state: "ok" };
  return { light: "green", note: lastPostedAt ? `${ch.handle} · last post ${lastPostedAt.slice(0, 10)}` : `${ch.handle} · posting OK`, fix: null, state: "ok" };
}
