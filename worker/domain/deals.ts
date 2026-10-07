// The deal pipeline (docs/reviews/agency-pov.md): which moves are allowed, the one next action
// on every card and when it is due, overdue first, the follow-up cadence (day 5, 12, 19, then
// stop), and the money strip. Pure; the routes store and read.
import { DEAL_STAGES, DEAL_STAGE_LABEL, type DealStage } from "@shared/constants";
import type { ScenarioKey } from "./emails";

export const STAGE_ORDER = DEAL_STAGES;
export const OPEN_STAGES: DealStage[] = ["find_contact", "pitch", "follow_up", "negotiating", "agreed", "delivering", "invoiced"];
export const CLOSED_STAGES: DealStage[] = ["declined", "lost"];
/** Stages that count as "won": money was agreed. */
export const WON_STAGES: DealStage[] = ["agreed", "delivering", "invoiced", "paid", "done"];

const FORWARD: Record<DealStage, DealStage[]> = {
  find_contact: ["pitch"],
  pitch: ["follow_up", "negotiating"], // sent; or they wrote first / replied at once
  follow_up: ["negotiating"],
  negotiating: ["agreed"],
  agreed: ["delivering"],
  delivering: ["invoiced"],
  invoiced: ["paid"],
  paid: ["done"],
  done: [],
  declined: [],
  lost: [],
};
const BACK: Partial<Record<DealStage, DealStage>> = {
  pitch: "find_contact",
  follow_up: "pitch",
  negotiating: "follow_up",
  agreed: "negotiating",
  delivering: "agreed",
  invoiced: "delivering",
  paid: "invoiced",
};

/**
 * One step forward (or the listed skips), one step back to undo a mistake, out to declined /
 * lost from any open stage (with a reason, see needsReason), and back in from declined / lost
 * to pitch or negotiating. Paid and done money is never "lost".
 */
export function canMove(from: DealStage, to: DealStage): boolean {
  if (from === to) return false;
  if (to === "declined" || to === "lost") return OPEN_STAGES.includes(from);
  if (from === "declined" || from === "lost") return to === "pitch" || to === "negotiating";
  return FORWARD[from].includes(to) || BACK[from] === to;
}

export function needsReason(to: DealStage): boolean {
  return to === "declined" || to === "lost";
}

// ---------- follow-ups: day 5, day 12, day 19 (the last, a gentle close), then stop

export const FOLLOWUP_DAYS = [5, 12, 19] as const;
/** After the last follow-up with no reply, the card asks to close it as "no reply" this many days later. */
export const CLOSE_AFTER_LAST_DAYS = 5;

export function nextFollowup(sentAt: string, followupsSent: number): string | null {
  if (followupsSent < 0 || followupsSent >= FOLLOWUP_DAYS.length) return null;
  return new Date(new Date(sentAt).getTime() + FOLLOWUP_DAYS[followupsSent] * 86400_000).toISOString();
}

/**
 * The weekly recap's follow-ups line: "Follow-ups due: <brand> (<date>), …" for every item due
 * in the coming week or already overdue; null when there is none, so the recap does not carry
 * an empty line. Dates read in her audience timezone.
 */
export function followupsDueLine(due: { brand: string; dueAt: string; what?: string }[], timeZone: string): string | null {
  if (!due.length) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const parts = [...due].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((d) => `${d.brand} (${d.what ? `${d.what}, ` : ""}${fmt.format(new Date(d.dueAt))})`);
  return `Deal emails due: ${parts.join(", ")}.`;
}

// ---------- the next action on a card

export interface DealContext {
  stage: DealStage;
  kind: "brand" | "agency" | "local";
  hasContact: boolean;
  createdAt: string;
  updatedAt: string;
  pitchSentAt: string | null;
  followupsSent: number;
  nextFollowupAt: string | null;
  hasOffer: boolean;
  confirmSent: boolean;
  delivery: { draftSentAt: string | null; approvedAt: string | null; postedAt: string | null; reportSentAt: string | null };
  draftBy: string | null;
  postBy: string | null;
  invoiceSentAt: string | null;
  invoiceDueAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  rebookSentAt: string | null;
  workedBefore: boolean;
}

