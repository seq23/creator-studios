// "Write the email" (docs/reviews/agency-pov.md): every email a talent manager sends for a deal,
// written in her voice from real facts. Each scenario has a starter (no model needed: used when
// the AI is off or answers badly), three subject lines, the "before you send" checks it needs,
// and the instruction the AI draft follows. The AI's answer is refused if it drops her kit link
// or states a dollar figure that is not in the facts (a draft never invents money).
//
// Every key in SCENARIOS has a template here and a test in tests/unit/emails.test.ts; the
// validator `mediakit-deals` fails the build if either is missing.
import type { CheckKey } from "@shared/emailcheck";
import type { OfferOption } from "./ratecard";

export type Tone = "warm" | "straight" | "short";
export type Length = "brief" | "standard" | "detailed";

export interface EmailFacts {
  creatorName: string;
  /** Her voice line from the locked Brand Profile. */
  voice: string;
  themes: string[];
  audience: string;
  brand: { name: string; kind: "brand" | "agency" | "local"; contactFirstName: string | null; herPick: boolean; product: string | null };
  /** "What I found" lines, each from a page (never unsourced). */
  research: { text: string; url: string }[];
  /** Her verified numbers, with the date they are from. */
  numbers: { platform: string; followers: number; avgViews: number; asOf: string }[];
  engagementLine: string | null;
  kitUrl: string;
  clipLinks: string[];
  idea: string | null;
  options: OfferOption[] | null;
  /** The package on the table for this deal (from her rate card or the deal memo). */
  offer: { name: string; what: string; price: number | null } | null;
  terms: {
    fee: number | null;
    deliverables: string | null;
    postBy: string | null;
    draftBy: string | null;
    usage: string | null;
    exclusivity: string | null;
    netDays: number;
    upfrontPct: number;
    upfrontOver: number;
    killFeePct: number;
    revisionRounds: number;
  };
  /** What they sent (inbound), each labelled from their email. */
  theirs: { fee: number | null; deliverables: string | null; usage: string | null; exclusivity: string | null; payment: string | null; timeline: string | null } | null;
  counter: { amount: number | null; line: string } | null;
  invoice: { number: string; amount: number; dueAt: string; link: string | null } | null;
  results: { posts: number; views: number; likes: number; comments: number; shares: number; saves: number; asOf: string } | null;
  declineReason: string | null;
  today: string;
}

export type ScenarioKey =
  | "cold_pitch"
  | "agency_pitch"
  | "warm_repitch"
  | "followup_1"
  | "followup_2"
  | "followup_3"
  | "inbound_reply"
  | "ask_brief"
  | "rate_proposal"
  | "counter_offer"
  | "usage_clarify"
  | "decline"
  | "deliverables_confirm"
  | "draft_for_approval"
  | "results_report"
  | "invoice_send"
  | "payment_reminder"
  | "thank_you_rebook";

export interface Scenario {
  key: ScenarioKey;
  label: string;
  /** One line: when to use it. */
  when: string;
  checks: CheckKey[];
  subjects: (f: EmailFacts) => string[];
  /** Paragraphs; each tagged with the shortest length that keeps it. */
  body: (f: EmailFacts, tone: Tone) => Para[];
  /** What the AI must do, in one or two sentences. */
  aim: string;
}

interface Para {
  text: string;
  keep: Length; // "brief" = always; "standard" = standard + detailed; "detailed" = detailed only
}

// ---------- helpers

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}
const first = (f: EmailFacts) => f.creatorName.split(" ")[0] || f.creatorName;
const productPhrase = (f: EmailFacts) => (f.brand.product ? `your ${f.brand.product}` : `${f.brand.name}`);
function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function hello(f: EmailFacts, tone: Tone): string {
  const who = f.brand.contactFirstName ?? (f.brand.kind === "agency" ? "there" : `${f.brand.name} team`);
  return tone === "warm" ? `Hi ${who},` : `Hi ${who},`;
}
function signoff(f: EmailFacts, tone: Tone): string {
  return tone === "warm" ? `Warmly,\n${first(f)}` : tone === "straight" ? `Thanks,\n${first(f)}` : first(f);
}

