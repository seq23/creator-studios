// Stats connections by OAuth (BUILD_PLAN.md section 4b): "Connect with Instagram" and "Connect
// with Google". She always logs in on the platform's own page; the dashboard only ever sees
// the token it is handed, stored AES-GCM encrypted in D1 (lib/connections saveConnection).
//
//   GET /api/oauth/:provider/start      → redirect to the provider's consent page (state cookie)
//   GET /api/oauth/:provider/callback   → exchange the code, store the token, health green,
//                                         back to /settings/connections
//
// Instagram uses the Instagram API with Instagram Login (a Professional account, no Facebook
// Page needed): scopes instagram_business_basic + instagram_business_manage_insights. The
// Meta app's id/secret are the Worker secrets META_APP_ID / META_APP_SECRET.
// YouTube uses Google OAuth (youtube.readonly + yt-analytics.readonly), offline access so the
// refresh token keeps it connected; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. The Google Cloud
// project must be "In production" (section 13), or tokens die every 7 days.
//
// FAKE_SERVICES=1: start "connects" at once with a stand-in token and account name.
// TikTok has no OAuth here (TikTok has not approved a read-stats app): she uploads the TikTok
// Studio export on Stats instead.
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env, Vars } from "../env";
import { practice } from "../lib/practice";
import { requireOwner, requireUser } from "../lib/auth";
import { getConnectionSecret, markConnection, saveConnection } from "../lib/connections";
import { timingSafeEqual } from "../lib/crypto";
import { parseJson, recordEvent, setHealth } from "../lib/db";
import { fail } from "../lib/http";
import { newId } from "../lib/ids";
import { log, safeError } from "../lib/log";
import { hasAllScopes, markBroken as markYouTubeBroken, writeLight as writeYouTubeLight, YT_UPLOAD_SCOPES } from "../lib/youtubeDirect";

export const oauth = new Hono<{ Bindings: Env; Variables: Vars }>();
oauth.use("*", requireUser);

export type StatsProvider = "meta" | "google";

export interface OAuthToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  account_id: string | null;
}

const STATE_COOKIE = "ss_oauth_state";
const HEALTH_NAME: Record<StatsProvider, string> = { meta: "Instagram stats", google: "YouTube stats" };
const RECONNECT: Record<StatsProvider, string> = { meta: "reconnect-meta", google: "reconnect-google" };

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const META_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];

function isProvider(p: string): p is StatsProvider {
  return p === "meta" || p === "google";
}

const redirectUri = (env: Env, p: StatsProvider) => `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/oauth/${p}/callback`;
const back = (q: string) => `/settings/connections?${q}`;

