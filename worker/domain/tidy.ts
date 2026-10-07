// Day 358 (docs/reviews/2026-09-26-day-358.md): what gets archived on its own, which files are
// cleared and when, and how full storage may get. Pure and unit-tested (tests/unit/day-358.test.ts).
//
// Two kinds of rule, never mixed up:
//   ARCHIVE (tidy): moves a finished thing out of the way. Nothing is deleted; Show archived +
//     Restore bring it back. Settings → Tidy up (on by default) switches these off.
//   FILES (storage): clears a file to stay inside the free 10 GB. Never her footage or anything
//     unposted without a warning first: an unapproved draft is cleared only after the Home warning
//     has shown for WARN days; an approved clip waiting to post and a media-kit clip never.
import { R2_FREE_BYTES } from "./fullVideo";

const DAY = 86400_000;

/** The ages, in plain days (Settings → Tidy up lists them from here). */
export const TIDY = {
  /** a dump she finished (every clip decided) or that failed / never finished uploading */
  dumpArchiveDays: 30,
  /** a deal that is paid, done, declined or lost */
  dealArchiveDays: 60,
  /** an open deal (any stage before paid) with nothing happening */
  quietDealArchiveDays: 90,
  /** a research brief a newer one replaced */
  briefArchiveDays: 90,
  /** a voice over that failed */
  failedVoiceArchiveDays: 14,
  /** a voice over never put on a clip */
  unusedVoiceArchiveDays: 60,
  /** Home cards she dismissed are forgotten after this (the table stays small) */
  dismissalForgetDays: 90,
} as const;

export const FILES = {
  /** a posted clip's video file (the cover, its numbers and the post link stay) */
  postedClipDays: 30,
  /** an unapproved draft (made this long ago, or since she tapped Keep) */
  draftDays: 60,
  /** the Home warning shows this long before a draft is cleared, and must have shown this long */
  warnDays: 7,
  /** Keep: this many more days */
  keepDays: 60,
} as const;

/** Storage: the free tier, the lights and the hard budget the daily lane holds. */
export const STORAGE = {
  limitBytes: R2_FREE_BYTES,
  yellowAt: 0.7,
  redAt: 0.9,
  /** the daily lane clears files (same rules, earlier) until usage is under this */
  budgetBytes: Math.floor(R2_FREE_BYTES * 0.9),
} as const;

const age = (iso: string | null | undefined, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / DAY : 0);

// ---------------------------------------------------------------- archive (tidy)

export function dumpArchiveDue(d: { status: string; created_at: string; ready_at: string | null; visible_drafts: number }, now: Date): boolean {
  const finished = d.status === "reviewed" || d.status === "failed" || (d.status === "ready" && d.visible_drafts === 0) || d.status === "uploading";
  return finished && age(d.ready_at ?? d.created_at, now) >= TIDY.dumpArchiveDays;
}

export const FINISHED_DEAL_STAGES = ["paid", "done", "declined", "lost"] as const;
/** Open stages: a deal here with no activity for 90 days has gone quiet (archived, never deleted; Restore brings it back). Invoiced is never on it: money she is owed stays in view until it is paid. */
export const QUIET_DEAL_STAGES = ["find_contact", "pitch", "follow_up", "negotiating", "agreed", "delivering"] as const;

export function dealArchiveDue(d: { stage: string; closed_at: string | null; paid_at: string | null; updated_at: string }, now: Date): "finished" | "quiet" | null {
  if ((FINISHED_DEAL_STAGES as readonly string[]).includes(d.stage)) return age(d.closed_at ?? d.paid_at ?? d.updated_at, now) >= TIDY.dealArchiveDays ? "finished" : null;
  if ((QUIET_DEAL_STAGES as readonly string[]).includes(d.stage)) return age(d.updated_at, now) >= TIDY.quietDealArchiveDays ? "quiet" : null;
  return null;
}

export function briefArchiveDue(b: { status: string; created_at: string }, now: Date): boolean {
  return b.status === "superseded" && age(b.created_at, now) >= TIDY.briefArchiveDays;
}

export function voiceArchiveDue(n: { status: string; clip_id: string | null; created_at: string }, now: Date): boolean {
  if (n.status === "failed") return age(n.created_at, now) >= TIDY.failedVoiceArchiveDays;
  return n.status === "ready" && !n.clip_id && age(n.created_at, now) >= TIDY.unusedVoiceArchiveDays;
}

