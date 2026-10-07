// Email through Resend (section 11). Two senders (studio brief §4):
//   - login codes go through the PLATFORM sender (PLATFORM_RESEND_API_KEY / PLATFORM_EMAIL_FROM,
//     the host's Resend): a new studio has no email service yet, and she must be able to log in.
//     This is the ONLY piece shared across studios (README "Platform sender").
//   - every other email goes through the studio's OWN Resend (Setup → Email, stored encrypted;
//     else the RESEND_API_KEY Worker secret). Without one, Email is in practice mode: the message
//     is recorded in emails_sent, never sent, and the health light says so.
// With FAKE_SERVICES=1 nothing leaves the Worker; login codes come back to the caller so local
// development and tests can log in without a mailbox.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { newId } from "../lib/ids";
import { setHealth } from "../lib/db";
import { log } from "../lib/log";
import { practice } from "../lib/practice";

export type EmailKind = "time_to_dump" | "clips_ready" | "posting_problem" | "connection_needs_you" | "weekly_recap" | "login_code" | "brief_ready";

export interface OutgoingEmail {
  kind: EmailKind;
  to: string[];
  subject: string;
  html: string;
  text: string;
  refId?: string | null;
}

export interface EmailResult {
  ok: boolean;
  providerId: string | null;
  error: string | null;
}

/** Resend's shared test sender: delivers only to the Resend account's own address. */
const fromDefault = (env: Pick<Env, "APP_NAME">) => `${(env.APP_NAME || "Studio").replace(/[<>"]/g, "")} <onboarding@resend.dev>`;

/** Which sender a message uses. Pure: login codes → the platform sender; everything else → the studio's own. */
export function senderFor(env: Pick<Env, "APP_NAME" | "RESEND_API_KEY" | "RESEND_FROM" | "PLATFORM_RESEND_API_KEY" | "PLATFORM_EMAIL_FROM">, kind: EmailKind): { key: string | null; from: string; platform: boolean } {
  if (kind === "login_code") return { key: env.PLATFORM_RESEND_API_KEY ?? null, from: env.PLATFORM_EMAIL_FROM || fromDefault(env), platform: true };
  return { key: env.RESEND_API_KEY ?? null, from: env.RESEND_FROM || fromDefault(env), platform: false };
}

async function sendReal(env: Env, mail: OutgoingEmail): Promise<EmailResult> {
  const sender = senderFor(env, mail.kind);
  if (!sender.key) return { ok: false, providerId: null, error: sender.platform ? "The login email service is not set up on this studio." : "Resend is not connected." };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${sender.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: sender.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) return { ok: false, providerId: null, error: resendRefusal(res.status, await res.text().catch(() => "")) };
  const data = (await res.json()) as { id?: string };
  return { ok: true, providerId: data.id ?? null, error: null };
}

/**
 * Resend's refusal in plain words. The common one on a new account: test mode delivers only to
 * the Resend account's own address until a sending domain is verified and used as `from`.
 * Never echoes Resend's message (it names the account's address).
 */
export function resendRefusal(status: number, body: string): string {
  if (status === 401) return "Resend says this key is not valid.";
  if (status === 403 && /only send testing emails|verify a domain/i.test(body)) return "Resend is in test mode: it only delivers to the Resend account's own address until a sending domain is verified.";
  if (status === 429) return "Resend says we sent too many emails; it will work again shortly.";
  return `Resend answered ${status}`;
}

export async function sendEmail(env: Env, mail: OutgoingEmail): Promise<EmailResult> {
  // Practice: the studio has no Resend of its own yet. Recorded (provider id practice_…), not sent.
  const practiceMail = mail.kind !== "login_code" && !fakeServices(env) && practice(env, "resend");
  const result = fakeServices(env)
    ? { ok: true, providerId: `fake_${newId("em")}`, error: null }
    : practiceMail
      ? { ok: true, providerId: `practice_${newId("em")}`, error: null }
      : await sendReal(env, mail);
  for (const to of mail.to) {
    await env.DB.prepare("INSERT INTO emails_sent (id, kind, to_email, subject, ref_id, provider_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("eml"), mail.kind, to, mail.subject, mail.refId ?? null, result.providerId)
      .run();
  }
  log.info("email.send", { kind: mail.kind, recipients: mail.to.length, ok: result.ok });
  // A refused send turns the Email light red with the reason, so the health board never says
  // "Ready to send" while nothing arrives. The next good send turns it green again.
  if (practiceMail) await setHealth(env.DB, "Email (Resend)", "grey", "Practice mode · emails are listed here, not sent. Set up Email on Setup.", "setup-email");
  else if (!fakeServices(env) && mail.kind !== "login_code") {
    if (!result.ok) await setHealth(env.DB, "Email (Resend)", "red", `The last email was not delivered: ${result.error ?? "Resend did not answer"}`, "connect-resend");
    else await setHealth(env.DB, "Email (Resend)", "green", "Ready to send", null);
  }
  return result;
}

/** Plain, phone-friendly email frame. Every email says exactly what to click. */
export function emailFrame(title: string, lines: string[], cta?: { label: string; url: string }): { html: string; text: string } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f2;font-family:Helvetica,Arial,sans-serif;color:#1b1d21">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;margin:0 0 16px">${esc(title)}</h1>
${lines.map((l) => `<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${esc(l)}</p>`).join("")}
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:999px">${esc(cta.label)}</a></p>` : ""}
</div></body></html>`;
  const text = [title, "", ...lines, cta ? `\n${cta.label}: ${cta.url}` : ""].join("\n");
  return { html, text };
}
