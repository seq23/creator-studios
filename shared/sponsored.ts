// Get it sponsored (owner-approved mock-up, 23 Oct 2026): one module for the Worker and the app.
// She types an experience she wants paid for; the $0 "sponsor" job (jobs/sponsor.py) finds the
// brands, the videos and her to-do list. What is decided in code, never by a model, lives here:
//   - which experiences are medical or cosmetic (the "Read before you book" box shows FIRST),
//   - the rules in that box,
//   - the to-do list's dates, worked back from the month she picked,
//   - the words a business studio sees ("Get an event sponsored"), never "dream trips".
// Pinned by tests/unit/get-it-sponsored.test.ts.

/** "experience" for a creator studio, "event" for a business studio (registry `sponsorKind`). */
export type SponsorKind = "experience" | "event";

export interface SponsorEvidence {
  text: string;
  url: string;
}

/** A public way to reach the brand. "none" shows as "Needs a way in"; nothing is guessed. */
export interface SponsorWayIn {
  kind: "email" | "form" | "page" | "none";
  /** the public business address or the form / program link */
  value: string | null;
  /** the public page it is printed on */
  foundOn: string | null;
  /** plain words: "Creator program page (public)" */
  label: string;
}

export interface SponsorBrand {
  key: string;
  name: string;
  website: string | null;
  /** "Family resort · comped stay for content" */
  what: string;
  fit: "best" | "good" | "try";
  why: string;
  /** public proof they sponsor creators: every line has its page */
  proof: SponsorEvidence[];
  wayIn: SponsorWayIn;
  /** the first step for this brand, if the research named one */
  firstStep: string | null;
}

export interface SponsorVideo {
  id: string;
  title: string;
  /** "GRWM · 30–45 sec" */
  format: string;
  forBrand: string | null;
  /** "Paid post", "Gifted", "Your own" */
  deal: string;
  hook: string;
  shots: string[];
}

export interface SponsorTodo {
  id: string;
  text: string;
  /** YYYY-MM-DD, or null with a label ("Tip", "Always", "When a yes comes") */
  by: string | null;
  label: string | null;
}

export interface SponsorResult {
  firstMove: { text: string; by: string | null } | null;
  brands: SponsorBrand[];
  videos: SponsorVideo[];
  /** extra to-do lines the research found (the dated plan comes from todoPlan) */
  todo: SponsorTodo[];
  /** extra "Read before you book" lines the research found (medical only; the fixed rules come first) */
  rules: string[];
  /** how many search results it read */
  sources: number;
  /** "ai" when the free model wrote it, "rules" when the built-in fallback did */
  madeBy: "ai" | "rules";
}

export interface SponsorAskView {
  id: string;
  title: string;
  whenMonth: string;
  whenLabel: string;
  who: string;
  notes: string;
  medical: boolean;
  status: "researching" | "ready" | "failed";
  error: string | null;
  readyAt: string | null;
  createdAt: string;
  counts: { brands: number; videos: number; todo: number };
  pitchBy: string | null;
}

// ---------- words

export function sponsorWords(kind: SponsorKind) {
  const noun = kind === "event" ? "event" : "experience";
  return {
    noun,
    cardTitle: kind === "event" ? "Want an event paid for?" : "Want an experience paid for?",
    cardLine:
      kind === "event"
        ? "A party, a pop-up, an open house. Tell us the event and we find the brands and venues that would sponsor it."
        : "A trip, a spa day, a treatment. Tell us what you want and we find the brands that would sponsor it.",
    cta: kind === "event" ? "Get an event sponsored" : "Get an experience sponsored",
    ask: kind === "event" ? "What event do you want sponsored?" : "What do you want to experience?",
    placeholder: kind === "event" ? "e.g. A holiday open house for 60 guests" : "e.g. Spring break somewhere warm with the family",
    list: kind === "event" ? "Your events" : "Your experiences",
    archive: kind === "event" ? "Archive this event" : "Archive this experience",
    newOne: kind === "event" ? "New event" : "New experience",
  };
}

export const EXAMPLE_CHIPS: Record<SponsorKind, string[]> = {
  experience: ["Spring break trip", "Medical spa / Botox", "Wellness retreat abroad", "Hotel staycation"],
  event: ["Holiday open house", "Pop-up at a local shop", "Customer appreciation party", "Workshop or class"],
};

