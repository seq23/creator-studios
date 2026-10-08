// Inbound offers (worker/domain/offers.ts): terms read from what the brand sent, red flags in
// plain English with the words that raised them, the qualifier's verdict, and the model's
// reading never trusted beyond the pasted text.
import { describe, expect, it } from "vitest";
import { extractTerms, mergeModelTerms, qualify, redFlags } from "@worker/domain/offers";

const GOOD = `Hi Sam,
We're launching our holiday stoneware and would love to partner. We'd like 2 TikTok videos and 1 Instagram Reel.
Our budget is $900 for the package. Posting by Oct 20, draft by Oct 12.
Usage: 30 days organic on our channels. Payment net-30 on invoice.
Best, Maya (Golden Hour Tableware)`;

const BAD = `Hello! Love your content. We'd love to send you free product in exchange for a post and 3 stories.
This is great exposure for your brand. We'll need usage rights in perpetuity across all media, and exclusivity with no other home brands for 6 months.
We also need rights to your name and likeness. Payment is net-90 after posting.`;

describe("reading their email", () => {
  it("pulls the fee, deliverables, usage, timing and payment terms", () => {
    const t = extractTerms(GOOD);
    expect(t.fee).toBe(900);
    expect(t.deliverables).toBe("2 TikTok videos, 1 Instagram Reel");
    expect(t.usage).toMatch(/30 days organic/);
    expect(t.timeline).toMatch(/Oct 20/);
    expect(t.netDays).toBe(30);
    expect(t.buyer).toBe("brand");
  });
  it("names the buyer: an agency writing for a client, a marketplace, or gifting", () => {
    expect(extractTerms("We represent a home brand. Our client has a $1,500 budget for 2 Reels.").buyer).toBe("agency");
    expect(extractTerms("You have a new invite on TikTok One for 1 video at $300.").buyer).toBe("platform");
    expect(extractTerms(BAD).buyer).toBe("gifting");
    expect(extractTerms(BAD).fee).toBeNull();
  });
  it("reads 1.5k and the largest pay figure near a pay word", () => {
    expect(extractTerms("Our product retails at $40. Our budget is $1.5k for one video.").fee).toBe(1500);
  });
});

describe("each term quotes only its own sentence", () => {
  it("a one-paragraph email is not quoted whole under every term", () => {
    const t = extractTerms("Hi Sam! We'd love 2 TikTok videos for our napkin launch. Our budget is $600. We need usage rights in perpetuity across all media. Payment is net-90 after posting.");
    expect(t.usage).toBe("We need usage rights in perpetuity across all media.");
    expect(t.payment).toBe("Payment is net-90 after posting.");
    expect(t.fee).toBe(600);
  });
  it("one sentence carrying several terms is split: each term quotes only its own clause (sample1, 7 Oct 2026)", () => {
    const t = extractTerms("Hi! We'd love 1 TikTok video for $500, usage rights for 12 months, net 60 payment. Exclusivity 6 months.");
    expect(t.usage).toBe("usage rights for 12 months");
    expect(t.payment).toBe("net 60 payment");
    expect(t.exclusivity).toBe("Exclusivity 6 months.");
    expect(t.fee).toBe(500);
    expect(t.netDays).toBe(60);
    const bad = extractTerms(BAD);
    expect(bad.usage).toBe("We'll need usage rights in perpetuity across all media");
    expect(bad.exclusivity).toBe("exclusivity with no other home brands for 6 months");
  });
  it("a sentence with one term is still quoted whole, commas and all", () => {
    expect(extractTerms("Usage rights for 30 days, paid social only.").usage).toBe("Usage rights for 30 days, paid social only.");
  });
});

