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
// What a voice can never say (24 Oct 2026, voice overs on one dump spoke "$350", hashtags run
// together, an emoji, "Made with." and "Book your"): hashtags, handles and emoji go before anything
// else (an emoji ends a sentence); a sentence with a price or the AI note is dropped; an unfinished
// last fragment goes when a finished sentence came before it; a cut never ends on a little word.
// The Python twin is jobs/script_clean.py clean_script (same lists, same order).
const SPOKEN_TAGS = /(^|[^\w])[#@]\w+/g;
const SPOKEN_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?(?:\u{200D}[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?)*|\u{FE0F}/gu;
const SPOKEN_PRICE = /[$£€]\s?\d|\b\d[\d,.]*\s?(?:dollars|bucks|usd)\b/i;
const SPOKEN_AI_NOTE = /\bmade with\b/i;
const LITTLE_WORDS = new Set(["a", "an", "the", "your", "our", "my", "to", "with", "and", "or", "of", "for", "in", "on", "at", "by", "from", "this", "that"]);
const ENDS = /[.!?]$/;

/** Words cut to `max`, never ending on a little word, ended with a full stop. */
export function cutWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, max);
  while (words.length && LITTLE_WORDS.has(norm(words[words.length - 1]))) words.pop();
  const out = words.join(" ").replace(/[,;:\u2014-]+$/, "");
  return out && !ENDS.test(out) ? `${out}.` : out;
}

export function cleanScript(text: string, caption = "", ctas: readonly string[] = [], maxWords?: number): string {
  if (isReasoning(text)) return "";
  const spoken = (text ?? "").replace(SPOKEN_TAGS, "$1").replace(SPOKEN_EMOJI, ". ");
  const plain = stripMarkdown(spoken).replace(URL_RE, "").replace(/(?:\.\s*){2,}/g, ". ").replace(/^[.\s]+/, "");
  const cap = sentences(stripMarkdown((caption ?? "").replace(URL_RE, ""))).filter((s) => norm(s).split(/\s+/).filter(Boolean).length >= 4);
  const ctaWords = ctas.map(norm).filter(Boolean);
  const all = sentences(plain);
  const finished = all.some((s) => ENDS.test(s));
  const kept: string[] = [];
  let saidCta = false;
  all.forEach((s, i) => {
    if (!norm(s)) return;
    if (SPOKEN_PRICE.test(s) || SPOKEN_AI_NOTE.test(s)) return;
    if (i === all.length - 1 && !ENDS.test(s) && finished) return;
    if (kept.some((k) => similar(s, k))) return;
    if (ctaWords.some((c) => norm(s).includes(c))) {
      if (saidCta) return;
      saidCta = true;
    } else if (cap.some((c) => norm(s) === norm(c))) return;
    kept.push(s);
  });
  let out = kept.join(" ").trim();
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  if (maxWords && count(out) > maxWords) {
    // Whole sentences while they fit; only a first sentence too long on its own is cut.
    const fit: string[] = [];
    for (const s of kept) {
      if (count([...fit, s].join(" ")) > maxWords) break;
      fit.push(s);
    }
    out = fit.length ? fit.join(" ") : cutWords(out, maxWords);
  }
  if (out && !ENDS.test(out)) out = cutWords(out, count(out));
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

// Distinct hooks in one dump (owner, 23-24 Oct 2026): the TypeScript twin of jobs/clipmaker.py
// hook_words / near_duplicate, so the hourly words pass never writes a hook that repeats another
// clip's (guard: tests/unit/hook-words.test.ts reads both sides).
export const HOOK_STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "my", "your", "you", "i", "is", "it", "this", "that", "me", "so", "just", "every", "day", "s"]);

export function hookWords(h: string): string[] {
  return ((h ?? "").toLowerCase().replace(/'s/g, "").match(/[a-z0-9']+/g) ?? []).filter((w) => !HOOK_STOP.has(w));
}

