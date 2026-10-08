// Practice mode, per service (studio brief §3). A studio's keys are read from encrypted storage
// FIRST (Setup → pasted, AES-GCM in D1 connections.secret_enc), then from Worker secrets (how a
// studio the host runs on the host's own accounts gets them). A service with neither runs in
// practice mode: clearly labelled in the app (Shell banner + Setup), never an error.
//
// hydrate() runs once per request and per cron tick (worker/index.ts): it overlays the stored keys
// onto the env names the rest of the Worker already reads (RESEND_API_KEY, YOUTUBE_API_KEY,
// GOOGLE_CLIENT_*, META_APP_*, GITHUB_DISPATCH_TOKEN + GITHUB_REPO, OPENROUTER_ / FIRECRAWL_ / HUNTER_API_KEY) and lists the services still in
// practice in env.PRACTICE. Nothing here logs a key.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { decryptSecret } from "./crypto";
import { hostBase } from "./hostKeys";
import { parseJson } from "./db";
import { log } from "./log";
import { SETUP_STEPS, type SetupServiceId } from "@shared/setup";

type Row = { service: string; status: string; secret_enc: string | null; meta: string | null };

/** Stored value of a multi-field step (JSON) or a bare key. */
function fieldsOf(raw: string): Record<string, string> {
  const t = raw.trim();
  if (t.startsWith("{")) return parseJson<Record<string, string>>(t, {});
  return { key: t };
}

/** The env overlay a stored value gives, by service. Pure. */
export function overlayFor(service: SetupServiceId, raw: string): Partial<Env> {
  const f = fieldsOf(raw);
  switch (service) {
    case "resend":
      // Her own Resend replaces the host's whole sender: her From (or Resend's test sender), no host reply-to.
      return { RESEND_API_KEY: f.key, RESEND_FROM: f.from || undefined, RESEND_REPLY_TO: undefined };
    case "openrouter":
      return { OPENROUTER_API_KEY: f.key };
    case "firecrawl":
      return { FIRECRAWL_API_KEY: f.key };
    case "hunter":
      return { HUNTER_API_KEY: f.key };
    case "youtube_api":
      return { YOUTUBE_API_KEY: f.key };
    case "google_app":
      return f.client_id && f.client_secret ? { GOOGLE_CLIENT_ID: f.client_id, GOOGLE_CLIENT_SECRET: f.client_secret } : {};
    case "meta_app":
      return f.app_id && f.app_secret ? { META_APP_ID: f.app_id, META_APP_SECRET: f.app_secret } : {};
    case "github":
      return f.token && f.repo ? { GITHUB_DISPATCH_TOKEN: f.token, GITHUB_REPO: f.repo } : {};
    default:
      return {};
  }
}

/** Whether the env (after the overlay) can run this service for real. Pure. */
export function hasEnvKey(env: Partial<Env>, service: SetupServiceId): boolean {
  switch (service) {
    case "resend":
      return !!env.RESEND_API_KEY;
    case "openrouter":
      return !!env.OPENROUTER_API_KEY;
    case "firecrawl":
      return !!env.FIRECRAWL_API_KEY;
    case "hunter":
      return !!env.HUNTER_API_KEY;
    case "youtube_api":
      return !!env.YOUTUBE_API_KEY;
    case "google_app":
      return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    case "meta_app":
      return !!(env.META_APP_ID && env.META_APP_SECRET);
    case "github":
      return !!(env.GITHUB_DISPATCH_TOKEN && env.GITHUB_REPO);
    default:
      return false;
  }
}

/** Services whose only home is D1 (pasted keys); the rest can also come from a Worker secret. */
const ENV_BACKED = new Set<SetupServiceId>(SETUP_STEPS.filter((s) => s.secrets.length).map((s) => s.id));

/**
 * A copy of env with stored keys laid over the secrets, and PRACTICE filled. Never throws: a
 * missing table (a fresh local D1) or an unreadable row leaves that service on its secret.
 */
export async function hydrate(env: Env): Promise<Env> {
  // A client studio loses the host fallback secrets here, before anything else reads the env.
  const out: Env = hostBase(env);
  let rows: Row[] = [];
  try {
    rows = (await env.DB.prepare("SELECT service, status, secret_enc, meta FROM connections").all<Row>()).results ?? [];
  } catch {
    rows = [];
  }
  const stored = new Map<string, Row>();
  for (const r of rows) if (r.secret_enc && r.status !== "disconnected") stored.set(r.service, r);
  for (const s of SETUP_STEPS) {
    if (!ENV_BACKED.has(s.id)) continue;
    const row = stored.get(s.id);
    if (!row?.secret_enc) continue;
    try {
      Object.assign(out, overlayFor(s.id, await decryptSecret(env.SECRETS_KEY, row.secret_enc)));
    } catch {
      log.warn("practice.decrypt_failed", { service: s.id });
    }
  }
  out.PRACTICE = practiceList(out, new Set(stored.keys()));
  return out;
}

/** The services in practice mode, given the hydrated env and which services have a stored key. Pure. */
export function practiceList(env: Partial<Env>, storedServices: Set<string>): SetupServiceId[] {
  if (env.FAKE_SERVICES === "1") return [];
  return SETUP_STEPS.filter((s) => (ENV_BACKED.has(s.id) ? !hasEnvKey(env, s.id) : !storedServices.has(s.id))).map((s) => s.id);
}

/**
 * True when this service should use its stand-in: every service in local/e2e (FAKE_SERVICES "1"),
 * or this one in a studio until its key is set. The single question every vendor factory asks.
 */
export function practice(env: Pick<Env, "FAKE_SERVICES" | "PRACTICE">, service: SetupServiceId): boolean {
  return fakeServices(env as Env) || (env.PRACTICE ?? []).includes(service);
}

/** True only for the practice case (a real studio with no key), not for local fakes: the UI labels it. */
export function inPracticeOnly(env: Pick<Env, "FAKE_SERVICES" | "PRACTICE">, service: SetupServiceId): boolean {
  return !fakeServices(env as Env) && (env.PRACTICE ?? []).includes(service);
}
