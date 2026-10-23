// A clip's words on the Worker side, held to the SAME rules as the clip engine (studio fix A+B,
// 23 Oct 2026). One list each, read from the engine's own files so the two sides never drift:
//   jobs/script_rules.json  what a script, hook or caption may never be (a model's "thinking" read
//                           aloud: "1. **Analyze the Request:** * **Format:** ..."); jobs/script_clean.py
//                           is the Python twin of cleanScript / isReasoning below.
//   jobs/playbook.json      the clip-type library (labels) and the "send this to..." lines.
// The caption layout is the owner's exact one (jobs/clipmaker.py compose_caption):
//   body \n\n CTA line with link \n\n hashtags \n\n — \n Made with AI
// Guards: tests/unit/clip-words.test.ts (and the cross-side test in tests/unit/studio-fix-ab.test.ts).
import scriptRules from "../jobs/script_rules.json";
import playbook from "../jobs/playbook.json";

const MARKERS: string[] = (scriptRules.reasoning_markers as string[]).map((m) => m.toLowerCase());
const MD_ANYWHERE = ["**", "__", "##", "```"];
const MD_LINE_START: string[] = (scriptRules.markdown_signs as string[]).filter((s) => !MD_ANYWHERE.includes(s));
const URL_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|net|org|co|us|io)(?:\/\S*)?)/gi;

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** True when the text looks like a model working something out rather than words to say. */
export function isReasoning(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const low = t.toLowerCase();
  if (MARKERS.some((m) => low.includes(m))) return true;
  if (/(\*\*|__)[^*_\n]{1,40}:\s*(\*\*|__)/.test(t)) return true;
  let signs = MD_ANYWHERE.reduce((n, s) => n + (s === "**" || s === "__" ? Math.floor((count(low, s) + 1) / 2) : count(low, s)), 0);
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  signs += lines.filter((l) => MD_LINE_START.some((s) => l.startsWith(s)) || /^\d+[.)]\s/.test(l)).length;
  if (/^\s*\d+[.)]\s/.test(t)) signs += 1;
  return signs >= 2;
}