/** Two hooks that say nearly the same thing: the same words, half or more in common, or a shared two-word phrase. */
export function nearDuplicateHook(a: string, b: string): boolean {
  const wa = hookWords(a);
  const wb = hookWords(b);
  if (!wa.length || !wb.length) return false;
  if (wa.join(" ") === wb.join(" ")) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  const common = [...sa].filter((w) => sb.has(w)).length;
  if (common >= 2 && common / Math.min(sa.size, sb.size) >= 0.5) return true;
  const pairs = new Set(wa.slice(0, -1).map((w, i) => `${w} ${wa[i + 1]}`));
  return wb.slice(0, -1).some((w, i) => pairs.has(`${w} ${wb[i + 1]}`));
}

// Varied hooks in one dump (owner, 24 Oct 2026: many opened "POV:" and reused glow / instant /
// runway, which the near-duplicate check never caught). The TypeScript twin of jobs/clipmaker.py
// hook_opening / hook_stem / hook_variety_problem; the limits and the varied hook shapes are one
// list in jobs/playbook.json "hook_variety" (guard: tests/unit/hook-variety.test.ts reads both sides).
const VARIETY = (playbook as { hook_variety?: { opening_max?: number; word_max?: number; shapes?: string[] } }).hook_variety ?? {};
/** At most this many hooks in one dump open the same way. */
export const HOOK_OPENING_MAX = Number(VARIETY.opening_max) || 2;
/** At most this many hooks in one dump use the same distinctive word. */
export const HOOK_WORD_MAX = Number(VARIETY.word_max) || 2;
/** Varied hook patterns a clip is steered to in turn (after the niche playbook's own). */
export const HOOK_SHAPES: string[] = (VARIETY.shapes ?? []).map(String);

/** A hook's opening pattern: "pov" for any "POV:", else its first two words ("how i", "watch me"). */
export function hookOpening(h: string): string {
  const w = (h ?? "").toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? [];
  if (!w.length) return "";
  return w[0] === "pov" ? "pov" : w.slice(0, 2).join(" ");
}

