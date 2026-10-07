// The deal pipeline a talent manager runs (worker/domain/deals.ts, prospects.ts, memo.ts,
// delivery.ts, crons/deals.ts) and the migration that moved every old deal onto it.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEAL_STAGES } from "@shared/constants";
import { byUrgency, canMove, moneyStrip, needsReason, nextAction, type DealContext } from "@worker/domain/deals";
import { brandMark, expectedMoney, rankProspects, reachability, type ProspectInput } from "@worker/domain/prospects";
import { EMPTY_TERMS, cleanTerms, memo } from "@worker/domain/memo";
import { EMPTY_DELIVERY, cleanDelivery, deliverySteps, invoiceDue, invoiceNumber, resultsFromStats } from "@worker/domain/delivery";
import { DEFAULT_ADDONS } from "@worker/domain/ratecard";
import { shouldRefreshBrands } from "@worker/crons/deals";

const NOW = new Date("2026-09-25T12:00:00.000Z");

describe("stage moves", () => {
  it("forward one step, back one step to undo, nothing else", () => {
    const allowed = (from: (typeof DEAL_STAGES)[number]) => DEAL_STAGES.filter((to) => canMove(from, to));
    expect(allowed("find_contact")).toEqual(["pitch", "declined", "lost"]);
    expect(allowed("pitch")).toEqual(["find_contact", "follow_up", "negotiating", "declined", "lost"]);
    expect(allowed("negotiating")).toEqual(["follow_up", "agreed", "declined", "lost"]);
    expect(allowed("invoiced")).toEqual(["delivering", "paid", "declined", "lost"]);
    expect(allowed("paid")).toEqual(["invoiced", "done"]);
    expect(allowed("done")).toEqual([]);
    expect(allowed("declined")).toEqual(["pitch", "negotiating"]);
  });
  it("closing a deal needs a reason; nothing else does", () => {
    expect(DEAL_STAGES.filter(needsReason)).toEqual(["declined", "lost"]);
  });
});

const ctx = (p: Partial<DealContext>): DealContext => ({
  stage: "pitch",
  kind: "brand",
  hasContact: true,
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
  pitchSentAt: null,
  followupsSent: 0,
  nextFollowupAt: null,
  hasOffer: false,
  confirmSent: false,
  delivery: { draftSentAt: null, approvedAt: null, postedAt: null, reportSentAt: null },
  draftBy: null,
  postBy: null,
  invoiceSentAt: null,
  invoiceDueAt: null,
  paidAt: null,
  deliveredAt: null,
  rebookSentAt: null,
  workedBefore: false,
  ...p,
});