export const WHO_OPTIONS: Record<SponsorKind, string[]> = {
  experience: ["Just me", "Me and my partner", "Family", "Friends"],
  event: ["Our customers", "The public", "Invited guests", "Our team"],
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function validMonth(m: string | null | undefined): boolean {
  return !!m && /^20\d\d-(0[1-9]|1[0-2])$/.test(m);
}

/** "2027-03" → "Mar 2027"; "" → "Date not set". */
export function monthLabel(m: string | null | undefined): string {
  if (!validMonth(m)) return "Date not set";
  const [y, mo] = m!.split("-").map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

/** The next 18 months from today, for the When pull-down. */
export function monthOptions(todayIso: string, n = 18): { value: string; label: string }[] {
  const [y, m] = todayIso.slice(0, 7).split("-").map(Number);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const yy = y + Math.floor((m - 1 + i) / 12);
    const mm = ((m - 1 + i) % 12) + 1;
    const value = `${yy}-${String(mm).padStart(2, "0")}`;
    out.push({ value, label: monthLabel(value) });
  }
  return out;
}

// ---------- medical / cosmetic

const MEDICAL_RE =
  /\b(botox|jeuveau|dysport|xeomin|daxxify|tox|neurotoxin|fillers?|injectables?|injector|lip flip|med ?spa|medspa|medical|clinics?|surgery|surgical|surgeon|cosmetic procedure|lipo\w*|bbl|tummy tuck|rhinoplasty|nose job|face ?lift|blepharoplasty|veneers?|dental|dentist|laser|microneedl\w*|chemical peel|dermatolog\w*|derm|ozempic|semaglutide|wegovy|tirzepatide|iv drip|hair transplant|implants?|plastic surg\w*|skin booster|sculptra|kybella|coolsculpt\w*|prp)\b/i;

/** True when the experience is medical or cosmetic: the rules box shows first. */
export function isMedical(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && MEDICAL_RE.test(t));
}

/** "Read before you book": fixed in code, shown above everything else for a medical experience. */
export const MEDICAL_RULES: string[] = [
  "Label every post: say #ad or “gifted” out loud, on screen and in the caption. A free treatment counts as payment (FTC).",
  "No medical claims. Say how it felt and what you saw. Never promise results, and never say it is safe or has no side effects.",
  "A licensed provider only. Ask who will treat you and check their licence on your state's website before you book.",
  "Check the platform's rules first. TikTok, Instagram and YouTube limit paid posts about cosmetic treatments; turn on the paid-partnership label.",
  "Prescription drugs (Botox and the like): the drug maker can't pay you like a lipstick brand. A clinic can give you a treatment for honest content.",
  "Sign their photo release and consent forms, and keep a copy.",
];

const TRAVEL_RE = /\b(trip|travel|abroad|vacation|holiday abroad|resort|cruise|island|flight|fly|spring break|getaway|honeymoon|retreat|tour|tourism|overseas|caribbean|europe|asia|seoul|korea|mexico|bali)\b/i;

// ---------- the to-do list, worked back from the month

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The day the experience starts: the 1st of her month, or ~3 months out when she isn't sure. */
export function startDay(whenMonth: string, todayIso: string): string {
  return validMonth(whenMonth) ? `${whenMonth}-01` : addDays(todayIso, 90);
}

/** Pitch by: brands plan ahead (trips ~4 months, events ~2, a treatment ~1), never sooner than a week. */
export function pitchBy(o: { whenMonth: string; today: string; medical: boolean; kind: SponsorKind; title: string }): string {
  const start = startDay(o.whenMonth, o.today);
  const travel = TRAVEL_RE.test(o.title);
  const lead = o.kind === "event" ? 60 : travel ? 120 : o.medical ? 30 : 60;
  const ideal = addDays(start, -lead);
  const soonest = addDays(o.today.slice(0, 10), 7);
  return ideal < soonest ? soonest : ideal;
}

