// What a voice over may say, and (business studios) the line that sells the service a clip shows.
// Owner, 1 Nov 2026, on Porch & Party Studio's 28 clips in Review: the AI voice said "User Safety:
// safe." (a free model behind openrouter/free answered with its safety verdict instead of a script)
// and, on the rest, lines that never sold anything: "i thought she was supposed to be selling pnp
// services!!!". So:
//   voiceScriptProblem  the ONE check where a script is built (worker/lib/autoVoice.ts draftScript)
//                       and swept (worker/lib/voiceRedo.ts): a model's label or verdict, a shot line
//                       ("0.0–1.2 s · …"), a stage direction ("a warm voice narrates") or a stub is
//                       never spoken; on a business studio the script must also name the service
//                       and end on the studio's call to action.
//   serviceForClip      which of the profile's services (shared/services.ts servicesOf) the clip
//                       shows, from the profile's own "What each service looks like" words.
//   sellStarter         the no-AI line: the service, the business, the place, the call to action.
// Pure. Guard: tests/unit/sell-line.test.ts.
import { isReasoning } from "./clipWords";

const STOP = new Set(["with", "and", "the", "for", "from", "that", "this", "into", "such", "same", "before", "after", "plain", "bare", "empty", "dressed", "styled", "set", "up", "a", "an", "or", "of", "on", "in", "is", "as", "by", "to", "room"]);
const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "").replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const words = (t: string) => (t ?? "").split(/[^A-Za-z]+/).map(stem).filter((w) => w.length >= 3 && !STOP.has(w));

/** A classifier's verdict or a bare label, never words to say ("User Safety: safe.", "Safe", "unsafe\nS1"). */
export function isModelVerdict(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/^(?:user|response|prompt|assistant)?\s*safety\s*(?:assessment|rating|status)?\s*:/i.test(t)) return true;
  if (/^(?:safe|unsafe)\b[\s.!]*(?:\n.*)?$/i.test(t)) return true;
  if (/\bsafety categor(?:y|ies)\b/i.test(t)) return true;
  return false;
}

/** "Label: value." with nothing else: a field, not a sentence. */
const LABEL_ONLY = /^[A-Za-z][A-Za-z ]{0,30}:\s*[A-Za-z]{1,20}[.!]?$/;
/** A shot line read back ("0.0–1.2 s · a close look · …", "0.0–1.2 s: …"). */
const SHOT_LINE = /\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*s\b\s*[·:]/;
/** A description of the voice instead of the words ("A warm, upbeat friend speaking plainly…"). */
const STAGE_DIRECTION = /\b(?:voice[- ]?over|voiceover|narrates|narrator|speaking plainly|describing the scene|plain sentences|upbeat voice|warm voice|spoken in her)\b/i;

export interface SellContext {
  /** The service this clip sells, or null on a studio that sells none (a creator). */
  service: string | null;
  /** The business name as spoken ("Porch and Party"). */
  business: string;
  /** The call to action it ends on, or null when the studio chose none. */
  cta: string | null;
}

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Why this script must not be spoken, or null when it is fine. The guard where every voice-over
 * script is built (draftScript) and swept (voiceRedo): "empty", "label" (a model verdict, a field,
 * a shot line, a stage direction or reasoning), "stub" (under four words), and on a business studio
 * "no_service" (never names the service or the business) and "no_cta" (does not end on the CTA).
 */
export function voiceScriptProblem(script: string | null | undefined, sell?: SellContext | null): "empty" | "label" | "stub" | "no_service" | "no_cta" | null {
  const t = (script ?? "").trim();
  if (!t) return "empty";
  if (isModelVerdict(t) || LABEL_ONLY.test(t) || SHOT_LINE.test(t) || STAGE_DIRECTION.test(t) || isReasoning(t)) return "label";
  if (t.split(/\s+/).filter(Boolean).length < 4) return "stub";
  if (sell?.service) {
    const said = new Set(words(t));
    const named = words(sell.service).some((w) => said.has(w)) || (sell.business && norm(t).includes(norm(sell.business)));
    if (!named) return "no_service";
  }
  if (sell?.service && sell.cta && !norm(t).endsWith(norm(sell.cta))) return "no_cta";
  return null;
}

