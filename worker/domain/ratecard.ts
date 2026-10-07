// Rate card, rate helper and negotiation math (docs/reviews/agency-pov.md "How we price" and
// "How we negotiate"). Pure, so every rule is unit-tested.
//
// The one rule that matters most: never a made-up number. Every benchmark below names its
// source, link and the date it was checked (25 Sep 2026). The helper uses, in order: her own
// agreed fees for that package; a published range for her follower tier; a published platform
// average (said plainly to be "not by size"); otherwise it says "no benchmark" and asks her to
// set her own. The multipliers for usage, paid usage and exclusivity default inside a sourced
// band; rush, bundle, kill fee and upfront have no credible published figure, so they are her
// own terms and labelled that way.
import type { Platform } from "@shared/constants";

export interface Source {
  name: string;
  url: string;
  checked: string;
  quote: string;
}

export const SOURCES = {
  later2026: { name: "Later, Influencer pricing benchmarks 2026 (7 Jul 2026)", url: "https://later.com/blog/influencer-pricing-benchmarks-the-complete-2026-guide/", checked: "2026-09-25", quote: "Nano (1K–10K): Reels/TikTok $200–$500, feed post $100–$300, Stories $50–$150. Micro (10K–100K): Reels/TikTok $800–$2,500, feed post $500–$1,500." },
  collabstr2026: { name: "Collabstr 2026 Influencer Marketing Report (21,000 deals)", url: "https://collabstr.com/2026-influencer-marketing-report", checked: "2026-09-25", quote: "Average amount actually paid: YouTube $255, Instagram $193, TikTok $186, UGC $154." },
  laterUsage: { name: "Later 2026 guide: usage rights and whitelisting", url: "https://later.com/blog/influencer-pricing-benchmarks-the-complete-2026-guide/", checked: "2026-09-25", quote: "Usage rights typically add 30–50% to the base rate … whitelisting: add 30–50% to your base rate." },
  impactUsage: { name: "impact.com, How much to charge for usage rights (Jan 2026)", url: "https://impact.com/influencer/how-much-to-charge-for-usage-rights-influencer/", checked: "2026-09-25", quote: "Most influencers charge an additional 20 to 50 percent of their base rate for usage rights … exclusivity: between 20 and 100 percent of their base rate." },
  digidayTerms: { name: "Digiday, creators and late payments (28 Jan 2026)", url: "https://digiday.com/future-of-tv/future-of-tv-briefing-the-creators-economys-very-loud-dirty-little-secret-of-brands-late-delayed-payments/", checked: "2026-09-25", quote: "Net-30 is still the most common, but it's definitely extending. I'm seeing a lot more 60, 45." },
  socialinsiderTikTok: { name: "Socialinsider TikTok benchmarks 2026 (engagement by views)", url: "https://www.socialinsider.io/social-media-benchmarks/tiktok", checked: "2026-09-25", quote: "Engagement rate by views, 2025: 1–5K followers 4.40%, 5–10K 4.00%, 10–50K 3.90%." },
} as const satisfies Record<string, Source>;

export type DeliverableKey = "tiktok_video" | "ig_reel" | "ig_story_set" | "ig_feed_post" | "yt_short" | "yt_integration" | "ugc_video";

export const DELIVERABLES: Record<DeliverableKey, { label: string; platform: Platform | null }> = {
  tiktok_video: { label: "TikTok video", platform: "tiktok" },
  ig_reel: { label: "Instagram Reel", platform: "instagram" },
  ig_story_set: { label: "Instagram Story set (3 frames)", platform: "instagram" },
  ig_feed_post: { label: "Instagram feed post", platform: "instagram" },
  yt_short: { label: "YouTube Short", platform: "youtube" },
  yt_integration: { label: "YouTube video mention (60–90 s)", platform: "youtube" },
  ugc_video: { label: "Video for their channels (no post from you)", platform: null },
};

