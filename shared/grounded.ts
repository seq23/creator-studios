// Grounded words (studio intelligence layer 4): a voice-over script, like a hook or caption, may
// describe only what is on screen and never mentions automation. ONE word list with the cutter
// (shared/grounded.json, read by jobs/plan.py grounded_ok). Pure; tests/unit/grounded.test.ts.
import words from "./grounded.json";

function norm(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
}

function hasPhrase(text: string, phrases: readonly string[]): string | null {
  const t = norm(text);
  return phrases.find((p) => t.includes(` ${p.toLowerCase()} `)) ?? null;
}

export const AUTOMATION_WORDS: readonly string[] = words.automation;

/** The automation phrase a script uses ("added automatically"…), or null. */
export function mentionsAutomation(text: string): string | null {
  return hasPhrase(text, words.automation);
}

/** A script with every sentence that mentions automation, or a state the picture lacks, taken out. */
export function groundScript(text: string, ctx: { hasAfter: boolean; hasBefore: boolean }): string {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(
    (s) => !mentionsAutomation(s) && (ctx.hasAfter || !hasPhrase(s, words.finished)) && (ctx.hasBefore || !hasPhrase(s, words.before)),
  );
  return kept.join(" ").trim();
}
