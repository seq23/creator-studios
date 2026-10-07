// The full-video door (owner, 26 Sep 2026): "A full video for YouTube". One video goes up whole:
// no cutting and no 9:16 reframing (validator `full-video-uncut`). From its transcript we draft a
// title, a description with chapters, tags and three thumbnail choices; she approves in Review; it
// goes on the Calendar within her YouTube cap (at most one full video a week) and posts through
// Buffer with the privacy she picked. Buffer cannot set a custom thumbnail or tags (its schema,
// introspected 26 Sep 2026: VideoAssetInput.thumbnailUrl is rejected and thumbnailOffset is for
// Instagram/TikTok/Pinterest only; YoutubePostMetadataInput has no tags), so those two are a
// guided "Finish in YouTube Studio" step. Pure and unit-tested (tests/unit/full-video.test.ts).

export const FULL_VIDEO_PRIVACY = ["public", "unlisted", "private"] as const;
export type FullVideoPrivacy = (typeof FULL_VIDEO_PRIVACY)[number];
export const PRIVACY_LABEL: Record<FullVideoPrivacy, string> = { public: "Public", unlisted: "Unlisted", private: "Private" };

/** R2's free tier (Cloudflare): 10 GB stored. Shown before Dump, never enforced beyond the bucket's own limit. */
export const R2_FREE_BYTES = 10 * 1024 ** 3;
/** Storage rule: the file goes 7 days after it posted, or 14 days after it came back if never approved (warning 3 days before). */
export const DELETE_AFTER_POSTED_DAYS = 7;
export const DELETE_UNAPPROVED_DAYS = 14;
export const WARN_DAYS_BEFORE = 3;
/** YouTube's own limits for a title and a description; tags are at most 500 characters together. */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_MAX_CHARS = 500;

