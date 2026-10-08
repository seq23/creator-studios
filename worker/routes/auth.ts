// Email one-time code login (section 13: "no passwords"), in EVERY studio (never open). Only the
// owner email, the host developer (DEVELOPER_EMAIL) and the optional helper can request a code. Codes: 6 digits, 10 minutes, 5 attempts,
// sent through the platform sender (services/email.ts senderFor). A sample studio's owner email is
// claimed once through its first-login invite link (POST /invite).
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { fakeServices } from "../env";
import { allowedRole, createSession, developerEmail, ownerEmail, destroySession, ensureUser, meFor, userFromRequest } from "../lib/auth";
import { sha256Hex } from "../lib/crypto";
import { fail, isEmail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { setSetting } from "../lib/db";
import { log } from "../lib/log";
import { emailFrame, sendEmail } from "../services/email";

export const auth = new Hono<{ Bindings: Env; Variables: Vars }>();


const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function sixDigits(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

/** Mint, store and send a login code. Shared by /request and /invite. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendCode(c: Context<{ Bindings: Env; Variables: Vars }, any>, email: string) {
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?")
    .bind(email, new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 5) return fail(c, 429, "Too many codes requested. Wait 15 minutes and try again.");
  const code = sixDigits();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await c.env.DB.prepare("INSERT INTO login_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(newId("otp"), email, await sha256Hex(`${email}:${code}`), expires)
    .run();
  const { html, text } = emailFrame(`Your ${c.env.APP_NAME} code`, [`Your login code is ${code}.`, "It works for 10 minutes. If you did not ask for it, ignore this email."]);
  const sent = await sendEmail(c.env, { kind: "login_code", to: [email], subject: `${code} is your ${c.env.APP_NAME} code`, html, text });
  if (!sent.ok) return fail(c, 502, "We could not send your code just now. Try again in a minute; if it keeps failing, the email service needs fixing.", "i-didnt-get-an-email");
  log.info("auth.code.sent", { accepted: !!sent.providerId });
  return c.json({ ok: true, ...(fakeServices(c.env) ? { dev_code: code } : {}) });
}

/** Is there an owner yet? A sample studio has none until its invite link is used. */
auth.get("/status", async (c) => c.json({ hasOwner: !!(await ownerEmail(c.env)), appName: c.env.APP_NAME }));

/**
 * First login through the invite link: the token (only its SHA-256 is stored) is good once, for
 * 14 days, and only while the studio has no owner. It records her email as the owner and sends
 * her first code.
 */
auth.post("/invite", async (c) => {
  const body = await readJson<{ token?: string; email?: string }>(c);
  const email = body?.email?.trim().toLowerCase();
  const token = body?.token?.trim() ?? "";
  if (!isEmail(email)) return fail(c, 400, "Type the email address you want to log in with.");
  if (token.length < 20 || token.length > 200) return fail(c, 400, "This invite link is not complete. Open the whole link from your invite.", "log-in");
  // The host developer never claims a studio: she just gets a code, and the link stays unused for the owner.
  const dev = developerEmail(c.env);
  if (dev && email === dev) return sendCode(c, email);
  const hash = await sha256Hex(`invite:${token}`);
  const row = await c.env.DB.prepare("SELECT token_hash, expires_at, used_at, used_by FROM invites WHERE token_hash = ?").bind(hash).first<{ expires_at: string; used_at: string | null; used_by: string | null }>();
  if (!row) return fail(c, 404, "This invite link is not valid. Ask for a new one.", "log-in");
  if (row.used_at) {
    // The same person opening her link again just gets a code.
    if (row.used_by === email && (await ownerEmail(c.env)) === email) return sendCode(c, email);
    return fail(c, 409, "This invite link was already used. Log in with your email instead.", "log-in");
  }
  if (row.expires_at < nowIso()) return fail(c, 409, "This invite link has expired. Ask for a new one.", "log-in");
  const current = await ownerEmail(c.env);
  if (current && current !== email) return fail(c, 409, "This studio already has an owner. Log in with that email.", "log-in");
  await c.env.DB.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ?").bind(nowIso(), email, hash).run();
  await setSetting(c.env.DB, "owner_email", email);
  log.info("auth.invite.claimed");
  return sendCode(c, email);
});

auth.post("/request", async (c) => {
  const body = await readJson<{ email?: string }>(c);
  const email = body?.email?.trim().toLowerCase();
  if (!isEmail(email)) return fail(c, 400, "Type the email address you use for this dashboard.");
  const role = await allowedRole(c.env, email);
  // Same answer whether or not the address is allowed, so the form never reveals who can log in.
  if (!role) {
    log.warn("auth.request.denied");
    return c.json({ ok: true });
  }
  return sendCode(c, email);
});

auth.post("/verify", async (c) => {
  const body = await readJson<{ email?: string; code?: string }>(c);
  const email = body?.email?.trim().toLowerCase();
  const code = body?.code?.replace(/\D/g, "");
  if (!isEmail(email) || !code || code.length !== 6) return fail(c, 400, "Enter the 6-digit code from your email.");
  const row = await c.env.DB.prepare("SELECT id, code_hash, expires_at, attempts, used_at FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1")
    .bind(email)
    .first<{ id: string; code_hash: string; expires_at: string; attempts: number; used_at: string | null }>();
  if (!row || row.used_at || row.expires_at < nowIso()) return fail(c, 401, "That code has expired. Request a new one.");
  if (row.attempts >= MAX_ATTEMPTS) return fail(c, 429, "Too many tries. Request a new code.");
  const ok = row.code_hash === (await sha256Hex(`${email}:${code}`));
  if (!ok) {
    await c.env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return fail(c, 401, "That code does not match. Check the email and try again.");
  }
  const role = await allowedRole(c.env, email);
  if (!role) return fail(c, 403, "This email is not allowed to log in.");
  await c.env.DB.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  const user = await ensureUser(c.env, email, role);
  await createSession(c, user);
  log.info("auth.login", { role });
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const user = await userFromRequest(c);
  if (!user) return fail(c, 401, "Please log in.", "log-in");
  return c.json(await meFor(c.env, user));
});