/** A word's stem for the reuse count ("instantly" and "instant", "glows" and "glow" are one word). */
export function hookStem(w: string): string {
  const s = (w ?? "").toLowerCase().replace(/'/g, "");
  if (s.endsWith("ly") && s.length >= 5) return s.slice(0, -2);
  if (s.endsWith("ing") && s.length >= 6) return s.slice(0, -3);
  if (/(ss|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length >= 4) return s.slice(0, -1);
  return s;
}

function stems(h: string, exempt: Set<string>): Set<string> {
  return new Set(hookWords(h).map(hookStem).filter((s) => s.length >= 3 && !exempt.has(s)));
}

/**
 * Why a new hook would make its dump read alike, or null when it is fine: it nearly repeats another
 * hook, opens the way HOOK_OPENING_MAX others already open, or uses a distinctive word that
 * HOOK_WORD_MAX others already use. `exempt` words (the studio's place words, which the words pass
 * asks for) are never counted. Pure.
 */
export function hookVarietyProblem(hook: string, others: string[], exempt: string[] = []): string | null {
  const used = others.filter((o) => (o ?? "").trim());
  const twin = used.find((u) => nearDuplicateHook(hook, u));
  if (twin) return `It says nearly the same as “${twin}”.`;
  const open = hookOpening(hook);
  const sameOpen = used.filter((u) => hookOpening(u) === open).length;
  if (open && sameOpen >= HOOK_OPENING_MAX) return `${sameOpen} hooks already open with “${open}”.`;
  const ex = new Set(exempt.flatMap((e) => hookWords(e)).map(hookStem));
  const mine = stems(hook, ex);
  for (const s of mine) {
    const n = used.filter((u) => stems(u, ex).has(s)).length;
    if (n >= HOOK_WORD_MAX) return `${n} hooks already use “${hookWords(hook).find((w) => hookStem(w) === s) ?? s}”.`;
  }
  return null;
}

/** The openings and words a new hook must avoid in this dump (for the model's prompt). Pure. */
export function crowdedHookParts(others: string[], exempt: string[] = []): { openings: string[]; words: string[] } {
  const used = others.filter((o) => (o ?? "").trim());
  const ex = new Set(exempt.flatMap((e) => hookWords(e)).map(hookStem));
  const tally = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const opens = tally(used.map(hookOpening).filter(Boolean));
  const words = tally(used.flatMap((u) => [...stems(u, ex)]));
  return {
    openings: [...opens].filter(([, n]) => n >= HOOK_OPENING_MAX).map(([k]) => k),
    words: [...words].filter(([, n]) => n >= HOOK_WORD_MAX).map(([k]) => k),
  };
}

/**
 * The hook pattern this clip is steered to: the niche playbook's patterns, then HOOK_SHAPES, taken
 * in turn from `k` and skipping any that opens the way the dump's crowded openings do. Pure.
 */
export function hookPatternFor(k: number, nichePatterns: string[], crowdedOpenings: string[]): string | null {
  const all = [...nichePatterns.map(String).filter(Boolean), ...HOOK_SHAPES];
  if (!all.length) return null;
  const crowded = new Set(crowdedOpenings);
  for (let i = 0; i < all.length; i++) {
    const p = all[(Math.max(0, k) + i) % all.length];
    if (!crowded.has(hookOpening(p.replace(/^[^"“]*["“]/, "")))) return p;
  }
  return all[Math.max(0, k) % all.length];
}

const HYPE = new Set(((VARIETY as { hype?: string[] }).hype ?? []).map((w) => hookStem(String(w))));
const PULL_OPENERS: string[] = ((VARIETY as { pull_openers?: string[] }).pull_openers ?? []).map((w) => String(w).toLowerCase());
const NUMBER_WORDS = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/;

/**
 * How strong a hook is, 0..10 (the score's on-screen-words check): 0 when it is empty or too long to
 * read, else 6, +1 a word under the limit, +1 no vague hype word, +2 a pull (a number, "you", or a
 * curiosity opener). The twin of jobs/clipmaker.py hook_points. Pure.
 */
export function hookPoints(hook: string, maxWords = 8): number {
  const h = (hook ?? "").trim();
  const words = h.split(/\s+/).filter(Boolean);
  if (!h || words.length > Math.max(3, Math.min(10, maxWords)) || h.length > 56) return 0;
  const low = h.toLowerCase().replace(/[’]/g, "'");
  const raw = low.match(/[a-z0-9']+/g) ?? [];
  let pts = 6;
  if (words.length <= Math.max(3, Math.min(10, maxWords)) - 1) pts += 1;
  if (!raw.some((w) => HYPE.has(hookStem(w)))) pts += 1;
  const opener = raw.join(" ");
  const pull = NUMBER_WORDS.test(low) || raw.some((w) => ["you", "your", "you'll", "you're", "you've"].includes(w)) || low.includes("?") || PULL_OPENERS.some((o) => opener === o || opener.startsWith(`${o} `));
  if (pull) pts += 2;
  return pts;
}

/**
 * The niche pattern a hook copies word for word, or null (24 Oct 2026: "You asked, so here is style
 * the secret", "The one thing I do every day" and "How I host in under a minute" were the niche
 * playbook's patterns with one word dropped in). Copying = three or more of a pattern's own words in
 * a row (the "…" marks the part that changes). The twin of jobs/clipmaker.py copies_pattern. Pure.
 */
export function copiesPattern(hook: string, patterns: string[]): string | null {
  const words = (t: string) => (t.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? []);
  const hw = ` ${words(hook).join(" ")} `;
  for (const p of patterns) {
    for (const seg of String(p).split(/…|\.\.\./)) {
      const w = words(seg);
      for (let i = 0; i + 3 <= w.length; i++) if (hw.includes(` ${w.slice(i, i + 3).join(" ")} `)) return String(p);
    }
  }
  return null;
}
