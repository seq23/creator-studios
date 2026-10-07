// The studio owner's session cookie for route tests. Every studio logs in with the email code (no
// "open" mode exists), so a test that drives the API as the owner holds a real, signed session:
// the same rows and cookie the login makes (worker/lib/auth.ts createSession), nothing bypassed.
import type { Env } from "@worker/env";
import { signSession } from "@worker/lib/crypto";

const cache = new WeakMap<object, string>();

export async function ownerCookie(env: Env): Promise<string> {
  const hit = cache.get(env.DB as object);
  if (hit) return hit;
  const email = env.OWNER_EMAIL.trim().toLowerCase();
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  const userId = existing?.id ?? "usr_test_owner";
  if (!existing) await env.DB.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'owner')").bind(userId, email).run();
  const sid = `ses_test_${Math.random().toString(36).slice(2, 12)}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(sid, userId, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run();
  const cookie = `ss_session=${await signSession(env.SESSION_SECRET, sid)}`;
  cache.set(env.DB as object, cookie);
  return cookie;
}
