// The ElevenLabs premium voice, wired to the dashboard: which engine a narration uses, making and
// deleting the clone, a premium narration, and the one "Voice · ElevenLabs" light. The rules
// themselves are pure, in worker/domain/voiceEngine.ts; the vendor calls are in
// worker/services/elevenlabs.ts. Nothing here ever stops a narration: every failure falls back
// to the built-in voice and says so.
import type { Env } from "../env";
import { chooseEngine, ELEVEN_HEALTH, elevenLabsLight, mp3Duration, readPreference, shouldClone, type ElevenFailure, type ElevenLightInput, type ElevenPlan, type EngineChoice, type EngineInputs } from "../domain/voiceEngine";
import { getElevenLabs } from "../services/elevenlabs";
import { markConnection } from "./connections";
import { getSetting, parseJson, recordEvent, setHealth } from "./db";
import { nowIso } from "./ids";
import { log } from "./log";

export const ENGINE_SETTING = "voice_engine_preference";

interface VoiceRow {
  sample_r2_key: string | null;
  consent_at: string | null;
  elevenlabs_voice_id: string | null;
}

export interface PremiumState extends EngineInputs {
  voiceId: string | null;
  sampleKey: string | null;
  plan: ElevenPlan | null;
}

export function planFromMeta(meta: Record<string, unknown>): ElevenPlan | null {
  if (typeof meta.tier !== "string") return null;
  return { tier: meta.tier, used: Number(meta.characters_used ?? 0), limit: Number(meta.characters_limit ?? 0), canClone: meta.can_clone === true };
}

export function planMeta(plan: ElevenPlan): Record<string, unknown> {
  return { tier: plan.tier, characters_used: plan.used, characters_limit: plan.limit, can_clone: plan.canClone };
}

export async function premiumState(env: Env): Promise<PremiumState> {
  const [conn, v, pref] = await Promise.all([
    env.DB.prepare("SELECT status, meta FROM connections WHERE service = 'elevenlabs'").first<{ status: string; meta: string }>(),
    env.DB.prepare("SELECT sample_r2_key, consent_at, elevenlabs_voice_id FROM voice WHERE id = 1").first<VoiceRow>(),
    getSetting<string>(env.DB, ENGINE_SETTING, "premium_when_available"),
  ]);
  const plan = planFromMeta(parseJson<Record<string, unknown>>(conn?.meta, {}));
  return {
    preference: readPreference(pref),
    connection: conn?.status ?? null,
    canClone: !!plan?.canClone,
    hasPremiumVoice: !!v?.elevenlabs_voice_id,
    hasSample: !!v?.sample_r2_key && !!v?.consent_at,
    voiceId: v?.elevenlabs_voice_id ?? null,
    sampleKey: v?.sample_r2_key ?? null,
    plan,
  };
}

export async function currentEngine(env: Env): Promise<EngineChoice & { state: PremiumState }> {
  const state = await premiumState(env);
  return { ...chooseEngine(state), state };
}

export async function writeElevenLabsLight(env: Env, input: ElevenLightInput): Promise<void> {
  const l = elevenLabsLight(input);
  await setHealth(env.DB, ELEVEN_HEALTH, l.light, l.note, l.fix);
}

/**
 * What a failed ElevenLabs call does to the connection and the light. A refused key (401) marks
 * the connection broken and turns the light red; used-up credits (402 / quota_exceeded) turn it
 * yellow; busy (429) and anything else are logged and leave both alone.
 */
export async function recordElevenFailure(env: Env, failure: ElevenFailure, where: string): Promise<void> {
  log.warn("elevenlabs.failed", { where, failure });
  if (failure === "auth") {
    await markConnection(env, "elevenlabs", "error", "ElevenLabs says this key is not valid.");
    await writeElevenLabsLight(env, { state: "refused" });
  } else if (failure === "quota") {
    await writeElevenLabsLight(env, { state: "quota_hit" });
  }
}

