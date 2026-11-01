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
const SHOT_LINE = /\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*(?:s\b)?\s*[·:]/;
/** A description of the voice instead of the words ("A warm, upbeat friend speaking plainly…"). */
const STAGE_DIRECTION = /\b(?:voice[- ]?over|voiceover|narrates|narrator|speaking plainly|describing the scene|plain sentences|upbeat voice|warm voice|spoken in her)\b/i;

/** Words no spoken sentence ends on: a cut or a model that stopped mid-thought (Mercedes, 1 Nov 2026: "…into something that feels."). */
const DANGLING = new Set(["a", "an", "the", "your", "our", "my", "their", "its", "of", "to", "with", "and", "or", "but", "for", "from", "at", "into", "onto", "about", "than", "as", "if", "because", "until", "very", "really", "such", "some", "every", "each", "whose", "which"]);
const HANGING = [
  /\b(?:that|which|who)\s+(?:feels?|looks?|seems?|makes?|turns?|gets?|becomes?|is|are|was|were)$/i, // "…something that feels."
  /\b(?:feels?|felt|looks?|seems?|sounds?)\s+like$/i, // "…that feel like."
  /,\s*[a-z]+ing$/i, // "…pours steamed milk slowly, shaping."
];

/** A sentence that stops before it is finished: no ending mark, a trailing little word, or a clause cut off. */
export function unfinishedSentence(text: string): boolean {
  const t = (text ?? "").trim().replace(/["”'’)\]]+$/, "");
  if (!t) return false;
  if (!/[.!?…]$/.test(t)) return true;
  return t.split(/(?<=[.!?…])\s+/).some((sentence) => {
    const body = sentence.replace(/[.!?…]+$/, "").trim();
    const last = (body.split(/\s+/).pop() ?? "").toLowerCase().replace(/[^a-z']/g, "");
    return DANGLING.has(last) || HANGING.some((r) => r.test(body));
  });
}

export interface SellContext {
  /** The service this clip sells, or null on a studio that sells none (a creator). */
  service: string | null;
  /** The business name as spoken ("Porch and Party"). */
  business: string;
  /** The call to action it ends on, or null when the studio chose none. */
  cta: string | null;
  /** Varies the no-AI line between clips (the clip id), so Review never shows one line on every clip. */
  seed?: string;
}

/** A sentence that is itself a call to action ("Book now.", "Book your visit today.", "Message us"): the studio's own CTA closes the line instead. */
const CTA_LIKE = /^(?:book|request|call|text|message|dm|contact|reach out|get in touch|get a quote|visit|order|shop|tap|click|follow|link in bio|swing by|stop by|come see)\b/i;

const hash = (s: string) => {
  let h = 0;
  for (const ch of s ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Why this script must not be spoken, or null when it is fine. The guard where every voice-over
 * script is built (draftScript) and swept (voiceRedo): "empty", "label" (a model verdict, a field,
 * a shot line, a stage direction or reasoning), "stub" (under four words), "unfinished" (a sentence
 * that stops mid-thought: no ending mark, a trailing little word, "…something that feels."), and on a business studio
 * "no_service" (never names the service or the business) and "no_cta" (does not end on the CTA).
 */
export function voiceScriptProblem(script: string | null | undefined, sell?: SellContext | null): "empty" | "label" | "stub" | "unfinished" | "no_service" | "no_cta" | null {
  const t = (script ?? "").trim();
  if (!t) return "empty";
  if (isModelVerdict(t) || LABEL_ONLY.test(t) || SHOT_LINE.test(t) || STAGE_DIRECTION.test(t) || isReasoning(t)) return "label";
  if (t.split(/\s+/).filter(Boolean).length < 4) return "stub";
  if (unfinishedSentence(t)) return "unfinished";
  if (sell?.service) {
    const said = new Set(words(t));
    const named = words(sell.service).some((w) => said.has(w)) || (sell.business && norm(t).includes(norm(sell.business)));
    if (!named) return "no_service";
  }
  if (sell?.service && sell.cta && !norm(t).endsWith(norm(sell.cta))) return "no_cta";
  // One call to action, the studio's, at the end ("Book now. Book your date." was spoken, 1 Nov 2026).
  if (sell?.service && sell.cta && t.split(/(?<=[.!?])\s+/).slice(0, -1).some((s) => CTA_LIKE.test(s.trim()))) return "no_cta";
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

/** The place to say: a place word the clip already uses, else one the studio serves. */
export function placeFor(placeWords: readonly string[], clipText: string, seed = ""): string | null {
  const low = (clipText ?? "").toLowerCase();
  // Else one of the places the studio serves, by clip (every one is true; the first on every clip read the same).
  return placeWords.find((p) => low.includes(p.toLowerCase())) ?? (placeWords.length ? placeWords[hash(seed) % placeWords.length] : null);
}

const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
const end = (s: string) => `${s.replace(/[.!?,;:\s]+$/, "")}.`;
const lower1 = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const upper1 = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The CTA as the closing sentence. */
export function ctaSentence(cta: string): string {
  return end(upper1(cta.trim()));
}

/** A line's identity for "no two clips in a studio say the same line": lower case, letters and digits only. */
export const lineKey = (t: string | null | undefined) => norm(t ?? "");

/**
 * Every selling line with no AI that fits `max` words (call to action included), for this clip:
 * warm shapes that name the service and, where the studio serves places, a town ("Holiday porches,
 * here in Germantown. Book your date."). Ordered for this clip (its seed picks the shape and the town
 * to start from, so a dump's clips differ); the longest that fits within each shape. Never empty.
 */
export function sellStarters(sell: SellContext, places: readonly (string | null)[], max: number): string[] {
  const svc = lower1(sell.service ?? sell.business);
  const Svc = upper1(svc);
  const biz = sell.business;
  const cta = sell.cta ? ` ${ctaSentence(sell.cta)}` : "";
  const room = max - count(cta);
  const h = hash(sell.seed ?? svc);
  const towns = places.filter((p): p is string => !!p);
  const order = towns.length ? towns.map((_, i) => towns[(i + h) % towns.length]) : [null];
  const shapesAt = (P: string | null): string[][] => {
    const at = P ? ` in ${P}` : "";
    return [
      // longest first within each shape; the room picks the one that fits
      [biz ? `Let ${biz} do your ${svc}, right here${at}.` : "", biz ? `${biz} does ${svc}${at}.` : "", `${Svc}${at}.`],
      [biz ? `Make it special with ${svc} from ${biz}${at}.` : "", biz ? `${Svc} from ${biz}${at}.` : "", P ? `${P} ${svc}, made easy.` : `${Svc}, made easy.`],
      [biz ? `This is ${svc} by ${biz}${at}.` : "", P ? `${Svc}, here in ${P}.` : `${Svc}, done for you.`],
      [`Want this at your place? ${Svc}${at}.`, P ? `${Svc}, anywhere in ${P}.` : `${Svc}, start to finish.`],
      [P ? `${P} loves ${biz ? `${biz}'s` : "our"} ${svc}.` : "", P ? `${P} loves our ${svc}.` : "", P ? `${Svc} across ${P}.` : `${Svc}, made for you.`],
      [P ? `${Svc} for your ${P} home, done for you.` : "", P ? `${Svc} for your ${P} home.` : `${Svc} for your home.`],
    ];
  };
  const out: string[] = [];
  // Every shape in every town once; neighbours differ in both, so clips drafted together do not sound alike.
  for (let r = 0; r < order.length; r++) {
    for (let k = 0; k < 6; k++) {
      const family = shapesAt(order[(k + r) % order.length])[(k + h) % 6].filter(Boolean);
      const body = family.find((o) => count(o) <= room);
      if (body) out.push(`${body}${cta}`.trim());
    }
  }
  const seen = new Set<string>();
  const uniq = out.filter((l) => !seen.has(lineKey(l)) && !!seen.add(lineKey(l)));
  return uniq.length ? uniq : [`${Svc}.${cta}`.trim()];
}

/** The selling line with no AI for this clip: the first of sellStarters, its place first. */
export function sellStarter(sell: SellContext, place: string | null, max: number): string {
  return sellStarters(sell, [place], max)[0];
}

/** The first line not already spoken on another clip of this studio, else the first. */
export function firstUnused(lines: readonly string[], taken: ReadonlySet<string>): string | null {
  return lines.find((l) => !!l && !taken.has(lineKey(l))) ?? null;
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
    if ((sell.cta && norm(s).includes(norm(sell.cta))) || CTA_LIKE.test(s)) continue; // one CTA, the studio's, at the end
    // A sentence too long for a short clip is skipped, not the rest: a later, shorter one may say the sale.
    if (count([...kept, s].join(" ")) > room || unfinishedSentence(s)) continue;
    kept.push(s);
  }
  let out = kept.join(" ");
  if (voiceScriptProblem(`${out} ${cta}`.trim(), { ...sell, cta: null }) === "no_service" || !out) {
    // The model's own words stay when a starter line still fits after them; else the starter line alone.
    const left = room - count(out);
    const tail = out ? sellStarters({ ...sell, cta: null }, [place], left).find((l) => count(l) <= left && (!place || l.includes(place))) ?? null : null;
    out = tail ? `${out} ${tail}` : sellStarter({ ...sell, cta: null }, place, room);
  }
  return `${out} ${cta}`.trim();
}
