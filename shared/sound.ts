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

export const SOUND_DEFAULT: SoundSettings = { camera: "keep", voice_source: "mine", stock_voice: STOCK_VOICES[0].id };

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
