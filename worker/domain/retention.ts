// File retention for her originals (owner, 20 Nov 2026). Pure: what each dump's originals are due
// for today. worker/lib/retention.ts reads D1, sends the emails and clears the files.
//
// The rule, in her words: your original videos and photos are cleared RAW_RETENTION_DAYS after their
// clips are ready. You get an email 14 days and 3 days before (Download all, or Keep them), and a
// note when it is done. A dump you kept, or one still being cut, is never cleared.
//
// Never cleared unwarned: the 14-day email must have stood 14 days and the 3-day email 3 days, so a
// dump already past its date when this shipped still gets the full 14 days from its first email.
import { RAW_RETENTION_DAYS, RAW_WARN_DAYS } from "@shared/constants";
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
}

export type RetentionStep = { do: "none"; why: string } | { do: "warn14" | "warn3"; clears: string } | { do: "clear" };

const t = (iso: string) => Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);

/** The day this dump's originals clear, given the notices so far (never before each warning has stood its days). Null = never (kept, still open, not ready). */
export function clearDate(d: RetentionDump): Date | null {
  if (d.kept || d.open_job || !d.ready_at || !["ready", "reviewed"].includes(d.status)) return null;
  let due = t(d.ready_at) + RAW_RETENTION_DAYS * DAY;
  if (d.sent14) due = Math.max(due, t(d.sent14) + FIRST * DAY);
  if (d.sent3) due = Math.max(due, t(d.sent3) + LAST * DAY);
  return new Date(due);
}

export function retentionStep(d: RetentionDump, now: Date): RetentionStep {
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
