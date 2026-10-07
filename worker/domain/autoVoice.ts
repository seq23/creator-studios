// Automatic voice overs (owner, 26 Sep 2026): when "Automatic voice overs" is on and her voice is
// saved, every clip with no talking (montage, b-roll, product shots) gets a short voice over in her
// voice; a clip where she talks never does. Pure and unit-tested (tests/unit/auto-voice.test.ts);
// validator `auto-voice-silent-only` keeps every automatic voice over behind isSilentClip.

/** Under this share of the clip covered by her words, the clip counts as having no talking. */
export const SILENT_BELOW = 0.15;

/**
 * No talking: speech measured and under 15%. Not measured (null, an older clip) is treated like
 * talking, so a voice over is never laid over her own words by accident.
 */
export function isSilentClip(speech: number | null | undefined): boolean {
  return typeof speech === "number" && Number.isFinite(speech) && speech >= 0 && speech < SILENT_BELOW;
}

export function silentClips<T extends { speech: number | null }>(clips: readonly T[]): T[] {
  return clips.filter((c) => isSilentClip(c.speech));
}

/** What the switch shows: on, on but her voice isn't saved yet (a quiet state, never an error), or off. */
export type AutoVoiceState = "on" | "needs_voice" | "off";
export function autoVoiceState(switchOn: boolean, hasSample: boolean): AutoVoiceState {
  if (!switchOn) return "off";
  return hasSample ? "on" : "needs_voice";
}

import { maxWords } from "@shared/autoVoice";
import type { VoiceChoice } from "@shared/steer";

/**
 * What a dump (or one of its videos) does about voice overs. Her choice for this dump (the "Voice
 * over" chip, or a note) wins over the Settings switch; with no choice, the switch decides: on →
 * the clips with no talking, off → none. "quiet" without a saved voice is the quiet
 * "needs_voice": nothing is made, nothing fails.
 */
export type VoicePlan = "quiet" | "none" | "pick" | "needs_voice";
export function voiceFor(choice: VoiceChoice | undefined, switchOn: boolean, hasSample: boolean): VoicePlan {
  const want: VoiceChoice = choice ?? (switchOn ? "quiet" : "none");
  if (want === "quiet" && !hasSample) return "needs_voice";
  return want;
}
export { AUTO_VOICE_HINT, maxWords } from "@shared/autoVoice";

/** A script cut to fit the clip, at a sentence end when one is close. */
export function fitScript(text: string, seconds: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const max = maxWords(seconds);
  if (words.length <= max) return words.join(" ");
  const cut = words.slice(0, max).join(" ");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/[,;:]$/, "")}.`;
}

/**
 * The script when the free AI is busy or not connected: the clip's hook and caption in her words,
 * with her call to action, fitted to the clip. Never empty, never a failure.
 */
export function starterScript(clip: { hook_text: string; caption: string }, cta: string | null, seconds: number): string {
  const hook = clip.hook_text.replace(/[…]+$/, "").trim();
  const caption = clip.caption.replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  const lines = [hook && /[.!?]$/.test(hook) ? hook : hook ? `${hook}.` : "", caption && caption.toLowerCase() !== hook.toLowerCase() ? caption : "", cta ? `${cta.replace(/[.!]*$/, "")}.` : ""].filter(Boolean);
  return fitScript(lines.join(" ") || "Here's a little look at my day. Follow for more.", seconds);
}