describe("the one next action on every card", () => {
  it("names the email to send, and when", () => {
    expect(nextAction(ctx({ hasContact: false }), NOW)).toMatchObject({ label: "Find their contact", step: "add_contact", scenario: null });
    expect(nextAction(ctx({}), NOW)).toMatchObject({ label: "Send your pitch", scenario: "cold_pitch", overdue: true });
    expect(nextAction(ctx({ kind: "agency" }), NOW)).toMatchObject({ scenario: "agency_pitch" });
    expect(nextAction(ctx({ stage: "follow_up", pitchSentAt: "2026-09-10T12:00:00.000Z", followupsSent: 1, nextFollowupAt: "2026-09-22T12:00:00.000Z" }), NOW)).toMatchObject({ label: "Send follow-up 2", scenario: "followup_2", overdue: true });
    expect(nextAction(ctx({ stage: "follow_up", pitchSentAt: "2026-09-10T12:00:00.000Z", followupsSent: 2, nextFollowupAt: "2026-09-29T12:00:00.000Z" }), NOW)).toMatchObject({ label: "Send the last follow-up", scenario: "followup_3", overdue: false });
  });
  it("after 3 follow-ups with no reply: stop, and close as no reply 5 days after the last", () => {
    const n = nextAction(ctx({ stage: "follow_up", pitchSentAt: "2026-09-01T12:00:00.000Z", followupsSent: 3, nextFollowupAt: null }), NOW);
    expect(n).toMatchObject({ label: "No reply after 3 follow-ups", step: "close_no_reply", scenario: null, dueAt: "2026-09-25T12:00:00.000Z" });
  });
  it("runs delivery: draft, approval, post, day-7 report, invoice, reminder, thank-you, rebook at 30 days", () => {
    const d = { draftSentAt: null, approvedAt: null, postedAt: null, reportSentAt: null };
    expect(nextAction(ctx({ stage: "agreed" }), NOW)).toMatchObject({ scenario: "deliverables_confirm" });
    expect(nextAction(ctx({ stage: "delivering", confirmSent: true, draftBy: "2026-10-01T17:00:00.000Z", delivery: d }), NOW)).toMatchObject({ scenario: "draft_for_approval", dueAt: "2026-10-01T17:00:00.000Z" });
    expect(nextAction(ctx({ stage: "delivering", delivery: { ...d, draftSentAt: "2026-09-20T00:00:00.000Z", approvedAt: "2026-09-21T00:00:00.000Z", postedAt: "2026-09-22T00:00:00.000Z" } }), NOW)).toMatchObject({ scenario: "results_report", dueAt: "2026-09-29T00:00:00.000Z" });
    expect(nextAction(ctx({ stage: "invoiced", invoiceSentAt: "2026-09-01T00:00:00.000Z", invoiceDueAt: "2026-09-24T00:00:00.000Z" }), NOW)).toMatchObject({ scenario: "payment_reminder", overdue: true });
    expect(nextAction(ctx({ stage: "invoiced", invoiceSentAt: "2026-09-01T00:00:00.000Z", invoiceDueAt: "2026-10-24T00:00:00.000Z" }), NOW)).toMatchObject({ step: "mark_paid", scenario: null });
    expect(nextAction(ctx({ stage: "done", deliveredAt: "2026-09-01T00:00:00.000Z" }), NOW)).toMatchObject({ label: "Rebook them", scenario: "thank_you_rebook", dueAt: "2026-10-01T00:00:00.000Z" });
    expect(nextAction(ctx({ stage: "done", rebookSentAt: "2026-09-02T00:00:00.000Z" }), NOW).dueAt).toBeNull();
  });
  it("overdue rises to the top, then soonest due, closed deals last", () => {
    const item = (id: string, stage: DealContext["stage"], dueAt: string | null, overdue: boolean) => ({ id, stage, next: { label: id, detail: "", dueAt, overdue, scenario: null, step: null } });
    const sorted = byUrgency([item("later", "pitch", "2026-10-05T00:00:00Z", false), item("closed", "lost", null, false), item("old", "follow_up", "2026-09-01T00:00:00Z", true), item("newer", "invoiced", "2026-09-20T00:00:00Z", true), item("soon", "negotiating", "2026-09-26T00:00:00Z", false), item("none", "agreed", null, false)]);
    expect(sorted.map((s) => s.id)).toEqual(["old", "newer", "soon", "later", "none", "closed"]);
  });
});

describe("the money strip", () => {
  it("counts pitched this month, replies, won, dollars agreed and paid, average fee and why deals closed", () => {
    const m = moneyStrip(
      [
        { stage: "follow_up", fee: null, pitchedAt: "2026-09-03T00:00:00Z", repliedAt: null, agreedAt: null, paidAt: null, outcomeReason: null },
        { stage: "paid", fee: 900, pitchedAt: "2026-08-10T00:00:00Z", repliedAt: "2026-08-12T00:00:00Z", agreedAt: "2026-08-15T00:00:00Z", paidAt: "2026-09-10T00:00:00Z", outcomeReason: null },
        { stage: "delivering", fee: 500, pitchedAt: "2026-09-05T00:00:00Z", repliedAt: "2026-09-06T00:00:00Z", agreedAt: "2026-09-08T00:00:00Z", paidAt: null, outcomeReason: null },
        { stage: "lost", fee: null, pitchedAt: "2026-09-01T00:00:00Z", repliedAt: null, agreedAt: null, paidAt: null, outcomeReason: "No reply after 3 follow-ups" },
        { stage: "declined", fee: null, pitchedAt: null, repliedAt: "2026-09-02T00:00:00Z", agreedAt: null, paidAt: null, outcomeReason: "Budget too low" },
      ],
      NOW,
      "America/New_York",
    );
    // 1 Sep 00:00 UTC is still 31 Aug in New York: "this month" reads in her timezone.
    expect(m).toEqual({ pitchedThisMonth: 2, pitched: 4, replies: 3, replyRate: 50, won: 2, dollarsAgreed: 1400, dollarsPaid: 900, averageFee: 700, lostReasons: [{ reason: "No reply after 3 follow-ups", n: 1 }, { reason: "Budget too low", n: 1 }] });
  });
  it("an empty pipeline is zeros, never a made-up rate", () => {
    expect(moneyStrip([], NOW)).toMatchObject({ pitched: 0, replyRate: null, averageFee: null, dollarsAgreed: 0 });
  });
});

