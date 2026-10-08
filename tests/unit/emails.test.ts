// "Write the email" (worker/domain/emails.ts): every scenario has a starter template that uses
// real facts only, three subject lines, the right "before you send" checks, and never states a
// dollar figure that is not in the facts. The validator `mediakit-deals` fails the build if a
// scenario key in SCENARIOS is missing from the SCENARIO_TESTS table below.
import { describe, expect, it } from "vitest";
import { SCENARIOS, SCENARIO_KEYS, toBrand, allowedAmounts, amountsIn, emailPrompt, numbersLine, parseEmail, starterEmail, suggestedScenario, type EmailFacts, type ScenarioKey } from "@worker/domain/emails";
import { beforeYouSend } from "@shared/emailcheck";

const KIT = "https://samplestudio.example/kit/studio";

function facts(p: Partial<EmailFacts> = {}): EmailFacts {
  return {
    creatorName: "Sam Creator",
    voice: "Warm, gracious, a little playful; short sentences; never salesy.",
    themes: ["Table styling", "Easy entertaining"],
    audience: "Women 30-55 in the US who love hosting.",
    brand: { name: "Golden Hour Tableware", kind: "brand", contactFirstName: "Maya", herPick: false, product: null },
    research: [{ text: "Their new stoneware line launched this month", url: "https://goldenhour.example/new" }],
    numbers: [
      { platform: "TikTok", followers: 12_400, avgViews: 3_100, asOf: "2026-09-24T12:00:00.000Z" },
      { platform: "Instagram", followers: 8_200, avgViews: 1_900, asOf: "2026-09-24T12:00:00.000Z" },
    ],
    engagementLine: "4.1% of TikTok viewers like, comment, share or save.",
    kitUrl: KIT,
    clipLinks: ["https://samplestudio.example/media/abc"],
    idea: "a 30-second Sunday brunch reset using your stoneware",
    options: [
      { tier: "full", name: "3-video bundle", what: "2 × TikTok video + Instagram Reel, with 90 days of usage on your channels", price: 1200, onRequest: false },
      { tier: "standard", name: "1 TikTok video", what: "TikTok video", price: 350, onRequest: false },
      { tier: "entry", name: "UGC", what: "Video for their channels (no post from you)", price: 180, onRequest: false },
    ],
    offer: { name: "1 TikTok video", what: "TikTok video", price: 350 },
    terms: { fee: 900, deliverables: "2 TikTok videos + 1 Instagram Reel", postBy: "2026-10-20", draftBy: "2026-10-12", usage: "30 days of reposting on their channels", exclusivity: "None", netDays: 30, upfrontPct: 50, upfrontOver: 1000, killFeePct: 50, revisionRounds: 2 },
    theirs: { fee: 600, deliverables: "2 TikTok videos", usage: null, exclusivity: null, payment: "net-60", timeline: "post by Oct 20" },
    counter: { amount: 900, line: "For the bundle my rate is $900. If the budget is fixed at $600, I can keep it at that with usage limited to 30 days." },
    invoice: { number: "SB-2026-0001", amount: 900, dueAt: "2026-11-20T00:00:00.000Z", link: null },
    results: { posts: 2, views: 48_200, likes: 3_100, comments: 140, shares: 220, saves: 1_150, asOf: "2026-10-27T12:00:00.000Z" },
    declineReason: "The budget is below what I take for this work",
    today: "2026-09-25",
    ...p,
  };
}

/** One row per scenario: a phrase its starter must contain (the heart of that email). */
const SCENARIO_TESTS: Record<ScenarioKey, RegExp> = {
  cold_pitch: /My idea: a 30-second Sunday brunch reset/,
  agency_pitch: /on your list when your brands need/,
  warm_repitch: /new idea for you/,
  followup_1: /Floating this back up/,
  followup_2: /next 4 weeks/,
  followup_3: /close the loop/,
  inbound_reply: /To make sure I have it right: deliverables: 2 TikTok videos; fee: \$600; timing: post by Oct 20/,
  ask_brief: /What budget range are you working with\?/,
  rate_proposal: /Full: 2 × TikTok video \+ Instagram Reel, with 90 days of usage on your channels, \$1,200/,
  counter_offer: /my rate is \$900/,
  usage_clarify: /I don't grant perpetual rights/,
  decline: /The budget is below what I take for this work, so I'll pass/,
  deliverables_confirm: /Fee: \$900\nDraft to you by: Oct 12; posting by: Oct 20/,
  draft_for_approval: /round 1 of 2/,
  results_report: /48,200 views, 3,100 likes, 140 comments, 220 shares, 1,150 saves \(as of Oct 27\)/,
  invoice_send: /Invoice SB-2026-0001: \$900, due Nov 20 \(net-30\)/,
  payment_reminder: /invoice SB-2026-0001 for \$900 was due Nov 20/,
  thank_you_rebook: /For next time: a 30-second Sunday brunch reset/,
};