export interface NextAction {
  /** What to do, in five words or so. */
  label: string;
  /** One line more. */
  detail: string;
  dueAt: string | null;
  overdue: boolean;
  /** The email that goes with it (the Write the email panel opens on this), or null. */
  scenario: ScenarioKey | null;
  /** A non-email step: the screen shows its button. */
  step: "add_contact" | "mark_sent" | "paste_offer" | "set_terms" | "delivery" | "make_invoice" | "mark_paid" | "close_no_reply" | "mark_done" | null;
}

const addDays = (iso: string, d: number) => new Date(new Date(iso).getTime() + d * 86400_000).toISOString();

export function nextAction(c: DealContext, now: Date): NextAction {
  const na = (label: string, detail: string, dueAt: string | null, scenario: ScenarioKey | null, step: NextAction["step"] = null): NextAction => ({
    label,
    detail,
    dueAt,
    overdue: !!dueAt && new Date(dueAt).getTime() < now.getTime(),
    scenario,
    step,
  });
  switch (c.stage) {
    case "find_contact":
      return na("Find their contact", "Add a public business email or their creator form. Then the pitch is ready.", null, null, "add_contact");
    case "pitch":
      if (!c.hasContact) return na("Find their contact", "Add a public business email or their creator form.", null, null, "add_contact");
      return na(c.kind === "agency" ? "Send your roster pitch" : c.workedBefore ? "Send your re-pitch" : "Send your pitch", "It's written. Open it in Gmail, send, then tap Mark sent.", c.createdAt, c.kind === "agency" ? "agency_pitch" : c.workedBefore ? "warm_repitch" : "cold_pitch", "mark_sent");
    case "follow_up": {
      if (c.nextFollowupAt && c.followupsSent < FOLLOWUP_DAYS.length) {
        const n = c.followupsSent;
        const scen: ScenarioKey = n === 0 ? "followup_1" : n === 1 ? "followup_2" : "followup_3";
        return na(n === 2 ? "Send the last follow-up" : `Send follow-up ${n + 1}`, `Day ${FOLLOWUP_DAYS[n]} after your pitch. If they reply first, tap They replied.`, c.nextFollowupAt, scen, "mark_sent");
      }
      const since = c.pitchSentAt ? addDays(c.pitchSentAt, FOLLOWUP_DAYS[FOLLOWUP_DAYS.length - 1] + CLOSE_AFTER_LAST_DAYS) : null;
      return na("No reply after 3 follow-ups", "Close it as \"no reply\"; you can re-pitch next season.", since, null, "close_no_reply");
    }
    case "negotiating":
      if (c.hasOffer) return na("Reply to their offer", "Your reply is written from their terms and your rate card.", addDays(c.updatedAt, 2), "inbound_reply", "paste_offer");
      return na("Send your rate proposal", "Three options from your rate card. Or paste what they sent.", addDays(c.updatedAt, 2), "rate_proposal", "paste_offer");
    case "agreed":
      if (!c.confirmSent) return na("Confirm the deal in writing", "Fee, dates, usage and payment in one email before you start.", addDays(c.updatedAt, 1), "deliverables_confirm", "set_terms");
      return na("Start making the content", "Add the dates they agreed; then tap Start delivery.", c.draftBy, null, "delivery");
    case "delivering":
      if (!c.delivery.draftSentAt) return na("Send your draft for approval", "Film, edit, then send the draft.", c.draftBy, "draft_for_approval", "delivery");
      if (!c.delivery.approvedAt) return na("Waiting on their approval", "When they approve, tick Approved. Two rounds of changes are included.", addDays(c.delivery.draftSentAt, 2), null, "delivery");
      if (!c.delivery.postedAt) return na("Post it with #ad", "Post by the agreed date with the paid-partnership label on.", c.postBy, null, "delivery");
      if (!c.delivery.reportSentAt) return na("Send their results", "Day 7 after posting: your real numbers from Stats.", addDays(c.delivery.postedAt, 7), "results_report", "delivery");
      return na("Send the invoice", "Make the invoice, then send it.", addDays(c.delivery.reportSentAt, 1), "invoice_send", "make_invoice");
    case "invoiced":
      if (!c.invoiceSentAt) return na("Send the invoice", "It's made; open it, then send the email.", c.updatedAt, "invoice_send", "make_invoice");
      if (c.invoiceDueAt && new Date(c.invoiceDueAt).getTime() < now.getTime()) return na("Payment is late: send a reminder", "Polite and specific. Tap Paid when the money lands.", c.invoiceDueAt, "payment_reminder", "mark_paid");
      return na("Wait for payment", "Tap Paid when the money lands.", c.invoiceDueAt, null, "mark_paid");
    case "paid":
      return na("Say thank you, then close it", "A thank-you that plants the next campaign.", addDays(c.paidAt ?? c.updatedAt, 2), "thank_you_rebook", "mark_done");
    case "done": {
      if (c.rebookSentAt) return na("Nothing to do", "Done and rebook note sent.", null, null);
      const at = addDays(c.deliveredAt ?? c.paidAt ?? c.updatedAt, 30);
      return na("Rebook them", "30 days after delivery: a thank-you with a next idea.", at, "thank_you_rebook");
    }
    default:
      return na("Closed", DEAL_STAGE_LABEL[c.stage], null, null);
  }
}

