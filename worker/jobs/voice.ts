// Chatterbox narration (section 12): the "built-in" engine (free). The premium engine
// (ElevenLabs) never reaches this job; it runs in the Worker (worker/lib/premiumVoice.ts). The job (jobs/voice.py) clones her voice from the consented
// sample on the Actions CPU runner, writes the narration to R2 and calls back. Every generated
// file is logged in `events`. The fake writes a short tone WAV so the screen can be exercised.
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { log } from "../lib/log";
import { recordEvent, setHealth } from "../lib/db";
import { nowIso } from "../lib/ids";
import { applyBatch, batchFailed, buildBatchSpec, fakeBatch } from "./voice_batch";

/** "auto/<batch>": one run voices every clip of a batch (automatic voice overs, redo in Review). */
const batchOf = (refId: string | null) => (refId?.startsWith("auto/") ? refId.slice(5) : null);

export const VOICE_MODEL_KEY = "voice/model/conds.pt";

interface NarrationDb {
  id: string;
  script: string;
  status: string;
  r2_key: string | null;
  clip_id: string | null;
  mix_status: string | null;
}

async function narration(env: Env, id: string | null): Promise<NarrationDb | null> {
  if (!id) return null;
  return env.DB.prepare("SELECT id, script, status, r2_key, clip_id, mix_status FROM narrations WHERE id = ?").bind(id).first<NarrationDb>();
}

/** Where the clip with her voice over mixed in is written (the job may write only this). */
export const mixedKey = (narrationId: string) => `voice/mixed/${narrationId}.mp4`;

/** A ready voice over waiting to be mixed into the clip it was attached to. */
const wantsMix = (n: NarrationDb) => n.status === "ready" && !!n.clip_id && !!n.r2_key && n.mix_status === "mixing";

