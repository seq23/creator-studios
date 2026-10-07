// Full videos straight to her own YouTube channel (owner decision, 26 Sep 2026): Sam taps
// "Connect YouTube" once, signs in on Google's page and taps Continue; from then on every full video
// she approves uploads to her channel from a GitHub Actions job (resumable upload, videos.insert)
// and is read back to prove it landed the way she asked. Buffer keeps posting the Shorts, TikTok
// and Instagram clips. Pure rules, unit-tested (tests/unit/youtube-direct.test.ts); the Worker side
// is worker/lib/youtubeDirect.ts, the job is jobs/ytupload.py.

import type { FullVideoPrivacy } from "./fullVideo";

/** YouTube's default daily allowance for one Google project (quota units). */
export const YT_DAILY_UNITS = 10_000;
/** videos.insert's cost in quota units (YouTube Data API quota table). */
export const YT_INSERT_UNITS = 1600;
/** At most this many uploads a day, so the reads, updates and thumbnails always have room left. */
export const YT_UPLOADS_PER_DAY = 3;
/** YouTube's quota day starts at midnight Pacific time. */
export const YT_QUOTA_TIMEZONE = "America/Los_Angeles";
/** A publish time closer than this is not scheduled: the video goes up with her privacy at once. */
export const PUBLISH_AT_MIN_LEAD_MS = 15 * 60_000;
/** Upload once the post is this close (the same window Buffer loads in): moves before that cost nothing. */
export const UPLOAD_WINDOW_MS = 7 * 86_400_000;
/** A job still "uploading" after this long is treated as failed (the workflow's own timeout is 120 min). */
export const UPLOAD_STUCK_MS = 3 * 3600_000;
/** An upload that failed for no named reason is tried again this many times before the hand-off. */
export const UPLOAD_MAX_ATTEMPTS = 2;
/** Where she proves her channel is hers so YouTube takes a custom thumbnail. */
export const YT_VERIFY_URL = "https://www.youtube.com/verify";
export const THUMB_VERIFY_NOTE = "Verify your channel's phone number in YouTube to use custom thumbnails";

export type UploadStatus = "queued" | "uploading" | "scheduled" | "live" | "removed" | "mismatch" | "failed";
export type DirectMode = "on" | "broken" | "off";

export interface Intent {
  privacyStatus: FullVideoPrivacy;
  /** ISO time YouTube makes it public; only with privacyStatus "private" (YouTube's rule). */
  publishAt: string | null;
}

/**
 * What YouTube is told for a video on the Calendar at `slot`:
 *   Public, slot at least 15 minutes ahead → private now, public at the slot (publishAt).
 *   Public, slot past or within 15 minutes → public now.
 *   Unlisted / Private → that, set directly, no publishAt.
 */
export function intentFor(privacy: FullVideoPrivacy, slot: string, now: Date): Intent {
  if (privacy !== "public") return { privacyStatus: privacy, publishAt: null };
  const at = Date.parse(slot);
  if (Number.isFinite(at) && at - now.getTime() >= PUBLISH_AT_MIN_LEAD_MS) return { privacyStatus: "private", publishAt: new Date(Math.floor(at / 1000) * 1000).toISOString() };
  return { privacyStatus: "public", publishAt: null };
}

/** Taken off the Calendar before it went public: private, kept on her channel, never deleted. */
export const REMOVED_INTENT: Intent = { privacyStatus: "private", publishAt: null };

/** The status part YouTube gets on insert and on every update (videos.update replaces the whole part). */
export function statusPart(intent: Intent, aiVoice: boolean): Record<string, unknown> {
  const s: Record<string, unknown> = { privacyStatus: intent.privacyStatus, selfDeclaredMadeForKids: false, containsSyntheticMedia: aiVoice };
  if (intent.publishAt) s.publishAt = intent.publishAt;
  return s;
}

export interface ReadBack {
  privacyStatus: string | null;
  publishAt: string | null;
  uploadStatus?: string | null;
  failureReason?: string | null;
  rejectionReason?: string | null;
}

export type Verdict = { ok: true } | { ok: false; why: "missing" | "rejected" | "kept_private" | "publish_at" | "privacy"; note: string; guide: string };

const sameTime = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) < 1000 : !a && !b);