/** Overdue first (longest overdue on top), then soonest due, then undated by pipeline order. */
export function byUrgency<T extends { stage: DealStage; next: NextAction }>(items: T[]): T[] {
  const t = (x: T) => (x.next.dueAt ? new Date(x.next.dueAt).getTime() : Infinity);
  return [...items].sort((a, b) => {
    const ca = CLOSED_STAGES.includes(a.stage) ? 1 : 0;
    const cb = CLOSED_STAGES.includes(b.stage) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    if (a.next.overdue !== b.next.overdue) return a.next.overdue ? -1 : 1;
    if (t(a) !== t(b)) return t(a) - t(b);
    return STAGE_ORDER.indexOf(b.stage) - STAGE_ORDER.indexOf(a.stage);
  });
}

// ---------- the money strip + won/lost learning

export interface DealRow {
  stage: DealStage;
  fee: number | null;
  pitchedAt: string | null;
  repliedAt: string | null;
  agreedAt: string | null;
  paidAt: string | null;
  outcomeReason: string | null;
}

export interface MoneyStrip {
  pitchedThisMonth: number;
  pitched: number;
  replies: number;
  replyRate: number | null;
  won: number;
  dollarsAgreed: number;
  dollarsPaid: number;
  averageFee: number | null;
  lostReasons: { reason: string; n: number }[];
}

export function moneyStrip(rows: DealRow[], now: Date, timeZone = "UTC"): MoneyStrip {
  const month = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(new Date(iso));
  const thisMonth = month(now.toISOString());
  const pitched = rows.filter((r) => r.pitchedAt);
  const replies = rows.filter((r) => r.repliedAt);
  const won = rows.filter((r) => r.agreedAt && !CLOSED_STAGES.includes(r.stage));
  const fees = won.map((r) => r.fee).filter((f): f is number => typeof f === "number" && f > 0);
  const agreed = fees.reduce((a, b) => a + b, 0);
  const paid = rows.filter((r) => r.paidAt && typeof r.fee === "number").reduce((a, r) => a + (r.fee ?? 0), 0);
  const reasons = new Map<string, number>();
  for (const r of rows) if (CLOSED_STAGES.includes(r.stage) && r.outcomeReason) reasons.set(r.outcomeReason, (reasons.get(r.outcomeReason) ?? 0) + 1);
  return {
    pitchedThisMonth: pitched.filter((r) => month(r.pitchedAt!) === thisMonth).length,
    pitched: pitched.length,
    replies: replies.length,
    replyRate: pitched.length ? Math.round((replies.filter((r) => r.pitchedAt).length / pitched.length) * 100) : null,
    won: won.length,
    dollarsAgreed: agreed,
    dollarsPaid: paid,
    averageFee: fees.length ? Math.round(agreed / fees.length) : null,
    lostReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  };
}

/** Reasons offered when she closes a deal (she can type her own). */
export const DECLINE_REASONS = ["Budget too low", "Not a fit for my audience", "Terms I can't accept (usage, exclusivity, payment)", "No time this season"] as const;
export const LOST_REASONS = ["No reply after 3 follow-ups", "They said no", "They went with someone else", "Budget fell through"] as const;