/** The dated plan. Every date works back from the month; none lands before today. */
export function todoPlan(o: { whenMonth: string; today: string; medical: boolean; kind: SponsorKind; title: string }): SponsorTodo[] {
  const today = o.today.slice(0, 10);
  const start = startDay(o.whenMonth, today);
  const pitch = pitchBy(o);
  const notBefore = (d: string) => (d < today ? today : d);
  const travel = TRAVEL_RE.test(o.title);
  const dated: SponsorTodo[] = [];
  const undated: SponsorTodo[] = [];
  const add = (id: string, text: string, by: string | null, label: string | null = null) => (by ? dated : undated).push({ id, text, by: by ? notBefore(by) : null, label });

  add("kit", "Publish your media kit with your newest numbers", addDays(pitch, -14));
  add("proof", o.kind === "event" ? "Post one video from a past event, so sponsors see what they get" : "Post one video like this before you pitch (proof it fits your page)", addDays(pitch, -7));
  add("pitch", "Pitch your top 5 brands", pitch);
  add("follow", "Send one polite follow-up to anyone who hasn't replied", addDays(pitch, 14));
  if (o.medical) {
    add("consult", "See a licensed doctor for a consult before you book anything", addDays(start, -21));
    add("licence", "Check the provider's licence on your state's website", addDays(pitch, -3));
    add("consent", "Sign their photo release and consent forms; keep a copy", addDays(start, -1));
  }
  if (travel && o.kind === "experience") add("passports", "Passports for everyone, valid 6 months past the trip", addDays(start, -60));
  if (o.kind === "event") {
    add("confirm", "Confirm the date, the place and what each sponsor gives, in writing", addDays(start, -21));
    add("after", "Send each sponsor the photos and your numbers after the event", addDays(start, 14));
  }
  add("ask", o.kind === "event" ? "Know your ask: products, a prize, a venue or a fee for a sponsor's name on the event" : "Know your ask: the experience free (comped) for 3–4 videos, or a fee per video", null, "Tip");
  add("contract", "Get it in writing: what you post, posting dates, usage rights, at most 2 rounds of edits", null, "When a yes comes");
  add("disclose", "Label every paid or free post #ad or “Paid partnership”", null, "Always");
  dated.sort((a, b) => (a.by! < b.by! ? -1 : a.by! > b.by! ? 1 : 0));
  return [...dated, ...undated];
}

/** The built-in video ideas when the free model gives none: three plain shapes in her own words. */
export function baselineVideos(title: string, kind: SponsorKind): SponsorVideo[] {
  const t = title.trim() || (kind === "event" ? "the event" : "the experience");
  if (kind === "event") {
    return [
      { id: "v1", title: `Getting ready for ${t}`, format: "Set up with me · 30 sec", forBrand: null, deal: "For sponsors", hook: "From empty room to ready in 30 seconds.", shots: ["the empty space", "setting up, sped up", "sponsor products in place", "the finished room held for 2 seconds"] },
      { id: "v2", title: `${t}: the moment it all came together`, format: "Reveal · 20 sec", forBrand: null, deal: "For sponsors", hook: "Wait for the reveal.", shots: ["guests arriving", "one wide shot", "close-ups of the details", "a thank-you line to the sponsors"] },
      { id: "v3", title: "What it took to pull this off", format: "Talking to camera · 45 sec", forBrand: null, deal: "Your own", hook: "Here is what it really took.", shots: ["you to camera", "behind-the-scenes clips", "the finished event"] },
    ];
  }
  return [
    { id: "v1", title: `Get ready with me: ${t}`, format: "GRWM · 30–45 sec", forBrand: null, deal: "Paid post", hook: `Getting ready for ${t.toLowerCase()}, come with me.`, shots: ["the place, wide", "vanity or mirror close-ups", "the outfit", "one line to camera"] },
    { id: "v2", title: `POV: ${t}`, format: "POV · 20 sec", forBrand: null, deal: "Gifted", hook: `POV: you finally booked ${t.toLowerCase()}.`, shots: ["arriving", "the best moment", "a detail only you would notice", "walking out"] },
    { id: "v3", title: `Honest review: ${t}`, format: "Talking to camera · 45 sec", forBrand: null, deal: "Your own", hook: "Here is the honest version.", shots: ["you to camera", "what it cost", "the one thing you'd change"] },
  ];
}
