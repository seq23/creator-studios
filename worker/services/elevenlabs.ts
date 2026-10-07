// ElevenLabs premium voice (Phase 11 addition). A plain REST API called with fetch from the
// Worker, no runner: her own ElevenLabs key (pasted on Connect, stored encrypted) pays for it
// with her own credits. Behind one interface so the fake and the real client are
// interchangeable. Every real call goes through `elevenFetch`, and every failed answer goes
// through `classifyElevenError` (401 refused key, 402 / quota_exceeded credits, 429 busy), so
// no call site can see a raw status (validator voice-engines).
import type { Env } from "../env";
import { fakeServices } from "../env";
import { classifyElevenError, type ElevenFailure, type ElevenPlan } from "../domain/voiceEngine";
import { getConnectionSecret } from "../lib/connections";
import { log } from "../lib/log";

export const ELEVEN_BASE = "https://api.elevenlabs.io";
export const ELEVEN_TTS_MODEL = "eleven_multilingual_v2";
export const ELEVEN_OUTPUT = "mp3_44100_128";
export const ELEVEN_VOICE_NAME = "Creator Studio voice";
const ELEVEN_VOICE_DESCRIPTION = "The studio owner's own voice, cloned from her consented sample in her studio. Delete it from the dashboard with Delete my voice.";
/** Natural, close to her sample; the defaults ElevenLabs recommends for a cloned voice. */
export const ELEVEN_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };

export type ElevenFail = { ok: false; failure: ElevenFailure; status: number };
export type ElevenResult<T> = ({ ok: true } & T) | ElevenFail;

export interface ElevenLabsClient {
  /** Her plan: tier, characters used / limit, and whether Instant Voice Cloning is included. */
  subscription(): Promise<ElevenResult<{ plan: ElevenPlan }>>;
  /** Instant Voice Clone from the consented sample. */
  addVoice(sample: Blob, fileName: string): Promise<ElevenResult<{ voiceId: string }>>;
  deleteVoice(voiceId: string): Promise<ElevenResult<object>>;
  /** Text to speech in the cloned voice: mp3 bytes. */
  tts(voiceId: string, text: string): Promise<ElevenResult<{ audio: Uint8Array }>>;
}

// ---------------------------------------------------------------- real

