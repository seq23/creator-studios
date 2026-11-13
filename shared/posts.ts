// The one Posts list (owner's rulings, 13 Nov 2026): every upcoming post of every kind in one
// place (reels cut from her videos AND photo posts), one set of numbers read by Home, the Calendar
// and Settings, the three true answers of "Fill the calendar", and the Rejected bin. Pure types and
// words shared by the Worker and the app. Plain words only: no vendor names, no ids.
import type { ItemKind } from "./photoPosts";

/** What a post is, in her words. */
export type PostKind = "reel" | "video" | "photo" | "moving_photo" | "before_after" | "photo_set";
export const POST_KIND_LABEL: Record<PostKind, string> = { reel: "Reel", video: "Video", photo: "Photo post", moving_photo: "Moving photo", before_after: "Before and after", photo_set: "Photo set" };

/** A photo pack's piece → its kind (a set of one picture is a photo post). Pure. */
export function photoKind(kind: ItemKind, pictures: number): PostKind {
  if (kind === "reel") return "moving_photo";
  if (kind === "before_after") return "before_after";
  return pictures <= 1 ? "photo" : "photo_set";
}

/**
 * The ONE set of numbers (worker/domain/postCounts.ts): Home, the Calendar and the Settings line
 * all read this, so they can never disagree again (13 Nov 2026: 13 / 17, 16 and 22 on three screens).
 */
export interface PostsSummary {
  /** Posts of every kind that went out this week (the audience's week, Monday to Sunday). */
  postedThisWeek: number;
  /** Posts of every kind still to go out: planned and able to go. Waiting or stopped ones are not counted. */
  toGo: number;
  /** When the last upcoming post goes out; null when nothing is coming. */
  plannedThrough: string | null;
}

/** What "Fill the calendar" found. Never "full" when it is only out of approved posts. */
export type FillState = "added" | "nothing_left" | "all_planned";

export interface FillResult {
  added: number;
  state: FillState;
  /** How many weeks it looked at. */
  weeks: number;
  summary: PostsSummary;
}

export interface PostItem {
  id: string;
  /** Which table it lives in: a reel/video cut from her footage, or a photo post. */
  source: "clip" | "photo";
  kind: PostKind;
  kind_label: string;
  platform: string;
  platform_label: string;
  scheduled_at: string;
  /** coming: goes out by itself · waiting: cannot go out yet (reason says why) · failed · posted · off: taken off or skipped. */
  state: "coming" | "waiting" | "failed" | "posted" | "off";
  /** The plain reason a waiting or failed post cannot go out; null otherwise. */
  reason: string | null;
  headline: string;
  /** The first line of the caption (under the headline in the list). */
  caption_line: string;
  /** The whole caption exactly as it will post, with its tags. */
  caption: string;
  /** What the caption box edits. `tags` is null when the tags are part of the caption itself. */
  edit: { caption: string; tags: string | null } | null;
  /** Why the words cannot be changed right now (plain words), when `edit` is null. */
  edit_note: string | null;
  thumb_url: string | null;
  video_url: string | null;
  images: string[];
  /** The link to the post once it is out. */
  url: string | null;
  can: { move: boolean; swap: boolean; remove: boolean; retry: boolean };
  /** The clip or the photo set behind it (the app never shows it). */
  ref_id: string;
}

/** Posts that cannot go out yet, by reason, each group with one button. */
export interface BlockedGroup {
  key: string;
  label: string;
  action: { label: string; to: string } | null;
  posts: PostItem[];
}

export interface WeekLimit {
  platform: string;
  label: string;
  used: number;
  cap: number;
}

export interface PostsList {
  tz: string;
  summary: PostsSummary;
  /** Every post that will go out, soonest first. */
  posts: PostItem[];
  blocked: BlockedGroup[];
  /** This week's limits, per platform. */
  limits: WeekLimit[];
  /** How many posts sit in the Rejected bin. */
  bin: number;
}

export interface BinItem {
  id: string;
  source: "clip" | "photo";
  kind_label: string;
  headline: string;
  thumb_url: string | null;
  rejected_at: string | null;
  /** When the studio clears it by itself (Settings → Storage); null = it stays until she deletes it. */
  clears_on: string | null;
}

export interface BinList {
  tz: string;
  items: BinItem[];
  /** Days a rejected reel stays before it is cleared automatically. */
  keep_days: number;
}

/** "Fri 13 Nov" in the audience's time zone. Pure. */
export function plainDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/** "4:00 PM" in the audience's time zone. Pure. */
export function plainTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(/ /g, " ");
}

/** "Fri 13 Nov, 4:00 PM". Pure. */
export const plainWhen = (iso: string, timeZone: string): string => `${plainDay(iso, timeZone)}, ${plainTime(iso, timeZone)}`;

/** Under a week of posts left (or none): the list says "then nothing" and offers Add. Pure. */
export function runsOutSoon(s: PostsSummary, now = Date.now()): boolean {
  return !s.plannedThrough || Date.parse(s.plannedThrough) - now < 7 * 86_400_000;
}

/** Line 1 of the Posts list. Pure. */
export function comingLine(s: PostsSummary, timeZone: string, now = Date.now()): string {
  if (!s.toGo) return "No posts coming";
  const n = `${s.toGo} ${s.toGo === 1 ? "post" : "posts"} coming`;
  if (!s.plannedThrough) return n;
  return `${n} · planned through ${plainDay(s.plannedThrough, timeZone)}${runsOutSoon(s, now) ? ", then nothing" : ""}`;
}

/** The sentence "Fill the calendar" answers with: one of three true things. Pure. */
export function fillLine(r: FillResult, timeZone: string): string {
  const through = r.summary.plannedThrough ? plainDay(r.summary.plannedThrough, timeZone) : null;
  if (r.state === "added") return `Added ${r.added} ${r.added === 1 ? "post" : "posts"}.${through ? ` You are now planned through ${through}.` : ""}`;
  if (r.state === "all_planned") return `All ${r.weeks} ${r.weeks === 1 ? "week is" : "weeks are"} planned. Nothing to do.`;
  return `Nothing left to add. ${through ? `You are planned through ${through}.` : "Nothing is planned yet."}`;
}

/** "TikTok: 10 of 10 this week's limit used". Pure. */
export const limitLine = (l: WeekLimit, which: "this" | "that" = "this"): string => `${l.label}: ${l.used} of ${l.cap} ${which} week's limit used`;

/** First line of a caption and the rest's first line (photo posts have no headline of their own). Pure. */
export function splitCaption(caption: string): { first: string; next: string } {
  const lines = String(caption ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return { first: lines[0], next: lines[1] };
  const one = lines[0] ?? "";
  const m = /^(.{12,}?[.!?])\s+(\S.*)$/.exec(one);
  return m ? { first: m[1], next: m[2] } : { first: one, next: "" };
}
