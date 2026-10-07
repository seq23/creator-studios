// "Before you send": the checklist under every drafted email. One source for the Worker (it
// stores the result with the draft) and the screen (it re-checks as she edits). Each scenario in
// worker/domain/emails.ts names which of these it needs; the rest are not shown for it.

export const CHECKS = {
  rate: "Your rate or options are stated",
  deliverables: "The deliverables are named",
  timeline: "A date or timeline is given",
  usage: "Usage rights are covered",
  exclusivity: "Exclusivity is covered",
  payment: "Payment terms are stated",
  kit: "Your media kit link is in it",
} as const;
export type CheckKey = keyof typeof CHECKS;

export interface CheckResult {
  key: CheckKey;
  label: string;
  ok: boolean;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

const TESTS: Record<CheckKey, (t: string, kitUrl: string) => boolean> = {
  rate: (t) => /\$\s?\d/.test(t) || /rates? on request/i.test(t),
  deliverables: (t) => /\b(videos?|reels?|tiktoks?|stor(y|ies)|posts?|shorts?|integration|ugc|frames?)\b/i.test(t),
  timeline: (t) => new RegExp(`\\b(${MONTHS})\\b\\.? ?\\d{1,2}|\\b\\d{1,2}/\\d{1,2}\\b|\\bwithin \\d+ (days?|weeks?)|\\b(this|next) (week|month)|\\bby (monday|tuesday|wednesday|thursday|friday|the end of)|\\b\\d+ (days?|weeks?)\\b|\\bday \\d+`, "i").test(t),
  usage: (t) => /\busage\b|\brights\b|\blicen[cs]e\b|\brepost/i.test(t),
  exclusivity: (t) => /exclusiv/i.test(t),
  payment: (t) => /\bnet[- ]?\d+|\bpayment\b|\binvoice\b|\bupfront\b|\bup front\b|\bpaid within\b|\bdue\b/i.test(t),
  kit: (t, kit) => !!kit && t.includes(kit),
};

export function beforeYouSend(text: string, keys: readonly CheckKey[], kitUrl: string): CheckResult[] {
  return keys.map((key) => ({ key, label: CHECKS[key], ok: TESTS[key](text, kitUrl) }));
}