/** "12.4K followers on TikTok (about 3.1K views a video, as of Sep 24)" */
export function numbersLine(f: EmailFacts, max = 2): string | null {
  const parts = [...f.numbers]
    .filter((n) => n.followers > 0)
    .sort((a, b) => b.followers - a.followers)
    .slice(0, max)
    .map((n) => `${compact(n.followers)} followers on ${n.platform}${n.avgViews ? ` (about ${compact(n.avgViews)} views a video)` : ""}`);
  if (!parts.length) return null;
  const asOf = fmtDay([...f.numbers].sort((a, b) => b.asOf.localeCompare(a.asOf))[0]?.asOf ?? null);
  return `${parts.join(" and ")}${asOf ? `, as of ${asOf}` : ""}`;
}

function optionsBlock(f: EmailFacts): string | null {
  if (!f.options?.length) return null;
  const names = ["Full", "Standard", "Entry"];
  return f.options.map((o, i) => `${names[i] ?? "Option"}: ${o.what}${o.onRequest || o.price == null ? " (rate on request)" : `, ${usd(o.price)}`}`).join("\n");
}

function termsLine(f: EmailFacts): string {
  const t = f.terms;
  const up = t.fee != null && t.fee >= t.upfrontOver ? ` ${t.upfrontPct}% up front, the rest` : "";
  return `Payment:${up} net-${t.netDays} from invoice. Includes ${t.revisionRounds} ${t.revisionRounds === 1 ? "round" : "rounds"} of changes. If the project is cancelled after the brief is approved, a ${t.killFeePct}% kill fee applies.`;
}

const TURN: Record<string, string> = { their: "your", theirs: "yours", they: "you", them: "you", your: "my", yours: "mine", you: "I" };

/** A finder note is written to her ("their new line … like yours"); in a pitch it speaks to the brand ("your new line … like mine"). */
export function toBrand(note: string): string {
  return note.replace(/\b(their|theirs|they|them|your|yours|you)\b/gi, (w) => {
    const t = TURN[w.toLowerCase()];
    return w[0] === w[0].toUpperCase() ? t[0].toUpperCase() + t.slice(1) : t;
  });
}

function researchLine(f: EmailFacts): string | null {
  const r = f.research[0];
  return r ? toBrand(r.text.replace(/\.$/, "")) : null;
}

function kitLine(f: EmailFacts): string {
  return `My media kit, with my numbers, past work and rates: ${f.kitUrl}`;
}

function clipsLine(f: EmailFacts): string | null {
  if (!f.clipLinks.length) return null;
  return `${f.clipLinks.length === 1 ? "A video" : "Two videos"} that show my style:\n${f.clipLinks.slice(0, 2).join("\n")}`;
}

function ideaLine(f: EmailFacts): string {
  return f.idea ?? `a ${f.themes[0] ? f.themes[0].toLowerCase() : "styling"} video that shows ${productPhrase(f)} the way my audience uses it at home`;
}

// ---------- the scenarios