function appCredentials(env: Env, p: StatsProvider): { id: string; secret: string } | null {
  const id = p === "meta" ? env.META_APP_ID : env.GOOGLE_CLIENT_ID;
  const secret = p === "meta" ? env.META_APP_SECRET : env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

async function storeToken(env: Env, p: StatsProvider, token: OAuthToken, account: string, actor: string) {
  await saveConnection(env, p, JSON.stringify(token), "ok", { account, connected_via: "oauth", last_sync_at: null });
  await setHealth(env.DB, HEALTH_NAME[p], "green", `Connected · ${account}`, null);
  await recordEvent(env.DB, "connection.ok", p, { via: "oauth" }, actor);
  log.info("oauth.connected", { provider: p });
}

async function failConnect(env: Env, p: StatsProvider, why: string) {
  await markConnection(env, p, "error", why);
  await setHealth(env.DB, HEALTH_NAME[p], "red", why, RECONNECT[p]);
}

/**
 * "Connect YouTube (full videos)": her own Google sign-in with youtube.upload + youtube.force-ssl,
 * offline (a refresh token), consent every time, incremental (include_granted_scopes keeps the
 * optional Stats sign-in's scopes). Google sends her back to the ONE registered callback,
 * /api/oauth/google/callback; the state cookie says it was this flow. Stored as its own connection
 * ('youtube'), so the optional Stats sign-in ('google') is untouched.
 */
oauth.get("/youtube/start", requireOwner, async (c) => {
  // Local fakes, or Google sign-in still in practice mode: a practice connection, labelled so.
  if (practice(c.env, "google_app")) {
    const token: OAuthToken = { access_token: `fake-youtube-token-${newId("t", 8)}`, refresh_token: "fake-refresh", expires_at: new Date(Date.now() + 3600_000).toISOString(), account_id: "fake_yt_channel" };
    await storeYouTube(c.env, token, "Practice channel", YT_UPLOAD_SCOPES.join(" "), c.get("user").email);
    return c.redirect(back("connected=youtube"));
  }
  const app = appCredentials(c.env, "google");
  if (!app) {
    log.warn("oauth.not_set_up", { provider: "youtube" });
    return c.redirect(back("oauth_error=not_set_up&provider=youtube"));
  }
  const state = newId("st", 32);
  setCookie(c, STATE_COOKIE, `youtube.${state}`, { httpOnly: true, secure: c.env.PUBLIC_BASE_URL.startsWith("https://"), sameSite: "Lax", path: "/api/oauth", maxAge: 600 });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", app.id);
  u.searchParams.set("redirect_uri", redirectUri(c.env, "google"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("scope", YT_UPLOAD_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  return c.redirect(u.toString());
});

async function storeYouTube(env: Env, token: OAuthToken & { scope?: string }, account: string, scope: string, actor: string) {
  await saveConnection(env, "youtube", JSON.stringify({ ...token, scope }), "ok", { account, channel_id: token.account_id, connected_via: "oauth", scopes: scope.split(" ").filter((x) => x.includes("youtube")) });
  await recordEvent(env.DB, "connection.ok", "youtube", { via: "oauth" }, actor);
  await writeYouTubeLight(env);
  log.info("oauth.connected", { provider: "youtube" });
}

oauth.get("/:provider/start", requireOwner, async (c) => {
  const p = c.req.param("provider") ?? "";
  if (p === "tiktok") return fail(c, 404, "TikTok stats come from the export you upload on Stats.", "upload-your-tiktok-export");
  if (!isProvider(p)) return fail(c, 404, "Unknown connection.");

  if (practice(c.env, p === "meta" ? "meta_app" : "google_app")) {
    const token: OAuthToken = {
      access_token: `fake-${p}-token-${newId("t", 8)}`,
      refresh_token: p === "google" ? "fake-refresh" : null,
      expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      account_id: p === "meta" ? "fake_ig_user" : "fake_yt_channel",
    };
    await storeToken(c.env, p, token, p === "meta" ? "@practice.account" : "Practice channel", c.get("user").email);
    return c.redirect(back(`connected=${p}`));
  }

  const app = appCredentials(c.env, p);
  if (!app) {
    log.warn("oauth.not_set_up", { provider: p });
    return c.redirect(back(`oauth_error=not_set_up&provider=${p}`));
  }
  const state = newId("st", 32);
  setCookie(c, STATE_COOKIE, `${p}.${state}`, { httpOnly: true, secure: c.env.PUBLIC_BASE_URL.startsWith("https://"), sameSite: "Lax", path: "/api/oauth", maxAge: 600 });
  const u =
    p === "meta"
      ? new URL("https://www.instagram.com/oauth/authorize")
      : new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", app.id);
  u.searchParams.set("redirect_uri", redirectUri(c.env, p));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  if (p === "meta") {
    u.searchParams.set("scope", META_SCOPES.join(","));
  } else {
    u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
  }
  return c.redirect(u.toString());
});

oauth.get("/:provider/callback", requireOwner, async (c) => {
  const p = c.req.param("provider") ?? "";
  if (!isProvider(p)) return fail(c, 404, "Unknown connection.");
  const cookie = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, { path: "/api/oauth" });
  const [cp, cstate] = cookie.split(".");
  const state = c.req.query("state") ?? "";
  // Connect YouTube (full videos) comes back through Google's one registered callback.
  const youtube = p === "google" && cp === "youtube";
  if ((cp !== p && !youtube) || !cstate || !timingSafeEqual(cstate, state)) {
    log.warn("oauth.bad_state", { provider: p });
    return c.redirect(back(`oauth_error=expired&provider=${p}`));
  }
  if (c.req.query("error")) {
    log.info("oauth.denied", { provider: youtube ? "youtube" : p });
    return c.redirect(back(`oauth_error=denied&provider=${youtube ? "youtube" : p}`));
  }
  const code = c.req.query("code");
  const app = appCredentials(c.env, p);
  if (!code || !app) return c.redirect(back(`oauth_error=failed&provider=${youtube ? "youtube" : p}`));

  if (youtube) {
    try {
      const { token, account, scope } = await exchangeGoogle(c.env, app, code);
      // Google's consent page lets her untick a box: without upload the videos cannot go up.
      if (!hasAllScopes(scope)) throw new OAuthStop("no_upload", "Google didn't give permission to upload. Tap Connect YouTube again and leave every box ticked, then tap Continue.");
      await storeYouTube(c.env, token, account, scope, c.get("user").email);
      return c.redirect(back("connected=youtube"));
    } catch (e) {
      log.error("oauth.exchange", { provider: "youtube", err: safeError(e) });
      const why = e instanceof OAuthStop ? e.message : "The connection did not finish. Tap Connect YouTube again.";
      await markYouTubeBroken(c.env, why);
      return c.redirect(back(`oauth_error=${e instanceof OAuthStop ? e.reason : "failed"}&provider=youtube`));
    }
  }

  try {
    const { token, account } = p === "meta" ? await exchangeMeta(c.env, app, code) : await exchangeGoogle(c.env, app, code);
    await storeToken(c.env, p, token, account, c.get("user").email);
    return c.redirect(back(`connected=${p}`));
  } catch (e) {
    log.error("oauth.exchange", { provider: p, err: safeError(e) });
    const why = e instanceof OAuthStop ? e.message : "The connection did not finish. Try again.";
    await failConnect(c.env, p, why);
    return c.redirect(back(`oauth_error=${e instanceof OAuthStop ? e.reason : "failed"}&provider=${p}`));
  }
});

/** A plain-sentence stop the Connect page can show (e.g. not a Professional account). */
class OAuthStop extends Error {
  constructor(
    public reason: "no_account" | "no_upload" | "failed",
    message: string,
  ) {
    super(message);
  }
}

async function exchangeMeta(env: Env, app: { id: string; secret: string }, code: string): Promise<{ token: OAuthToken; account: string }> {
  const form = new URLSearchParams({ client_id: app.id, client_secret: app.secret, grant_type: "authorization_code", redirect_uri: redirectUri(env, "meta"), code });
  const short = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  if (!short.ok) throw new Error(`instagram token ${short.status}`);
  const s = (await short.json()) as { access_token?: string; user_id?: string | number };
  if (!s.access_token) throw new Error("instagram token missing");
  // Swap for a long-lived (60-day) token; refreshed by freshToken before it runs out.
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", app.secret);
  longUrl.searchParams.set("access_token", s.access_token);
  const long = await fetch(longUrl.toString());
  if (!long.ok) throw new Error(`instagram long token ${long.status}`);
  const l = (await long.json()) as { access_token?: string; expires_in?: number };
  if (!l.access_token) throw new Error("instagram long token missing");
  const me = await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(l.access_token)}`);
  const m = me.ok ? ((await me.json()) as { user_id?: string; username?: string; account_type?: string }) : {};
  if (m.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(m.account_type)) throw new OAuthStop("no_account", "This Instagram account is not a Professional account. Switch it to Creator or Business in Instagram, then connect again.");
  return {
    token: { access_token: l.access_token, refresh_token: null, expires_at: new Date(Date.now() + (l.expires_in ?? 5_184_000) * 1000).toISOString(), account_id: String(m.user_id ?? s.user_id ?? "") || null },
    account: m.username ? `@${m.username}` : "Instagram",
  };
}

async function exchangeGoogle(env: Env, app: { id: string; secret: string }, code: string): Promise<{ token: OAuthToken; account: string; scope: string }> {
  const form = new URLSearchParams({ client_id: app.id, client_secret: app.secret, grant_type: "authorization_code", redirect_uri: redirectUri(env, "google"), code });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: form });
  if (!res.ok) throw new Error(`google token ${res.status}`);
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!t.access_token) throw new Error("google token missing");
  const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${t.access_token}` } });
  const data = ch.ok ? ((await ch.json()) as { items?: { id: string; snippet?: { title?: string } }[] }) : {};
  const first = data.items?.[0];
  if (!first) throw new OAuthStop("no_account", "This Google account has no YouTube channel. Log in with the Google account that owns her channel.");
  return {
    token: { access_token: t.access_token, refresh_token: t.refresh_token ?? null, expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), account_id: first.id },
    account: first.snippet?.title ?? "YouTube",
    scope: t.scope ?? "",
  };
}

