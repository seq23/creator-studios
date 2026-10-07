// "Brands to pitch this week" (owner, 26 Sep 2026: "an emphasis on finding brands to give you
// $$"): rank brands by expected money = budget signal × fit × reachability, with the arithmetic
// shown, never a dollar figure we cannot back. Brands with no evidence of paying creators are
// kept, below the line, as "unproven". A brand she declined or lost, hid, or that is on her
// off-limits list never comes back (the finder never stores an off-limits brand at all).

export type BudgetLevel = "paying" | "likely" | "unproven";
export interface Evidence {
  text: string;
  url: string;
}
export interface BudgetSignal {
  level: BudgetLevel;
  evidence: Evidence[];
}

/** Weights: how sure we are this brand spends on creators. */
export const BUDGET_WEIGHT: Record<BudgetLevel, number> = { paying: 1, likely: 0.6, unproven: 0.25 };
export const BUDGET_LABEL: Record<BudgetLevel, string> = {
  paying: "Pays creators",
  likely: "Has a creator program",
  unproven: "No sign yet that they pay",
};

const PARTNER_WORDS = ["partnerships", "partnership", "partners", "partner", "collab", "collabs", "collaborations", "influencer", "influencers", "creators", "creator", "ambassadors", "ambassador", "affiliates", "affiliate", "sponsorships", "sponsorship", "talent"];
const PR_WORDS = ["pr", "press", "media", "marketing", "brand", "brands", "social"];

export interface ContactLike {
  kind: "form" | "role_email" | "agency";
  value: string;
}

/** How likely a message reaches someone who can say yes. */
export function reachability(contacts: ContactLike[]): { weight: number; label: string } {
  let best = { weight: 0.2, label: "no contact yet" };
  for (const c of contacts) {
    let r = { weight: 0.6, label: "general inbox" };
    if (c.kind === "form") r = { weight: 0.9, label: "creator application form" };
    else if (c.kind === "agency") r = { weight: 0.8, label: "their agency" };
    else {
      const parts = c.value.split("@")[0].toLowerCase().split(/[._+-]/);
      if (parts.some((p) => PARTNER_WORDS.includes(p))) r = { weight: 1, label: "partnerships email" };
      else if (parts.some((p) => PR_WORDS.includes(p))) r = { weight: 0.85, label: "PR / marketing email" };
    }
    if (r.weight > best.weight) best = r;
  }
  return best;
}

export interface ProspectInput {
  id: string;
  name: string;
  kind: "brand" | "agency" | "local";
  fit: number; // 0–1
  budget: BudgetSignal;
  contacts: ContactLike[];
  status: "suggested" | "saved" | "hidden";
  dealStage: string | null;
}

export interface Ranked<T> {
  item: T;
  score: number;
  math: string;
  aboveLine: boolean;
}

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function expectedMoney(p: Pick<ProspectInput, "fit" | "budget" | "contacts">): { score: number; math: string } {
  const b = BUDGET_WEIGHT[p.budget.level];
  const reach = reachability(p.contacts);
  const fit = Math.max(0, Math.min(1, p.fit));
  const score = Math.round(b * fit * reach.weight * 100) / 100;
  return { score, math: `${BUDGET_LABEL[p.budget.level]} ${r2(b)} × fit ${r2(fit)} × ${reach.label} ${r2(reach.weight)} = ${r2(score)}` };
}

/**
 * Brands she can pitch now: not hidden, not already in a deal (pitched, replied, won, declined or
 * lost), ranked by expected money. "Paying" and "likely" sit above the line; "unproven" below it.
 * A "paying" level with no evidence link is treated as unproven (nothing without a source).
 */
export function rankProspects<T extends ProspectInput>(items: T[]): Ranked<T>[] {
  return items
    .filter((p) => p.status !== "hidden" && !p.dealStage)
    .map((p) => {
      const level: BudgetLevel = p.budget.level !== "unproven" && !p.budget.evidence.some((e) => /^https?:\/\//.test(e.url)) ? "unproven" : p.budget.level;
      const { score, math } = expectedMoney({ ...p, budget: { ...p.budget, level } });
      return { item: p, score, math, aboveLine: level !== "unproven" };
    })
    .sort((a, b) => Number(b.aboveLine) - Number(a.aboveLine) || b.score - a.score);
}

/** The per-brand mark on a card: where it stands with her. */
export function brandMark(stage: string | null): "new" | "pitched" | "replied" | "won" | "closed" {
  if (!stage || stage === "find_contact" || stage === "pitch") return "new";
  if (stage === "follow_up") return "pitched";
  if (stage === "negotiating") return "replied";
  if (stage === "declined" || stage === "lost") return "closed";
  return "won";
}

/** Normalise a finder budget signal: level must be known, evidence needs real links. */
export function cleanBudget(raw: unknown): BudgetSignal {
  const r = (raw && typeof raw === "object" ? raw : {}) as { level?: unknown; evidence?: unknown };
  const level: BudgetLevel = r.level === "paying" || r.level === "likely" ? r.level : "unproven";
  const evidence = (Array.isArray(r.evidence) ? r.evidence : [])
    .map((e) => ({ text: typeof (e as Evidence)?.text === "string" ? (e as Evidence).text.trim().slice(0, 200) : "", url: typeof (e as Evidence)?.url === "string" ? (e as Evidence).url.trim() : "" }))
    .filter((e) => e.text && /^https?:\/\/[^\s]+\.[^\s]+/.test(e.url))
    .slice(0, 4);
  return { level: evidence.length ? level : "unproven", evidence };
}
