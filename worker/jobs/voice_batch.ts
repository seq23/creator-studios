// The voice job's batch mode (automatic voice overs, worker/lib/autoVoice.ts): ONE run of the
// runner voices every clip of a dump with no talking. The built-in voice model loads once for all
// of them (not once per clip), then each voice over is mixed into its clip. Premium voice overs
// were made in the Worker already; the run only mixes those. Ref "auto/<batch id>".
import type { Env } from "../env";
import { log } from "../lib/log";
import { recordEvent, setHealth } from "../lib/db";
import { nowIso } from "../lib/ids";

export const VOICE_MODEL_KEY = "voice/model/conds.pt";
export const mixedKey = (narrationId: string) => `voice/mixed/${narrationId}.mp4`;
export const builtInKey = (narrationId: string) => `voice/narrations/${narrationId}.mp3`;

interface BatchRow {
  id: string;
  script: string;
  status: string;
  engine: string;
  r2_key: string | null;
  clip_id: string;
  clip_key: string;
}

export interface BatchItem {
  narration_id: string;
  script: string;
  /** true: the built-in voice speaks it in this run; false: it is ready (premium), only mixed. */
  speak: boolean;
  narration_key: string;
  clip_key: string;
  output_key: string;
}

async function rows(env: Env, batch: string): Promise<BatchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.script, n.status, n.engine, n.r2_key, n.clip_id, c.r2_key AS clip_key FROM narrations n JOIN clips c ON c.id = n.clip_id
     WHERE n.batch = ? AND n.mix_status = 'mixing' AND c.status != 'deleted' ORDER BY n.created_at`,
  )
    .bind(batch)
    .all<BatchRow>();
  return results;
}

export async function buildBatchSpec(env: Env, jobId: string, batch: string) {
  const list = await rows(env, batch);
  if (!list.length) throw new Error("nothing to voice");
  const v = await env.DB.prepare("SELECT sample_r2_key, consent_at, model_r2_key FROM voice WHERE id = 1").first<{ sample_r2_key: string | null; consent_at: string | null; model_r2_key: string | null }>();
  const speaks = list.some((r) => r.status !== "ready");
  if (speaks && (!v?.sample_r2_key || !v.consent_at)) throw new Error("no consented voice sample");
  await env.DB.prepare("UPDATE narrations SET status = 'generating' WHERE batch = ? AND status = 'queued'").bind(batch).run();
  const items: BatchItem[] = list.map((r) => ({
    narration_id: r.id,
    script: r.script,
    speak: r.status !== "ready",
    narration_key: r.status === "ready" && r.r2_key ? r.r2_key : builtInKey(r.id),
    clip_key: r.clip_key,
    output_key: mixedKey(r.id),
  }));
  return {
    job_id: jobId,
    type: "voice",
    mode: "batch",
    batch,
    sample_key: v?.sample_r2_key ?? null,
    model_key: v?.model_r2_key ?? VOICE_MODEL_KEY,
    model_exists: !!v?.model_r2_key,
    items,
  };
}

interface BatchResultItem {
  narration_id?: string;
  ok?: boolean;
  narration_key?: string;
  duration_s?: number;
  mixed_key?: string;
}

/** Each voice over checked against what this batch asked for, then put on its clip. */
export async function applyBatch(env: Env, jobId: string, batch: string, result: unknown): Promise<void> {
  const r = (result ?? {}) as { items?: BatchResultItem[]; model_key?: string; minutes?: number };
  const list = await rows(env, batch);
  const got = new Map((Array.isArray(r.items) ? r.items : []).map((x) => [String(x.narration_id), x]));
  let ok = 0;
  for (const n of list) {
    const x = got.get(n.id);
    const expectVoice = n.status === "ready" && n.r2_key ? n.r2_key : builtInKey(n.id);
    const good = !!x?.ok && x.narration_key === expectVoice && x.mixed_key === mixedKey(n.id) && !!(await env.FILES.head(mixedKey(n.id)));
    if (!good) {
      await env.DB.prepare("UPDATE narrations SET mix_status = 'failed', status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END WHERE id = ?").bind(n.id).run();
      continue;
    }
    const secs = Number(x!.duration_s);
    await env.DB.prepare("UPDATE narrations SET status = 'ready', r2_key = ?, duration_s = COALESCE(?, duration_s), mixed_r2_key = ?, mix_status = 'ready' WHERE id = ? AND clip_id IS NOT NULL")
      .bind(expectVoice, Number.isFinite(secs) && secs > 0 ? secs : null, mixedKey(n.id), n.id)
      .run();
    ok++;
  }
  if (r.model_key && r.model_key.startsWith("voice/model/")) await env.DB.prepare("UPDATE voice SET model_r2_key = ?, updated_at = ? WHERE id = 1").bind(r.model_key, nowIso()).run();
  const failed = list.length - ok;
  await recordEvent(env.DB, "voice.batch.done", batch, { job: jobId, voiced: ok, failed, minutes: Number(r.minutes ?? 0) });
  if (failed) await setHealth(env.DB, "Voice", "yellow", `${failed} voice over${failed === 1 ? "" : "s"} could not be added. Tap Redo on the clip in Review.`, "record-your-voice");
  else await setHealth(env.DB, "Voice", "green", "Last voice overs added to clips", null);
  log.info("voice.batch.apply", { voiced: ok, failed });
}

export async function batchFailed(env: Env, jobId: string, batch: string, safeError: string): Promise<void> {
  await env.DB.prepare("UPDATE narrations SET mix_status = 'failed', status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END WHERE batch = ? AND mix_status = 'mixing'").bind(batch).run();
  await recordEvent(env.DB, "voice.batch.failed", batch, { job: jobId });
  await setHealth(env.DB, "Voice", "yellow", "Voice overs could not be added this time; the clips keep their own sound. Tap Redo in Review.", "record-your-voice");
  log.warn("voice.batch.failed", { len: safeError.length });
}

/** FAKE_SERVICES: a short tone for each built-in voice, the clip itself as the "mix", where the real job writes them. */
export async function fakeBatch(env: Env, jobId: string, batch: string, tone: Uint8Array) {
  const spec = await buildBatchSpec(env, jobId, batch);
  const items = [];
  for (const it of spec.items) {
    if (it.speak) await env.FILES.put(it.narration_key, tone, { httpMetadata: { contentType: "audio/mpeg" } });
    const clip = await env.FILES.get(it.clip_key);
    await env.FILES.put(it.output_key, clip ? new Uint8Array(await clip.arrayBuffer()) : new Uint8Array(8), { httpMetadata: { contentType: "video/mp4" } });
    items.push({ narration_id: it.narration_id, ok: true, narration_key: it.narration_key, duration_s: 2, mixed_key: it.output_key });
  }
  return { mode: "batch", items, minutes: 0 };
}