// ---------------------------------------------------------------- files (storage)

export interface ClipFileFacts {
  status: string; // draft | approved | rejected | deleted
  full_video: number;
  created_at: string;
  file_deleted_at: string | null;
  /** latest posted_at, when any post went out */
  last_posted_at: string | null;
  /** a post still planned or in Buffer */
  waiting_post: boolean;
  in_kit: boolean;
  keep_until: string | null;
  delete_warned_at: string | null;
}

export type ClipFileAction =
  | { do: "keep"; why?: "kit" | "waiting" | "approved" }
  | { do: "warn"; deleteOn: string }
  | { do: "delete"; why: "posted" | "draft" };

/** When an unapproved draft's file is due to be cleared (60 days after it was made, or after Keep). */
export function draftDeleteOn(c: Pick<ClipFileFacts, "created_at" | "keep_until">): number {
  const base = Date.parse(c.created_at) + FILES.draftDays * DAY;
  return c.keep_until ? Math.max(base, Date.parse(c.keep_until)) : base;
}

/**
 * One clip's file. Full videos have their own rule (worker/domain/fullVideo.ts storageAction);
 * rejected clips keep theirs (7 days after she rejects, the daily lane's rejected rule).
 */
export function clipFileAction(c: ClipFileFacts, now: Date): ClipFileAction {
  if (c.full_video || c.file_deleted_at || c.status === "deleted" || c.status === "rejected") return { do: "keep" };
  if (c.in_kit) return { do: "keep", why: "kit" };
  if (c.waiting_post) return { do: "keep", why: "waiting" };
  if (c.last_posted_at) return age(c.last_posted_at, now) >= FILES.postedClipDays ? { do: "delete", why: "posted" } : { do: "keep" };
  if (c.status === "approved") return { do: "keep", why: "approved" };
  // an unapproved draft
  const at = draftDeleteOn(c);
  const warnFrom = at - FILES.warnDays * DAY;
  if (now.getTime() < warnFrom) return { do: "keep" };
  // Never without the warning first: cleared only once the warning has shown for WARN days.
  const warnedLongEnough = !!c.delete_warned_at && now.getTime() - Date.parse(c.delete_warned_at) >= FILES.warnDays * DAY;
  if (now.getTime() >= at && warnedLongEnough) return { do: "delete", why: "draft" };
  // the date she sees: never earlier than WARN days after the warning first showed
  const shownOn = c.delete_warned_at ? Date.parse(c.delete_warned_at) + FILES.warnDays * DAY : now.getTime() + FILES.warnDays * DAY;
  return { do: "warn", deleteOn: new Date(Math.max(at, shownOn)).toISOString() };
}

// ---------------------------------------------------------------- the meter and the budget

export type StorageLight = "green" | "yellow" | "red";

export function storageLight(usedBytes: number, limit = STORAGE.limitBytes): StorageLight {
  const f = usedBytes / limit;
  return f >= STORAGE.redAt ? "red" : f >= STORAGE.yellowAt ? "yellow" : "green";
}

export { gbWords } from "@shared/bytes";

/** A file the budget may clear, in the order of least harm. */
export interface BudgetCandidate {
  kind: "raw" | "posted_clip" | "rejected_clip";
  id: string;
  bytes: number;
  /** when its rule would clear it anyway (older first) */
  at: string;
}

/** Least harm first: originals already cut into clips, clips already posted, clips she rejected. */
const ORDER: Record<BudgetCandidate["kind"], number> = { raw: 0, rejected_clip: 1, posted_clip: 2 };

/**
 * Over the hard budget: which files to clear, the same kinds of file the rules clear anyway, just
 * earlier. Candidates never include an approved clip waiting to post, a kit clip or an unwarned
 * draft (the lane never offers them). Returns what to clear and whether that is enough.
 */
export function budgetPlan(used: number, candidates: BudgetCandidate[], budget = STORAGE.budgetBytes): { clear: BudgetCandidate[]; after: number; enough: boolean } {
  if (used <= budget) return { clear: [], after: used, enough: true };
  const sorted = [...candidates].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.at.localeCompare(b.at));
  const clear: BudgetCandidate[] = [];
  let after = used;
  for (const c of sorted) {
    if (after <= budget) break;
    if (c.bytes <= 0) continue;
    clear.push(c);
    after -= c.bytes;
  }
  return { clear, after, enough: after <= budget };
}