/** Daily lane and "Check everything now": re-read her plan with the stored key, write the light. */
export async function recheckElevenLabs(env: Env): Promise<void> {
  const client = await getElevenLabs(env);
  if (!client) {
    await writeElevenLabsLight(env, { state: "not_connected" });
    return;
  }
  const r = await client.subscription();
  if (r.ok) {
    await markConnection(env, "elevenlabs", "ok", null, planMeta(r.plan));
    await writeElevenLabsLight(env, { state: "ok", plan: r.plan });
    await ensurePremiumVoice(env);
    return;
  }
  if (r.failure === "auth") await recordElevenFailure(env, "auth", "recheck");
  else await writeElevenLabsLight(env, { state: "unreachable" });
}

/**
 * Make the premium clone when it should exist and does not: after the sample is saved, after
 * ElevenLabs is connected, and before a narration. The built-in voice is untouched either way.
 */
export async function ensurePremiumVoice(env: Env): Promise<{ voiceId: string | null; failure: ElevenFailure | null }> {
  const s = await premiumState(env);
  if (!shouldClone(s)) return { voiceId: s.voiceId, failure: null };
  const client = await getElevenLabs(env);
  const obj = s.sampleKey ? await env.FILES.get(s.sampleKey) : null;
  if (!client || !obj) return { voiceId: null, failure: null };
  const type = obj.httpMetadata?.contentType ?? "audio/mpeg";
  const sample = new Blob([await obj.arrayBuffer()], { type });
  const r = await client.addVoice(sample, `voice-sample.${extFor(type)}`);
  if (!r.ok) {
    await recordElevenFailure(env, r.failure, "clone");
    return { voiceId: null, failure: r.failure };
  }
  await env.DB.prepare("UPDATE voice SET elevenlabs_voice_id = ?, updated_at = ? WHERE id = 1").bind(r.voiceId, nowIso()).run();
  await recordEvent(env.DB, "voice.premium.cloned", null, { bytes: sample.size });
  log.info("elevenlabs.cloned", { bytes: sample.size });
  return { voiceId: r.voiceId, failure: null };
}

/** Delete the clone from her ElevenLabs account (best effort, logged) and forget it here. */
export async function dropPremiumVoice(env: Env, why: string): Promise<void> {
  const v = await env.DB.prepare("SELECT elevenlabs_voice_id FROM voice WHERE id = 1").first<{ elevenlabs_voice_id: string | null }>();
  if (!v?.elevenlabs_voice_id) return;
  const client = await getElevenLabs(env);
  if (client) {
    const r = await client.deleteVoice(v.elevenlabs_voice_id);
    if (!r.ok) log.warn("elevenlabs.delete_failed", { why, failure: r.failure, status: r.status });
    else log.info("elevenlabs.deleted", { why });
  } else log.warn("elevenlabs.delete_skipped", { why, reason: "not_connected" });
  await env.DB.prepare("UPDATE voice SET elevenlabs_voice_id = NULL, updated_at = ? WHERE id = 1").bind(nowIso()).run();
  await recordEvent(env.DB, "voice.premium.deleted", null, { why });
}

/** A premium narration: text to speech in her cloned voice, straight into storage. */
export async function premiumNarrate(env: Env, narrationId: string, script: string, voiceId: string): Promise<{ ok: true; bytes: number; duration: number | null } | { ok: false; failure: ElevenFailure }> {
  const client = await getElevenLabs(env);
  if (!client) return { ok: false, failure: "auth" };
  const r = await client.tts(voiceId, script);
  if (!r.ok) {
    await recordElevenFailure(env, r.failure, "narrate");
    return { ok: false, failure: r.failure };
  }
  const key = `voice/narrations/${narrationId}.mp3`;
  await env.FILES.put(key, r.audio, { httpMetadata: { contentType: "audio/mpeg" } });
  const duration = mp3Duration(r.audio);
  await env.DB.prepare("UPDATE narrations SET status = 'ready', r2_key = ?, duration_s = ? WHERE id = ?").bind(key, duration, narrationId).run();
  return { ok: true, bytes: r.audio.byteLength, duration };
}

function extFor(type: string): string {
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("webm")) return "webm";
  if (type.includes("caf")) return "caf";
  return "mp3";
}
