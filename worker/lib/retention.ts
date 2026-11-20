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
import type { Env } from "../env";
import { fakeServices } from "../env";
import { setHealth } from "./db";
import { newId } from "./ids";
import { log } from "./log";
import { practice } from "./practice";
import { readSettings } from "../routes/settings";
import { emailFrame, sendEmail } from "../services/email";
import { originalsToken, retentionStep, type RetentionDump } from "../domain/retention";
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
  COUNT(a.id) AS files, COALESCE(SUM(a.size_bytes), 0) AS bytes
  FROM dumps d JOIN assets a ON a.dump_id = d.id AND a.upload_status = 'uploaded' AND a.raw_deleted_at IS NULL
  GROUP BY d.id ORDER BY d.created_at LIMIT 500`;

const dayWords = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
const dumpWords = (d: DumpFacts, tz: string) => `Your dump from ${new Date(d.created_at.endsWith("Z") ? d.created_at : `${d.created_at}Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })}: ${d.files} ${d.files === 1 ? "file" : "files"}, ${gbWords(d.bytes)}`;

/** The warning email (14 or 3 days). Pure apart from the token. */
export async function warningEmail(env: Env, days: 14 | 3, dumps: (DumpFacts & { clears: string })[], batchId: string, tz: string) {
  const first = dumps.map((d) => d.clears).sort()[0];
  const url = `${env.PUBLIC_BASE_URL}/originals/${await originalsToken(env.SESSION_SECRET, batchId)}`;
  const lines = [
    `To keep your studio inside its free space, the original videos and photos you dump are cleared ${RAW_RETENTION_DAYS} days after their clips are ready.`,
    ...dumps.map((d) => `${dumpWords(d, tz)}. Clears ${dayWords(d.clears, tz)}.`),
    "Your clips stay. Only the original uploads go.",
    "Want them? Tap the button to save them to your phone or computer, or to keep them so they are never cleared.",
  ];
  const title = days === 14 ? "Your original files clear in 14 days" : "Your original files clear in 3 days";
  return { subject: `${title} (${dayWords(first, tz)})`, ...emailFrame(title, lines, { label: "Download all or keep them", url }) };
}

/** The note after clearing. Pure. */
export function clearedEmail(env: Env, dumps: DumpFacts[], tz: string) {
  const lines = [
    "As the emails before said, these original files were cleared today to keep your studio inside its free space:",
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
  const { results } = await env.DB.prepare(DUMPS_SQL).all<DumpFacts>();
  const out: RetentionResult = { checked: results.length, warned14: 0, warned3: 0, cleared_dumps: 0, cleared_files: 0, cleared_bytes: 0, paused: false };
  const settings = await readSettings(env);
  const tz = settings.audience_timezone || env.AUDIENCE_TIMEZONE || "America/New_York";
  // Named stop: with no studio email her warnings cannot reach her, so nothing is cleared.
  const canTell = fakeServices(env) || !practice(env, "resend");
  const steps = results.map((d) => ({ d, s: retentionStep(d, now) }));
  const due = steps.filter((x) => x.s.do !== "none");
  if (due.length && !canTell) {
    out.paused = true;
    await setHealth(env.DB, RETENTION_LIGHT, "yellow", `Paused: ${due.length} ${due.length === 1 ? "dump's" : "dumps'"} originals are due, but studio email is not set up, so no warning can reach you. Nothing is cleared until it is.`, "setup-email");
    log.info("OUTPUT", { job: "file_retention", ...out });
    return out;
  }
  const at = now.toISOString();
  for (const days of [14, 3] as const) {
    const batch = due.filter((x) => x.s.do === (days === 14 ? "warn14" : "warn3")).map((x) => ({ ...x.d, clears: (x.s as { clears: string }).clears }));
    if (!batch.length) continue;
    const batchId = newId("fnb");
    const mail = await warningEmail(env, days, batch, batchId, tz);
    const sent = await sendEmail(env, { kind: "heads_up", to: settings.notify_emails, subject: mail.subject, html: mail.html, text: mail.text, refId: batchId });
    // Only a warning that went out counts; without it nothing clears (tried again tomorrow).
    if (!sent.ok) continue;
    await env.DB.batch(batch.map((d) => env.DB.prepare("INSERT OR IGNORE INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES (?, ?, ?, ?)").bind(d.id, String(days), batchId, at)));
    if (days === 14) out.warned14 = batch.length;
    else out.warned3 = batch.length;
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
  if (cleared.length) {
    const batchId = newId("fnb");
    const mail = clearedEmail(env, cleared, tz);
    await sendEmail(env, { kind: "heads_up", to: settings.notify_emails, subject: mail.subject, html: mail.html, text: mail.text, refId: batchId });
    await env.DB.batch(cleared.map((d) => env.DB.prepare("INSERT OR IGNORE INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES (?, 'done', ?, ?)").bind(d.id, batchId, at)));
  }
  const kept = steps.filter((x) => x.s.do === "none" && x.s.why === "kept").length;
  await setHealth(env.DB, RETENTION_LIGHT, "green", `${results.length} ${results.length === 1 ? "dump has" : "dumps have"} original files${kept ? ` (${kept} kept)` : ""}. Cleared today: ${out.cleared_files} ${out.cleared_files === 1 ? "file" : "files"}.`);
  log.info("OUTPUT", { job: "file_retention", ...out });
  return out;
}
