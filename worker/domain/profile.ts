// Brand Profile (BUILD_PLAN.md section 5): the nine fixed sections, the drafting prompt, the
// parser for the model's answer, and the stand-in profile used with fake services.
import { BRAND_PROFILE_SECTIONS, type BrandProfileKey } from "@shared/constants";
import type { BrandProfileSections } from "@shared/types";

export const PROFILE_KEYS = BRAND_PROFILE_SECTIONS.map((s) => s.key) as BrandProfileKey[];

/** Drafting in the Worker is one model call; past this much text the job drafts instead. */
export const WORKER_DRAFT_MAX_CHARS = 60_000;
export const SECTION_MAX_CHARS = 4_000;

export function emptySections(): BrandProfileSections {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, ""])) as BrandProfileSections;
}

/** Keep only the nine keys, as trimmed strings of bounded length. */
export function cleanSections(x: unknown): BrandProfileSections {
  const out = emptySections();
  if (!x || typeof x !== "object") return out;
  const o = x as Record<string, unknown>;
  for (const k of PROFILE_KEYS) {
    const v = o[k];
    const s = Array.isArray(v) ? v.map((i) => `• ${String(i)}`).join("\n") : typeof v === "string" ? v : v == null ? "" : String(v);
    out[k] = s.trim().slice(0, SECTION_MAX_CHARS);
  }
  return out;
}

export function filledCount(s: BrandProfileSections): number {
  return PROFILE_KEYS.filter((k) => s[k].trim().length > 0).length;
}

/** Parse the model's JSON answer; tolerates a fenced code block around it. */
export function parseProfileAnswer(text: string): BrandProfileSections | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const s = cleanSections(JSON.parse(m[0]));
    return filledCount(s) >= 5 ? s : null;
  } catch {
    return null;
  }
}

export const PROFILE_SYSTEM = `You distill a creator's brand documents into one Brand Profile that every later AI step reads.
Answer with ONE JSON object and nothing else. Keys (all strings, plain words, short paragraphs or "• " bullet lines):
${BRAND_PROFILE_SECTIONS.map((s) => `  "${s.key}": ${s.label}`).join("\n")}
Rules: use only what the documents say or clearly imply; never invent numbers, names or partners.
If the documents say nothing about a section, write "Not in your docs yet." for it.
"themes" lists 3 to 5 themes. "do_dont" has "Do:" and "Don't:" lines. "off_limits" is what she never posts about.`;

export function profileUserPrompt(docs: { n: number; text: string }[]): string {
  return docs.map((d) => `--- Document ${d.n} ---\n${d.text}`).join("\n\n");
}

/**
 * Stand-in profile for FAKE_SERVICES=1: a realistic draft for Sample Creator, built from the
 * made-up facts for a demo creator. Demo data only.
 */
export const FAKE_PROFILE: BrandProfileSections = {
  who: "Sample Creator is the host behind Table & Gather, a home hosting brand. It started as a neighborhood supper club and grew into dinner parties, tablescapes and Sunday brunches anyone can make at home, on a real budget.",
  audience: "• Home cooks and new hosts who want to feed people well\n• Friends who take turns hosting\n• Renters and small-space hosts\n• Mostly 25 to 45, budget-minded, into food, decor and slow weekends",
  goals: "90 days: post consistently on TikTok, Instagram and YouTube Shorts; grow followers who host along.\n1 year: be the go-to name for easy home hosting; land 3–5 paid brand partnerships that fit (kitchenware, tableware, food, home decor).",
  voice: "Warm, practical and encouraging, with joy in it. Speaks like a friend welcoming you in: \"Come on in, pull up a chair.\" Confident, never fussy; generous with tips.",
  themes: "• Tablescapes: from bare cloth to candles lit\n• Dinner parties: arrivals, the first toast, the main dish\n• Make-ahead menus and hosting tips\n• Sunday brunch and seasonal tables",
  do_dont: "Do: show real guests having a good time (with their OK); show the food up close; lead with the feeling of the room; credit makers and shops.\nDon't: post guests who did not agree to be filmed; use slang that doesn't sound like her; make it look rushed.",
  off_limits: "Politics, religion debates, gossip about guests, guests' private details, anything that embarrasses a guest.",
  deal_fit: "Kitchenware and tableware, specialty food and drink, home decor and candles, grocery delivery, local makers. Not a fit: fast food, gambling, anything off-brand for a warm home host.",
  ctas: "• \"Save this for your next dinner party.\"\n• \"Follow for the next table.\"\n• \"Tag the friend who always hosts.\"\n• \"Tell me what you're celebrating.\"",
};
