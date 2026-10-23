// A studio's content rules (studios/<slug>.json "contentRules", var CONTENT_RULES): words it never
// says, no street address or house number, no customer face, and prices only from its one price
// list. Enforced in code, never by a person remembering: the Worker checks every caption when it is
// written, edited and again the moment it would post (worker/lib/photoPosts.ts), and the photo job
// blurs faces and house numbers (jobs/photopack.py). A studio with no rules gets NO_RULES (Hadiyah
// and the samples). Pure; the app uses the same check to explain a refusal before she saves.
// Guard: tests/unit/content-rules.test.ts (each rule proven to fail when broken).

export interface Price {
  name: string;
  usd: number;
}

export interface ContentRules {
  /** Words never written, matched inside longer words too ("uninsured" is refused with "insured"). */
  banWords: string[];
  /** No street address or house number in any caption. */
  blockAddresses: boolean;
  /** No face in any photo: the photo job blurs them; an unchecked photo never posts. */
  blockFaces: boolean;
  /** When set, every dollar amount must be one of these (the studio's one price list). */
  prices: Price[];
  /**
   * The owner's own face (layer 5, jobs/protect.py): "show" when her Brand Profile allows it (only
   * the person working or talking to the camera, never a customer), "blur" to blur every face.
   */
  ownerFace: "show" | "blur";
}

export const NO_RULES: ContentRules = { banWords: [], blockAddresses: false, blockFaces: false, prices: [], ownerFace: "show" };

/** The studio's rules from its var. A malformed value fails CLOSED: every rule on, no price allowed. */
export function parseRules(raw: string | undefined | null): ContentRules {
  if (!raw || !raw.trim()) return NO_RULES;
  try {
    const j = JSON.parse(raw) as Partial<ContentRules>;
    const prices = Array.isArray(j.prices) ? j.prices.filter((p): p is Price => !!p && typeof p.name === "string" && Number.isFinite(p.usd) && p.usd > 0) : [];
    return {
      banWords: Array.isArray(j.banWords) ? j.banWords.filter((w): w is string => typeof w === "string" && w.trim().length > 0).map((w) => w.trim().toLowerCase()) : [],
      blockAddresses: j.blockAddresses === true,
      blockFaces: j.blockFaces === true,
      prices,
      ownerFace: j.ownerFace === "blur" ? "blur" : "show",
    };
  } catch {
    return { banWords: ["insured"], blockAddresses: true, blockFaces: true, prices: [], ownerFace: "blur" };
  }
}

/** True when any rule is on (the photo check then has to have run before anything posts). */
export const hasRules = (r: ContentRules): boolean => r.banWords.length > 0 || r.blockAddresses || r.blockFaces || r.prices.length > 0;

const SUFFIX =
  "st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cv|cove|pl|place|way|cir|circle|pkwy|parkway|ter|terrace|trl|trail|hwy|highway|pike|loop|row|sq|square|xing|crossing|cres|crescent|bend|run|path|alley";
/** "1234 Oak Hollow Cv", "55 N. Main St." — a number, up to four words, a street word. */
const STREET = new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[nsew]\\.?\\s+)?(?:[a-z0-9'.-]+\\s+){0,4}(?:${SUFFIX})\\b\\.?`, "i");
/** "house number 42", "home #42", "door no. 42", "apt 3" (a hashtag like #901 is not an address). */
const HOUSE_NUMBER = /\b(?:house|home|door|unit|apt|apartment)\s*(?:number|num|no\.?|#)?\s*#?\s*\d{1,6}\b/i;
/** "$1,050", "$ 900.00", "1050 dollars", "USD 900" */
const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b|\busd\s?(\d[\d,]*(?:\.\d{1,2})?)/gi;

export const money = (usd: number): string => `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The plain sentence naming the studio's price list. */
export const priceList = (r: ContentRules): string => r.prices.map((p) => `${p.name} ${money(p.usd)}`).join(", ");

/**
 * Every rule a piece of text breaks, as plain sentences she can act on (empty = fine). Pure.
 * The same function runs on a fresh AI caption, on her edit and at the moment of posting.
 */
export function textProblems(text: string, r: ContentRules): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const lower = t.toLowerCase();
  for (const w of r.banWords) if (lower.includes(w)) out.push(`It says “${w}”. This studio never says that. Take it out and try again.`);
  if (r.blockAddresses && (STREET.test(t) || HOUSE_NUMBER.test(t))) out.push("It has a street address or house number. Take it out so no customer's home can be found.");
  if (r.prices.length) {
    const allowed = new Set(r.prices.map((p) => Math.round(p.usd * 100)));
    for (const m of t.matchAll(MONEY)) {
      const n = Math.round(Number((m[1] ?? m[2] ?? m[3] ?? "").replace(/,/g, "")) * 100);
      if (!allowed.has(n)) {
        out.push(`${m[0].trim()} is not on the price list. Use only: ${priceList(r)}.`);
        break;
      }
    }
  } else if (hasRules(r) && MONEY.test(t)) {
    out.push("It names a price, and this studio has no price list. Take the price out.");
  }
  MONEY.lastIndex = 0;
  return out;
}

/** The label a post carries when its picture or video was made or moved by the studio's tools. */
export const AI_LABEL = "Made with AI";

/** The caption with the AI label on the end, once (never doubled). Pure. */
export function withAiLabel(caption: string, aiMade: boolean): string {
  const c = String(caption ?? "").trim();
  if (!aiMade || /made with ai/i.test(c)) return c;
  return c ? `${c}\n\n${AI_LABEL}` : AI_LABEL;
}
