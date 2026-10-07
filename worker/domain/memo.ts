// The deal memo a talent manager keeps (docs/reviews/agency-pov.md "What the manager keeps"):
// one screen per deal: who, what, money, dates, rights, status, next step. DealTerms is what
// she fills in (or what an inbound offer and her rate card pre-fill); memo() lays it out.
import { DEAL_STAGE_LABEL, type DealStage } from "@shared/constants";
import { quote, type AddOnTerms, type QuoteLine } from "./ratecard";
import type { NextAction } from "./deals";

export interface DealTerms {
  fee: number | null;
  packageId: string | null;
  deliverables: string | null;
  usageDays: number;
  paidUsageDays: number;
  exclusivityMonths: number;
  exclusivityCategory: string | null;
  rush: boolean;
  netDays: number | null;
  upfrontPct: number | null;
  killFeePct: number | null;
  revisionRounds: number | null;
  briefBy: string | null;
  draftBy: string | null;
  postBy: string | null;
  contactName: string | null;
  buyer: "brand" | "agency" | "platform" | null;
  idea: string | null;
}

export const EMPTY_TERMS: DealTerms = { fee: null, packageId: null, deliverables: null, usageDays: 30, paidUsageDays: 0, exclusivityMonths: 0, exclusivityCategory: null, rush: false, netDays: null, upfrontPct: null, killFeePct: null, revisionRounds: null, briefBy: null, draftBy: null, postBy: null, contactName: null, buyer: null, idea: null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Merge a patch over stored terms; returns a problem sentence on bad input. */
export function cleanTerms(prev: DealTerms, patch: unknown): { terms: DealTerms } | { problem: string } {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const t: DealTerms = { ...EMPTY_TERMS, ...prev };
  const num = (k: keyof DealTerms, min: number, max: number, allowNull = true) => {
    if (!(k in p)) return null;
    const v = p[k];
    if ((v === null || v === "") && allowNull) {
      (t as unknown as Record<string, unknown>)[k] = null;
      return null;
    }
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < min || n > max) return `That ${String(k).replace(/([A-Z])/g, " $1").toLowerCase()} does not look right.`;
    (t as unknown as Record<string, unknown>)[k] = Math.round(n);
    return null;
  };
  const problems = [num("fee", 0, 1_000_000), num("usageDays", 0, 3650, false), num("paidUsageDays", 0, 3650, false), num("exclusivityMonths", 0, 36, false), num("netDays", 0, 180), num("upfrontPct", 0, 100), num("killFeePct", 0, 100), num("revisionRounds", 0, 10)].filter(Boolean);
  if (problems.length) return { problem: problems[0]! };
  for (const k of ["briefBy", "draftBy", "postBy"] as const) {
    if (!(k in p)) continue;
    const v = p[k];
    if (v === null || v === "") t[k] = null;
    else if (typeof v === "string" && DAY.test(v)) t[k] = v;
    else return { problem: "Pick a date." };
  }
  for (const [k, max] of [["deliverables", 300], ["exclusivityCategory", 60], ["contactName", 60], ["idea", 300], ["packageId", 40]] as const) {
    if (!(k in p)) continue;
    const v = p[k];
    t[k] = typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  }
  if ("rush" in p) t.rush = !!p.rush;
  if ("buyer" in p) t.buyer = p.buyer === "brand" || p.buyer === "agency" || p.buyer === "platform" ? p.buyer : null;
  if (t.draftBy && t.postBy && t.draftBy > t.postBy) return { problem: "The draft date is after the posting date. Swap them." };
  return { terms: t };
}

/** Terms with her rate-card defaults filled in where the deal leaves them blank. */
export function effectiveTerms(t: DealTerms, a: AddOnTerms): DealTerms & { netDays: number; upfrontPct: number; killFeePct: number; revisionRounds: number } {
  return { ...t, netDays: t.netDays ?? a.netDays, upfrontPct: t.upfrontPct ?? a.upfrontPct, killFeePct: t.killFeePct ?? a.killFeePct, revisionRounds: t.revisionRounds ?? a.revisionRounds };
}

export function usageText(t: DealTerms): string {
  const parts = [`${t.usageDays} days of reposting on their channels`];
  if (t.paidUsageDays) parts.push(`${t.paidUsageDays} days of paid ads from your handle`);
  return parts.join("; ");
}
export function exclusivityText(t: DealTerms): string {
  return t.exclusivityMonths ? `${t.exclusivityMonths} ${t.exclusivityMonths === 1 ? "month" : "months"}${t.exclusivityCategory ? `, ${t.exclusivityCategory} only` : ", one category"}` : "None";
}

export interface Memo {
  who: { brand: string; contact: string | null; buyer: string };
  what: string;
  money: { base: number | null; lines: QuoteLine[]; total: number | null; upfront: number | null; killFee: string; paid: boolean };
  dates: { label: string; value: string | null }[];
  rights: { usage: string; exclusivity: string };
  status: string;
  next: NextAction;
}

export function memo(input: { brand: string; contact: string | null; kind: string; stage: DealStage; terms: DealTerms; addons: AddOnTerms; next: NextAction; paidAt: string | null; invoiceDueAt: string | null; postedAt: string | null }): Memo {
  const t = effectiveTerms(input.terms, input.addons);
  const q = t.fee != null ? quote(t.fee, { usageDays: t.usageDays, paidUsageDays: t.paidUsageDays, exclusivityMonths: t.exclusivityMonths, rush: t.rush }, input.addons) : null;
  const total = q ? q.total : null;
  return {
    who: { brand: input.brand, contact: t.contactName ?? input.contact, buyer: t.buyer ?? input.kind },
    what: t.deliverables ?? "Not agreed yet",
    money: {
      base: t.fee,
      lines: q ? q.lines : [],
      total,
      upfront: total != null && total >= input.addons.upfrontOver ? Math.round((total * t.upfrontPct) / 100) : null,
      killFee: `${t.killFeePct}% if they cancel after the brief is approved`,
      paid: !!input.paidAt,
    },
    dates: [
      { label: "Brief by", value: t.briefBy },
      { label: "Draft to them by", value: t.draftBy },
      { label: "Post by", value: t.postBy },
      { label: "Posted", value: input.postedAt ? input.postedAt.slice(0, 10) : null },
      { label: "Invoice due", value: input.invoiceDueAt ? input.invoiceDueAt.slice(0, 10) : null },
      { label: "Paid", value: input.paidAt ? input.paidAt.slice(0, 10) : null },
    ],
    rights: { usage: usageText(t), exclusivity: exclusivityText(t) },
    status: DEAL_STAGE_LABEL[input.stage],
    next: input.next,
  };
}
