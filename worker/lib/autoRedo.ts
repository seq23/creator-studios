// The studio redoes held clips on its own (owner's standing rule, 23 Oct 2026: "if its not up to par
// or something is broken it should re do those clips"). Hourly lane (worker/crons/index.ts), every
// studio. Never asks her, never emails her (the redone clip simply appears in Review), never posts.
//
//   1. Settle: an automatic redo that finished is recorded (back in Review, still held, or failed);
//      a failure's "Try again" line is cleared, since she never asked for it.
//   2. Every hidden clip says why in plain words; each held clip is stamped with its cause and the
//      cause's check version (shared/holdCauses.ts) the first time the sweep sees it.
//   3. Redo: up to MAX_PER_SWEEP held clips go through "Try another version" (worker/jobs/cut.ts
//      buildAgainSpec): a different moment of the same footage, away from every version it had,
//      a different look, and the cause's one-tap fixes. Which clips, and why not, is redoDecision.
//   Rule 0: the "Clip redo" light says what each run did; work found and nothing started is yellow
//   with the reason.
// Guard: tests/unit/auto-redo.test.ts.
import type { Env } from "../env";
import { recordEvent, setHealth } from "./db";
import { log } from "./log";
import { readStudioRules } from "./studioRules";
import { dispatchJob } from "../services/github";
import { fixWords } from "@shared/fixes";
import { GAVE_UP_NOTE, HOLD_CAUSES, holdCause, plainHeldReason, redoDecision, type HeldClip } from "@shared/holdCauses";

export const MAX_PER_SWEEP = 3;
export const REDO_LIGHT = "Clip redo";

interface Row extends HeldClip {
  id: string;
  dump_id: string;
  look: string | null;
  score: number | null;
  created_at: string;
}

const HELD_SQL = `SELECT c.id, c.dump_id, c.hidden, c.status, c.style_of, c.edited_with, c.clip_type, c.hidden_reason, c.pending_look, c.rerender_job_id,
  c.hold_cause, c.hold_check, c.auto_redo_check, c.auto_redo_count, c.look, c.score, c.created_at,
  EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id) AS in_posts,
  EXISTS (SELECT 1 FROM assets x WHERE x.dump_id = c.dump_id AND x.raw_deleted_at IS NOT NULL AND (x.id = c.asset_id OR instr(COALESCE(c.part_assets, ''), x.id) > 0)) AS raw_cleared,
  EXISTS (SELECT 1 FROM assets x WHERE x.dump_id = c.dump_id AND x.source_owner = 'other' AND (x.id = c.asset_id OR instr(COALESCE(c.part_assets, ''), x.id) > 0)) AS not_hers
  FROM clips c JOIN dumps d ON d.id = c.dump_id
  WHERE c.hidden = 1 AND c.status = 'draft' AND c.style_of IS NULL AND d.archived_at IS NULL AND d.status IN ('ready', 'reviewed')
  ORDER BY c.created_at DESC LIMIT 300`;

export interface SweepResult {
  held: number;
  started: number;
  back: number;
  stillHeld: number;
  failed: number;
  waiting: number;
  blocked: string | null;
}

/** Step 1: automatic redos whose job finished (applied or failed). */
async function settle(env: Env, out: SweepResult): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, dump_id, hidden, hidden_reason, rerender_error, auto_redo_job_id FROM clips WHERE auto_redo_job_id IS NOT NULL AND rerender_job_id IS NULL LIMIT 100")
    .all<{ id: string; dump_id: string; hidden: number; hidden_reason: string | null; rerender_error: string | null; auto_redo_job_id: string }>();
  for (const c of results) {
    const failed = !!c.rerender_error;
    const cause = holdCause(c.hidden_reason);
    await env.DB.prepare("UPDATE clips SET auto_redo_job_id = NULL, rerender_error = NULL, hold_cause = ?, hold_check = ? WHERE id = ? AND auto_redo_job_id = ?")
      .bind(c.hidden ? cause : null, c.hidden && cause ? HOLD_CAUSES[cause].check : null, c.id, c.auto_redo_job_id)
      .run();
    if (failed) out.failed++;
    else if (c.hidden) out.stillHeld++;
    else {
      out.back++;
      await env.DB.prepare("UPDATE dumps SET status = 'ready' WHERE id = ? AND status = 'reviewed'").bind(c.dump_id).run();
    }
    await recordEvent(env.DB, "clip.auto_redo_done", c.id, { outcome: failed ? "failed" : c.hidden ? "still_held" : "back", cause });
  }
}