export function stripMarkdown(text: string): string {
  let t = (text ?? "").replace(/[*_`#>]+/g, " ");
  t = t.replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, " ");
  t = t.replace(/[“”"]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t.replace(/\s+([,.;:!?])/g, "$1");
}

export const sentences = (text: string): string[] => (text ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const norm = (s: string): string => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
function similar(a: string, b: string): boolean {
  const wa = new Set(norm(a).split(/\s+/).filter(Boolean));
  const wb = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / Math.max(1, Math.min(wa.size, wb.size)) >= 0.8;
}

/** A hook or caption body: "" when reasoning-shaped, else the plain words. */
export function cleanLine(text: string, limit = 300): string {
  return isReasoning(text) ? "" : stripMarkdown(text).slice(0, limit);
}

/**
 * A voice-over script fit to speak, or "" when it must not be spoken: reasoning-shaped text is
 * rejected, links are never read aloud, no sentence twice, the call to action at most once, and a
 * sentence that repeats the caption word for word is dropped. Twin of jobs/script_clean.py clean_script.
 */
export function cleanScript(text: string, caption = "", ctas: readonly string[] = [], maxWords?: number): string {
  if (isReasoning(text)) return "";
  const plain = stripMarkdown(text).replace(URL_RE, "");
  const cap = sentences(stripMarkdown((caption ?? "").replace(URL_RE, ""))).filter((s) => norm(s).split(/\s+/).filter(Boolean).length >= 4);
  const ctaWords = ctas.map(norm).filter(Boolean);
  const kept: string[] = [];
  let saidCta = false;
  for (const s of sentences(plain)) {
    if (!norm(s)) continue;
    if (kept.some((k) => similar(s, k))) continue;
    if (ctaWords.some((c) => norm(s).includes(c))) {
      if (saidCta) continue;
      saidCta = true;
    } else if (cap.some((c) => norm(s) === norm(c))) continue;
    kept.push(s);
  }
  let out = kept.join(" ").trim();
  if (maxWords) {
    const words = out.split(/\s+/).filter(Boolean);
    if (words.length > maxWords) out = words.slice(0, maxWords).join(" ").replace(/[,;:]+$/, "") + (/[.!?]$/.test(out) ? "" : ".");
  }
  return out.length >= 6 ? out : "";
}

// ---------------------------------------------------------------- the caption layout

export const DIVIDER = "—";
export const AI_NOTE = "Made with AI";

export interface WordsRules {
  cta_phrases: string[];
  cta_link: string;
  ai_note: "all" | "ai_images";
  place_words: string[];
}

/** Rotate the studio's phrases; every third clip combines two (jobs/clipmaker.py cta_phrase). */
export function ctaPhrase(rules: Pick<WordsRules, "cta_phrases">, k: number): string {
  const ph = rules.cta_phrases ?? [];
  if (!ph.length) return "";
  const a = ph[((k % ph.length) + ph.length) % ph.length].replace(/[.!]+$/, "");
  if (ph.length > 1 && k % 3 === 2) {
    const b = ph[(k + 1) % ph.length].replace(/[.!]+$/, "");
    return `${a} or ${b.charAt(0).toLowerCase()}${b.slice(1)}`;
  }
  return a;
}

export function ctaLine(rules: Pick<WordsRules, "cta_phrases" | "cta_link">, k: number): string {
  const phrase = ctaPhrase(rules, k);
  const link = rules.cta_link ?? "";
  return phrase && link ? `${phrase}: ${link}` : phrase || link;
}

/**
 * Which turn of the phrase rotation a clip's caption used, so a re-render's end card says the same
 * call to action as its caption. null when no phrase of the studio's is in the caption.
 */
export function ctaTurnFor(caption: string, rules: Pick<WordsRules, "cta_phrases" | "cta_link">): number | null {
  const n = rules.cta_phrases?.length ?? 0;
  if (!n) return null;
  const low = (caption ?? "").toLowerCase();
  // A combined turn ("A or b") first: its first phrase alone is also in the caption.
  if (n > 1) for (let k = 2; k < n * 3; k += 3) if (low.includes(ctaPhrase(rules, k).toLowerCase())) return k;
  for (let k = 0; k < n * 3; k++) if ((n === 1 || k % 3 !== 2) && low.includes(ctaPhrase(rules, k).toLowerCase())) return k;
  return null;
}

export const wantsAiNote = (rules: Pick<WordsRules, "ai_note">, usesAiImages: boolean): boolean => rules.ai_note === "all" || (rules.ai_note === "ai_images" && usesAiImages);

/** The EXACT layout (owner, 23 Oct 2026). Twin of jobs/clipmaker.py compose_caption. */
export function composeCaption(body: string, cta: string, hashtags: readonly string[], aiNote: boolean): string {
  const blocks = [body.trim(), cta.trim(), hashtags.filter(Boolean).join(" ").trim()].filter(Boolean);
  const out = blocks.join("\n\n");
  if (!aiNote) return out;
  return out ? `${out}\n\n${DIVIDER}\n${AI_NOTE}` : `${DIVIDER}\n${AI_NOTE}`;
}

/** The caption body without a call to action of its own (the CTA line carries it, once). */
export function stripCta(body: string, rules: Pick<WordsRules, "cta_phrases" | "cta_link">): string {
  const phrases = (rules.cta_phrases ?? []).map((p) => p.toLowerCase().replace(/[.!]+$/, ""));
  const link = (rules.cta_link ?? "").toLowerCase();
  return sentences(body)
    .filter((s) => {
      const low = s.toLowerCase();
      return !((link && low.includes(link)) || phrases.some((p) => p && low.includes(p)));
    })
    .join(" ")
    .trim();
}

/** Some captions carry a "send this to..." line (sends rank Reels). Twin of clipmaker.send_line. */
export function sendLine(k: number, body: string): string {
  const every = Number(playbook.send_line_every) || 3;
  const lines = (playbook.send_lines as string[]) ?? [];
  if (k % every !== 1 || /send this/i.test(body) || !lines.length) return body;
  return `${body} ${lines[Math.floor(k / every) % lines.length]}`.trim();
}

// ---------------------------------------------------------------- clip types

const TYPES = playbook.types as Record<string, { label?: string }>;
export const CLIP_TYPE_IDS = [...Object.keys(TYPES), "imported"] as const;

/** "payoff_first" -> "Payoff-first before -> after"; "imported" -> "From your editor". */
export function clipTypeLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === "imported") return "From your editor";
  const label = TYPES[id]?.label ?? id.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