describe("brands to pitch: expected money, arithmetic shown", () => {
  const p = (x: Partial<ProspectInput>): ProspectInput => ({ id: "b", name: "B", kind: "brand", fit: 0.9, budget: { level: "paying", evidence: [{ text: "#ad post", url: "https://x.example/p" }] }, contacts: [{ kind: "role_email", value: "partnerships@b.example" }], status: "suggested", dealStage: null, ...x });
  it("score = budget signal × fit × reachability, with the working", () => {
    expect(expectedMoney(p({}))).toEqual({ score: 0.9, math: "Pays creators 1.00 × fit 0.90 × partnerships email 1.00 = 0.90" });
    expect(expectedMoney(p({ budget: { level: "likely", evidence: [] }, contacts: [{ kind: "role_email", value: "hello@b.example" }] })).math).toBe("Has a creator program 0.60 × fit 0.90 × general inbox 0.60 = 0.32");
    expect(reachability([])).toEqual({ weight: 0.2, label: "no contact yet" });
    expect(reachability([{ kind: "form", value: "https://b.example/apply" }, { kind: "role_email", value: "pr@b.example" }])).toEqual({ weight: 0.9, label: "creator application form" });
  });
  it("unproven sits below the line; a paying claim with no link is unproven; hidden and dealt-with brands never show", () => {
    const r = rankProspects([
      p({ id: "unproven", budget: { level: "unproven", evidence: [] }, fit: 1 }),
      p({ id: "claims", budget: { level: "paying", evidence: [{ text: "trust me", url: "" }] } }),
      p({ id: "pays", fit: 0.7 }),
      p({ id: "likely", budget: { level: "likely", evidence: [{ text: "program", url: "https://x.example/c" }] } }),
      p({ id: "hidden", status: "hidden" }),
      p({ id: "declined", dealStage: "declined" }),
      p({ id: "pitched", dealStage: "follow_up" }),
    ]);
    expect(r.map((x) => [x.item.id, x.aboveLine])).toEqual([
      ["pays", true],
      ["likely", true],
      ["unproven", false],
      ["claims", false],
    ]);
  });
  it("each brand carries its mark: new, pitched, replied, won, closed", () => {
    expect(["pitch", "follow_up", "negotiating", "delivering", "lost"].map(brandMark)).toEqual(["new", "pitched", "replied", "won", "closed"]);
  });
});

describe("the deal memo and its terms", () => {
  it("rejects nonsense, keeps dates in order, and fills her defaults", () => {
    expect(cleanTerms(EMPTY_TERMS, { fee: "lots" })).toEqual({ problem: "That fee does not look right." });
    expect(cleanTerms(EMPTY_TERMS, { draftBy: "2026-10-20", postBy: "2026-10-12" })).toEqual({ problem: "The draft date is after the posting date. Swap them." });
    const ok = cleanTerms(EMPTY_TERMS, { fee: "$1,200", usageDays: 90, exclusivityMonths: 1, exclusivityCategory: "candles", postBy: "2026-10-20" });
    expect("terms" in ok && ok.terms).toMatchObject({ fee: 1200, usageDays: 90, exclusivityMonths: 1, postBy: "2026-10-20" });
  });
  it("lays out who, what, money (with add-on arithmetic and the upfront share), rights and dates", () => {
    const next = { label: "x", detail: "", dueAt: null, overdue: false, scenario: null, step: null } as const;
    const m = memo({ brand: "Golden Hour", contact: "collabs@gh.example", kind: "brand", stage: "agreed", terms: { ...EMPTY_TERMS, fee: 1000, usageDays: 60, exclusivityMonths: 1, exclusivityCategory: "tableware", deliverables: "2 TikTok videos" }, addons: DEFAULT_ADDONS, next, paidAt: null, invoiceDueAt: null, postedAt: null });
    expect(m.money.lines.map((l) => [l.label, l.amount])).toEqual([["Base fee", 1000], ["Usage beyond 30 days (30 more days)", 300], ["Exclusivity, one category (1 month)", 250]]);
    expect(m.money.total).toBe(1550);
    expect(m.money.upfront).toBe(775);
    expect(m.rights).toEqual({ usage: "60 days of reposting on their channels", exclusivity: "1 month, tableware only" });
    expect(m.status).toBe("Agreed");
    expect(m.money.killFee).toBe("50% if they cancel after the brief is approved");
  });
});