/**
 * A usable token for a stats connection, refreshed first when it is close to expiring.
 * Returns null (and turns the health light red with the reconnect guide) when she has to
 * reconnect. Never logs the token.
 */
export async function freshToken(env: Env, p: StatsProvider): Promise<OAuthToken | null> {
  const raw = await getConnectionSecret(env, p);
  if (!raw) return null;
  const token = parseJson<OAuthToken | null>(raw, null);
  if (!token?.access_token) return null;
  if (practice(env, p === "meta" ? "meta_app" : "google_app")) {
    if (token.access_token.includes("expired")) {
      await failConnect(env, p, `${p === "meta" ? "Instagram" : "Google"} needs you to reconnect.`);
      return null;
    }
    return token;
  }
  const left = token.expires_at ? Date.parse(token.expires_at) - Date.now() : Infinity;
  try {
    if (p === "google" && left < 5 * 60_000) {
      const app = appCredentials(env, "google");
      if (!app || !token.refresh_token) throw new OAuthStop("failed", "Google needs you to reconnect.");
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ client_id: app.id, client_secret: app.secret, grant_type: "refresh_token", refresh_token: token.refresh_token }),
      });
      if (!res.ok) throw new OAuthStop("failed", "Google needs you to reconnect.");
      const t = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!t.access_token) throw new OAuthStop("failed", "Google needs you to reconnect.");
      const next = { ...token, access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString() };
      await saveSecretOnly(env, p, next);
      return next;
    }
    if (p === "meta" && left < 10 * 86_400_000) {
      if (left <= 0) throw new OAuthStop("failed", "Instagram needs you to reconnect.");
      const u = new URL("https://graph.instagram.com/refresh_access_token");
      u.searchParams.set("grant_type", "ig_refresh_token");
      u.searchParams.set("access_token", token.access_token);
      const res = await fetch(u.toString());
      if (!res.ok) throw new OAuthStop("failed", "Instagram needs you to reconnect.");
      const t = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!t.access_token) throw new OAuthStop("failed", "Instagram needs you to reconnect.");
      const next = { ...token, access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in ?? 5_184_000) * 1000).toISOString() };
      await saveSecretOnly(env, p, next);
      return next;
    }
    return token;
  } catch (e) {
    log.warn("oauth.refresh", { provider: p, err: e instanceof Error ? e.name : "error" });
    await failConnect(env, p, e instanceof OAuthStop ? e.message : "The connection needs you to reconnect.");
    return null;
  }
}

async function saveSecretOnly(env: Env, p: StatsProvider, token: OAuthToken) {
  const row = await env.DB.prepare("SELECT meta FROM connections WHERE service = ?").bind(p).first<{ meta: string }>();
  await saveConnection(env, p, JSON.stringify(token), "ok", parseJson<Record<string, unknown>>(row?.meta, {}));
}

export { HEALTH_NAME as STATS_HEALTH_NAME, RECONNECT as STATS_RECONNECT_GUIDE, failConnect as markStatsConnectionFailed };
