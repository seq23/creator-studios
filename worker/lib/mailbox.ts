// Who a studio email may address, as a mailbox (not a string): the host developer's address
// (DEVELOPER_EMAIL) in any spelling Gmail delivers to her (capitals, dots, a +tag, googlemail.com).
//
// Owner's rulings:
//  - 1 Nov 2026: "I don't need creator studio emails at all, not even pnp studio".
//  - 2 Nov 2026: "pnp is different since im running it u can keep that one". So Porch & Party
//    Studio (slug sample1, HOST_EMAIL_STUDIOS) still mails her and replies reach her; every other
//    studio never addresses her: not as a recipient
//    and not as the reply-to. Their reply-to is the studio's own owner, or none.
// Pure. Pinned by tests/unit/notify-override.test.ts.
import type { Env } from "../env";

/** The studios whose mail still reaches the host developer (owner's ruling 2 Nov 2026: she runs Porch & Party). */
export const HOST_EMAIL_STUDIOS: readonly string[] = Object.freeze(["sample1"]);

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** One mailbox for an address: lower case, no +tag, and on Gmail no dots and one domain. Pure. */
export function mailboxOf(address: string): string {
  const a = address.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
  const at = a.lastIndexOf("@");
  if (at < 1) return a;
  let local = a.slice(0, at).split("+")[0];
  let domain = a.slice(at + 1);
  if (GMAIL.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** True when both addresses deliver to the same mailbox. Empty never matches. Pure. */
export function sameMailbox(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return mailboxOf(a) === mailboxOf(b);
}

/** Does this studio's mail still go to the host developer? Only the pinned HOST_EMAIL_STUDIOS. */
export const hostGetsStudioEmail = (env: Pick<Env, "STUDIO_SLUG">): boolean => HOST_EMAIL_STUDIOS.includes((env.STUDIO_SLUG ?? "").trim().toLowerCase());

/** True when this address is the host developer's and this studio may not mail her. */
export function isBlockedHost(env: Pick<Env, "STUDIO_SLUG" | "DEVELOPER_EMAIL">, address: string | null | undefined): boolean {
  return !hostGetsStudioEmail(env) && sameMailbox(address, env.DEVELOPER_EMAIL);
}

/**
 * The reply-to for mail sent on the host's Resend: Porch & Party keeps the host developer (she runs
 * it); every other studio gets its own owner's address, or none when that is the host's mailbox.
 */
export function studioReplyTo(env: Pick<Env, "STUDIO_SLUG" | "DEVELOPER_EMAIL" | "OWNER_EMAIL">): string | null {
  if (hostGetsStudioEmail(env)) return env.DEVELOPER_EMAIL?.trim() || null;
  const owner = (env.OWNER_EMAIL ?? "").trim();
  if (!owner || isBlockedHost(env, owner)) return null;
  return owner;
}