describe("delivery", () => {
  it("steps have due dates from the terms; the report is due 7 days after posting", () => {
    const s = deliverySteps({ ...EMPTY_DELIVERY, draftSentAt: "2026-10-01T00:00:00.000Z", approvedAt: "2026-10-02T00:00:00.000Z", postedAt: "2026-10-05T00:00:00.000Z", adLabelOn: true, roundsUsed: 1 }, { draftBy: "2026-10-01", postBy: "2026-10-06", revisionRounds: 2 });
    expect(s.map((x) => [x.key, x.done])).toEqual([["brief", false], ["concept", false], ["draft", true], ["approved", true], ["posted", true], ["report", false]]);
    expect(s.find((x) => x.key === "report")!.dueAt).toBe("2026-10-12T00:00:00.000Z");
    expect(s.find((x) => x.key === "approved")!.label).toBe("Approved (1 of 2 rounds of changes used)");
  });
  it("refuses out-of-order steps and bad links", () => {
    expect(cleanDelivery(EMPTY_DELIVERY, { approvedAt: true }, "2026-10-01T00:00:00Z")).toEqual({ problem: "Send the draft before marking it approved." });
    expect(cleanDelivery({ ...EMPTY_DELIVERY, draftSentAt: "x" }, { postedAt: true }, "2026-10-01T00:00:00Z")).toEqual({ problem: "Get their approval before you post." });
    expect(cleanDelivery(EMPTY_DELIVERY, { postUrls: ["not a link"] }, "2026-10-01T00:00:00Z")).toEqual({ problem: "Paste the full link to the post, starting with https://." });
  });
  it("results come from Stats rows, summed, with the latest date; none until there is one", () => {
    expect(resultsFromStats([])).toBeNull();
    expect(resultsFromStats([{ views: 100, likes: 10, comments: 1, shares: 2, saves: 3, captured_at: "2026-10-01T00:00:00Z" }, { views: 50, likes: 5, comments: 0, shares: 0, saves: 1, captured_at: "2026-10-03T00:00:00Z" }])).toEqual({ posts: 2, views: 150, likes: 15, comments: 1, shares: 2, saves: 4, asOf: "2026-10-03T00:00:00Z" });
  });
  it("invoice numbers and due dates", () => {
    expect(invoiceNumber(7, new Date("2026-10-01T00:00:00Z"))).toBe("SB-2026-0007");
    expect(invoiceDue(new Date("2026-10-01T00:00:00Z"), 30)).toBe("2026-10-31T00:00:00.000Z");
  });
});

describe("daily brand refresh", () => {
  it("runs once a day after her profile is locked, and says why when it doesn't", () => {
    expect(shouldRefreshBrands(null, false, NOW)).toEqual({ run: false, why: "Waiting for a locked Brand Profile (Client Brain)." });
    expect(shouldRefreshBrands("2026-09-25T02:00:00.000Z", true, NOW).run).toBe(false);
    expect(shouldRefreshBrands("2026-09-24T12:00:00.000Z", true, NOW)).toEqual({ run: true, why: "Started the daily brand refresh." });
  });
});

describe("migration 0009 moves every old deal onto the new pipeline", () => {
  it("maps each old stage, keeps every row, and publishes a kit that was already live", () => {
    const db = new DatabaseSync(":memory:");
    const dir = path.resolve("migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0009")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    db.exec(`INSERT INTO brands (id, name) VALUES ('b1','A'),('b2','B'),('b3','C'),('b4','D'),('b5','E'),('b6','F'),('b7','G'),('b8','H');
      INSERT INTO brand_contacts (id, brand_id, kind, value, found_on_url) VALUES ('c2','b2','role_email','pr@b.example','https://b.example');
      INSERT INTO deals (id, brand_id, stage) VALUES ('d1','b1','found'),('d2','b2','drafted'),('d3','b3','sent'),('d4','b4','replied'),('d5','b5','negotiating'),('d6','b6','won'),('d7','b7','passed');
      INSERT INTO deals (id, brand_id, stage, deliverables) VALUES ('d8','b8','won','[{"id":"x"}]');
      INSERT INTO pitches (id, brand_id, subject, body, status, sent_at) VALUES ('p3','b3','s','b','sent','2026-09-01T00:00:00.000Z');
      UPDATE media_kit SET bio = 'Live bio', featured_clip_ids = '["c1"]' WHERE id = 1;`);
    for (const f of files.filter((x) => x >= "0009")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    const rows = db.prepare("SELECT id, stage, outcome_reason, pitched_at FROM deals ORDER BY id").all() as { id: string; stage: string; outcome_reason: string | null; pitched_at: string | null }[];
    expect(rows.map((r) => r.stage)).toEqual(["find_contact", "pitch", "follow_up", "negotiating", "negotiating", "agreed", "declined", "delivering"]);
    expect(rows[6].outcome_reason).toBe("Passed before the deals overhaul");
    expect(rows[2].pitched_at).toBe("2026-09-01T00:00:00.000Z");
    const v = db.prepare("SELECT version, content FROM media_kit_versions").all() as { version: number; content: string }[];
    expect(v).toHaveLength(1);
    expect(JSON.parse(v[0].content)).toMatchObject({ legacy: 1, bio: "Live bio", featured_clip_ids: ["c1"] });
    expect(() => db.exec("INSERT INTO deals (id, brand_id, stage) VALUES ('bad','b1','won')")).toThrow(/CHECK/);
  });
});