export async function autoRedoSweep(env: Env): Promise<SweepResult> {
  const out: SweepResult = { held: 0, started: 0, back: 0, stillHeld: 0, failed: 0, waiting: 0, blocked: null };
  await settle(env, out);
  const bar = (await readStudioRules(env)).bar;
  const from = (env.AUTO_REDO_FROM ?? "").trim();
  const { results } = await env.DB.prepare(HELD_SQL).all<Row>();
  out.held = results.length;
  const todo: { row: Row; d: Extract<ReturnType<typeof redoDecision>, { redo: true }> }[] = [];
  for (const row of results) {
    // Every hidden clip says why, in plain words.
    if (!row.hidden_reason?.trim()) {
      const s = row.score === null ? null : row.score <= 1 ? row.score * 100 : row.score;
      row.hidden_reason = plainHeldReason(s, bar);
      await env.DB.prepare("UPDATE clips SET hidden_reason = ? WHERE id = ? AND (hidden_reason IS NULL OR hidden_reason = '')").bind(row.hidden_reason, row.id).run();
    }
    // Its cause and the check version it was held under, once.
    if (!row.hold_cause) {
      const cause = holdCause(row.hidden_reason);
      if (cause) {
        row.hold_cause = cause;
        row.hold_check = HOLD_CAUSES[cause].check;
        await env.DB.prepare("UPDATE clips SET hold_cause = ?, hold_check = ? WHERE id = ? AND hold_cause IS NULL").bind(cause, row.hold_check, row.id).run();
      }
    }
    const d = redoDecision(row);
    // A studio may start its own redos from a moment on (registry autoRedoFrom): older clips wait,
    // unless a newer check fixed what held them.
    if (d.redo && from && row.created_at < from && !d.fixedSince) {
      out.waiting++;
      continue;
    }
    if (d.redo) todo.push({ row, d });
    else if (!d.terminal) out.waiting++;
    else if (d.cause && /already redone/.test(d.why) && !row.hidden_reason.includes(GAVE_UP_NOTE)) {
      await env.DB.prepare("UPDATE clips SET hidden_reason = ? WHERE id = ?").bind(`${row.hidden_reason} ${GAVE_UP_NOTE}`.slice(0, 300), row.id).run();
    }
  }
  for (const { row, d } of todo.slice(0, MAX_PER_SWEEP)) {
    // The same path as Try another version / one-tap fixes, marked as the studio's own redo.
    const words = fixWords(d.fixes, "a different moment and a different look than before");
    await env.DB.prepare("UPDATE clips SET again_notes = ?, again_fixes = ?, pending_look = ?, pending_layout = NULL, pending_music = NULL, rerender_error = NULL WHERE id = ? AND pending_look IS NULL AND rerender_job_id IS NULL")
      .bind(words, JSON.stringify(d.fixes), row.look ?? "clean", row.id)
      .run();
    const job = await dispatchJob(env, "cut", `${row.dump_id}/${row.id}/again`);
    if (!job.dispatched) {
      await env.DB.prepare("UPDATE clips SET pending_look = NULL WHERE id = ?").bind(row.id).run();
      out.blocked = job.error ?? "the job runner did not start";
      break;
    }
    await env.DB.prepare("UPDATE clips SET rerender_job_id = ?, auto_redo_job_id = ?, auto_redo_check = ?, auto_redo_count = CASE WHEN auto_redo_check = ? THEN auto_redo_count + 1 ELSE 1 END WHERE id = ?")
      .bind(job.jobId, job.jobId, d.check, d.check, row.id)
      .run();
    await recordEvent(env.DB, "clip.auto_redo", row.id, { cause: d.cause, attempt: d.attempt, fixed_since: d.fixedSince, fixes: d.fixes });
    out.started++;
  }
  // Rule 0: every run says what it did; work found and nothing started says why.
  if (todo.length && !out.started) {
    await setHealth(env.DB, REDO_LIGHT, "yellow", `${todo.length} held clip${todo.length === 1 ? "" : "s"} could not be redone: ${out.blocked ?? "nothing started"}. The studio tries again next hour.`, "reconnect-github");
  } else {
    const parts = [`${out.held} held`, `${out.started} being redone`, `${out.back} back in Review`];
    if (out.stillHeld) parts.push(`${out.stillHeld} still not good enough`);
    if (out.failed) parts.push(`${out.failed} redo${out.failed === 1 ? "" : "s"} did not finish`);
    await setHealth(env.DB, REDO_LIGHT, "green", `The studio redoes held clips on its own: ${parts.join(", ")}.`, "review-and-approve-clips");
  }
  log.info("auto_redo.sweep", { held: out.held, eligible: todo.length, started: out.started, back: out.back, still_held: out.stillHeld, failed: out.failed, waiting: out.waiting, blocked: !!out.blocked });
  return out;
}