describe("red flags, in plain English", () => {
  const flags = redFlags(BAD, extractTerms(BAD));
  const keys = flags.map((f) => f.key);
  it("catches perpetual usage, likeness, unpaid exclusivity, net-60+, gifting and exposure", () => {
    expect(keys).toEqual(expect.arrayContaining(["perpetual", "likeness", "exclusivity_unpaid", "late_pay", "unpaid_gifting", "exposure"]));
    expect(flags.find((f) => f.key === "late_pay")!.text).toBe("They pay net-90. Net-30 is normal; ask for net-30, or a part up front.");
  });
  it.each([
    ["Usage rights in perpetuity for this video.", "perpetual"],
    ["We'll need perpetual usage of the content.", "perpetual"],
    ["Unlimited usage on all our channels.", "perpetual"],
    ["Usage across all media, worldwide.", "perpetual"],
    ["We also need your name and likeness for ads.", "likeness"],
    ["This is a work for hire.", "content_ownership"],
    ["Great exposure for your brand!", "exposure"],
    ["Paid only if it performs above 10K views.", "pay_on_performance"],
  ])("each phrase is caught on its own: %s", (text, key) => {
    expect(redFlags(text, extractTerms(text)).map((f) => f.key)).toContain(key);
  });
  it("quotes the words that raised each flag", () => {
    expect(flags.find((f) => f.key === "perpetual")!.quote).toMatch(/in perpetuity across all media/);
    for (const f of flags) expect(f.quote.length).toBeGreaterThan(0);
  });
  it("a clean offer raises none; ownership and unlimited revisions are caught", () => {
    expect(redFlags(GOOD, extractTerms(GOOD))).toEqual([]);
    const more = redFlags("Fee $500. Unlimited revisions. This is a work for hire.", extractTerms("Fee $500."));
    expect(more.map((f) => f.key).sort()).toEqual(["content_ownership", "unlimited_revisions"]);
  });
});

describe("the verdict: worth a reply, counter, or decline", () => {
  const ctx = { offLimitsHit: null, themeHit: true, floor: 600, target: 900 };
  it("good money and clean terms: reply", () => {
    const v = qualify(extractTerms(GOOD), [], ctx);
    expect(v).toMatchObject({ verdict: "reply", scenario: "inbound_reply" });
    expect(v.scores).toEqual({ fit: 3, budget: 3, brief: 3, risk: 3 });
  });
  it("under target: counter, with the numbers in the reason", () => {
    const t = { ...extractTerms(GOOD), fee: 700 };
    expect(qualify(t, [], ctx)).toMatchObject({ verdict: "counter", scenario: "counter_offer", reason: "Their $700 is under your target ($900). Counter, or trade scope." });
  });
  it("a serious flag means fix the terms first, even when the money is right", () => {
    const t = extractTerms(GOOD);
    expect(qualify(t, [{ key: "perpetual", text: "They want to use your video forever or everywhere. Usage…", quote: "x" }], ctx)).toMatchObject({ verdict: "counter", scenario: "usage_clarify" });
  });
  it("off-limits, unpaid gifting, or under half the floor: decline", () => {
    expect(qualify(extractTerms(GOOD), [], { ...ctx, offLimitsHit: "alcohol" })).toMatchObject({ verdict: "decline", reason: 'It touches "alcohol", which is on your off-limits list.' });
    expect(qualify(extractTerms(BAD), redFlags(BAD, extractTerms(BAD)), ctx).verdict).toBe("decline");
    expect(qualify({ ...extractTerms(GOOD), fee: 250 }, [], ctx).verdict).toBe("decline");
  });
  it("no budget named: ask for the brief before giving a number", () => {
    expect(qualify({ ...extractTerms(GOOD), fee: null }, [], ctx)).toMatchObject({ verdict: "reply", scenario: "ask_brief" });
  });
});

describe("the model's reading is never trusted beyond their words", () => {
  const rules = extractTerms("Hi! We'd love a video. Budget to be discussed.");
  it("keeps a fee only if it appears in the pasted email", () => {
    expect(mergeModelTerms("Our budget is $750.", rules, { fee: 750 }).fee).toBe(750);
    expect(mergeModelTerms("Hi! We'd love a video.", rules, { fee: 5000 }).fee).toBeNull();
  });
  it("keeps a term only when its words are in the email", () => {
    expect(mergeModelTerms("Usage for ninety days on paid social.", rules, { usage: "ninety days paid social" }).usage).toBe("ninety days paid social");
    expect(mergeModelTerms("Hi! We'd love a video.", rules, { usage: "perpetual worldwide license" }).usage).toBeNull();
    expect(mergeModelTerms("x", rules, "not an object")).toEqual(rules);
  });
});