/** The one place the Worker talks to ElevenLabs. A thrown fetch reads as "other" (status 0). */
async function elevenFetch(key: string, path: string, init: RequestInit = {}): Promise<{ ok: true; res: Response } | ElevenFail> {
  let res: Response;
  try {
    res = await fetch(`${ELEVEN_BASE}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": key } });
  } catch {
    return { ok: false, failure: "other", status: 0 };
  }
  if (res.ok) return { ok: true, res };
  const body = await res.text().catch(() => "");
  const failure = classifyElevenError(res.status, body);
  log.warn("elevenlabs.refused", { path: path.split("/").slice(0, 3).join("/"), status: res.status, failure });
  return { ok: false, failure, status: res.status };
}

export class RealElevenLabs implements ElevenLabsClient {
  constructor(private key: string) {}

  async subscription(): Promise<ElevenResult<{ plan: ElevenPlan }>> {
    const r = await elevenFetch(this.key, "/v1/user/subscription");
    if (!r.ok) return r;
    const d = (await r.res.json().catch(() => ({}))) as { tier?: string; character_count?: number; character_limit?: number; can_use_instant_voice_cloning?: boolean };
    return { ok: true, plan: { tier: String(d.tier ?? "unknown"), used: Number(d.character_count ?? 0), limit: Number(d.character_limit ?? 0), canClone: d.can_use_instant_voice_cloning === true } };
  }

  async addVoice(sample: Blob, fileName: string): Promise<ElevenResult<{ voiceId: string }>> {
    const form = new FormData();
    form.append("name", ELEVEN_VOICE_NAME);
    form.append("files", sample, fileName);
    form.append("remove_background_noise", "true");
    form.append("description", ELEVEN_VOICE_DESCRIPTION);
    const r = await elevenFetch(this.key, "/v1/voices/add", { method: "POST", body: form });
    if (!r.ok) return r;
    const d = (await r.res.json().catch(() => ({}))) as { voice_id?: string };
    if (!d.voice_id) return { ok: false, failure: "other", status: r.res.status };
    return { ok: true, voiceId: d.voice_id };
  }

  async deleteVoice(voiceId: string): Promise<ElevenResult<object>> {
    const r = await elevenFetch(this.key, `/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
    return r.ok ? { ok: true } : r;
  }

  async tts(voiceId: string, text: string): Promise<ElevenResult<{ audio: Uint8Array }>> {
    const r = await elevenFetch(this.key, `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVEN_OUTPUT}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: ELEVEN_TTS_MODEL, voice_settings: ELEVEN_VOICE_SETTINGS }),
    });
    if (!r.ok) return r;
    const audio = new Uint8Array(await r.res.arrayBuffer());
    if (!audio.byteLength) return { ok: false, failure: "other", status: r.res.status };
    return { ok: true, audio };
  }
}

// ---------------------------------------------------------------- fake
// Keys starting "good-" work: plan "creator" with cloning. "good-nocloning-": a plan without
// cloning. "good-quota-": cloning allowed, every character used, and text to speech answers
// ElevenLabs' real quota shape (a 401 with detail.status "quota_exceeded"), so the fallback is
// exercised through the same classifier as the real thing. Anything else: 401, key refused.
// Text to speech returns a real ~1 s silent mp3 so the player works.

/** 1.04 s of silence, MPEG-1 Layer III, 44.1 kHz mono 32 kbps (ffmpeg anullsrc, no tags). */
export const SILENT_MP3_BASE64 = "//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLEKYPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDEU4PAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsR9A8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMSnA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sSxNCDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sSxNWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sSxNWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sSxNWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sSxNWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sSxNWDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xLE1YPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsTVg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==";

export function silentMp3(): Uint8Array {
  const bin = atob(SILENT_MP3_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const FAKE_VOICES = new Set<string>();

/** Test hook: the voices the fake currently holds (a delete removes one). */
export function fakeElevenVoices(): string[] {
  return [...FAKE_VOICES];
}
export function resetFakeElevenLabs(): void {
  FAKE_VOICES.clear();
}

const REFUSED: ElevenFail = { ok: false, failure: classifyElevenError(401, JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } })), status: 401 };

export class FakeElevenLabs implements ElevenLabsClient {
  constructor(private key: string) {}
  private get good() {
    return this.key.startsWith("good-");
  }
  async subscription(): Promise<ElevenResult<{ plan: ElevenPlan }>> {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-nocloning-")) return { ok: true, plan: { tier: "free", used: 1_200, limit: 10_000, canClone: false } };
    if (this.key.startsWith("good-quota-")) return { ok: true, plan: { tier: "starter", used: 30_000, limit: 30_000, canClone: true } };
    return { ok: true, plan: { tier: "creator", used: 12_000, limit: 100_000, canClone: true } };
  }
  async addVoice(sample: Blob): Promise<ElevenResult<{ voiceId: string }>> {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-nocloning-")) return { ok: false, failure: classifyElevenError(403, JSON.stringify({ detail: { status: "can_not_use_instant_voice_cloning" } })), status: 403 };
    if (!sample.size) return { ok: false, failure: "other", status: 400 };
    const id = `fake_voice_${Math.random().toString(36).slice(2, 12)}`;
    FAKE_VOICES.add(id);
    return { ok: true, voiceId: id };
  }
  async deleteVoice(voiceId: string): Promise<ElevenResult<object>> {
    if (!this.good) return REFUSED;
    FAKE_VOICES.delete(voiceId);
    return { ok: true };
  }
  async tts(voiceId: string, text: string): Promise<ElevenResult<{ audio: Uint8Array }>> {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-quota-")) {
      return { ok: false, failure: classifyElevenError(401, JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } })), status: 401 };
    }
    if (!voiceId || !text.trim()) return { ok: false, failure: "other", status: 400 };
    return { ok: true, audio: silentMp3() };
  }
}

/** The client for a pasted key, or for the stored one. null when ElevenLabs is not connected. */
export async function getElevenLabs(env: Env, key?: string | null): Promise<ElevenLabsClient | null> {
  const k = key ?? (await getConnectionSecret(env, "elevenlabs"));
  if (!k) return null;
  return fakeServices(env) ? new FakeElevenLabs(k) : new RealElevenLabs(k);
}