/** "Celebration room decor: a bedroom … with balloon clouds …" → the clue words of each service. */
function serviceClues(serviceLooks: string | null | undefined, services: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(services.map((s) => [s, new Set(words(s))]));
  for (const line of (serviceLooks ?? "").split(/\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).replace(/^[\s\d.)•*\-–]+/, "").trim().toLowerCase();
    const key = services.find((s) => s.toLowerCase() === name);
    if (!key) continue;
    // What it looks like finished, never the "before is …" half (a plain room is every service's before).
    const finished = line.slice(i + 1).split(/;\s*before\b/i)[0];
    for (const w of words(finished)) out.get(key)!.add(w);
  }
  return out;
}

/**
 * The service a clip shows: the profile service whose own words match the clip's shots, hook and
 * on-screen text best; on a tie or no match, the clip's stored service (the shot sheet's), else the first.
 */
export function serviceForClip(services: readonly string[], serviceLooks: string | null | undefined, clipText: string, stored?: string | null): string | null {
  if (!services.length) return null;
  const clues = serviceClues(serviceLooks, services);
  const said = words(clipText);
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const s of services) {
    const c = clues.get(s)!;
    const score = said.filter((w) => c.has(w)).length;
    if (score > bestScore) [best, bestScore, tie] = [s, score, false];
    else if (score === bestScore && score > 0) tie = true;
  }
  const storedOk = stored ? services.find((s) => s.toLowerCase() === stored.toLowerCase()) ?? null : null;
  if (best && !tie) return best;
  return storedOk ?? best ?? services[0];
}

/** The business name as a voice says it: "Porch & Party Studio" → "Porch and Party". */
export function spokenBusiness(appName: string): string {
  return (appName ?? "").replace(/\s+studio$/i, "").replace(/\s*&\s*/g, " and ").replace(/\s+/g, " ").trim();
}

/** The place to say: a place word the clip already uses, else the studio's first. */
export function placeFor(placeWords: readonly string[], clipText: string): string | null {
  const low = (clipText ?? "").toLowerCase();
  return placeWords.find((p) => low.includes(p.toLowerCase())) ?? placeWords[0] ?? null;
}

const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
const end = (s: string) => `${s.replace(/[.!?,;:\s]+$/, "")}.`;
const lower1 = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const upper1 = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The CTA as the closing sentence. */
export function ctaSentence(cta: string): string {
  return end(upper1(cta.trim()));
}

/**
 * The selling line with no AI, within `max` words: the longest of
 * "<Service> by <Business>, here in <Place>." / "<Service> by <Business>." / "<Service> in <Place>." / "<Service>.",
 * then the call to action. Never empty.
 */
export function sellStarter(sell: SellContext, place: string | null, max: number): string {
  const service = upper1(lower1(sell.service ?? sell.business));
  const cta = sell.cta ? ` ${ctaSentence(sell.cta)}` : "";
  const room = max - count(cta);
  const options = [
    sell.business && place ? `${service} by ${sell.business}, here in ${place}.` : "",
    sell.business ? `${service} by ${sell.business}.` : "",
    place ? `${service} in ${place}.` : "",
    `${service}.`,
  ].filter(Boolean);
  const body = options.find((o) => count(o) <= room) ?? options[options.length - 1];
  return `${body}${cta}`.trim();
}

/**
 * A model's body + the call to action, within `max` words. The body keeps whole sentences while
 * they fit; when it never names the service, the service line goes in front of the CTA if it fits.
 */
export function withSale(body: string, sell: SellContext, place: string | null, max: number): string {
  const cta = sell.cta ? ctaSentence(sell.cta) : "";
  const room = max - count(cta);
  const sentences = (body ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const s of sentences) {
    if (sell.cta && norm(s).includes(norm(sell.cta))) continue; // the CTA is said once, at the end
    if (count([...kept, s].join(" ")) > room) break;
    kept.push(s);
  }
  let out = kept.join(" ");
  if (voiceScriptProblem(`${out} ${cta}`.trim(), { ...sell, cta: null }) === "no_service" || !out) {
    const line = sellStarter({ ...sell, cta: null }, place, room);
    out = count(`${out} ${line}`) <= room && out ? `${out} ${line}` : line;
  }
  return `${out} ${cta}`.trim();
}
