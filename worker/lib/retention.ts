// File retention for her originals (owner, 20 Nov 2026), run once a day by the daily lane
// (worker/crons/daily.ts). The rule is pure in worker/domain/retention.ts; this file reads D1, sends
// the creator's emails through the studio's own sender, clears the files and reports.
//
//   14 days before: "Your originals clear in 14 days" with Download all / Keep them (/originals/<token>)
//   3 days before:  the same, "in 3 days"
//   when cleared:   "Your originals were cleared" (her clips, covers and posts are untouched)
//
// Never cleared: a dump she kept (dumps.originals_kept), a dump still being cut or with a cut job
// queued or running, or anything whose warning did not go out. NAMED STOP: when the studio's email
// is not set up (practice mode) no warning can reach her, so nothing is cleared and the "File
// clean-up" light says so (fix guide setup-email). One OUTPUT line per run.
//
// That is the rule for HER OWN storage. On the host's shared storage (owner, 21 Nov 2026) originals
// clear 7 days after their clips or 14 days after upload, whichever comes first, with one heads-up 3
// days before when the studio has email; no studio email does not pause it (the host's storage must
// rotate). With her own storage, originals uploaded before she added it are still on the host's and
// keep the shared rule. A studio with no storage at all (Hadiyah before she adds hers) clears
// nothing here: the host empties that bucket by hand, and measureStorage stops counting what is gone.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { setHealth } from "./db";
import { newId } from "./ids";
import { log } from "./log";
import { practice } from "./practice";
import { readSettings } from "../routes/settings";
import { emailFrame, sendEmail } from "../services/email";
import { originalsToken, retentionStep, type RetentionDump, type RetentionRule } from "../domain/retention";
import { filesPlace, HOST_STORAGE } from "../domain/tidy";
import { ownStorageView } from "./storage";
import { gbWords } from "@shared/bytes";
import { RAW_RETENTION_DAYS } from "@shared/constants";

export const RETENTION_LIGHT = "File clean-up";

interface DumpFacts extends RetentionDump {
  created_at: string;
  files: number;
  bytes: number;
}

const DUMPS_SQL = `SELECT d.id, d.status, d.ready_at, d.created_at, d.originals_kept AS kept,
  EXISTS (SELECT 1 FROM jobs j WHERE j.ref_id = d.id AND j.status IN ('queued','dispatched','running')) AS open_job,
  (SELECT sent_at FROM file_notices n WHERE n.dump_id = d.id AND n.stage = '14') AS sent14,
  (SELECT sent_at FROM file_notices n WHERE n.dump_id = d.id AND n.stage = '3') AS sent3,
  COUNT(a.id) AS files, COALESCE(SUM(a.size_bytes), 0) AS bytes, MAX(a.created_at) AS uploaded_at
  FROM dumps d JOIN assets a ON a.dump_id = d.id AND a.upload_status = 'uploaded' AND a.raw_deleted_at IS NULL
  GROUP BY d.id ORDER BY d.created_at LIMIT 500`;

