// One-tap fixes in Review (studio fix, 23 Oct 2026). Each re-plans the clip through the existing
// "Try another version" job (worker/jobs/cut.ts buildAgainSpec): the spec carries `fixes`, a list of
// these keys the clip engine reads, and the same words in `change_request`, so an engine that only
// reads words still follows them. The keys are the interface; the labels are what she taps.
// Guard: tests/unit/review-fixes.test.ts.

export const FIXES = {
  end_on_finished: { label: "End on the finished room", words: "end on the most finished, steady shot and hold it for at least 2 seconds" },
  less_blur: { label: "Less blur", words: "use only sharp, steady shots; drop the blurry or shaky ones" },
  different_opening: { label: "Different opening", words: "open with a different shot: show the finished result in the first second" },
  shorter: { label: "Shorter", words: "make it shorter and faster" },
  photo_ending: { label: "Use a photo ending", words: "end on the best photo of the finished result, held at least 2 seconds" },
} as const;

export type FixKey = keyof typeof FIXES;
export const FIX_KEYS = Object.keys(FIXES) as FixKey[];

/** Only known keys, each once, in the order above. */
export function cleanFixes(v: unknown): FixKey[] {
  const asked = new Set(Array.isArray(v) ? v.map(String) : []);
  return FIX_KEYS.filter((k) => asked.has(k));
}

/** The words that ride in change_request with the keys: her own notes first, then each fix. */
export function fixWords(fixes: FixKey[], notes: string): string {
  return [notes.trim(), ...fixes.map((k) => FIXES[k].words)].filter(Boolean).join("; ").slice(0, 1000);
}
