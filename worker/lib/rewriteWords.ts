// Write a dump's words again (owner, 24 Oct 2026). A cut whose free-model budget ran out shipped lines
// of speech as hooks ("Go ahead.", "Yeah, you're good.") and scored them 94-100; the engine is fixed
// (jobs/cut.py distinct_hooks, jobs/clipmaker.py echoes_speech), and this puts an already-cut dump
// right WITHOUT a new cut (so no second "Clips ready" email): its New clips go back to waiting for
// their words (hook, caption and voice script cleared, the score docked exactly as the engine docks a
// clip with no words), the hourly words pass writes them now in her voice, and every clip whose old
// hook was burned into its video is re-rendered in the same look so the old line leaves the picture
// (dispatched first; then one words pass, and the hourly lane writes whatever is left).
// Nothing is approved, posted or deleted. Signed ops only (worker/routes/ops.ts "rewrite-words").
// Guard: tests/unit/written-hooks.test.ts.
import type { Env } from "../env";
import { dispatchJob } from "../services/github";
import { WAITING_REASON, WORDS_HIT, WORDS_POINTS, wordsPass } from "./wordsPass";

/** jobs/clipmaker.py WORDS_CAP: a clip waiting for its words scores at most this. */
export const WORDS_CAP = 80;
/** The score's on-screen-words reasons (jobs/clipmaker.py score_clip), hit or miss. */
const WORDS_REASONS = [WORDS_HIT, WAITING_REASON, "The on-screen words are too long or missing", "The hook says nearly the same as another clip's", "The hook is a line from the speech, not a written hook"];

/** A clip's score and reasons once its words are cleared, as the engine scores a clip with none. Pure. */
export function scoreWithoutWords(score: number, reasons: string | null): { score: number; score_reasons: string } {
  let list: string[] = [];
  try {
    const v = JSON.parse(reasons ?? "[]");
    list = Array.isArray(v) ? v.map(String) : [];
  } catch {
    list = [];
  }
  const had = list.includes(WORDS_HIT) ? WORDS_POINTS : list.some((r) => WORDS_REASONS.includes(r)) ? WORDS_POINTS / 2 : 0;
  const rest = list.filter((r) => !WORDS_REASONS.includes(r));
  return { score: Math.max(0, Math.min(WORDS_CAP, Math.round(score - had))), score_reasons: JSON.stringify([WAITING_REASON, ...rest]) };
}

export interface RewriteResult {
  cleared: number;
  written: number;
  waiting: number;
  rerenders: number;
  rerender_failed: number;
}

export async function rewriteDumpWords(env: Env, dumpId: string, numbers: number[] | null, rerenderAll = false): Promise<RewriteResult | null> {
  const dump = await env.DB.prepare("SELECT id, status FROM dumps WHERE id = ?").bind(dumpId).first<{ id: string; status: string }>();
  if (!dump || !["ready", "reviewed"].includes(dump.status)) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, number, hook_text, look, score, score_reasons, words_pending FROM clips
     WHERE dump_id = ? AND status = 'draft' AND style_of IS NULL AND full_video = 0 AND edited_with IS NULL AND rerender_job_id IS NULL`,
  )
    .bind(dumpId)
    .all<{ id: string; number: number | null; hook_text: string; look: string | null; score: number; score_reasons: string | null; words_pending: number }>();
  const targets = results.filter((r) => !numbers || (r.number !== null && numbers.includes(r.number)));
  const burned: { id: string; look: string }[] = [];
  for (const r of targets) {
    // Its hook is in its picture (or the caller says an earlier pass already cleared one that was).
    if ((r.hook_text.trim() || rerenderAll) && r.look) burned.push({ id: r.id, look: r.look });
    if (r.words_pending) continue;
    const s = scoreWithoutWords(r.score, r.score_reasons);
    await env.DB.prepare(
      "UPDATE clips SET hook_text = '', hook_alt = NULL, caption = '', hashtags = '', voice_script = NULL, words_pending = 1, words_tries = 0, words_tried_at = NULL, score = ?, score_reasons = ? WHERE id = ? AND status = 'draft'",
    )
      .bind(s.score, s.score_reasons, r.id)
      .run();
  }
  let rerenders = 0;
  let failed = 0;
  for (const b of burned) {
    // Same look, same moment: only the words on the picture change (applyRerender swaps the file in).
    await env.DB.prepare("UPDATE clips SET pending_look = ?, pending_layout = layout, pending_music = NULL, rerender_error = NULL WHERE id = ? AND rerender_job_id IS NULL").bind(b.look, b.id).run();
    const job = await dispatchJob(env, "cut", `${dumpId}/${b.id}`);
    if (!job.dispatched) {
      await env.DB.prepare("UPDATE clips SET pending_look = NULL, pending_layout = NULL WHERE id = ?").bind(b.id).run();
      failed++;
      continue;
    }
    await env.DB.prepare("UPDATE clips SET rerender_job_id = ? WHERE id = ?").bind(job.jobId, b.id).run();
    rerenders++;
  }
  // One words pass now (WORDS_PER_RUN clips, one free-model call each, so the request stays short);
  // the hourly lane writes the rest. The re-renders went first: the old line leaves the picture
  // whether or not the new words are in yet.
  const r = await wordsPass(env);
  const written = r.written;
  const waiting = r.waiting;
  return { cleared: targets.length, written, waiting, rerenders, rerender_failed: failed };
}
