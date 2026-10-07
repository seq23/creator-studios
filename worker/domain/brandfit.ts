// Brand finder rules (section 12b.2–3), pure so they are unit-tested:
//   * anything on her off-limits list is never suggested;
//   * contacts are public business contacts only: an application form, or a role address
//     (partnerships@, pr@ …) at a business domain, always with the page it was found on;
//     never a personal or free-mail address, never a guess;
//   * follow-up scheduling after she marks a pitch sent.
import { FOLLOWUP_DAYS, nextFollowup } from "./deals";

// ---------- off-limits ----------

/** Split the Brand Profile's "Off-limits topics" section into lower-case terms. */
export function offLimitsTerms(section: string | null | undefined): string[] {
  if (!section) return [];
  return [
    ...new Set(
      section
        .split(/[\n,;•·]+|\band\b|\bor\b/i)
        .map((t) =>
          t
            .toLowerCase()
            .replace(/^[\s\-*\d.)]+/, "")
            .replace(/^(no|never|avoid|nothing about|not)\s+/, "")
            .replace(/[.!"“”]+$/g, "")
            .trim(),
        )
        .filter((t) => t.length >= 3 && t.length <= 60),
    ),
  ];
}

export interface BrandLike {
  name: string;
  website?: string | null;
  categories?: string[];
  fit_reasons?: string[];
  why_now?: string | null;
}

function words(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** True when the brand touches an off-limits term (whole-word match, plural-tolerant). */
export function violatesOffLimits(brand: BrandLike, terms: string[]): string | null {
  const hay = words([brand.name, brand.website ?? "", ...(brand.categories ?? []), ...(brand.fit_reasons ?? []), brand.why_now ?? ""].join(" "));
  for (const t of terms) {
    const w = words(t).trim();
    if (!w) continue;
    const stem = w.replace(/s$/, "");
    if (hay.includes(` ${w} `) || hay.includes(` ${stem} `) || hay.includes(` ${stem}s `)) return t;
  }
  return null;
}

// ---------- contacts ----------

export const ROLE_LOCAL_PARTS = [
  "partnerships",
  "partnership",
  "partners",
  "partner",
  "collab",
  "collabs",
  "collaborations",
  "influencer",
  "influencers",
  "creators",
  "creator",
  "ambassadors",
  "ambassador",
  "affiliates",
  "affiliate",
  "sponsorships",
  "sponsorship",
  "pr",
  "press",
  "media",
  "marketing",
  "brand",
  "brands",
  "social",
  "hello",
  "hi",
  "info",
  "contact",
  "team",
  "talent",
  "business",
  "bookings",
] as const;

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "mail.com"]);

export type ContactKind = "form" | "role_email" | "agency";

export interface ContactCandidate {
  kind: ContactKind;
  value: string;
  found_on_url: string;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** A role address at a business domain. Personal-looking local parts are refused. */
export function isRoleEmail(email: string): boolean {
  const m = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(email.trim());
  if (!m) return false;
  const local = m[1].toLowerCase().split("+")[0];
  const domain = m[2].toLowerCase();
  if (FREE_MAIL.has(domain)) return false;
  // "partnerships", "us-partnerships", "pr.team", "creators_uk" … the role word must be a whole part.
  const parts = local.split(/[._-]/);
  return parts.some((p) => (ROLE_LOCAL_PARTS as readonly string[]).includes(p));
}

/** Returns a reason when the contact must not be stored, or null when it is safe. */
export function contactProblem(c: ContactCandidate): string | null {
  if (!c.found_on_url || !isHttpUrl(c.found_on_url)) return "Every contact needs the public page it was found on.";
  if (c.kind === "form") return isHttpUrl(c.value) ? null : "An application form must be a web link.";
  if (c.kind === "role_email" || c.kind === "agency") {
    if (isHttpUrl(c.value)) return c.kind === "agency" ? null : "That is a link, not an email address.";
    return isRoleEmail(c.value) ? null : "Only public business addresses like partnerships@ or pr@ are allowed, never a personal one.";
  }
  return "Unknown contact type.";
}

/** Contact finder priority (section 12b.3): application form → role email → agency. */
export function sortContacts<T extends { kind: ContactKind }>(contacts: T[]): T[] {
  const rank: Record<ContactKind, number> = { form: 0, role_email: 1, agency: 2 };
  return [...contacts].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// ---------- matching ----------

/** Dedupe key: website host without www, else the lower-cased name. */
export function brandKey(b: { name: string; website?: string | null }): string {
  if (b.website) {
    try {
      return new URL(b.website).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      /* fall through */
    }
  }
  return b.name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function clampFit(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const v = x > 1 ? x / 100 : x; // accept 0–1 or 0–100
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

// ---------- follow-ups ----------

/** How many follow-ups she has already sent (0–3), read back from the stored next date. */
export function followupsDone(sentAt: string, nextAt: string | null): number {
  if (!nextAt) return FOLLOWUP_DAYS.length;
  for (let i = 0; i < FOLLOWUP_DAYS.length; i++) if (nextAt === nextFollowup(sentAt, i)) return i;
  // A date that matches none (moved by hand): the pending one is the first whose next day it is still before.
  const t = new Date(nextAt).getTime();
  for (let i = 0; i < FOLLOWUP_DAYS.length - 1; i++) if (t < new Date(nextFollowup(sentAt, i + 1)!).getTime()) return i;
  return FOLLOWUP_DAYS.length - 1;
}

/** After she sends the follow-up that is due, the next one (day 12, then day 19), or none: stop after 3. */
export function afterFollowupSent(sentAt: string, nextAt: string | null): string | null {
  const done = followupsDone(sentAt, nextAt);
  if (done >= FOLLOWUP_DAYS.length) return null;
  return nextFollowup(sentAt, done + 1);
}

/** "When did you send it?" must be a real date, not in the future, within the last 60 days. */
export function validSentAt(input: string | null | undefined, now: Date): string | null {
  if (!input) return now.toISOString();
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime() + 60_000) return null;
  if (d.getTime() < now.getTime() - 60 * 86400_000) return null;
  return d.toISOString();
}