/** Read back with videos.list and compare with what was intended. Any difference is a red light with a named fix. */
export function verifyReadBack(intent: Intent, got: ReadBack | null): Verdict {
  if (!got) return { ok: false, why: "missing", note: "YouTube doesn't show the video on your channel. It goes back to Upload it yourself.", guide: "upload-it-yourself" };
  if (got.uploadStatus === "rejected" || got.uploadStatus === "failed") return { ok: false, why: "rejected", note: `YouTube didn't accept the video (${(got.rejectionReason ?? got.failureReason ?? "no reason given").slice(0, 60)}). Upload it yourself from Home.`, guide: "upload-it-yourself" };
  if (got.privacyStatus === intent.privacyStatus && sameTime(got.publishAt, intent.publishAt)) return { ok: true };
  if (intent.publishAt && got.privacyStatus === "private" && !sameTime(got.publishAt, intent.publishAt)) return { ok: false, why: "publish_at", note: "YouTube didn't keep the time it goes public. It is safe as private: move it on the Calendar to set the time again.", guide: "move-or-remove-a-post" };
  if (intent.privacyStatus !== "private" && got.privacyStatus === "private") return { ok: false, why: "kept_private", note: "YouTube kept this video private instead of what you chose. It is safe on your channel; set who can see it in YouTube Studio, or Upload it yourself from Home.", guide: "upload-it-yourself" };
  return { ok: false, why: "privacy", note: `YouTube shows it as ${got.privacyStatus ?? "unknown"}, not ${intent.privacyStatus}. Open it in YouTube Studio and set who can see it.`, guide: "post-a-full-video" };
}

export type ErrorKind = "quota" | "upload_limit" | "revoked" | "scope" | "publish_at" | "thumb_verify" | "retry" | "other";

/**
 * YouTube's and Google's error shapes (shared/youtube-errors.json, the real bodies),
 * by HTTP status and the first `errors[].reason` (or OAuth's `error`). `thumbnail` = the answer
 * came from thumbnails.set.
 */
export function classifyError(http: number, reason: string | null | undefined, opts: { thumbnail?: boolean } = {}): ErrorKind {
  const r = (reason ?? "").trim();
  if (r === "quotaExceeded" || r === "dailyLimitExceeded" || r === "rateLimitExceeded" || r === "userRateLimitExceeded") return "quota";
  if (r === "uploadLimitExceeded") return "upload_limit";
  // The sign-in lacks a permission the call needs (insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT): reconnect.
  if (r === "insufficientPermissions" || r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || r === "PERMISSION_DENIED") return "scope";
  if (http === 401 || r === "authError" || r === "invalid_grant" || r === "unauthorized_client") return "revoked";
  if (r === "invalidPublishAt") return "publish_at";
  if (opts.thumbnail && http === 403) return "thumb_verify";
  if (http === 0 || http === 408 || http === 429 || http >= 500) return "retry";
  return "other";
}

/** The YouTube quota day (Pacific), as YYYY-MM-DD. */
export function quotaDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: YT_QUOTA_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The next midnight Pacific, when YouTube's allowance starts again (to the minute, DST-safe). */
export function nextQuotaReset(now: Date): string {
  const today = quotaDay(now);
  let t = Math.ceil(now.getTime() / 60_000) * 60_000;
  // at most ~25 hours ahead; step an hour, then back to the minute the day flips
  while (quotaDay(new Date(t)) === today) t += 3600_000;
  while (quotaDay(new Date(t - 60_000)) !== today) t -= 60_000;
  return new Date(t).toISOString();
}

/** The plain note when today's uploads are used up (the cap), or null when this one may go. */
export function capNote(startedToday: number): string | null {
  if (startedToday < YT_UPLOADS_PER_DAY) return null;
  return `YouTube lets the dashboard upload ${YT_UPLOADS_PER_DAY} full videos a day. This one goes up tomorrow, still in time for its slot.`;
}

export const QUOTA_NOTE = "YouTube's upload allowance for today is used up. It goes up tomorrow on its own; nothing for you to do.";

export interface ReconcileInput {
  status: UploadStatus;
  video_id: string | null;
  privacy: FullVideoPrivacy;
  intended: Intent | null;
  /** The clip's active post (planned), or null when it is off the Calendar. */
  post: { scheduled_at: string } | null;
  posted: boolean;
}

export type ReconcileAction = { do: "none" } | { do: "update"; intent: Intent } | { do: "read_back" };

/**
 * An uploaded video follows the Calendar: moved → a new publishAt (videos.update), taken off before
 * it went public → private and kept, put back → its time again. Never a second upload, never a delete.
 */
export function reconcile(v: ReconcileInput, now: Date): ReconcileAction {
  if (!v.video_id || v.posted || v.status === "uploading" || v.status === "failed") return { do: "none" };
  if (!v.post) {
    if (v.status === "removed") return { do: "none" };
    if (v.status === "live" && v.privacy !== "public") return { do: "none" }; // already where she chose, nothing to hide
    return { do: "update", intent: REMOVED_INTENT };
  }
  const want = intentFor(v.privacy, v.post.scheduled_at, now);
  const had = v.intended;
  if (v.status === "scheduled" && had?.publishAt && Date.parse(had.publishAt) <= now.getTime()) return { do: "read_back" };
  if (!had || had.privacyStatus !== want.privacyStatus || !sameTime(had.publishAt, want.publishAt)) {
    // Unlisted / Private are set once; moving them on the Calendar changes nothing on YouTube.
    if (v.status === "live" && want.publishAt === null && had?.privacyStatus === want.privacyStatus) return { do: "none" };
    return { do: "update", intent: want };
  }
  return { do: "none" };
}

/** The light for the connection and the uploads, in one row: "YouTube (full videos)". */
export const HEALTH_NAME = "YouTube (full videos)";