describe("every scenario has a template, and each one is tested", () => {
  it("the test table covers every scenario and nothing else", () => {
    expect(Object.keys(SCENARIO_TESTS).sort()).toEqual([...SCENARIO_KEYS].sort());
    expect(SCENARIO_KEYS.length).toBeGreaterThanOrEqual(15);
  });
  it.each(SCENARIO_KEYS)("%s: three subjects, a body with its key line, signed by her", (key) => {
    const e = starterEmail(key, facts());
    expect(e.subjects).toHaveLength(3);
    expect(new Set(e.subjects).size).toBe(3);
    for (const s of e.subjects) expect(s.length).toBeLessThanOrEqual(120);
    expect(e.subject).toBe(e.subjects[0]);
    expect(e.body).toMatch(SCENARIO_TESTS[key]);
    expect(e.body.trim().endsWith("Sam")).toBe(true);
    expect(e.body).not.toMatch(/undefined|null|NaN|\[object/);
    expect(SCENARIOS[key].label.length).toBeGreaterThan(3);
    expect(SCENARIOS[key].when.length).toBeGreaterThan(10);
  });
  it.each(SCENARIO_KEYS)("%s: never states money the facts don't hold, in any tone or length", (key) => {
    const f = facts();
    const allowed = allowedAmounts(f);
    for (const tone of ["warm", "straight", "short"] as const)
      for (const length of ["brief", "standard", "detailed"] as const) {
        const e = starterEmail(key, f, tone, length);
        for (const n of amountsIn(`${e.subject} ${e.body}`)) expect(allowed.has(n), `${key}/${tone}/${length}: $${n}`).toBe(true);
      }
  });
  it.each(SCENARIO_KEYS)("%s: passes its own before-you-send checks with full facts", (key) => {
    const e = starterEmail(key, facts(), "warm", "detailed");
    const failed = beforeYouSend(`${e.subject}\n${e.body}`, SCENARIOS[key].checks, KIT).filter((c) => !c.ok);
    expect(failed.map((c) => c.key)).toEqual([]);
  });
});

describe("real facts only", () => {
  it("with no numbers and no rate card, the pitch says rates on request and invents nothing", () => {
    const e = starterEmail("cold_pitch", facts({ numbers: [], options: null, engagementLine: null, research: [], idea: null }));
    expect(e.body).toMatch(/Rates on request/);
    expect(e.body).not.toMatch(/followers/);
    expect(amountsIn(e.body)).toEqual([]);
    expect(e.body).toContain(KIT);
  });
  it("only says she uses the product when it is a brand she listed", () => {
    expect(starterEmail("cold_pitch", facts()).body).not.toMatch(/already part of how I work/);
    expect(starterEmail("cold_pitch", facts({ brand: { ...facts().brand, herPick: true } })).body).toMatch(/already part of how I work/);
  });
  it("her numbers carry their as-of date", () => {
    expect(numbersLine(facts())).toBe("12.4K followers on TikTok (about 3.1K views a video) and 8.2K followers on Instagram (about 1.9K views a video), as of Sep 24");
  });
  it("the reply to an offer asks only for what their email left out", () => {
    const body = starterEmail("inbound_reply", facts()).body;
    expect(body).toMatch(/how long and where you'd like to use the content/);
    expect(body).toMatch(/whether you need exclusivity/);
    expect(body).not.toMatch(/Could you share[^?]*the budget/);
  });
  it("terms quoted from their email never end the restatement on a double stop (sample1, 7 Oct 2026)", () => {
    const body = starterEmail("inbound_reply", facts({ theirs: { fee: 500, deliverables: "1 TikTok video", usage: "Usage for 12 months.", exclusivity: null, payment: "Payment is net-60 after posting.", timeline: null } })).body;
    expect(body).toContain("usage: Usage for 12 months; payment: Payment is net-60 after posting.");
    expect(body).not.toMatch(/\.\./);
    expect(body).not.toMatch(/\.;/);
  });
  it("tone and length change the draft: short is shorter than detailed", () => {
    const short = starterEmail("cold_pitch", facts(), "short", "brief").body;
    const long = starterEmail("cold_pitch", facts(), "warm", "detailed").body;
    expect(short.length).toBeLessThan(long.length);
    expect(long).toContain("https://samplestudio.example/media/abc");
    expect(short).not.toContain("https://samplestudio.example/media/abc");
    expect(long.endsWith("Warmly,\nSam")).toBe(true);
  });
  it("an agency gets the roster pitch; the first pitch names what we found about the brand", () => {
    expect(starterEmail("agency_pitch", facts({ brand: { ...facts().brand, kind: "agency" } })).body).toMatch(/12.4K followers on TikTok/);
    expect(starterEmail("cold_pitch", facts({ idea: null, brand: { ...facts().brand, herPick: false } })).body).toMatch(/I noticed your new stoneware line launched this month/);
  });
});

describe("a finder note, turned to speak to the brand", () => {
  it("their/you become your/I, keeping capitals", () => {
    expect(toBrand("Their new stoneware line is shot on brunch tables like yours")).toBe("Your new stoneware line is shot on brunch tables like mine");
    expect(toBrand("They sponsored 3 creators your size")).toBe("You sponsored 3 creators my size");
  });
});

describe("the AI draft is checked before it is used", () => {
  const f = facts();
  it("refused if it drops the kit link where the email needs it", () => {
    expect(parseEmail(JSON.stringify({ subjects: ["A"], body: "Hi Maya, here is my pitch with no link at all, thanks." }), "cold_pitch", f)).toBeNull();
  });
  it("refused if it states a dollar figure the facts don't hold", () => {
    expect(parseEmail(JSON.stringify({ subjects: ["A"], body: `Hi Maya, my rate is $2,500 for this. ${KIT}` }), "cold_pitch", f)).toBeNull();
    expect(parseEmail(JSON.stringify({ subjects: ["A"], body: `Hi Maya, my rate is $1.5k. ${KIT}` }), "cold_pitch", f)).toBeNull();
  });
  it("accepted with its own subjects first, topped up to three from the starter", () => {
    const ok = parseEmail(`Sure! {"subjects":["Brunch with Golden Hour"],"body":"Hi Maya, the bundle is $1,200. ${KIT}"}`, "cold_pitch", f)!;
    expect(ok.subjects).toHaveLength(3);
    expect(ok.subject).toBe("Brunch with Golden Hour");
  });
  it("the prompt carries the tone, the length and the no-invention rule", () => {
    const p = emailPrompt("counter_offer", f, "short", "brief");
    expect(p.system).toMatch(/very short/);
    expect(p.system).toMatch(/under 70 words/);
    expect(p.system).toMatch(/never invent a number, a dollar amount/);
    expect(JSON.parse(p.user).kitUrl).toBe(KIT);
  });
});

describe("before you send", () => {
  it("flags each missing item by name", () => {
    const r = beforeYouSend("Hi, love your brand!", ["rate", "deliverables", "timeline", "usage", "exclusivity", "payment", "kit"], KIT);
    expect(r.filter((c) => !c.ok).map((c) => c.key)).toEqual(["rate", "deliverables", "timeline", "usage", "exclusivity", "payment", "kit"]);
    const ok = beforeYouSend(`One TikTok video for $400 by Oct 12, 30 days usage, no exclusivity, net-30. ${KIT}`, ["rate", "deliverables", "timeline", "usage", "exclusivity", "payment", "kit"], KIT);
    expect(ok.every((c) => c.ok)).toBe(true);
  });
});

describe("which email comes next", () => {
  const base = { kind: "brand" as const, followupsSent: 0, hasOffer: false, invoiceOverdue: false, delivered: false, paid: false, workedBefore: false };
  it("follows the pipeline", () => {
    expect(suggestedScenario("pitch", base)).toBe("cold_pitch");
    expect(suggestedScenario("pitch", { ...base, kind: "agency" })).toBe("agency_pitch");
    expect(suggestedScenario("pitch", { ...base, workedBefore: true })).toBe("warm_repitch");
    expect(suggestedScenario("follow_up", { ...base, followupsSent: 2 })).toBe("followup_3");
    expect(suggestedScenario("negotiating", { ...base, hasOffer: true })).toBe("inbound_reply");
    expect(suggestedScenario("negotiating", base)).toBe("rate_proposal");
    expect(suggestedScenario("delivering", { ...base, delivered: true })).toBe("results_report");
    expect(suggestedScenario("invoiced", { ...base, invoiceOverdue: true })).toBe("payment_reminder");
    expect(suggestedScenario("done", base)).toBe("thank_you_rebook");
  });
});