type Tier = "nano" | "micro";
/** Later 2026 ranges, only for the deliverables and tiers the source states. */
const TIER_RANGES: Partial<Record<DeliverableKey, Partial<Record<Tier, [number, number]>>>> = {
  tiktok_video: { nano: [200, 500], micro: [800, 2500] },
  ig_reel: { nano: [200, 500], micro: [800, 2500] },
  ig_feed_post: { nano: [100, 300], micro: [500, 1500] },
  ig_story_set: { nano: [50, 150] },
};
/** Collabstr 2026 average actually paid, by platform (not by account size). */
const PLATFORM_AVG_PAID: Partial<Record<DeliverableKey, number>> = { yt_short: 255, yt_integration: 255, ugc_video: 154 };

export function tierFor(followers: number | null | undefined): Tier | null {
  if (followers == null) return null;
  if (followers >= 1_000 && followers < 10_000) return "nano";
  if (followers >= 10_000 && followers < 100_000) return "micro";
  return null;
}

export interface RateSuggestion {
  kind: "own" | "tier" | "platform" | "none";
  startingAt: number | null;
  target: number | null;
  floor: number | null;
  /** The arithmetic, in words, exactly as the screen shows it. */
  formula: string;
  sources: Source[];
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/**
 * A starting point for one deliverable. `ownFees` are fees she agreed for this same deliverable
 * (from deals); they beat any benchmark. Never returns a number without saying where it came from.
 */
export function suggestRate(key: DeliverableKey, followers: number | null | undefined, ownFees: number[] = []): RateSuggestion {
  const label = DELIVERABLES[key].label;
  const own = ownFees.filter((f) => Number.isFinite(f) && f > 0);
  if (own.length) {
    const avg = own.reduce((a, b) => a + b, 0) / own.length;
    const hi = Math.max(...own);
    const lo = Math.min(...own);
    return {
      kind: "own",
      startingAt: roundTo(avg, 5),
      target: roundTo(Math.max(avg * 1.1, hi), 5),
      floor: roundTo(lo, 5),
      formula: `Your ${own.length} agreed ${own.length === 1 ? "deal" : "deals"} for a ${label}: average ${usd(avg)} (${own.map(usd).join(" + ")} ÷ ${own.length}). Starting at = your average; target = your highest or average + 10%, whichever is more; floor = your lowest.`,
      sources: [],
    };
  }
  const tier = tierFor(followers);
  const range = tier ? TIER_RANGES[key]?.[tier] : undefined;
  if (tier && range) {
    const [lo, hi] = range;
    const mid = (lo + hi) / 2;
    return {
      kind: "tier",
      startingAt: lo,
      target: roundTo(mid, 5),
      floor: lo,
      formula: `Later's 2026 range for ${tier === "nano" ? "creators with 1K–10K" : "creators with 10K–100K"} followers: ${usd(lo)}–${usd(hi)} per ${label}. Starting at = low end ${usd(lo)}; target = middle (${usd(lo)} + ${usd(hi)}) ÷ 2 = ${usd(mid)}; floor = low end ${usd(lo)}.`,
      sources: [SOURCES.later2026],
    };
  }
  const avgPaid = PLATFORM_AVG_PAID[key];
  if (avgPaid) {
    return {
      kind: "platform",
      startingAt: avgPaid,
      target: avgPaid,
      floor: null,
      formula: `Collabstr's 2026 report: brands paid ${usd(avgPaid)} on average for ${key === "ugc_video" ? "content-only (UGC) work" : "YouTube work"}. This is an average across all sizes, not a figure for your size. Starting at = that average; set your own floor.`,
      sources: [SOURCES.collabstr2026],
    };
  }
  return {
    kind: "none",
    startingAt: null,
    target: null,
    floor: null,
    formula: followers == null ? `No numbers for this platform yet, so no benchmark. Connect your stats, or set your own price for a ${label}.` : `No published benchmark for a ${label} at ${followers.toLocaleString("en-US")} followers. Set your own starting price.`,
    sources: [],
  };
}

// ---------- the rate card she keeps (packages + add-on terms)

export interface PackageItem {
  key: DeliverableKey;
  qty: number;
}
export interface RatePackage {
  id: string;
  name: string;
  items: PackageItem[];
  /** Public "starting at" price, whole dollars; null when she leaves it blank. */
  startingAt: number | null;
  /** Public shows "Rates on request" instead of the price. */
  onRequest: boolean;
  /** Private: never on the public kit or in an email. */
  floor: number | null;
  target: number | null;
  note: string;
  /** Shown on the public kit. */
  showOnKit: boolean;
}

export interface AddOnTerms {
  usagePctPer30d: number; // organic reuse on their channels
  paidUsagePctPer30d: number; // whitelisting / Spark Ads / paid ads from her handle
  exclusivityPctPerMonth: number; // one named category
  rushPct: number | null; // under 7 days brief-to-post
  bundleDiscountPct: number;
  killFeePct: number;
  upfrontPct: number;
  upfrontOver: number;
  netDays: number;
  revisionRounds: number;
}

export const DEFAULT_ADDONS: AddOnTerms = {
  usagePctPer30d: 30,
  paidUsagePctPer30d: 40,
  exclusivityPctPerMonth: 25,
  rushPct: null,
  bundleDiscountPct: 10,
  killFeePct: 50,
  upfrontPct: 50,
  upfrontOver: 1000,
  netDays: 30,
  revisionRounds: 2,
};

/** Where each add-on number comes from, for the screen. */
export const ADDON_BASIS: Record<keyof AddOnTerms, { text: string; sources: Source[] }> = {
  usagePctPer30d: { text: "Published range: 20–50% of the base fee.", sources: [SOURCES.impactUsage, SOURCES.laterUsage] },
  paidUsagePctPer30d: { text: "Published range for whitelisting: 30–50% of the base fee.", sources: [SOURCES.laterUsage] },
  exclusivityPctPerMonth: { text: "Published range: 20–100% of the base fee depending on length; no published per-month figure, so this monthly number is your own.", sources: [SOURCES.impactUsage] },
  rushPct: { text: "No published benchmark. Your own term (leave blank for no rush fee).", sources: [] },
  bundleDiscountPct: { text: "No published benchmark. Your own term.", sources: [] },
  killFeePct: { text: "No published benchmark. Your own term: what they owe if they cancel after the brief is approved.", sources: [] },
  upfrontPct: { text: "No published benchmark. Your own term for bigger deals.", sources: [] },
  upfrontOver: { text: "Your own term.", sources: [] },
  netDays: { text: "Net-30 is the most common; longer is creeping in and is a red flag.", sources: [SOURCES.digidayTerms] },
  revisionRounds: { text: "Your own term.", sources: [] },
};

export function packageLabel(items: PackageItem[]): string {
  return items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ""}${DELIVERABLES[i.key]?.label ?? i.key}`).join(" + ");
}

/**
 * Suggest a package price from its items: each item's suggestion × qty, less her bundle discount
 * when there is more than one piece. Returns "none" if any item has no basis (no half-invented totals).
 */
export function suggestPackage(items: PackageItem[], followers: Partial<Record<Platform, number>>, addons: AddOnTerms, ownFeesByKey: Partial<Record<DeliverableKey, number[]>> = {}): RateSuggestion {
  const parts = items.map((i) => ({ i, s: suggestRate(i.key, DELIVERABLES[i.key].platform ? followers[DELIVERABLES[i.key].platform!] : Math.max(0, ...Object.values(followers).filter((x): x is number => typeof x === "number")) || null, ownFeesByKey[i.key]) }));
  const missing = parts.find((p) => p.s.startingAt === null);
  if (missing || !parts.length) return { kind: "none", startingAt: null, target: null, floor: null, formula: missing ? missing.s.formula : "Add at least one item.", sources: [] };
  const pieces = items.reduce((a, b) => a + b.qty, 0);
  const disc = pieces > 1 ? addons.bundleDiscountPct : 0;
  const sum = (f: (s: RateSuggestion) => number | null) => parts.reduce((a, p) => a + (f(p.s) ?? p.s.startingAt!) * p.i.qty, 0);
  const start = sum((s) => s.startingAt);
  const target = sum((s) => s.target);
  const floor = sum((s) => s.floor);
  const k = (100 - disc) / 100;
  const math = parts.map((p) => `${p.i.qty} × ${usd(p.s.startingAt!)} (${DELIVERABLES[p.i.key].label})`).join(" + ");
  const sources = [...new Map(parts.flatMap((p) => p.s.sources).map((s) => [s.url, s])).values()];
  return {
    kind: parts.every((p) => p.s.kind === "own") ? "own" : parts.some((p) => p.s.kind === "platform") ? "platform" : "tier",
    startingAt: roundTo(start * k, 5),
    target: roundTo(target * k, 5),
    floor: roundTo(floor * k, 5),
    formula: `${math} = ${usd(start)}${disc ? `, less your ${disc}% bundle discount = ${usd(start * k)}` : ""}. ${parts.map((p) => p.s.formula).filter((v, i, a) => a.indexOf(v) === i).join(" ")}`,
    sources,
  };
}

// ---------- quoting a deal with add-ons

export interface AddOnAsk {
  usageDays?: number;
  paidUsageDays?: number;
  exclusivityMonths?: number;
  rush?: boolean;
}
export interface QuoteLine {
  label: string;
  amount: number;
  math: string;
}

/** Base fee + add-ons, each line with its arithmetic. The base includes 30 days of organic reposting. */
export function quote(base: number, ask: AddOnAsk, t: AddOnTerms): { lines: QuoteLine[]; total: number } {
  const lines: QuoteLine[] = [{ label: "Base fee", amount: base, math: usd(base) }];
  const extraUsageDays = Math.max(0, (ask.usageDays ?? 30) - 30);
  if (extraUsageDays > 0) {
    const periods = Math.ceil(extraUsageDays / 30);
    const amt = (base * t.usagePctPer30d * periods) / 100;
    lines.push({ label: `Usage beyond 30 days (${extraUsageDays} more days)`, amount: amt, math: `${usd(base)} × ${t.usagePctPer30d}% × ${periods} × 30 days = ${usd(amt)}` });
  }
  if (ask.paidUsageDays && ask.paidUsageDays > 0) {
    const periods = Math.ceil(ask.paidUsageDays / 30);
    const amt = (base * t.paidUsagePctPer30d * periods) / 100;
    lines.push({ label: `Paid ads from your handle (${ask.paidUsageDays} days)`, amount: amt, math: `${usd(base)} × ${t.paidUsagePctPer30d}% × ${periods} × 30 days = ${usd(amt)}` });
  }
  if (ask.exclusivityMonths && ask.exclusivityMonths > 0) {
    const amt = (base * t.exclusivityPctPerMonth * ask.exclusivityMonths) / 100;
    lines.push({ label: `Exclusivity, one category (${ask.exclusivityMonths} ${ask.exclusivityMonths === 1 ? "month" : "months"})`, amount: amt, math: `${usd(base)} × ${t.exclusivityPctPerMonth}% × ${ask.exclusivityMonths} = ${usd(amt)}` });
  }
  if (ask.rush && t.rushPct) {
    const amt = (base * t.rushPct) / 100;
    lines.push({ label: "Rush (under 7 days)", amount: amt, math: `${usd(base)} × ${t.rushPct}% = ${usd(amt)}` });
  }
  const total = lines.reduce((a, l) => a + l.amount, 0);
  return { lines: lines.map((l) => ({ ...l, amount: Math.round(l.amount) })), total: Math.round(total) };
}

// ---------- three options (anchor high) and the counter-offer calculator

export interface OfferOption {
  tier: "full" | "standard" | "entry";
  name: string;
  what: string;
  price: number | null;
  onRequest: boolean;
}

/**
 * Three options for a pitch or rate proposal, most expensive first (anchor high). From her rate
 * card when she has one; a package priced "on request" says so; with no packages at all, null.
 */
export function threeOptions(pkgs: RatePackage[], t: AddOnTerms): OfferOption[] | null {
  const usable = pkgs.filter((p) => p.items.length && (p.startingAt || p.onRequest));
  if (!usable.length) return null;
  const pieces = (p: RatePackage) => p.items.reduce((a, b) => a + b.qty, 0);
  const priced = [...usable].sort((a, b) => (b.startingAt ?? 0) - (a.startingAt ?? 0) || pieces(b) - pieces(a));
  const full = priced[0];
  const entry = [...usable].sort((a, b) => (a.startingAt ?? Infinity) - (b.startingAt ?? Infinity))[0];
  const standard = priced.find((p) => p !== full && p !== entry) ?? null;
  const out: OfferOption[] = [];
  const fullUsage = full.startingAt ? quote(full.startingAt, { usageDays: 90 }, t) : null;
  out.push({ tier: "full", name: full.name, what: `${packageLabel(full.items)}, with 90 days of usage on your channels`, price: fullUsage ? fullUsage.total : null, onRequest: full.onRequest || !full.startingAt });
  if (standard) out.push({ tier: "standard", name: standard.name, what: packageLabel(standard.items), price: standard.onRequest ? null : standard.startingAt, onRequest: standard.onRequest || !standard.startingAt });
  if (entry !== full) out.push({ tier: "entry", name: entry.name, what: packageLabel(entry.items), price: entry.onRequest ? null : entry.startingAt, onRequest: entry.onRequest || !entry.startingAt });
  return out;
}

export interface CounterResult {
  verdict: "accept" | "counter" | "trim" | "walk" | "no_floor";
  counter: number | null;
  math: string[];
  /** One line she can paste: what to say. */
  line: string;
}

/**
 * Their number against her floor and target for the package. At or above target: accept.
 * Between: counter at target (anchor), say the arithmetic. Below floor: trade scope, not price
 * (fewer pieces at her per-piece floor), or walk away politely if not even one piece fits.
 */
export function counterOffer(their: number, pkg: Pick<RatePackage, "name" | "items" | "floor" | "target">): CounterResult {
  const pieces = pkg.items.reduce((a, b) => a + b.qty, 0) || 1;
  if (pkg.floor == null || pkg.target == null) {
    return { verdict: "no_floor", counter: null, math: [], line: "Set your floor and target for this package in your rate card, and this works out your counter." };
  }
  const { floor, target } = pkg;
  if (their >= target) {
    return { verdict: "accept", counter: their, math: [`${usd(their)} ≥ your target ${usd(target)}`], line: `${usd(their)} works for ${pkg.name}. Confirm usage and payment terms in writing, then say yes.` };
  }
  if (their >= floor) {
    const gapPct = Math.round(((target - their) / target) * 100);
    return {
      verdict: "counter",
      counter: target,
      math: [`Their ${usd(their)} is ${gapPct}% under your target ${usd(target)} and above your floor ${usd(floor)}.`, `Counter at your target: ${usd(target)}. If they can't move, ${usd(their)} is still above your floor.`],
      line: `For ${pkg.name} my rate is ${usd(target)}. If the budget is fixed at ${usd(their)}, I can keep it at that with usage limited to 30 days.`,
    };
  }
  const perPieceFloor = floor / pieces;
  const fits = Math.floor(their / perPieceFloor);
  if (fits >= 1 && fits < pieces) {
    return {
      verdict: "trim",
      counter: roundTo(perPieceFloor * fits, 5),
      math: [`Their ${usd(their)} is under your floor ${usd(floor)} for ${pieces} pieces.`, `Your floor per piece: ${usd(floor)} ÷ ${pieces} = ${usd(perPieceFloor)}. ${usd(their)} ÷ ${usd(perPieceFloor)} = ${(their / perPieceFloor).toFixed(1)}, so ${fits} ${fits === 1 ? "piece fits" : "pieces fit"}.`],
      line: `I can't do all ${pieces} pieces for ${usd(their)}, but I can do ${fits} for ${usd(roundTo(perPieceFloor * fits, 5))}. Trade the scope, not the price.`,
    };
  }
  return {
    verdict: "walk",
    counter: null,
    math: [`Their ${usd(their)} is under your floor ${usd(floor)}${pieces > 1 ? ` and under one piece at ${usd(perPieceFloor)}` : ""}.`],
    line: "This is below what you take for this work. Decline politely and leave the door open (the Decline email does it).",
  };
}

