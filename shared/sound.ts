// Sound for a studio's clips (owner, 22 Oct 2026): what happens to the camera's own sound, the
// built-in music library (never a silent clip), and whose voice the voice overs use. One list for the
// Worker and the app. A studio's defaults come from its registry entry ("sound", var STUDIO_SOUND);
// Settings → Sound changes them; a dump's "Camera sound" chip (or note) changes one dump.
import library from "../jobs/music/library.json";
import voices from "../jobs/voices.json";

export const CAMERA_SOUNDS = ["auto", "keep", "off"] as const;
export type CameraSound = (typeof CAMERA_SOUNDS)[number];

/** The chip / Settings words. */
export const CAMERA_LABEL: Record<CameraSound, string> = {
  auto: "Automatic",
  keep: "Keep it",
  off: "Off, music instead",
};
export const CAMERA_HINT: Record<CameraSound, string> = {
  auto: "Keeps someone talking to the camera. Drops it when it is only background talk or noise, and music plays instead.",
  keep: "Every clip keeps the sound the camera recorded.",
  off: "No camera sound and no captions from it. Music plays instead, and a voice over is added when a voice is set.",
};

/** The built-in music: original instrumentals made in this repo, CC0 (jobs/music/library.json). */
export interface LibraryTrack {
  id: string;
  title: string;
  mood: string;
  licence: string;
}
export const MUSIC_LIBRARY: LibraryTrack[] = library.tracks.map((t) => ({ id: t.id, title: t.title, mood: t.mood, licence: t.licence }));
export const libraryKey = (id: string) => `library/${id}`;
/** "library/<id>" of a track that exists, else null. */
export function libraryTrack(key: string | null | undefined): LibraryTrack | null {
  const m = /^library\/([a-z0-9-]{2,40})$/.exec(key ?? "");
  return m ? (MUSIC_LIBRARY.find((t) => t.id === m[1]) ?? null) : null;
}

/** Stock voices: Kokoro-82M preset speakers, Apache-2.0; no real person's voice is cloned (jobs/voices.json). */
export interface StockVoice {
  id: string;
  label: string;
  preview: string;
}
export const STOCK_VOICES: StockVoice[] = voices.voices.map((v) => ({ id: v.id, label: v.label, preview: v.preview }));
export const STOCK_VOICE_LICENCE = voices.engine.model_licence;

export type VoiceSource = "stock" | "mine";
export interface SoundSettings {
  camera: CameraSound;
  voice_source: VoiceSource;
  stock_voice: string;
}

/**
 * The stock voice used until she records her own (owner, 23 Oct 2026: "stock af_heart until a
 * consented voice sample exists, then switch automatically"). Named, never "the first in the list".
 */
export const DEFAULT_STOCK_VOICE = "af_heart";

/**
 * Plain defaults: keep the camera sound; voice overs in her own voice once she has recorded it, and
 * in the stock voice af_heart until then (voiceInUse). A studio's registry or Settings change these.
 */
export const SOUND_DEFAULT: SoundSettings = { camera: "keep", voice_source: "mine", stock_voice: DEFAULT_STOCK_VOICE };

export interface VoiceInUse {
  /** "stock": a studio voice speaks; "mine": her own recorded voice. */
  speaks: "stock" | "mine";
  /** The stock voice's id when one speaks, else null. */
  stock_voice: string | null;
  /** Why, in plain words (the Sound screen shows it). */
  why: "picked_stock" | "no_recording_yet" | "recorded";
}

/**
 * Which voice the voice overs use right now, and why. A studio voice when she picked one; her own
 * voice when she chose it AND a consented recording exists; otherwise (her voice chosen, nothing
 * recorded yet) the stock voice, so voice overs never wait on a recording, switching to hers by
 * itself once it exists. Pure; pinned in tests/unit/voice-follow-on.test.ts.
 */
export function voiceInUse(sound: SoundSettings, hasSample: boolean): VoiceInUse {
  if (sound.voice_source === "stock") return { speaks: "stock", stock_voice: sound.stock_voice, why: "picked_stock" };
  if (hasSample) return { speaks: "mine", stock_voice: null, why: "recorded" };
  return { speaks: "stock", stock_voice: sound.stock_voice || DEFAULT_STOCK_VOICE, why: "no_recording_yet" };
}

/** The Sound screen's sentence for voiceInUse, in plain words. Pure. */
export function voiceInUseLine(v: VoiceInUse): string {
  // "Voice 1: warm, a woman" → "Voice 1", the name the Sound screen's list shows first.
  const name = (STOCK_VOICES.find((s) => s.id === v.stock_voice)?.label ?? "Voice 1").split(":")[0].trim();
  if (v.why === "recorded") return "Voice overs use your own recorded voice.";
  if (v.why === "picked_stock") return `Voice overs use the studio voice you picked (${name}).`;
  return `Voice overs use a studio voice (${name}) because you have not recorded your voice yet. Once you record it, your own voice takes over by itself.`;
}

/** A studio's defaults from its registry var, then anything saved in Settings on top; anything odd is dropped. Pure. */
export function soundSettings(registry: string | undefined | null, saved: unknown): SoundSettings {
  let base: SoundSettings = { ...SOUND_DEFAULT };
  try {
    const j = registry ? (JSON.parse(registry) as { cameraSound?: unknown; voice?: { source?: unknown; stock?: unknown } }) : {};
    base = cleanSound({ camera: j.cameraSound, voice_source: j.voice?.source, stock_voice: j.voice?.stock }, base);
  } catch {
    // a malformed var keeps the plain defaults
  }
  return cleanSound(saved, base);
}

export function cleanSound(input: unknown, base: SoundSettings): SoundSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  return {
    camera: (CAMERA_SOUNDS as readonly string[]).includes(v.camera as string) ? (v.camera as CameraSound) : base.camera,
    voice_source: v.voice_source === "stock" || v.voice_source === "mine" ? v.voice_source : base.voice_source,
    stock_voice: STOCK_VOICES.some((s) => s.id === v.stock_voice) ? (v.stock_voice as string) : base.stock_voice,
  };
}
