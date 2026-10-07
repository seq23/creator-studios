// Delivery on a won deal (docs/reviews/agency-pov.md "How we run delivery"): the checklist a
// manager runs from brief to paid, the approval rounds, and the day-7 results that come from her
// real Stats numbers (never typed-in guesses).

export interface DeliveryState {
  briefReceivedAt: string | null;
  conceptOkAt: string | null;
  draftSentAt: string | null;
  roundsUsed: number;
  approvedAt: string | null;
  postedAt: string | null;
  postUrls: string[];
  adLabelOn: boolean;
  reportSentAt: string | null;
  rebookSentAt: string | null;
  invoiceSentAt: string | null;
}

export const EMPTY_DELIVERY: DeliveryState = { briefReceivedAt: null, conceptOkAt: null, draftSentAt: null, roundsUsed: 0, approvedAt: null, postedAt: null, postUrls: [], adLabelOn: false, reportSentAt: null, rebookSentAt: null, invoiceSentAt: null };

export type DeliveryStepKey = "brief" | "concept" | "draft" | "approved" | "posted" | "report";
export interface DeliveryStep {
  key: DeliveryStepKey;
  label: string;
  done: boolean;
  doneAt: string | null;
  dueAt: string | null;
  hint: string;
}

const add = (iso: string | null, d: number) => (iso ? new Date(new Date(iso).getTime() + d * 86400_000).toISOString() : null);
const day = (d: string | null) => (d ? `${d}T17:00:00.000Z` : null);

export function deliverySteps(s: DeliveryState, t: { draftBy: string | null; postBy: string | null; revisionRounds: number }): DeliveryStep[] {
  return [
    { key: "brief", label: "Brief received", done: !!s.briefReceivedAt, doneAt: s.briefReceivedAt, dueAt: null, hint: "Their written brief: key message, do's and don'ts, product, links." },
    { key: "concept", label: "Idea agreed", done: !!s.conceptOkAt, doneAt: s.conceptOkAt, dueAt: null, hint: "One line on the idea, agreed in writing before you film." },
    { key: "draft", label: "Draft sent for approval", done: !!s.draftSentAt, doneAt: s.draftSentAt, dueAt: day(t.draftBy), hint: "Send the draft with the date you need feedback by." },
    { key: "approved", label: `Approved (${s.roundsUsed} of ${t.revisionRounds} rounds of changes used)`, done: !!s.approvedAt, doneAt: s.approvedAt, dueAt: add(s.draftSentAt, 2), hint: "More rounds than agreed are paid extra." },
    { key: "posted", label: "Posted with #ad and the paid-partnership label", done: !!s.postedAt && s.adLabelOn, doneAt: s.postedAt, dueAt: day(t.postBy), hint: "Turn on the platform's paid-partnership label when it posts." },
    { key: "report", label: "Results sent (day 7)", done: !!s.reportSentAt, doneAt: s.reportSentAt, dueAt: add(s.postedAt, 7), hint: "Your real numbers from Stats, 7 days after posting." },
  ];
}

export function cleanDelivery(prev: DeliveryState, patch: unknown, now: string): { state: DeliveryState } | { problem: string } {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const s: DeliveryState = { ...EMPTY_DELIVERY, ...prev };
  const stamp = (k: keyof DeliveryState) => {
    if (!(k in p)) return;
    (s as unknown as Record<string, unknown>)[k] = p[k] ? (typeof p[k] === "string" && !Number.isNaN(Date.parse(p[k] as string)) ? new Date(p[k] as string).toISOString() : now) : null;
  };
  for (const k of ["briefReceivedAt", "conceptOkAt", "draftSentAt", "approvedAt", "postedAt", "reportSentAt", "rebookSentAt", "invoiceSentAt"] as const) stamp(k);
  if ("roundsUsed" in p) {
    const n = Number(p.roundsUsed);
    if (!Number.isInteger(n) || n < 0 || n > 20) return { problem: "Rounds of changes must be a whole number." };
    s.roundsUsed = n;
  }
  if ("adLabelOn" in p) s.adLabelOn = !!p.adLabelOn;
  if ("postUrls" in p) {
    const urls = (Array.isArray(p.postUrls) ? p.postUrls : []).map(String).map((u) => u.trim()).filter(Boolean);
    if (urls.some((u) => !/^https?:\/\/[^\s]+\.[^\s]+$/.test(u))) return { problem: "Paste the full link to the post, starting with https://." };
    s.postUrls = urls.slice(0, 6);
  }
  if (s.approvedAt && !s.draftSentAt) return { problem: "Send the draft before marking it approved." };
  if (s.postedAt && !s.approvedAt) return { problem: "Get their approval before you post." };
  return { state: s };
}

export interface VideoResult {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  captured_at: string;
}

/** Day-7 results from her Stats rows for the deal's posts; null until there is at least one. */
export function resultsFromStats(rows: VideoResult[]): { posts: number; views: number; likes: number; comments: number; shares: number; saves: number; asOf: string } | null {
  if (!rows.length) return null;
  const sum = (k: keyof Omit<VideoResult, "captured_at">) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  return { posts: rows.length, views: sum("views"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"), asOf: rows.map((r) => r.captured_at).sort().at(-1)! };
}

// ---------- invoice

export function invoiceNumber(seq: number, issued: Date): string {
  return `SB-${issued.getUTCFullYear()}-${String(seq).padStart(4, "0")}`;
}

export function invoiceDue(issued: Date, netDays: number): string {
  return new Date(issued.getTime() + netDays * 86400_000).toISOString();
}
