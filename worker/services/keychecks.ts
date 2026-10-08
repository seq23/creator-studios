// "Check key" for the paste-a-key services on the Connect screen: Firecrawl, Hunter,
// Resend, OpenRouter, Buffer, ElevenLabs. Each returns ok + a plain sentence + meta for the card.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { getBuffer } from "./buffer";
import { getLlm } from "./openrouter";
import { getElevenLabs } from "./elevenlabs";
import { planMeta } from "../lib/premiumVoice";
import { editorClient } from "./editors";
import { editorDef, type ApiEditorId } from "../domain/editors";
import { vendorStatusError } from "../lib/vendorStatus";

export { vendorStatusError };

export interface KeyCheck {
  ok: boolean;
  error: string | null;
  meta: Record<string, unknown>;
}

export async function checkFirecrawl(env: Env, key: string): Promise<KeyCheck> {
  if (fakeServices(env)) return key.startsWith("bad") ? { ok: false, error: "Firecrawl says this key is not valid.", meta: {} } : { ok: true, error: null, meta: { credits_left: 980 } };
  const res = await fetch("https://api.firecrawl.dev/v1/team/credit-usage", { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return { ok: false, error: vendorStatusError("Firecrawl", res.status), meta: {} };
  const data = (await res.json()) as { data?: { remaining_credits?: number } };
  return { ok: true, error: null, meta: { credits_left: data.data?.remaining_credits ?? null } };
}

export async function checkHunter(env: Env, key: string): Promise<KeyCheck> {
  if (fakeServices(env)) return key.startsWith("bad") ? { ok: false, error: "Hunter says this key is not valid.", meta: {} } : { ok: true, error: null, meta: { credits_left: 38, credits_total: 50 } };
  const res = await fetch(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`);
  if (!res.ok) return { ok: false, error: vendorStatusError("Hunter", res.status), meta: {} };
  const data = (await res.json()) as { data?: { requests?: { searches?: { used?: number; available?: number } } } };
  const used = data.data?.requests?.searches?.used ?? 0;
  const total = data.data?.requests?.searches?.available ?? 50;
  return { ok: true, error: null, meta: { credits_left: Math.max(0, total - used), credits_total: total } };
}

export async function checkOpenRouter(env: Env, key: string): Promise<KeyCheck> {
  const llm = await getLlm(env, key);
  const r = await llm.checkKey();
  return { ok: r.ok, error: r.error, meta: { model: "free" } };
}

export async function checkBufferKey(env: Env, key: string): Promise<KeyCheck> {
  const buffer = await getBuffer(env, key);
  const r = await buffer.checkKey();
  return { ok: r.ok, error: r.error, meta: { channels: r.channels } };
}

/**
 * ElevenLabs (premium voice): reads her plan. A key on a plan without cloning is accepted and
 * says so plainly; the built-in voice is used. `note` is the sentence the card and toast show.
 */
export async function checkElevenLabs(env: Env, key: string): Promise<KeyCheck & { note?: string }> {
  const client = await getElevenLabs(env, key);
  const r = await client!.subscription();
  if (!r.ok) {
    if (r.failure === "auth") return { ok: false, error: "ElevenLabs says this key is not valid.", meta: {} };
    return { ok: false, error: "ElevenLabs did not answer. Try Check key again in a minute.", meta: {} };
  }
  const note = r.plan.canClone ? "ElevenLabs connected. Your voice overs will use the premium voice." : "Your ElevenLabs plan does not include voice cloning; the built-in voice will be used.";
  return { ok: true, error: null, meta: planMeta(r.plan), note };
}

/**
 * A connected editor (docs/EDITORS.md): the key is checked with one real read of her account.
 * Credits are shown when the vendor's answer carries them; none of the five documents them, so
 * the card says where to see them instead. `note` is the sentence the card and toast show.
 */
export function checkEditor(editor: ApiEditorId) {
  return async (env: Env, key: string): Promise<KeyCheck & { note?: string }> => {
    const def = editorDef(editor)!;
    const r = await editorClient(env, editor, key).account();
    if (!r.ok) {
      if (r.failure === "auth") return { ok: false, error: `${def.name} says this key is not valid.`, meta: {} };
      if (r.failure === "credits") return { ok: false, error: `${def.name} says this account has no API credits left. Top up in ${def.name}, then Check key again.`, meta: {} };
      return { ok: false, error: `${def.name} did not answer. Try Check key again in a minute.`, meta: {} };
    }
    const meta: Record<string, unknown> = { plan: r.plan, credits_left: r.credits_left ?? undefined, credits_total: r.credits_total ?? undefined, reports_credits: r.credits_left !== null };
    const low = r.credits_left !== null && r.credits_total ? r.credits_left / r.credits_total < 0.1 : false;
    return { ok: true, error: null, meta: { ...meta, low }, note: `${def.name} connected. Pick it under Settings → Editing → Who edits.` };
  };
}

// ---------------------------------------------------------------- Setup probes (studio brief §3)
// Each "Test key" on Setup is ONE live, read-only request to the vendor: nothing is created,
// sent or changed. With FAKE_SERVICES (local, e2e) a value starting "bad" fails and anything else
// passes, so the screen is testable without accounts.

function fakeCheck(value: string, vendor: string, meta: Record<string, unknown> = {}): KeyCheck {
  return value.startsWith("bad") ? { ok: false, error: `${vendor} says this key is not valid.`, meta: {} } : { ok: true, error: null, meta };
}

/** Resend: list domains (read-only). A send-only key answers 401 "restricted_api_key": valid, just narrow. */
export async function checkResend(env: Env, key: string): Promise<KeyCheck> {
  if (fakeServices(env)) return fakeCheck(key, "Resend", { domains: [] });
  const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } });
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { data?: { name?: string; status?: string }[] };
    const verified = (data.data ?? []).filter((d) => d.status === "verified").map((d) => d.name ?? "").filter(Boolean);
    return { ok: true, error: null, meta: { domains: verified } };
  }
  const body = await res.text().catch(() => "");
  if (res.status === 401 && /restricted_api_key/.test(body)) return { ok: true, error: null, meta: { domains: null, sending_only: true } };
  return { ok: false, error: vendorStatusError("Resend", res.status), meta: {} };
}

/** YouTube Data API key: the video categories list (1 quota unit, public data, read-only). */
export async function checkYouTubeKey(env: Env, key: string): Promise<KeyCheck> {
  if (fakeServices(env)) return fakeCheck(key, "Google");
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=US&key=${encodeURIComponent(key)}`);
  if (res.ok) return { ok: true, error: null, meta: {} };
  const body = await res.text().catch(() => "");
  if (/API_KEY_INVALID|keyInvalid|API key not valid/i.test(body)) return { ok: false, error: "Google says this key is not valid.", meta: {} };
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(body)) return { ok: false, error: "The key works, but the YouTube Data API v3 is not turned on in that Google Cloud project. Enable it, then test again.", meta: {} };
  if (/API_KEY_SERVICE_BLOCKED|blocked/i.test(body)) return { ok: false, error: "This key is restricted to other APIs. Allow the YouTube Data API v3 on it, then test again.", meta: {} };
  return { ok: false, error: vendorStatusError("Google", res.status), meta: {} };
}

/**
 * Google OAuth client: trade a made-up code. A real client answers "invalid_grant" (the code is
 * wrong, the client is right); a wrong id or secret answers "invalid_client". Nothing is granted.
 */
export async function checkGoogleApp(env: Env, clientId: string, clientSecret: string): Promise<KeyCheck> {
  if (fakeServices(env)) return fakeCheck(clientSecret, "Google", { client_id: clientId });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code: "setup-probe", redirect_uri: `${env.PUBLIC_BASE_URL}/api/oauth/google/callback` }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (data.error === "invalid_grant" || data.error === "redirect_uri_mismatch") return { ok: true, error: null, meta: { client_id: clientId } };
  if (data.error === "invalid_client" || data.error === "unauthorized_client") return { ok: false, error: "Google says this Client ID or Client secret is wrong.", meta: {} };
  return { ok: false, error: `Google answered ${res.status}${data.error ? ` (${data.error})` : ""}. Try again in a minute.`, meta: {} };
}

