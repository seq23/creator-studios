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
  who: "Sample Creator makes short, practical videos about the thing they know best, filmed at home and on the go. It started as a few how-to clips for friends and grew into a channel people come back to every week.",
  audience: "• People who want to learn the craft without the jargon\n• Followers who try what they see and share it\n• Beginners and returning fans alike\n• Mostly 25 to 45, budget-minded, short on time",
  goals: "90 days: post consistently on TikTok, Instagram and YouTube Shorts; grow followers who come back.\n1 year: be the go-to name in the niche; land 3–5 paid brand partnerships that fit.",
  voice: "Warm, practical and encouraging, with joy in it. Speaks like a friend showing you how: \"Here's the one thing that changed it for me.\" Confident, never fussy; generous with tips.",
  themes: "• How-tos: one clear result in under a minute\n• Behind the scenes: how a video gets made\n• Tips and quick wins\n• Stories from the week",
  do_dont: "Do: show real results up close; lead with the payoff; credit the people and brands that helped.\nDon't: film anyone who did not agree to it; use slang that doesn't sound like them; make it look rushed.",
  off_limits: "Politics, religion debates, gossip, other people's private details, anything that embarrasses a viewer.",
  deal_fit: "Brands whose products show up in the videos already, tools and services the audience asks about, local makers. Not a fit: gambling, anything off-brand for a warm, practical creator.",
  ctas: "• \"Save this for later.\"\n• \"Follow for the next one.\"\n• \"Send this to a friend who needs it.\"\n• \"Tell me what you'd try first.\"",
};
