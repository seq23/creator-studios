// File retention for her originals (owner, 20 Nov 2026). Pure: what each dump's originals are due
// for today. worker/lib/retention.ts reads D1, sends the emails and clears the files.
//
// The rule, in her words: your original videos and photos are cleared RAW_RETENTION_DAYS after their
// clips are ready. You get an email 14 days and 3 days before (Download all, or Keep them), and a
// note when it is done. A dump you kept, or one still being cut, is never cleared.
//
// Never cleared unwarned: the 14-day email must have stood 14 days and the 3-day email 3 days, so a
// dump already past its date when this shipped still gets the full 14 days from its first email.
//
// On the host's SHARED storage the rule is shorter (owner, 21 Nov 2026: "it needs to rotate out
// often"; HOST_STORAGE in worker/domain/tidy.ts): cleared 7 days after the clips are made or 14 days
// after upload, whichever comes first, never while a cut is running; one heads-up email 3 days
// before when the studio has email, and the clear always waits the full 3 days after it. Keep is
// not offered there any more (her own storage is how she keeps originals); a dump she kept BEFORE
// that is cleared only after that email went and stood its 3 days, never silently without email.
// The 30-day rule above is for her own storage.
import { RAW_RETENTION_DAYS, RAW_WARN_DAYS } from "@shared/constants";
import { HOST_STORAGE } from "./tidy";
import { hmacHex, timingSafeEqual } from "../lib/crypto";

const DAY = 86400_000;
const [FIRST, LAST] = RAW_WARN_DAYS;

export interface RetentionDump {
  id: string;
  status: string;
  ready_at: string | null;
  /** 1 = she tapped Keep them. */
  kept: number;
  /** a cut / start-over job for this dump is queued or running */
  open_job: number;
  /** when each notice went (ISO), if it did */
  sent14: string | null;
  sent3: string | null;
  /** the latest original's upload time in this dump (the shared storage's 14-day clock) */
  uploaded_at?: string | null;
}

/** Which rule a dump's originals follow: her own storage (30 days, two emails, Keep) or the host's shared storage. */
export type RetentionRule = "own" | "shared";

export type RetentionStep = { do: "none"; why: string } | { do: "warn14" | "warn3"; clears: string } | { do: "clear" };

const t = (iso: string) => Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);

/** The shared storage's own date: 7 days after the clips, or 14 days after upload, whichever comes first. Null while it has neither. */
function sharedDue(d: RetentionDump): number | null {
  const fromClips = d.ready_at && ["ready", "reviewed"].includes(d.status) ? t(d.ready_at) + HOST_STORAGE.rawAfterClipsDays * DAY : Infinity;
  const fromUpload = d.uploaded_at ? t(d.uploaded_at) + HOST_STORAGE.rawAfterUploadDays * DAY : Infinity;
  const due = Math.min(fromClips, fromUpload);
  return Number.isFinite(due) ? due : null;
}

/** The day this dump's originals clear, given the notices so far (never before each warning has stood its days). Null = never (kept, still open, not ready). */
export function clearDate(d: RetentionDump, rule: RetentionRule = "own", canWarn = true, now = new Date()): Date | null {
  if (rule === "shared") {
    const due = d.open_job ? null : sharedDue(d);
    if (due === null) return null;
    if (!canWarn) return d.kept ? null : new Date(due);
    return new Date(d.sent3 ? Math.max(due, t(d.sent3) + HOST_STORAGE.warnDays * DAY) : Math.max(due, now.getTime() + HOST_STORAGE.warnDays * DAY));
  }
  if (d.kept || d.open_job || !d.ready_at || !["ready", "reviewed"].includes(d.status)) return null;
  let due = t(d.ready_at) + RAW_RETENTION_DAYS * DAY;
  if (d.sent14) due = Math.max(due, t(d.sent14) + FIRST * DAY);
  if (d.sent3) due = Math.max(due, t(d.sent3) + LAST * DAY);
  return new Date(due);
}

/**
 * What this dump's originals are due for today. `canWarn` false (no studio email) on the shared
 * storage: cleared on the day without an email (the rule is on the Add screen and in Settings); on
 * her own storage the caller pauses instead (worker/lib/retention.ts, a named stop).
 */
export function retentionStep(d: RetentionDump, now: Date, rule: RetentionRule = "own", canWarn = true): RetentionStep {
  if (rule === "shared") {
    if (d.open_job) return { do: "none", why: "open" };
    const due = sharedDue(d);
    if (due === null) return { do: "none", why: "not_ready" };
    const n = now.getTime();
    const warn = HOST_STORAGE.warnDays * DAY;
    if (!canWarn) {
      // A dump she kept is never cleared without the email first: it stays, and the Storage light says so.
      if (d.kept) return { do: "none", why: "kept_no_email" };
      return n >= due ? { do: "clear" } : { do: "none", why: "not_yet" };
    }
    if (!d.sent3) return due - n <= warn ? { do: "warn3", clears: new Date(Math.max(due, n + warn)).toISOString() } : { do: "none", why: "not_yet" };
    return n >= clearDate(d, rule, canWarn, now)!.getTime() ? { do: "clear" } : { do: "none", why: "warned" };
  }
  if (d.kept) return { do: "none", why: "kept" };
  if (d.open_job || !["ready", "reviewed"].includes(d.status)) return { do: "none", why: "open" };
  if (!d.ready_at) return { do: "none", why: "not_ready" };
  const n = now.getTime();
  // First email: 14 days ahead (or today, for a dump already inside that window).
  if (!d.sent14) {
    const due = t(d.ready_at) + RAW_RETENTION_DAYS * DAY;
    return due - n <= FIRST * DAY ? { do: "warn14", clears: new Date(Math.max(due, n + FIRST * DAY)).toISOString() } : { do: "none", why: "not_yet" };
  }
  const due = clearDate(d)!.getTime();
  if (!d.sent3) return due - n <= LAST * DAY ? { do: "warn3", clears: new Date(Math.max(due, n + LAST * DAY)).toISOString() } : { do: "none", why: "warned" };
  return n >= due ? { do: "clear" } : { do: "none", why: "warned" };
}

/** The Download all link in a notice: /originals/<batchId>.<signature>, signed with the session secret. */
export async function originalsToken(secret: string, batchId: string): Promise<string> {
  return `${batchId}.${(await hmacHex(secret, `originals:${batchId}`)).slice(0, 32)}`;
}

/** The batch a link names, or null when the signature is wrong. */
export async function readOriginalsToken(secret: string, token: string): Promise<string | null> {
  const [id, sig] = String(token ?? "").split(".");
  if (!id || !sig || !/^fnb_[a-z0-9]{6,32}$/.test(id)) return null;
  return timingSafeEqual(sig, (await hmacHex(secret, `originals:${id}`)).slice(0, 32)) ? id : null;
}
