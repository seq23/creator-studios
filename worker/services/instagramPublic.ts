// Instagram public numbers with no sign-in (owner decision 25 Sep 2026: production Stats is
// no-login; Instagram Login needs Meta App Review, which is friction she must never meet).
// Two keyless reads, in order, from the Worker:
//   1. the web profile JSON (www.instagram.com/api/v1/users/web_profile_info) — followers,
//      post count and the recent posts' like / comment counts, when Instagram answers it;
//   2. the public profile page's description ("1,417 Followers, 7,317 Following, 63 Posts").
// Either can be login-walled or refused from Cloudflare's addresses; the caller measures which
// answered and falls back to the numbers she types on Stats. Never a blank panel.
//
// MEASURED on staging 25 Sep 2026 (the Worker, a test handle): the profile JSON answers 401 and
// the profile page answers 302 → accounts/login, so from Cloudflare the active path is the
// form ("manual"). The public read stays: it is one request a day and switches itself on if
// Instagram ever answers.
//
// FAKE_SERVICES=1 mirrors that: login-walled by default; a handle containing "public" answers
// from the public page with plausible numbers, "missing" does not exist.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { log } from "../lib/log";

export type InstagramPublicVia = "profile_api" | "profile_page";
export type InstagramWall = "login_wall" | "rate_limited" | "blocked" | "no_numbers" | "not_found" | "failed";

export type InstagramPublicResult =
  | { ok: true; via: InstagramPublicVia; followers: number; posts: number; recent: { likes: number; comments: number; views: number | null }[] }
  | { ok: false; why: InstagramWall; status: number | null; api_status?: number | null };

/** "1,417" → 1417, "12.3K" → 12300, "1.2M" → 1200000. */
export function igCount(s: string): number {
  const m = s.trim().replace(/,/g, "").match(/^([\d.]+)\s*([KkMm])?/);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1000 : 1_000_000) : 1;
  return Math.round(n * mult);
}

/** Followers and posts from the profile page's meta description, or null when it has none. */
export function parseProfilePage(html: string): { followers: number; posts: number } | null {
  const metas = [...html.matchAll(/<meta[^>]+(?:property|name)="(?:og:description|description)"[^>]*>/gi)].map((m) => m[0]);
  for (const tag of metas) {
    const content = tag.match(/content="([^"]*)"/i)?.[1]?.replace(/&#0?44;/g, ",") ?? "";
    const f = content.match(/([\d.,]+\s*[KkMm]?)\s+Followers?/);
    const p = content.match(/([\d.,]+\s*[KkMm]?)\s+Posts?/);
    if (f) return { followers: igCount(f[1]), posts: p ? igCount(p[1]) : 0 };
  }
  return null;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function realRead(handle: string): Promise<InstagramPublicResult> {
  const h = handle.replace(/^@/, "").trim();
  // 1. The web profile JSON.
  let apiStatus: number | null = null;
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(h)}`, {
      headers: { "x-ig-app-id": "936619743392459", "user-agent": UA, accept: "application/json" },
      redirect: "manual",
    });
    apiStatus = res.status;
    if (res.ok) {
      const d = (await res.json().catch(() => null)) as { data?: { user?: { edge_followed_by?: { count?: number }; edge_owner_to_timeline_media?: { count?: number; edges?: { node?: { edge_liked_by?: { count?: number }; edge_media_preview_like?: { count?: number }; edge_media_to_comment?: { count?: number }; video_view_count?: number } }[] } } } } | null;
      const u = d?.data?.user;
      if (u?.edge_followed_by?.count != null) {
        const recent = (u.edge_owner_to_timeline_media?.edges ?? []).map((e) => ({
          likes: e.node?.edge_liked_by?.count ?? e.node?.edge_media_preview_like?.count ?? 0,
          comments: e.node?.edge_media_to_comment?.count ?? 0,
          views: e.node?.video_view_count ?? null,
        }));
        return { ok: true, via: "profile_api", followers: u.edge_followed_by.count, posts: u.edge_owner_to_timeline_media?.count ?? 0, recent };
      }
    }
  } catch {
    apiStatus = null;
  }
  // 2. The public profile page.
  try {
    const res = await fetch(`https://www.instagram.com/${encodeURIComponent(h)}/`, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    log.info("instagram.public.status", { api: apiStatus, page: res.status, login_redirect: /accounts\/login/.test(loc) });
    if (res.status >= 300 && res.status < 400) return { ok: false, why: /accounts\/login|challenge/.test(loc) ? "login_wall" : "blocked", status: res.status, api_status: apiStatus };
    if (res.status === 404) return { ok: false, why: "not_found", status: 404, api_status: apiStatus };
    if (res.status === 429) return { ok: false, why: "rate_limited", status: 429, api_status: apiStatus };
    if (!res.ok) return { ok: false, why: "blocked", status: res.status, api_status: apiStatus };
    const html = await res.text();
    const nums = parseProfilePage(html);
    if (nums) return { ok: true, via: "profile_page", followers: nums.followers, posts: nums.posts, recent: [] };
    return { ok: false, why: /accounts\/login|loginForm|"require_login":true/.test(html) ? "login_wall" : "no_numbers", status: res.status, api_status: apiStatus };
  } catch {
    return { ok: false, why: "failed", status: null, api_status: apiStatus };
  }
}

async function fakeRead(handle: string): Promise<InstagramPublicResult> {
  if (handle.includes("missing")) return { ok: false, why: "not_found", status: 404 };
  if (handle.includes("public")) return { ok: true, via: "profile_page", followers: 4820, posts: 212, recent: [] };
  return { ok: false, why: "login_wall", status: 302, api_status: 401 };
}

/** Read her public Instagram numbers by handle, keyless. Never throws. */
export async function readInstagramPublic(env: Env, handle: string): Promise<InstagramPublicResult> {
  return fakeServices(env) ? fakeRead(handle) : realRead(handle);
}
