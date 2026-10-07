// Automatic voice overs: the words on the switch (Settings and Voice overs). The rules are in
// worker/domain/autoVoice.ts.
export const AUTO_VOICE_HINT = "On = clips with no talking get a voice over in your voice automatically; you can remove it in Review. Off = only the voice overs you add yourself.";

/** About 2.3 spoken words a second, leaving a little air at the end so it fits the clip (Review's word count and the Worker's check use this one). */
export function maxWords(seconds: number): number {
  return Math.max(6, Math.floor(Math.max(3, seconds) * 2.3 * 0.85));
}