export interface Chapter {
  t: number;
  title: string;
}
export interface Thumb {
  key: string;
  t: number;
}
export interface FullVideoDetails {
  title: string;
  description: string;
  chapters: Chapter[];
  tags: string[];
  thumbnails: Thumb[];
  thumb_pick: number;
  privacy: FullVideoPrivacy;
  width: number;
  height: number;
  duration_s: number;
  size_bytes: number;
  studio_done_at: string | null;
  /** Buffer would not take it: she uploads it herself (Download for YouTube + YouTube Studio). */
  handoff: boolean;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** 0:00, 4:05, 1:02:03: how YouTube reads a chapter time in a description. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const STOP = new Set("a an and are as at be but by for from have i i'm in is it it's just like me my of on or our so that the then this to up was we what with you your yeah okay ok um uh really very".split(" "));

/** A short chapter name from the words spoken in it: the first few words that say something. */
function nameFrom(text: string, n: number): string {
  const words = text.replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const start = words.findIndex((w) => !STOP.has(w.toLowerCase()));
  const pick = words.slice(Math.max(0, start), Math.max(0, start) + 5).join(" ");
  const t = pick ? pick.charAt(0).toUpperCase() + pick.slice(1) : `Part ${n}`;
  return t.slice(0, 60);
}

/**
 * Chapters YouTube accepts: the first at 0:00, at least three, each at least 10 seconds long
 * (YouTube's rule), about one per 1.5 to 3 minutes, starting where a sentence starts. A video under
 * 1.5 minutes, or one we couldn't hear, gets none (YouTube would ignore them).
 */
export function draftChapters(segments: readonly Segment[], duration: number): Chapter[] {
  if (duration < 90 || !segments.length) return [];
  const want = Math.min(12, Math.max(3, Math.round(duration / 150)));
  const step = duration / want;
  const out: Chapter[] = [];
  for (let i = 0; i < want; i++) {
    const target = i * step;
    const seg = i === 0 ? segments[0] : segments.reduce((best, s) => (Math.abs(s.start - target) < Math.abs(best.start - target) ? s : best), segments[0]);
    const t = i === 0 ? 0 : Math.floor(seg.start);
    if (out.length && t - out[out.length - 1].t < 10) continue;
    if (duration - t < 10) continue;
    const words = segments.filter((s) => s.start >= t && s.start < t + step).map((s) => s.text).join(" ");
    // Every chapter a different name: a repeated one (she says the same thing twice, or a
    // looped intro) takes the next sentence of that chapter, then its number.
    let title = nameFrom(words || seg.text, out.length + 1);
    const taken = (x: string) => out.some((c) => c.title.toLowerCase() === x.toLowerCase());
    for (const sentence of (words || seg.text).split(/(?<=[.!?])\s+/).slice(1)) {
      if (!taken(title)) break;
      title = nameFrom(sentence, out.length + 1);
    }
    if (taken(title)) title = `${title.slice(0, 52)} (part ${out.length + 1})`;
    out.push({ t, title });
  }
  return out.length >= 3 ? out : [];
}

/** The description YouTube gets: her words, then the chapters (so YouTube shows them), then up to three hashtags. */
export function composeDescription(body: string, chapters: readonly Chapter[], tags: readonly string[]): string {
  const parts = [body.trim()];
  if (chapters.length >= 3) parts.push(["Chapters", ...chapters.map((c) => `${stamp(c.t)} ${c.title}`)].join("\n"));
  const hashtags = tags.slice(0, 3).map((t) => `#${t.replace(/[^\p{L}\p{N}]+/gu, "")}`).filter((t) => t.length > 1);
  if (hashtags.length) parts.push(hashtags.join(" "));
  return parts.filter(Boolean).join("\n\n").slice(0, DESCRIPTION_MAX);
}

/** Tags cleaned and cut to YouTube's 500 characters. */
export function cleanTags(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out: string[] = [];
  let used = 0;
  for (const x of list) {
    const t = String(x).replace(/^#/, "").replace(/[<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!t || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue;
    if (used + t.length + (out.length ? 1 : 0) > TAGS_MAX_CHARS) break;
    out.push(t);
    used += t.length + (out.length > 1 ? 1 : 0);
  }
  return out.slice(0, 30);
}

export function cleanTitle(t: unknown, fallback: string): string {
  const s = String(t ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  return s || fallback.slice(0, TITLE_MAX) || "New video";
}

/** When the free AI is busy: a title and a description from her own first words, never empty. */
export function starterDraft(segments: readonly Segment[], fileName: string): { title: string; body: string; tags: string[] } {
  const all = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const first = all.split(/(?<=[.!?])\s+/)[0] ?? "";
  const name = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  const title = cleanTitle(first.length >= 12 && first.length <= 90 ? first.replace(/[.!?]+$/, "") : name, "New video");
  const body = all ? all.slice(0, 400) + (all.length > 400 ? "…" : "") : "A new video.";
  const counts = new Map<string, number>();
  for (const w of all.toLowerCase().match(/\p{L}{4,}/gu) ?? []) if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  return { title, body, tags };
}

// ---------------------------------------------------------------- storage

export type StorageAction = { do: "keep" } | { do: "warn"; deleteOn: string } | { do: "delete"; why: "posted" | "unapproved" };

/**
 * The storage rule for one full video's file (owner, 26 Sep 2026): gone 7 days after it posted
 * (the thumbnail, words and numbers stay); an unapproved one goes 14 days after it came back,
 * with a Home warning from 3 days before. Approved and waiting to post: kept.
 */
export function storageAction(v: { status: string; created_at: string; posted_at: string | null; file_deleted_at: string | null }, now: Date): StorageAction {
  if (v.file_deleted_at) return { do: "keep" };
  const day = 86400_000;
  if (v.posted_at) return now.getTime() - Date.parse(v.posted_at) >= DELETE_AFTER_POSTED_DAYS * day ? { do: "delete", why: "posted" } : { do: "keep" };
  if (v.status === "draft" || v.status === "rejected") {
    const at = Date.parse(v.created_at) + DELETE_UNAPPROVED_DAYS * day;
    if (now.getTime() >= at) return { do: "delete", why: "unapproved" };
    if (now.getTime() >= at - WARN_DAYS_BEFORE * day) return { do: "warn", deleteOn: new Date(at).toISOString() };
  }
  return { do: "keep" };
}

/** "At most one pending full video file per week slot": how many may wait at once (the Calendar plans this many weeks). */
export function pendingRefusal(pending: number, weeksAhead: number): string | null {
  if (pending < weeksAhead) return null;
  return `You already have ${pending} full videos waiting, one for each of the next ${weeksAhead} weeks. Post or delete one first, so they don't fill your storage.`;
}

/** Plain size for the Dump screen: "1.2 GB", "640 MB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Before Dump: this upload and what's left of the free 10 GB; a warning when it would not fit. */
export function spaceLine(uploadBytes: number, usedBytes: number): { line: string; fits: boolean } {
  const left = Math.max(0, R2_FREE_BYTES - usedBytes);
  const fits = uploadBytes <= left;
  return { line: `This video: ${sizeWords(uploadBytes)} · free space left: ${sizeWords(left)} of 10 GB`, fits };
}

/**
 * Can Buffer post it? PROVEN on staging 26 Sep 2026 (a 1280x720, 200 s TEST video): Buffer's API
 * posts to YouTube only as a Short and refused it with "Video must be no longer than 3 minutes for
 * YouTube Shorts., Video must be vertical (portrait orientation) for YouTube Shorts."; its schema has
 * no post type for YouTube (YoutubePostMetadataInput has none). So Buffer takes a full video only
 * when it is vertical and 3 minutes or less; every other one is hers to upload in two taps (Download
 * for YouTube, then YouTube's upload page). With Connect YouTube (owner decision 26 Sep 2026) a full
 * video goes to her channel directly instead (worker/lib/youtubeDirect.ts) and this stays the fallback.
 */
export const SHORTS_MAX_S = 180;
export function bufferCanTake(v: { width: number; height: number; duration_s: number }): boolean {
  return v.height > v.width && v.duration_s <= SHORTS_MAX_S;
}

/** YouTube Studio: the video's edit page when we know its id, else Studio's home (she picks it). */
export function studioLink(url: string | null): string {
  const id = url?.match(/(?:v=|youtu\.be\/|shorts\/|video\/)([\w-]{11})/)?.[1];
  return id ? `https://studio.youtube.com/video/${id}/edit` : "https://studio.youtube.com/";
}