/** 16-bit mono PCM WAV: a short silence, a soft tone, a short silence. */
export function toneWav(seconds = 2, sampleRate = 16_000, hz = 440): Uint8Array {
  const n = Math.floor(seconds * sampleRate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  const quiet = Math.floor(n / 4);
  for (let i = 0; i < n; i++) {
    const on = i >= quiet && i < n - quiet;
    const s = on ? Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.2 : 0;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

export const voiceJob: JobHandler = {
  async buildSpec(env, jobId, refId) {
    const batch = batchOf(refId);
    if (batch) return buildBatchSpec(env, jobId, batch);
    const n = await narration(env, refId);
    if (n && wantsMix(n)) {
      const clip = await env.DB.prepare("SELECT r2_key FROM clips WHERE id = ? AND status != 'deleted'").bind(n.clip_id).first<{ r2_key: string }>();
      if (!clip) throw new Error("the clip for this voice over is gone");
      return { job_id: jobId, ref_id: refId, type: "voice", mode: "mix", narration_id: n.id, clip_key: clip.r2_key, narration_key: n.r2_key, output_key: mixedKey(n.id) };
    }
    const v = await env.DB.prepare("SELECT sample_r2_key, consent_at, model_r2_key FROM voice WHERE id = 1").first<{ sample_r2_key: string | null; consent_at: string | null; model_r2_key: string | null }>();
    if (!n || !v?.sample_r2_key || !v.consent_at) throw new Error("no consented voice sample or narration");
    await env.DB.prepare("UPDATE narrations SET status = 'generating' WHERE id = ?").bind(n.id).run();
    return {
      job_id: jobId,
      ref_id: refId,
      type: "voice",
      narration_id: n.id,
      script: n.script,
      sample_key: v.sample_r2_key,
      model_key: v.model_r2_key ?? VOICE_MODEL_KEY,
      model_exists: !!v.model_r2_key,
      output_key: `voice/narrations/${n.id}.mp3`,
    };
  },

  async applyResult(env, jobId, refId, result) {
    const batch = batchOf(refId);
    if (batch) return applyBatch(env, jobId, batch, result);
    const r = (result ?? {}) as { r2_key?: string; duration_s?: number; bytes?: number; model_key?: string; mode?: string };
    if (r.mode === "mix") {
      if (!refId || r.r2_key !== mixedKey(refId)) throw new Error("mix result missing its file");
      const mixed = await env.FILES.head(r.r2_key);
      if (!mixed) throw new Error("mixed clip not in storage");
      // Only if it is still attached: a detach while mixing wins.
      const u = await env.DB.prepare("UPDATE narrations SET mixed_r2_key = ?, mix_status = 'ready' WHERE id = ? AND clip_id IS NOT NULL AND mix_status = 'mixing'").bind(r.r2_key, refId).run();
      if (!u.meta.changes) await env.FILES.delete(r.r2_key);
      await recordEvent(env.DB, "voice.mix.ready", refId, { job: jobId, bytes: mixed.size });
      await setHealth(env.DB, "Voice", "green", "Last voice over added to a clip", null);
      log.info("voice.mix.apply", { bytes: mixed.size, attached: !!u.meta.changes });
      return;
    }
    if (!refId || !r.r2_key || !r.r2_key.startsWith(`voice/narrations/${refId}`)) throw new Error("voice result missing its file");
    const head = await env.FILES.head(r.r2_key);
    if (!head) throw new Error("voice file not in storage");
    const seconds = Number(r.duration_s);
    await env.DB.prepare("UPDATE narrations SET status = 'ready', r2_key = ?, duration_s = ? WHERE id = ?").bind(r.r2_key, Number.isFinite(seconds) && seconds > 0 ? seconds : null, refId).run();
    if (r.model_key && r.model_key.startsWith("voice/model/")) await env.DB.prepare("UPDATE voice SET model_r2_key = ?, updated_at = ? WHERE id = 1").bind(r.model_key, nowIso()).run();
    await recordEvent(env.DB, "voice.narration.generated", refId, { job: jobId, bytes: head.size, seconds: Number(r.duration_s ?? 0) });
    await setHealth(env.DB, "Voice", "green", "Last voice over made", null);
    log.info("voice.apply", { bytes: head.size });
  },

  async onFailure(env, jobId, refId, safeError) {
    const batch = batchOf(refId);
    if (batch) return batchFailed(env, jobId, batch, safeError);
    const n = await narration(env, refId);
    if (n && wantsMix(n)) {
      // The voice over itself is fine; only adding it to the clip failed. The clip stays as it was.
      await env.DB.prepare("UPDATE narrations SET mix_status = 'failed' WHERE id = ?").bind(n.id).run();
      await recordEvent(env.DB, "voice.mix.failed", refId, { job: jobId });
      await setHealth(env.DB, "Voice", "red", "A voice over could not be added to its clip. Attach it again.", "record-your-voice");
      log.warn("voice.mix.failed", { len: safeError.length });
      return;
    }
    if (refId) await env.DB.prepare("UPDATE narrations SET status = 'failed' WHERE id = ?").bind(refId).run();
    await recordEvent(env.DB, "voice.narration.failed", refId, { job: jobId });
    await setHealth(env.DB, "Voice", "red", "A voice over did not finish. Try Generate again; a shorter script is faster.", "record-your-voice");
    log.warn("voice.failed", { len: safeError.length });
  },

  async onProgress(env, _jobId, refId) {
    if (refId && !batchOf(refId)) await env.DB.prepare("UPDATE narrations SET status = 'generating' WHERE id = ? AND status = 'queued'").bind(refId).run();
  },

  /** FAKE_SERVICES: a 2-second tone WAV written to R2, exactly where the real job writes. */
  async fakeRun(env, jobId, refId) {
    const batch = batchOf(refId);
    if (batch) return fakeBatch(env, jobId, batch, toneWav());
    const n = await narration(env, refId);
    if (n && wantsMix(n)) {
      // FAKE_SERVICES: the "mixed" clip is the clip itself, written where the real job writes it.
      const clip = await env.DB.prepare("SELECT r2_key FROM clips WHERE id = ?").bind(n.clip_id).first<{ r2_key: string }>();
      const src = clip ? await env.FILES.get(clip.r2_key) : null;
      const bytes = src ? new Uint8Array(await src.arrayBuffer()) : new Uint8Array(0);
      await env.FILES.put(mixedKey(n.id), bytes, { httpMetadata: { contentType: "video/mp4" } });
      return { mode: "mix", r2_key: mixedKey(n.id), bytes: bytes.byteLength };
    }
    const key = `voice/narrations/${refId}.wav`;
    const bytes = toneWav();
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: "audio/wav" } });
    return { r2_key: key, duration_s: 2, bytes: bytes.byteLength };
  },
};