export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  cold_pitch: {
    key: "cold_pitch",
    label: "First pitch",
    when: "You have never written to this brand. Lead with one idea and three options.",
    checks: ["rate", "deliverables", "kit"],
    aim: "A first pitch: one specific idea tied to what we found about the brand, her audience in numbers, three options anchored high, one clear ask.",
    subjects: (f) => [`An idea for ${f.brand.name}: ${f.themes[0] ? f.themes[0].toLowerCase() : "hosting"} content`, `${f.brand.name} × ${first(f)}: ${f.idea ? "a video idea" : "a partnership idea"}`, `For your creator team: ${f.themes[0] ?? "home and hosting"} with ${f.brand.name}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: f.brand.herPick ? `I'm ${first(f)}, a ${f.themes.slice(0, 2).join(" and ").toLowerCase() || "lifestyle"} creator, and ${productPhrase(f)} is already part of how I host.` : `I'm ${first(f)}, a ${f.themes.slice(0, 2).join(" and ").toLowerCase() || "lifestyle"} creator.${researchLine(f) ? ` I noticed ${lowerFirst(researchLine(f)!)}, so this felt like the right moment to reach out.` : ""}`, keep: "brief" },
      { text: `My idea: ${ideaLine(f)}.`, keep: "brief" },
      ...(numbersLine(f) ? [{ text: `My audience${f.audience ? `: ${f.audience.replace(/\.$/, "")}` : ""}. ${numbersLine(f)}.${f.engagementLine ? ` ${f.engagementLine}` : ""}`, keep: "standard" as Length }] : []),
      ...(optionsBlock(f) ? [{ text: `Three ways we could do it:\n${optionsBlock(f)}`, keep: "brief" as Length }] : [{ text: "Rates on request; I'm happy to send options for your budget.", keep: "brief" as Length }]),
      ...(clipsLine(f) ? [{ text: clipsLine(f)!, keep: "detailed" as Length }] : []),
      { text: kitLine(f), keep: "brief" },
      { text: tone === "short" ? "Worth a quick chat?" : "Would one of these work for this season? If you have a brief or a budget in mind, I'll shape it to fit.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  agency_pitch: {
    key: "agency_pitch",
    label: "Pitch to an agency",
    when: "The contact books creators for many brands. Ask to be on their list for your categories.",
    checks: ["rate", "kit"],
    aim: "A roster pitch to an agency: her categories and numbers up front, what she delivers, rates on her kit, ask to be added to their creator list for home and hosting campaigns.",
    subjects: (f) => [`Creator for your ${f.themes[0]?.toLowerCase() ?? "home"} campaigns: ${first(f)}`, `Adding ${first(f)} to your creator list (${f.themes.slice(0, 2).join(", ").toLowerCase() || "home and hosting"})`, `${first(f)}: ${f.themes[0] ?? "hosting"} creator, rates and kit`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: `I'm ${first(f)}, a creator in ${f.themes.slice(0, 3).join(", ").toLowerCase() || "home and hosting"}. I'd love to be on your list when your brands need ${f.themes[0]?.toLowerCase() ?? "hosting"} content.`, keep: "brief" },
      ...(numbersLine(f, 3) ? [{ text: `${numbersLine(f, 3)}.${f.engagementLine ? ` ${f.engagementLine}` : ""}`, keep: "brief" as Length }] : []),
      ...(optionsBlock(f) ? [{ text: `What brands usually book:\n${optionsBlock(f)}`, keep: "standard" as Length }] : [{ text: "Rates on request, and my packages are on my kit.", keep: "standard" as Length }]),
      { text: "I turn briefs around quickly, take two rounds of feedback, and post with the paid-partnership label.", keep: "detailed" },
      { text: kitLine(f), keep: "brief" },
      { text: "Who is the best person to send availability to?", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  warm_repitch: {
    key: "warm_repitch",
    label: "Warm re-pitch",
    when: "You have worked with them or talked before. Pick up where you left off with a new idea.",
    checks: ["rate", "deliverables", "kit"],
    aim: "A warm re-pitch to a brand she has history with: reference the past, one new idea for this season, options, easy ask.",
    subjects: (f) => [`New idea for ${f.brand.name} this season`, `Round two? ${first(f)} × ${f.brand.name}`, `${f.brand.name}: a ${f.themes[0]?.toLowerCase() ?? "hosting"} idea for next month`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? `It's ${first(f)}, so good to be back in touch.` : `It's ${first(f)}.`, keep: "brief" },
      { text: `I have a new idea for you: ${ideaLine(f)}.`, keep: "brief" },
      ...(numbersLine(f) ? [{ text: `Since we last spoke: ${numbersLine(f)}.`, keep: "standard" as Length }] : []),
      ...(optionsBlock(f) ? [{ text: `Options:\n${optionsBlock(f)}`, keep: "brief" as Length }] : [{ text: "Rates on request; happy to fit your budget.", keep: "brief" as Length }]),
      { text: kitLine(f), keep: "brief" },
      { text: "Would you like to do it again?", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  followup_1: {
    key: "followup_1",
    label: "Follow-up (day 5)",
    when: "Five days, no reply. A short nudge in the same thread.",
    checks: ["kit"],
    aim: "A short, friendly nudge five days after the pitch: restate the idea in one line, the kit link, ask who is the right person.",
    subjects: (f) => [`Re: ${f.brand.name} × ${first(f)}`, `Quick follow-up: an idea for ${f.brand.name}`, `Floating this back up`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: `Floating this back up in case it got buried. The idea: ${ideaLine(f)}.`, keep: "brief" },
      { text: kitLine(f), keep: "brief" },
      { text: "If someone else looks after creators, could you point me to them?", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  followup_2: {
    key: "followup_2",
    label: "Follow-up (day 12)",
    when: "Twelve days, no reply. Add something new: a number or a date.",
    checks: ["kit", "timeline"],
    aim: "The second follow-up at day 12: add one new thing (a fresh number or a timing hook), keep it short, kit link.",
    subjects: (f) => [`Re: ${f.brand.name} × ${first(f)}`, `One more idea for ${f.brand.name}`, `Timing for ${f.brand.name} content`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: `One more note on this. I'm planning my content for the next 4 weeks and would love to hold a spot for ${f.brand.name}.`, keep: "brief" },
      ...(numbersLine(f, 1) ? [{ text: `For context: ${numbersLine(f, 1)}.`, keep: "standard" as Length }] : []),
      { text: kitLine(f), keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  followup_3: {
    key: "followup_3",
    label: "Last follow-up (day 19)",
    when: "Nineteen days, no reply. Close the loop politely; after this, stop.",
    checks: ["kit"],
    aim: "The final, gentle close at day 19: no pressure, the door stays open, kit link; after this she stops.",
    subjects: (f) => [`Closing the loop: ${f.brand.name}`, `Last note from me, ${f.brand.name}`, `Re: ${f.brand.name} × ${first(f)}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: "I'll close the loop on this one so I'm not crowding your inbox. If the timing is better later in the year, I'd love to hear from you.", keep: "brief" },
      { text: kitLine(f), keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  inbound_reply: {
    key: "inbound_reply",
    label: "Reply to their offer",
    when: "They wrote to you with an offer. Thank them, confirm what you read, ask what is missing.",
    checks: ["deliverables", "usage", "payment", "kit"],
    aim: "Reply to an inbound offer: thank them, restate the terms read from their email, ask only for what is missing (usage, exclusivity, timing, payment), no commitment yet.",
    subjects: (f) => [`Re: ${f.brand.name} partnership`, `Thanks, ${f.brand.name}: a few details`, `${f.brand.name} × ${first(f)}: next steps`],
    body: (f, tone) => {
      const t = f.theirs;
      const missing: string[] = [];
      if (!t?.deliverables) missing.push("the exact deliverables");
      if (!t?.usage) missing.push("how long and where you'd like to use the content (usage)");
      if (!t?.exclusivity) missing.push("whether you need exclusivity");
      if (!t?.timeline) missing.push("the posting dates");
      if (!t?.payment) missing.push("payment terms");
      if (!t?.fee) missing.push("the budget");
      const read = [t?.deliverables && `deliverables: ${t.deliverables}`, t?.fee != null && `fee: ${usd(t.fee)}`, t?.usage && `usage: ${t.usage}`, t?.timeline && `timing: ${t.timeline}`, t?.payment && `payment: ${t.payment}`].filter(Boolean);
      return [
        { text: hello(f, tone), keep: "brief" },
        { text: tone === "short" ? `Thanks for thinking of me.` : `Thank you for reaching out, I'd love to work with ${f.brand.name}.`, keep: "brief" },
        ...(read.length ? [{ text: `To make sure I have it right: ${read.join("; ")}.`, keep: "brief" as Length }] : []),
        ...(missing.length ? [{ text: `Could you share ${missing.join(", ")}?`, keep: "brief" as Length }] : []),
        { text: `Once I have those, I'll confirm my rate and the plan within a day. My usual payment terms are net-${f.terms.netDays}; my packages and usage terms are on my kit.`, keep: "brief" },
        { text: kitLine(f), keep: "brief" },
        { text: signoff(f, tone), keep: "brief" },
      ];
    },
  },
  ask_brief: {
    key: "ask_brief",
    label: "Ask for the brief",
    when: "They are interested. Get the brief and budget before you name a price.",
    checks: ["deliverables", "timeline", "usage"],
    aim: "Ask for the brief and budget before quoting (never say the first number when avoidable): deliverables, dates, usage, exclusivity, approvals, budget range.",
    subjects: (f) => [`${f.brand.name} brief: a few questions`, `Before I quote: the brief for ${f.brand.name}`, `Re: ${f.brand.name} × ${first(f)}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "So glad you're interested! So I can put together the right plan:" : "So I can put together the right plan:", keep: "brief" },
      { text: "1. Which platforms and how many videos (TikTok, Reels, Stories)?\n2. Your dates: when you'd like the draft and when it should post.\n3. Usage: will you repost or run it as an ad, and for how long?\n4. Do you need exclusivity, and in which category?\n5. What budget range are you working with?", keep: "brief" },
      { text: "I usually turn a video around within 7 days of an approved brief. If you have a written brief, send it over and I'll reply with options within a day.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  rate_proposal: {
    key: "rate_proposal",
    label: "Rate proposal",
    when: "You have the brief. Send three options, anchored high, with your terms.",
    checks: ["rate", "deliverables", "timeline", "usage", "exclusivity", "payment", "kit"],
    aim: "A rate proposal: three options anchored high (from the facts only), what each includes, usage and exclusivity priced separately, payment terms, a timeline, the kit link.",
    subjects: (f) => [`${f.brand.name}: three options`, `Proposal: ${first(f)} × ${f.brand.name}`, `Rates and timing for ${f.brand.name}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "Thank you for the brief, I love this. Here are three ways we can do it:" : "Here are three ways we can do it:", keep: "brief" },
      { text: optionsBlock(f) ?? (f.offer ? `${f.offer.name}: ${f.offer.what}${f.offer.price != null ? `, ${usd(f.offer.price)}` : " (rate on request)"}` : "Rates on request: tell me your budget and I'll shape the package to it."), keep: "brief" },
      { text: "Each includes concept, filming, editing and posting with the paid-partnership label, plus 30 days of reposting on your channels. Longer usage, paid ads from my handle, and category exclusivity are priced on top.", keep: "brief" },
      { text: `Timing: draft within 7 days of the approved brief${f.terms.postBy ? `, posting by ${fmtDay(f.terms.postBy)}` : ", posting on a date we agree"}.`, keep: "brief" },
      { text: termsLine(f), keep: "standard" },
      { text: kitLine(f), keep: "brief" },
      { text: "Which one works for you?", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  counter_offer: {
    key: "counter_offer",
    label: "Counter-offer",
    when: "Their number is under your target. Counter, or trade scope instead of price.",
    checks: ["rate", "deliverables", "usage", "payment"],
    aim: "A counter-offer: warm, firm, uses the counter line from the facts exactly (trade scope, not price), restates usage and payment terms.",
    subjects: (f) => [`Re: ${f.brand.name} budget`, `A way to make ${f.brand.name} work`, `Re: ${f.brand.name} × ${first(f)}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "Thank you for the offer, I really want to make this work." : "Thanks for the offer.", keep: "brief" },
      { text: f.counter?.line ?? (f.offer?.price != null ? `My rate for ${f.offer.name} is ${usd(f.offer.price)}.` : "Could you share the budget so I can suggest a scope that fits?"), keep: "brief" },
      ...((f.terms.deliverables ?? f.offer?.what) && !/can't do all/.test(f.counter?.line ?? "") ? [{ text: `That's for ${lowerFirst(f.terms.deliverables ?? f.offer!.what)}.`, keep: "brief" as Length }] : []),
      { text: `That includes 30 days of reposting on your channels; longer usage or paid ads from my handle are priced separately. ${termsLine(f)}`, keep: "standard" },
      { text: "Let me know which works and I'll send the agreement details.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  usage_clarify: {
    key: "usage_clarify",
    label: "Usage rights question",
    when: "Their usage or exclusivity is vague or too wide. Pin it down before you agree.",
    checks: ["usage", "exclusivity"],
    aim: "Clarify usage rights and exclusivity: where, how long, organic vs paid, which category; say what the base fee covers and that more is priced separately; never agree to perpetual or likeness rights.",
    subjects: (f) => [`Usage and exclusivity for ${f.brand.name}`, `Quick question on usage rights`, `Re: ${f.brand.name} terms`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: "Before I confirm, could we pin down usage?", keep: "brief" },
      { text: `${f.theirs?.usage ? `Your note says "${f.theirs.usage}". ` : ""}My rate covers 30 days of reposting on your own channels. Could you tell me:\n1. Where you'd use it (your social, website, email, paid ads)?\n2. For how long?\n3. Whether you'd run it as an ad from my handle?\n4. If you need exclusivity, which category and for how long?`, keep: "brief" },
      { text: "Longer usage, paid ads and exclusivity are priced as add-ons; I don't grant perpetual rights or rights to my name, face or voice beyond this campaign.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  decline: {
    key: "decline",
    label: "Decline politely",
    when: "It isn't right (budget, fit, terms). Say no and keep the door open.",
    checks: [],
    aim: "Decline politely in two or three sentences; one honest reason; the door stays open.",
    subjects: (f) => [`Re: ${f.brand.name}`, `Thank you, ${f.brand.name}`, `Re: ${f.brand.name} partnership`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: `Thank you so much for thinking of me. ${f.declineReason ? `${f.declineReason.replace(/\.$/, "")}, so I'll pass on this one.` : "This one isn't the right fit for me right now, so I'll pass."}`, keep: "brief" },
      { text: "I'd love to stay in touch for future campaigns.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  deliverables_confirm: {
    key: "deliverables_confirm",
    label: "Confirm what's agreed",
    when: "You said yes. Put the whole deal in writing before you start.",
    checks: ["rate", "deliverables", "timeline", "usage", "exclusivity", "payment"],
    aim: "Confirm the agreed deal in writing (the deal memo): deliverables, dates, fee, usage, exclusivity, approvals, payment terms, kill fee; ask them to reply to confirm.",
    subjects: (f) => [`Confirming our ${f.brand.name} partnership`, `${f.brand.name} × ${first(f)}: what we agreed`, `Agreement details: ${f.brand.name}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "I'm so excited to get started! Confirming what we agreed:" : "Confirming what we agreed:", keep: "brief" },
      {
        text: [
          `Deliverables: ${f.terms.deliverables ?? f.offer?.what ?? "(to confirm)"}`,
          `Fee: ${f.terms.fee != null ? usd(f.terms.fee) : "(to confirm)"}`,
          `Draft to you by: ${fmtDay(f.terms.draftBy) ?? "(date to confirm)"}; posting by: ${fmtDay(f.terms.postBy) ?? "(date to confirm)"}`,
          `Usage: ${f.terms.usage ?? "30 days of reposting on your channels"}`,
          `Exclusivity: ${f.terms.exclusivity ?? "none"}`,
          `Approvals: up to ${f.terms.revisionRounds} ${f.terms.revisionRounds === 1 ? "round" : "rounds"} of changes`,
          termsLine(f),
        ].join("\n"),
        keep: "brief",
      },
      { text: "Could you reply to confirm, and send the brief and any product details?", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  draft_for_approval: {
    key: "draft_for_approval",
    label: "Send the draft for approval",
    when: "The video is made. Send it for their review with the date feedback is due.",
    checks: ["timeline"],
    aim: "Send the draft for approval: what's attached, when feedback is needed to hit the posting date, how many rounds are left.",
    subjects: (f) => [`${f.brand.name} draft for your review`, `Draft ready: ${f.brand.name} × ${first(f)}`, `For approval: ${f.brand.name} video`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "The draft is ready and I'm really happy with it!" : "The draft is ready.", keep: "brief" },
      { text: "[Paste the link to the draft here.]", keep: "brief" },
      { text: `Could you send any changes within 2 business days${f.terms.postBy ? ` so we post on time by ${fmtDay(f.terms.postBy)}` : ""}? This is round 1 of ${f.terms.revisionRounds}.`, keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  results_report: {
    key: "results_report",
    label: "Results report (day 7)",
    when: "Seven days after posting. Send their results: it gets you rebooked.",
    checks: ["timeline"],
    aim: "A results report 7 days after posting with her real numbers exactly as given (views, likes, comments, shares, saves, as of the date), one line on what worked, offer a next campaign.",
    subjects: (f) => [`${f.brand.name} results: first 7 days`, `How your ${f.brand.name} video did`, `Week-one numbers for ${f.brand.name}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: "Here's how the video did in its first week:", keep: "brief" },
      { text: f.results ? `${f.results.posts} ${f.results.posts === 1 ? "post" : "posts"}: ${f.results.views.toLocaleString("en-US")} views, ${f.results.likes.toLocaleString("en-US")} likes, ${f.results.comments.toLocaleString("en-US")} comments, ${f.results.shares.toLocaleString("en-US")} shares, ${f.results.saves.toLocaleString("en-US")} saves (as of ${fmtDay(f.results.asOf)}). Screenshots attached.` : "[Your numbers aren't in yet: add them from the app's insights and attach screenshots.]", keep: "brief" },
      { text: "Happy to talk about a next round: I have ideas for the coming season.", keep: "standard" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  invoice_send: {
    key: "invoice_send",
    label: "Send the invoice",
    when: "The content is live. Send the invoice with the amount and due date.",
    checks: ["rate", "payment", "timeline"],
    aim: "Send the invoice: number, amount and due date exactly as given, how to pay, thank them.",
    subjects: (f) => [`Invoice ${f.invoice?.number ?? ""}: ${f.brand.name}`.replace("  ", " "), `${f.brand.name} invoice, due ${fmtDay(f.invoice?.dueAt ?? null) ?? "net-30"}`, `Invoice for our ${f.brand.name} partnership`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? "Thank you again, this was a joy to make. Here is my invoice:" : "Here is my invoice:", keep: "brief" },
      { text: f.invoice ? `Invoice ${f.invoice.number}: ${usd(f.invoice.amount)}, due ${fmtDay(f.invoice.dueAt)} (net-${f.terms.netDays}).${f.invoice.link ? `\n${f.invoice.link}` : ""}` : "[Make the invoice on the deal first.]", keep: "brief" },
      { text: "Let me know if you need a W-9 or anything for your accounts team.", keep: "standard" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  payment_reminder: {
    key: "payment_reminder",
    label: "Payment reminder",
    when: "The invoice is due or late. A polite, specific nudge.",
    checks: ["rate", "payment", "timeline"],
    aim: "A polite payment reminder: invoice number, amount and due date exactly as given, ask for an expected payment date.",
    subjects: (f) => [`Reminder: invoice ${f.invoice?.number ?? ""} for ${f.brand.name}`.replace("  ", " "), `Payment for ${f.brand.name} invoice`, `Re: invoice ${f.invoice?.number ?? ""}`.trim()],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: f.invoice ? `A friendly reminder that invoice ${f.invoice.number} for ${usd(f.invoice.amount)} was due ${fmtDay(f.invoice.dueAt)}.` : "A friendly reminder about my invoice.", keep: "brief" },
      { text: "Could you let me know when payment is scheduled? Happy to resend it or send it to your accounts team directly.", keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
  thank_you_rebook: {
    key: "thank_you_rebook",
    label: "Thank-you and rebook",
    when: "Paid and done. Thank them and plant the next campaign.",
    checks: ["kit"],
    aim: "A thank-you after payment that proposes the next campaign with a seasonal idea and the kit link.",
    subjects: (f) => [`Thank you, ${f.brand.name}, and an idea for next time`, `Next season with ${f.brand.name}?`, `Round two: ${f.brand.name} × ${first(f)}`],
    body: (f, tone) => [
      { text: hello(f, tone), keep: "brief" },
      { text: tone === "warm" ? `Thank you, working with ${f.brand.name} was a joy.` : `Thank you for a great campaign.`, keep: "brief" },
      { text: `For next time: ${ideaLine(f)}. I'm booking the next 6 weeks now and would love to hold a spot for you.`, keep: "brief" },
      { text: kitLine(f), keep: "brief" },
      { text: signoff(f, tone), keep: "brief" },
    ],
  },
};

export const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

const KEEP: Record<Length, Length[]> = { brief: ["brief"], standard: ["brief", "standard"], detailed: ["brief", "standard", "detailed"] };

/** The starter draft: no model, real facts only. */
export function starterEmail(key: ScenarioKey, f: EmailFacts, tone: Tone = "warm", length: Length = "standard"): { subjects: string[]; subject: string; body: string } {
  const s = SCENARIOS[key];
  const len: Length = tone === "short" && length === "detailed" ? "standard" : tone === "short" ? "brief" : length;
  const paras = s.body(f, tone).filter((p) => KEEP[len].includes(p.keep));
  const subjects = s.subjects(f).map((x) => x.replace(/\s+/g, " ").trim().slice(0, 120));
  return { subjects, subject: subjects[0], body: paras.map((p) => p.text).join("\n\n") };
}

/** Every dollar figure the facts allow a draft to state. */
export function allowedAmounts(f: EmailFacts): Set<number> {
  const s = new Set<number>();
  const add = (n: number | null | undefined) => n != null && Number.isFinite(n) && s.add(Math.round(n));
  f.options?.forEach((o) => add(o.price));
  add(f.offer?.price);
  add(f.terms.fee);
  add(f.theirs?.fee);
  add(f.counter?.amount);
  add(f.invoice?.amount);
  add(f.terms.upfrontOver);
  return s;
}

export function amountsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(k\b)?/gi)].map((m) => Math.round(Number(m[1].replace(/,/g, "") + (m[2] ?? "")) * (m[3] ? 1000 : 1)));
}

export function emailPrompt(key: ScenarioKey, f: EmailFacts, tone: Tone, length: Length): { system: string; user: string } {
  const s = SCENARIOS[key];
  const words = { brief: 70, standard: 140, detailed: 220 }[length];
  const system = [
    `You write emails for the creator ${f.creatorName} to brands, in her voice. Her voice: ${f.voice || "warm, gracious, a little playful; short sentences; never salesy"}.`,
    `This email: ${s.label}. ${s.aim}`,
    `Tone: ${tone === "warm" ? "warm and friendly" : tone === "straight" ? "straight to the point, polite" : "very short"}. Body under ${words} words.`,
    "Rules: use only the facts given; never invent a number, a dollar amount, a product or a result; include the media kit link exactly as given when the facts have one; plain words; sign with her first name.",
    'Answer as JSON: {"subjects": [three subject lines], "body": "the email"}.',
  ].join("\n");
  return { system, user: JSON.stringify(f) };
}

/** Parse the model's answer; null unless it is complete, keeps the kit link where needed, and invents no money. */
export function parseEmail(text: string, key: ScenarioKey, f: EmailFacts): { subjects: string[]; subject: string; body: string } | null {
  let raw: unknown;
  try {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    raw = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text);
  } catch {
    return null;
  }
  const r = raw as { subjects?: unknown; body?: unknown };
  if (!r || typeof r.body !== "string" || r.body.trim().length < 20) return null;
  const subjects = (Array.isArray(r.subjects) ? r.subjects : []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 120));
  if (!subjects.length) return null;
  const body = r.body.trim();
  if (SCENARIOS[key].checks.includes("kit") && f.kitUrl && !body.includes(f.kitUrl)) return null;
  const allowed = allowedAmounts(f);
  if (amountsIn(body + subjects.join(" ")).some((n) => !allowed.has(n))) return null;
  const starter = SCENARIOS[key].subjects(f);
  const all = [...subjects, ...starter].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
  return { subjects: all, subject: all[0], body };
}

/** Which scenario fits a deal's stage (the "next email" the card names). */
export function suggestedScenario(stage: string, opts: { kind: "brand" | "agency" | "local"; followupsSent: number; hasOffer: boolean; invoiceOverdue: boolean; delivered: boolean; paid: boolean; workedBefore: boolean }): ScenarioKey {
  switch (stage) {
    case "find_contact":
    case "pitch":
      return opts.kind === "agency" ? "agency_pitch" : opts.workedBefore ? "warm_repitch" : "cold_pitch";
    case "follow_up":
      return opts.followupsSent >= 2 ? "followup_3" : opts.followupsSent === 1 ? "followup_2" : "followup_1";
    case "negotiating":
      return opts.hasOffer ? "inbound_reply" : "rate_proposal";
    case "agreed":
      return "deliverables_confirm";
    case "delivering":
      return opts.delivered ? "results_report" : "draft_for_approval";
    case "invoiced":
      return opts.invoiceOverdue ? "payment_reminder" : "invoice_send";
    case "paid":
    case "done":
      return "thank_you_rebook";
    default:
      return "decline";
  }
}