const dayWords = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
const dumpWords = (d: DumpFacts, tz: string) => `Your dump from ${new Date(d.created_at.endsWith("Z") ? d.created_at : `${d.created_at}Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })}: ${d.files} ${d.files === 1 ? "file" : "files"}, ${gbWords(d.bytes)}`;

/** "Hi Hadiyah," when the studio knows her name (the other studio emails' frame has no greeting of its own). */
const greeting = (env: Env) => (env.OWNER_NAME?.trim() ? [`Hi ${env.OWNER_NAME.trim()},`] : []);

/** The warning email (14 or 3 days; "shared" = the host's shared storage's one heads-up). Pure apart from the token. */
export async function warningEmail(env: Env, days: 14 | 3, dumps: (DumpFacts & { clears: string })[], batchId: string, tz: string, rule: RetentionRule = "own") {
  const first = dumps.map((d) => d.clears).sort()[0];
  const url = `${env.PUBLIC_BASE_URL}/originals/${await originalsToken(env.SESSION_SECRET, batchId)}`;
  if (rule === "shared") {
    const lines = [
      ...greeting(env),
      `Your studio's storage is shared, so it clears original uploads ${HOST_STORAGE.rawAfterClipsDays} days after their clips are made, or ${HOST_STORAGE.rawAfterUploadDays} days after upload, whichever comes first.`,
      ...dumps.map((d) => `${dumpWords(d, tz)}. Clears ${dayWords(d.clears, tz)}.`),
      "Your clips stay. Only the original uploads go.",
      "Want them? Open your files to download them. To keep originals in your studio for longer, add your own storage in Settings → Storage (Cloudflare R2 is free up to 10 GB).",
    ];
    return { subject: `Your original files clear ${dayWords(first, tz)}`, ...emailFrame(`Your original files clear ${dayWords(first, tz)}`, lines, { label: "Open my files", url }) };
  }
  const lines = [
    ...greeting(env),
    days === 14
      ? `Original videos are big, so your studio clears the ones you upload ${RAW_RETENTION_DAYS} days after their clips are ready, and never before two emails like this one.`
      : "This is the last reminder before these original files are cleared.",
    ...dumps.map((d) => `${dumpWords(d, tz)}. Clears ${dayWords(d.clears, tz)}.`),
    "Your clips stay. Only the original uploads go.",
    "Want them? Open your files to download them, or to keep them in your studio so they are never cleared.",
  ];
  const title = `Your original files clear in ${days} days`;
  const subject = days === 14 ? `${title} (${dayWords(first, tz)})` : `Last reminder: your original files clear ${dayWords(first, tz)}`;
  return { subject, ...emailFrame(title, lines, { label: "Open my files", url }) };
}

/**
 * Which rule each dump follows: the shared rule on the host's storage, and for originals uploaded
 * before she added her own storage (they are still on the host's); her own rule after. Null = this
 * studio clears nothing here (no storage at all). Pure apart from the read of her storage's date.
 */
export async function ruleFor(env: Env): Promise<((d: DumpFacts) => RetentionRule) | null> {
  const place = filesPlace(env);
  if (place === "none") return null;
  if (place === "host") return () => "shared";
  const since = (await ownStorageView(env))?.since ?? null;
  return (d) => (since && (d.uploaded_at ?? d.created_at) < since ? "shared" : "own");
}

/** The note after clearing. Pure. */
export function clearedEmail(env: Env, dumps: DumpFacts[], tz: string) {
  const lines = [
    ...greeting(env),
    "After the two reminder emails, these original files were cleared today:",
    ...dumps.map((d) => `${dumpWords(d, tz)}.`),
    "Your clips, covers, captions and posts are all still there. Nothing else changed.",
  ];
  return { subject: "Your original files were cleared", ...emailFrame("Your original files were cleared", lines, { label: "Open my studio", url: env.PUBLIC_BASE_URL }) };
}

export interface RetentionResult {
  checked: number;
  warned14: number;
  warned3: number;
  cleared_dumps: number;
  cleared_files: number;
  cleared_bytes: number;
  paused: boolean;
}

