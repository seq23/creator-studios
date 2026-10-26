// Automatic voice overs: the words on the switch (Settings and Voice overs). The rules are in
// worker/domain/autoVoice.ts.
export const AUTO_VOICE_HINT = "On = clips with no talking get a voice over in your voice automatically; you can remove it in Review. Off = only the voice overs you add yourself.";

/**
 * Under the switch while no recording is saved (Settings and Voice overs). Since Follow-on V
 * (23 Oct 2026) voice overs never wait on a recording: a studio voice speaks until hers exists
 * (shared/sound.ts voiceInUse), so this never says "nothing is made".
 */
export const NO_RECORDING_HINT = "Until you record your voice, a studio voice speaks the voice overs. Once you record it, your own voice takes over by itself.";

/** About 2.3 spoken words a second, leaving a little air at the end so it fits the clip (Review's word count and the Worker's check use this one). */
export function maxWords(seconds: number): number {
  return Math.max(6, Math.floor(Math.max(3, seconds) * 2.3 * 0.85));
}
