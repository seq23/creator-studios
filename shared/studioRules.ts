// A studio's clip rules (studio fix, owner's rulings 23 Oct 2026): the call to action (phrases
// plus one link), when the caption says "Made with AI", how many distinct clips a dump should
// give, the review bar, the local words, whether prices may be said, and the logo for end cards.
// One list for the Worker and the app. Defaults come from the studio's registry entry
// ("studioRules", var STUDIO_RULES); Settings → Your clips changes them (settings key
// "studio_rules"). The cut job reads them as spec.studio_rules (the interface with the clip
// engine, docs in the studio-fix contract): business-neutral code, every word per studio is data.
// Guard: tests/unit/studio-rules.test.ts.

export type AiNote = "all" | "ai_images";

export interface StudioRules {
  /** Phrases the end card and caption rotate or combine ("Book now"). Never empty: a neutral fallback stands in. */
  cta_phrases: string[];
  /** The one link every call to action points at; "" = none set yet (no link in captions). */
  cta_link: string;
  /** "all": every caption ends "Made with AI"; "ai_images": only clips that use an AI picture. */
  ai_note: AiNote;
  /** How many distinct clips a dump should give (styles never count). */
  clip_target: { min: number; max: number };
  /** The review bar, 0..100: under it a clip is re-cut once, then hidden with its reason. */
  bar: number;
  /** Local and niche words for captions, on-screen words and voice ("Springfield"). */
  place_words: string[];
  /** May a clip say a price at all. */
  prices: boolean;
  /** The logo for end cards (an R2 key under brand/logo/), or null. */
  logo_r2_key: string | null;
}

/** When a studio has not set its own call to action yet: neutral, no link, never a business word. */
export const FALLBACK_CTA = "Follow for more";

export const RULES_DEFAULT: StudioRules = {
  cta_phrases: [FALLBACK_CTA],
  cta_link: "",
  ai_note: "ai_images",
  clip_target: { min: 8, max: 15 },
  bar: 70,
  place_words: [],
  prices: false,
  logo_r2_key: null,
};

/** Limits the Settings screen and the Worker both hold to. */
export const RULE_LIMITS = { phrases: 8, phraseChars: 60, places: 12, placeChars: 40, clipsMin: 1, clipsMax: 60, linkChars: 300 } as const;

const cleanList = (v: unknown, n: number, chars: number): string[] | null => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|,/) : null;
  if (!raw) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").replace(/\s+/g, " ").trim().slice(0, chars);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
};

/** A link she can paste: https only, no spaces; "" clears it; anything else is refused (null). */
export function cleanLink(v: unknown): string | null {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (t.length > RULE_LIMITS.linkChars || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

/** One field at a time over `base`; anything odd keeps the base value. Pure. */
export function cleanRules(input: unknown, base: StudioRules): StudioRules {
  const v = (input ?? {}) as Record<string, unknown>;
  const phrases = cleanList(v.cta_phrases, RULE_LIMITS.phrases, RULE_LIMITS.phraseChars);
  const places = cleanList(v.place_words, RULE_LIMITS.places, RULE_LIMITS.placeChars);
  const link = v.cta_link === undefined ? null : cleanLink(v.cta_link);
  const t = (v.clip_target ?? {}) as Record<string, unknown>;
  const min = Number(t.min);
  const max = Number(t.max);
  const targetOk = Number.isInteger(min) && Number.isInteger(max) && min >= RULE_LIMITS.clipsMin && max <= RULE_LIMITS.clipsMax && min <= max;
  const bar = Number(v.bar);
  const logo = v.logo_r2_key === null ? null : typeof v.logo_r2_key === "string" && /^brand\/logo\/[A-Za-z0-9_]{4,60}$/.test(v.logo_r2_key) ? v.logo_r2_key : undefined;
  return {
    cta_phrases: phrases === null ? base.cta_phrases : phrases.length ? phrases : [FALLBACK_CTA],
    cta_link: link === null ? base.cta_link : link,
    ai_note: v.ai_note === "all" || v.ai_note === "ai_images" ? v.ai_note : base.ai_note,
    clip_target: targetOk ? { min, max } : base.clip_target,
    bar: Number.isInteger(bar) && bar >= 0 && bar <= 100 ? bar : base.bar,
    place_words: places === null ? base.place_words : places,
    prices: typeof v.prices === "boolean" ? v.prices : base.prices,
    logo_r2_key: logo === undefined ? base.logo_r2_key : logo,
  };
}

/** The studio's registry defaults (var STUDIO_RULES), then anything saved in Settings on top. Pure. */
export function studioRules(registry: string | undefined | null, saved: unknown): StudioRules {
  let base = { ...RULES_DEFAULT };
  try {
    if (registry && registry.trim()) base = cleanRules(JSON.parse(registry), base);
  } catch {
    // a malformed var keeps the plain defaults
  }
  return cleanRules(saved, base);
}

/** What she can't save, as one plain sentence (the Settings screen shows it); null = fine. */
export function rulesProblem(input: Record<string, unknown>): string | null {
  if (input.cta_link !== undefined && cleanLink(input.cta_link) === null) return "That link does not look right. Paste the full address, starting with https://";
  const t = input.clip_target as { min?: unknown; max?: unknown } | undefined;
  if (t !== undefined) {
    const min = Number(t?.min);
    const max = Number(t?.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < RULE_LIMITS.clipsMin || max > RULE_LIMITS.clipsMax || min > max) return `Clips per dump: pick a smallest and a largest number between ${RULE_LIMITS.clipsMin} and ${RULE_LIMITS.clipsMax}, smallest first.`;
  }
  if (input.bar !== undefined) {
    const b = Number(input.bar);
    if (!Number.isInteger(b) || b < 0 || b > 100) return "The review bar is a number from 0 to 100.";
  }
  return null;
}