export async function originalsRetention(env: Env, now = new Date()): Promise<RetentionResult> {
  const rule = await ruleFor(env);
  if (!rule) {
    // No storage of her own and no share of the host's: nothing of hers is kept here to clear.
    const out: RetentionResult = { checked: 0, warned14: 0, warned3: 0, cleared_dumps: 0, cleared_files: 0, cleared_bytes: 0, paused: false };
    await setHealth(env.DB, RETENTION_LIGHT, "green", "Your files go in your own storage once you add it (Settings → Storage). Nothing to clear here.");
    log.info("OUTPUT", { job: "file_retention", place: "none", ...out });
    return out;
  }
  const { results } = await env.DB.prepare(DUMPS_SQL).all<DumpFacts>();
  const out: RetentionResult = { checked: results.length, warned14: 0, warned3: 0, cleared_dumps: 0, cleared_files: 0, cleared_bytes: 0, paused: false };
  const settings = await readSettings(env);
  const tz = settings.audience_timezone || env.AUDIENCE_TIMEZONE || "America/New_York";
  // Named stop (her own storage only): with no studio email her warnings cannot reach her, so nothing of hers is cleared.
  const canTell = fakeServices(env) || !practice(env, "resend");
  const steps = results.map((d) => ({ d, r: rule(d), s: retentionStep(d, now, rule(d), canTell) }));
  const ownDue = steps.filter((x) => x.r === "own" && x.s.do !== "none");
  const due = steps.filter((x) => x.s.do !== "none" && (canTell || x.r === "shared"));
  if (ownDue.length && !canTell) out.paused = true;
  const at = now.toISOString();
  for (const [days, r] of [[14, "own"], [3, "own"], [3, "shared"]] as const) {
    const batch = due.filter((x) => x.r === r && x.s.do === (days === 14 ? "warn14" : "warn3")).map((x) => ({ ...x.d, clears: (x.s as { clears: string }).clears }));
    if (!batch.length) continue;
    const batchId = newId("fnb");
    const mail = await warningEmail(env, days, batch, batchId, tz, r);
    const sent = await sendEmail(env, { kind: "heads_up", to: settings.notify_emails, subject: mail.subject, html: mail.html, text: mail.text, refId: batchId });
    // Only a warning that went out counts; without it nothing clears (tried again tomorrow).
    if (!sent.ok) continue;
    await env.DB.batch(batch.map((d) => env.DB.prepare("INSERT OR IGNORE INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES (?, ?, ?, ?)").bind(d.id, String(days), batchId, at)));
    if (days === 14) out.warned14 += batch.length;
    else out.warned3 += batch.length;
  }
  const clear = due.filter((x) => x.s.do === "clear").map((x) => x.d);
  const cleared: DumpFacts[] = [];
  for (const d of clear) {
    const { results: assets } = await env.DB.prepare("SELECT id, r2_key, size_bytes FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL").bind(d.id).all<{ id: string; r2_key: string; size_bytes: number }>();
    if (!assets.length) continue;
    await env.FILES.delete(assets.map((a) => a.r2_key));
    await env.DB.batch(assets.map((a) => env.DB.prepare("UPDATE assets SET raw_deleted_at = ? WHERE id = ?").bind(at, a.id)));
    cleared.push(d);
    out.cleared_dumps++;
    out.cleared_files += assets.length;
    out.cleared_bytes += assets.reduce((s, a) => s + (a.size_bytes ?? 0), 0);
  }
  if (cleared.length && canTell) {
    const batchId = newId("fnb");
    const mail = clearedEmail(env, cleared, tz);
    await sendEmail(env, { kind: "heads_up", to: settings.notify_emails, subject: mail.subject, html: mail.html, text: mail.text, refId: batchId });
    await env.DB.batch(cleared.map((d) => env.DB.prepare("INSERT OR IGNORE INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES (?, 'done', ?, ?)").bind(d.id, batchId, at)));
  }
  const kept = steps.filter((x) => x.s.do === "none" && x.s.why === "kept").length;
  if (out.paused) {
    await setHealth(env.DB, RETENTION_LIGHT, "yellow", `Paused: ${ownDue.length} ${ownDue.length === 1 ? "dump's" : "dumps'"} originals are due, but studio email is not set up, so no warning can reach you. Nothing in your own storage is cleared until it is.${out.cleared_files ? ` Cleared from shared storage today: ${out.cleared_files} ${out.cleared_files === 1 ? "file" : "files"}.` : ""}`, "setup-email");
    log.info("OUTPUT", { job: "file_retention", ...out });
    return out;
  }
  await setHealth(env.DB, RETENTION_LIGHT, "green", `${results.length} ${results.length === 1 ? "dump has" : "dumps have"} original files${kept ? ` (${kept} kept)` : ""}. Cleared today: ${out.cleared_files} ${out.cleared_files === 1 ? "file" : "files"}.`);
  log.info("OUTPUT", { job: "file_retention", ...out });
  return out;
}