/** Meta app: ask for an app token (client_credentials). Read-only; nothing about any user is touched. */
export async function checkMetaApp(env: Env, appId: string, appSecret: string): Promise<KeyCheck> {
  if (fakeServices(env)) return fakeCheck(appSecret, "Meta", { app_id: appId });
  const u = new URL("https://graph.facebook.com/oauth/access_token");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("client_secret", appSecret);
  u.searchParams.set("grant_type", "client_credentials");
  const res = await fetch(u.toString());
  if (res.ok) return { ok: true, error: null, meta: { app_id: appId } };
  if (res.status === 400 || res.status === 401) return { ok: false, error: "Meta says this App ID or App secret is wrong.", meta: {} };
  return { ok: false, error: vendorStatusError("Meta", res.status), meta: {} };
}

/** GitHub job runner: read the repository with the token (read-only) and confirm it can start jobs. */
export async function checkGithubRunner(env: Env, token: string, repo: string): Promise<KeyCheck> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "Type the repository as owner/name.", meta: {} };
  if (fakeServices(env)) return fakeCheck(token, "GitHub", { repo });
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "creator-studios", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (res.status === 401) return { ok: false, error: "GitHub says this token is not valid.", meta: {} };
  if (res.status === 404) return { ok: false, error: "GitHub cannot see that repository with this token. Check the name and give the token access to it.", meta: {} };
  if (!res.ok) return { ok: false, error: res.status === 403 ? "GitHub refused this token for that repository. Give it Contents: Read and write on it." : vendorStatusError("GitHub", res.status), meta: {} };
  const data = (await res.json().catch(() => ({}))) as { permissions?: { push?: boolean } };
  if (data.permissions && data.permissions.push === false) return { ok: false, error: "The token can read that repository but not start jobs in it. Give it Contents: Read and write.", meta: {} };
  return { ok: true, error: null, meta: { repo } };
}
