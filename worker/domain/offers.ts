// Inbound offers (docs/reviews/agency-pov.md "How we qualify inbound"): she pastes what a brand
// sent; this reads the terms (rules here, the model on top when it is on), lists red flags in
// plain English, and scores the offer (fit, budget, brief quality, risk) into one verdict:
// worth a reply / counter / decline, with the reason. Every extracted term is labelled "from
// their email" on screen; nothing here is trusted silently: a model's figure that does not
// appear in the pasted text is dropped.

export interface OfferTerms {
  fee: number | null;
  deliverables: string | null;
  usage: string | null;
  exclusivity: string | null;
  timeline: string | null;
  payment: string | null;
  netDays: number | null;
  buyer: "brand" | "agency" | "platform" | "gifting" | "unknown";
}

export interface RedFlag {
  key: string;
  text: string;
  quote: string;
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1 };

/** The sentence (or line) around a match: never the whole email when it is one paragraph. */
function around(t: string, i: number, len: number): string {
  const before = t.slice(0, i);
  const s = Math.max(before.lastIndexOf("\n"), before.search(/[.!?][^.!?]*$/) >= 0 ? before.search(/[.!?][^.!?]*$/) + 1 : -1) + 1;
  const rest = t.slice(i + len);
  const m = rest.search(/[.!?](\s|$)|\n/);
  const e = m < 0 ? t.length : i + len + m + 1;
  return t.slice(Math.max(0, s), e).trim().slice(0, 200);
}

function firstMatch(t: string, re: RegExp): { m: RegExpExecArray; line: string } | null {
  const m = re.exec(t);
  return m ? { m, line: around(t, m.index, m[0].length) } : null;
}

