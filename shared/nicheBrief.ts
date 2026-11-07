// The niche brief's shape and the lines every writer is given (owner, 7 Nov 2026). Pure.
export interface NicheCompetitor {
  name: string;
  handle: string;
  platform: string;
  followers?: string;
  url?: string;
}

export interface NicheBrief {
  buyer: string;
  competitors: NicheCompetitor[];
  hooks: string[];
  caption_patterns: string[];
  cta_patterns: string[];
  avoid: string[];
  channels: Record<string, { hashtags: string; norms: string }>;
}

/** A brief needs at least this many named accounts to be usable. */
export const MIN_COMPETITORS = 5;

const strs = (v: unknown, n: number, chars: number): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, chars) : "")).filter(Boolean).slice(0, n) : [];

/** A stored or researched brief, checked; null when it is not usable (too few named accounts, no hooks, no buyer). */
export function cleanBrief(v: unknown): NicheBrief | null {
  const r = (v ?? {}) as Record<string, unknown>;
  const competitors = (Array.isArray(r.competitors) ? r.competitors : [])
    .map((c) => (c ?? {}) as Record<string, unknown>)
    .map((c) => ({ name: String(c.name ?? "").trim().slice(0, 80), handle: String(c.handle ?? "").trim().slice(0, 60), platform: String(c.platform ?? "").trim().slice(0, 20), ...(c.followers ? { followers: String(c.followers).slice(0, 20) } : {}), ...(c.url ? { url: String(c.url).slice(0, 300) } : {}) }))
    .filter((c) => c.handle.startsWith("@") && c.handle.length > 2)
    .slice(0, 10);
  const buyer = String(r.buyer ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const hooks = strs(r.hooks, 8, 200);
  if (!buyer || competitors.length < MIN_COMPETITORS || hooks.length < 3) return null;
  const channels: NicheBrief["channels"] = {};
  if (r.channels && typeof r.channels === "object") {
    for (const [k, c] of Object.entries(r.channels as Record<string, unknown>)) {
      const x = (c ?? {}) as Record<string, unknown>;
      if (/^[a-z]{3,12}$/.test(k)) channels[k] = { hashtags: String(x.hashtags ?? "").slice(0, 200), norms: String(x.norms ?? "").slice(0, 200) };
    }
  }
  return { buyer, competitors, hooks, caption_patterns: strs(r.caption_patterns, 6, 220), cta_patterns: strs(r.cta_patterns, 5, 220), avoid: strs(r.avoid, 10, 220), channels };
}

/** The brief as the instructions a writer reads before it writes (one paragraph, bounded). */
export function briefPrompt(b: NicheBrief, channel?: string): string {
  const ch = channel && b.channels[channel] ? ` On ${channel}: hashtags ${b.channels[channel].hashtags}; ${b.channels[channel].norms}.` : "";
  return (
    `Niche brief (researched for this studio; write the way the accounts that win in it write). Buyer: ${b.buyer} ` +
    `Accounts that win here: ${b.competitors.map((c) => c.handle).join(", ")}. ` +
    `Their openings: ${b.hooks.join(" | ")}. ` +
    (b.caption_patterns.length ? `Captions: ${b.caption_patterns.join(" | ")}. ` : "") +
    (b.cta_patterns.length ? `Calls to action: ${b.cta_patterns.join(" | ")}. ` : "") +
    (b.avoid.length ? `Never: ${b.avoid.join(" | ")}.` : "") +
    ch
  ).slice(0, 2400);
}