// ---------- engagement (for the kit), with its method named

export interface VideoStat {
  platform: Platform;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  posted_at: string | null;
}

/**
 * Engagement by views over the last 90 days: (likes + comments + shares + saves) ÷ views.
 * Null under 3 videos or no views: too little to state.
 */
export function engagementRate(videos: VideoStat[], platform: Platform, now: Date): { rate: number; videos: number } | null {
  const since = now.getTime() - 90 * 86400_000;
  const rows = videos.filter((v) => v.platform === platform && v.posted_at && new Date(v.posted_at).getTime() >= since && v.views > 0);
  if (rows.length < 3) return null;
  const views = rows.reduce((a, v) => a + v.views, 0);
  const acts = rows.reduce((a, v) => a + v.likes + v.comments + v.shares + v.saves, 0);
  return { rate: Math.round((acts / views) * 10000) / 100, videos: rows.length };
}

/** TikTok only, same method (by views) as the source; no comparison anywhere else. */
export function tiktokTypicalEngagement(followers: number): { rate: number; band: string; source: Source } | null {
  if (followers >= 1_000 && followers < 5_000) return { rate: 4.4, band: "1K–5K followers", source: SOURCES.socialinsiderTikTok };
  if (followers >= 5_000 && followers < 10_000) return { rate: 4.0, band: "5K–10K followers", source: SOURCES.socialinsiderTikTok };
  if (followers >= 10_000 && followers < 50_000) return { rate: 3.9, band: "10K–50K followers", source: SOURCES.socialinsiderTikTok };
  return null;
}