/** Read the terms with rules only (always runs; the model result is merged on top of this). */
export function extractTerms(text: string): OfferTerms {
  const t = text.replace(/\r/g, "");
  const lower = t.toLowerCase();
  // fee: the largest "$" amount near a pay word, else the largest "$" amount at all
  const amounts = [...t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k\b)?|(\d{1,3}(?:,\d{3})+|\d+)\s?(usd|dollars)\b/gi)].map((m) => ({ n: Math.round(Number((m[1] ?? m[4]).replace(/,/g, "") + (m[1] ? (m[2] ?? "") : "")) * (m[3] ? 1000 : 1)), i: m.index ?? 0 }));
  const payNear = amounts.filter((a) => /(fee|budget|pay|rate|compensat|offer|flat|total)/i.test(t.slice(Math.max(0, a.i - 60), a.i + 40)));
  const pool = payNear.length ? payNear : amounts;
  const fee = pool.length ? Math.max(...pool.map((a) => a.n)) : null;

  const delivs: string[] = [];
  for (const m of t.matchAll(/\b(\d+|one|two|three|four|five|six|a|an|single)\s+(?:x\s+)?(tiktok|instagram|ig|youtube|yt)?\s*(videos?|reels?|tiktoks?|stor(?:y|ies)(?: frames?| sets?)?|feed posts?|posts?|shorts?|integrations?|ugc videos?)/gi)) {
    const n = WORD_NUM[m[1].toLowerCase()] ?? Number(m[1]);
    if (!Number.isFinite(n) || n > 20) continue;
    delivs.push(`${n} ${m[2] ? `${m[2]} ` : ""}${m[3]}`.replace(/\s+/g, " "));
  }
  const usage = firstMatch(t, /(usage|rights|licen[cs]e|whitelist|spark ads?|paid (?:media|ads|social)|in perpetuity|perpetual|repurpose)[^.\n]*/i);
  const excl = firstMatch(t, /exclusiv[^.\n]*/i);
  const timeline = firstMatch(t, /(post(?:ing)?|live|go live|launch|due|deadline|by)\s[^.\n]*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s?\d{1,2}[^.\n]*|within \d+ (?:days|weeks)[^.\n]*|(?:next|this) (?:week|month)[^.\n]*/i);
  const net = /net[\s-]?(\d{2,3})/i.exec(t);
  const payment = firstMatch(t, /(net[\s-]?\d{2,3}|payment[^.\n]*|paid (?:within|after|upon)[^.\n]*|upon (?:completion|posting|approval)[^.\n]*|invoice[^.\n]*)/i);

  let buyer: OfferTerms["buyer"] = "unknown";
  if (/(gift(ed|ing)?|free product|send you (some )?product|in exchange for (a )?post|product seeding|no budget)/i.test(lower) && fee === null) buyer = "gifting";
  else if (/\b(agency|on behalf of|our client|we represent|talent manager)\b/i.test(lower)) buyer = "agency";
  else if (/\b(tiktok one|creator marketplace|collabstr|aspire|grin|#paid|hashtagpaid|popular pays|ltk|shopmy)\b/i.test(lower)) buyer = "platform";
  else if (fee !== null || delivs.length) buyer = "brand";

  return {
    fee,
    deliverables: delivs.length ? [...new Set(delivs)].join(", ") : null,
    usage: usage ? usage.line : null,
    exclusivity: excl ? excl.line : null,
    timeline: timeline ? timeline.line : null,
    payment: payment ? payment.line : null,
    netDays: net ? Number(net[1]) : null,
    buyer,
  };
}

/** Red flags, each in plain English with the words from their email that raised it. */
export function redFlags(text: string, terms: OfferTerms): RedFlag[] {
  const t = text.replace(/\r/g, "");
  const out: RedFlag[] = [];
  const flag = (key: string, re: RegExp, say: string) => {
    const f = firstMatch(t, re);
    if (f) out.push({ key, text: say, quote: f.line });
  };
  flag("perpetual", /(in perpetuity|perpetual|unlimited (?:usage|use|rights|time)|forever|all media|any and all media|worldwide,? in all)/i, "They want to use your video forever or everywhere. Usage should have an end date and a price; ask for 30 or 90 days.");
  flag("likeness", /(likeness|your (?:name,? )?(?:image|voice|face)|name and likeness|biometric)/i, "They ask for rights to your name, face or voice. Limit it to this campaign's video only.");
  if (terms.exclusivity && terms.fee === null) out.push({ key: "exclusivity_unpaid", text: "They want exclusivity but name no fee. Exclusivity is paid, and only for one named category.", quote: terms.exclusivity });
  else flag("exclusivity_wide", /exclusiv[^.\n]*(all|any|every) (?:brands?|competitors?|categor)/i, "Exclusivity covers every brand or category. Narrow it to their direct competitors, for a set time, and price it.");
  if (terms.netDays !== null && terms.netDays >= 60) out.push({ key: "late_pay", text: `They pay net-${terms.netDays}. Net-30 is normal; ask for net-30, or a part up front.`, quote: terms.payment ?? `net-${terms.netDays}` });
  flag("pay_on_performance", /(paid (?:only )?(?:if|when|based on) (?:it )?(?:performs|views|sales)|performance[- ]based (?:only|payment)|commission only)/i, "Pay depends on how the video performs. Ask for a flat fee (commission can be on top).");
  if (terms.buyer === "gifting") out.push({ key: "unpaid_gifting", text: "This is free product, not a paid deal. Fine if you love it, but no posting duties without a fee.", quote: firstMatch(t, /(gift(?:ed|ing)?|free product|send you (?:some )?product|in exchange for (?:a )?post|no budget)[^.\n]*/i)?.line ?? "" });
  flag("exposure", /(exposure|great for your (?:brand|profile|growth)|visibility for you|feature you on our)/i, "They offer \"exposure\" instead of money. Exposure doesn't pay; ask for their budget.");
  flag("unlimited_revisions", /(unlimited (?:revisions|edits|changes)|as many (?:revisions|edits|changes))/i, "Unlimited changes. Two rounds is normal; more is paid.");
  flag("content_ownership", /(we (?:will )?own|full ownership|transfer (?:all )?(?:rights|ownership)|work for hire|work-for-hire)/i, "They want to own your video outright. License it to them instead, for a set time.");
  return out;
}

export interface OfferVerdict {
  verdict: "reply" | "counter" | "decline";
  headline: string;
  reason: string;
  scores: { fit: number; budget: number; brief: number; risk: number };
  scenario: "inbound_reply" | "counter_offer" | "usage_clarify" | "decline" | "ask_brief";
}

/**
 * Score 0–3 each: fit (brand not off-limits and on her themes), budget (a fee vs her floor),
 * brief quality (how much is written down), risk (red flags). The verdict follows the agency
 * rules: off-limits or gifting-with-duties or far under the floor → decline; money under target
 * or a serious flag → counter; otherwise reply and ask for what is missing.
 */
export function qualify(terms: OfferTerms, flags: RedFlag[], ctx: { offLimitsHit: string | null; themeHit: boolean; floor: number | null; target: number | null }): OfferVerdict {
  const fit = ctx.offLimitsHit ? 0 : ctx.themeHit ? 3 : 2;
  let budget = 1;
  if (terms.buyer === "gifting") budget = 0;
  else if (terms.fee != null && ctx.target != null && terms.fee >= ctx.target) budget = 3;
  else if (terms.fee != null && ctx.floor != null && terms.fee >= ctx.floor) budget = 2;
  else if (terms.fee != null && ctx.floor != null) budget = 0;
  else if (terms.fee != null) budget = 2;
  const brief = [terms.deliverables, terms.timeline, terms.usage, terms.payment, terms.fee].filter((x) => x != null).length;
  const briefScore = brief >= 4 ? 3 : brief >= 2 ? 2 : brief === 1 ? 1 : 0;
  const serious = flags.filter((f) => ["perpetual", "likeness", "content_ownership", "exclusivity_unpaid", "pay_on_performance"].includes(f.key)).length;
  const risk = Math.max(0, 3 - serious - (flags.length - serious > 0 ? 1 : 0));
  const scores = { fit, budget, brief: briefScore, risk };
  const base = { scores };
  if (ctx.offLimitsHit) return { ...base, verdict: "decline", headline: "Decline", reason: `It touches "${ctx.offLimitsHit}", which is on your off-limits list.`, scenario: "decline" };
  if (terms.buyer === "gifting" && flags.some((f) => f.key === "unpaid_gifting")) return { ...base, verdict: "decline", headline: "Decline, or ask for a fee", reason: "It's free product in exchange for posts. Reply only if they can add a fee.", scenario: "decline" };
  if (terms.fee != null && ctx.floor != null && terms.fee < ctx.floor * 0.5) return { ...base, verdict: "decline", headline: "Decline", reason: `Their $${terms.fee.toLocaleString("en-US")} is under half your floor ($${ctx.floor.toLocaleString("en-US")}).`, scenario: "decline" };
  if (serious > 0) return { ...base, verdict: "counter", headline: "Counter", reason: `The money may be fine, but ${flags.find((f) => ["perpetual", "likeness", "content_ownership", "exclusivity_unpaid", "pay_on_performance"].includes(f.key))!.text.split(".")[0].toLowerCase()}. Fix the terms before you say yes.`, scenario: "usage_clarify" };
  if (terms.fee != null && ctx.target != null && terms.fee < ctx.target) return { ...base, verdict: "counter", headline: "Counter", reason: `Their $${terms.fee.toLocaleString("en-US")} is under your target ($${ctx.target.toLocaleString("en-US")}). Counter, or trade scope.`, scenario: "counter_offer" };
  if (terms.fee == null) return { ...base, verdict: "reply", headline: "Worth a reply", reason: "No budget named yet. Ask for the brief and budget before you give a number.", scenario: "ask_brief" };
  return { ...base, verdict: "reply", headline: "Worth a reply", reason: flags.length ? "Good money; check the flag below in your reply." : "Good money and clear terms. Reply and confirm the details.", scenario: "inbound_reply" };
}

/** Merge the model's reading over the rules', keeping only figures that appear in the pasted text. */
export function mergeModelTerms(text: string, rules: OfferTerms, model: unknown): OfferTerms {
  if (!model || typeof model !== "object") return rules;
  const m = model as Record<string, unknown>;
  const lower = text.toLowerCase();
  const out = { ...rules };
  const fee = Number(m.fee);
  if (Number.isFinite(fee) && fee > 0) {
    const s = Math.round(fee).toLocaleString("en-US");
    if (text.includes(s) || text.includes(String(Math.round(fee))) || (fee % 1000 === 0 && lower.includes(`${fee / 1000}k`))) out.fee = Math.round(fee);
  }
  for (const k of ["deliverables", "usage", "exclusivity", "timeline", "payment"] as const) {
    const v = m[k];
    if (typeof v === "string" && v.trim() && !out[k]) {
      // keep only if its key words appear in their email (no invented terms)
      const words = v.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      if (words.length && words.filter((w) => lower.includes(w)).length / words.length >= 0.6) out[k] = v.trim().slice(0, 200);
    }
  }
  return out;
}

export function offerPrompt(text: string): { system: string; user: string } {
  return {
    system:
      'Read a brand\'s email to a creator and pull out the offer. Answer JSON: {"fee": number or null, "deliverables": string or null, "usage": string or null, "exclusivity": string or null, "timeline": string or null, "payment": string or null}. Use only what the email says; never guess.',
    user: text.slice(0, 8000),
  };
}