// ---------- negotiation scripts, one per lever (docs/reviews/agency-pov.md "How we negotiate")

export interface LeverScript {
  key: "price" | "usage" | "exclusivity" | "payment" | "revisions" | "rush";
  when: string;
  say: string;
  why: string;
}

/** What to say when they push on each lever. `t` fills her own terms into the lines. */
export function leverScripts(t: AddOnTerms): LeverScript[] {
  return [
    { key: "price", when: "They push on price", say: "I can meet that budget by trimming the scope: one video instead of two, and 30 days of usage instead of 90. The rate per video stays the same.", why: "Trade scope, not price. Your per-video rate is what the next brand hears about." },
    { key: "usage", when: "They want longer or wider usage", say: `My rate covers 30 days of reposting on your own channels. Longer usage is ${t.usagePctPer30d}% of the fee per extra 30 days, and ads from my handle are ${t.paidUsagePctPer30d}% per 30 days.`, why: "Usage is worth the most to them and costs you the least to give in a narrow form. Never perpetual." },
    { key: "exclusivity", when: "They ask for exclusivity", say: `Happy to hold the category for you: exclusivity is ${t.exclusivityPctPerMonth}% of the fee per month, for your direct competitors only, named in writing.`, why: "Exclusivity stops you earning from others, so it is always paid and always narrow." },
    { key: "payment", when: "They offer net-60 or longer", say: `My terms are net-${t.netDays}${t.upfrontPct ? `, with ${t.upfrontPct}% up front on projects over $${t.upfrontOver.toLocaleString("en-US")}` : ""}. Could your team do that?`, why: "Net-30 is the most common; longer terms are creeping in and cost you." },
    { key: "revisions", when: "They want more rounds of changes", say: `The fee includes ${t.revisionRounds} rounds of changes. Extra rounds, or a reshoot, are quoted separately.`, why: "Unlimited revisions is unpaid work." },
    { key: "rush", when: "They need it in under 7 days", say: t.rushPct ? `I can turn it around this week; a rush fee of ${t.rushPct}% applies under 7 days.` : "I can turn it around this week; for under 7 days I add a rush fee, so let me know your date and I'll confirm it.", why: "A rushed slot bumps other work; set your own rush fee on the rate card." },
  ];
}
