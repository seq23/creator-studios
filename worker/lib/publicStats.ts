// Stats with no login (owner decision 25 Sep 2026). The paths that lead, before any sign-in:
//   YouTube   public numbers with the Worker's API key (services/youtube.ts). The channel is the
//             one Buffer already posts to (Buffer's serviceId is the UC… id), or one she types
//             once on Stats. Runs on every "Update numbers", in the daily lane and the weekly
//             lane; the Google sign-in, when she has chosen it, only adds watch time on top.
//   Instagram public, keyless numbers when Instagram answers the Worker (followers, posts;
//             re-read at most once a day), and ALWAYS the "Your Instagram numbers" form she
//             can fill in whenever she likes. Which path is active is stored in the setting
//             `instagram_public.path` and logged as `stats.instagram.path`.
// Rule 0: every refresh returns the state it reached and writes a light; nothing is silent.
import type { Env } from "../env";
import { getSetting, parseJson, recordEvent, setHealth, setSetting } from "./db";
import { newId, nowIso } from "./ids";
import { log } from "./log";
import { getYouTubePublic, YouTubeError, type YouTubeFailure, type YouTubePublicClient, type YouTubeChannel } from "../services/youtube";
import { readInstagramPublic, type InstagramPublicVia, type InstagramWall } from "../services/instagramPublic";
import { getBuffer, type BufferChannel } from "../services/buffer";
import { recentAverageViews } from "../domain/tiktokImport";
import { upsertVideos, updateLearnedSlots } from "../jobs/metrics";
import { matchHandoffs } from "./fullVideo";

export const YT_HEALTH = "YouTube stats";
export const IG_HEALTH = "Instagram stats";
export const YT_GUIDE = "your-youtube-numbers";
export const IG_GUIDE = "update-instagram-numbers";
/** Instagram's public numbers are re-read at most this often (the daily cache). */
export const IG_CACHE_MS = 24 * 3_600_000;
/** The monthly reminder: a line in the Monday recap once her typed numbers are this old. */
export const IG_REMIND_AFTER_DAYS = 30;

export type YouTubeState = "ok" | "no_channel" | YouTubeFailure;

export interface YouTubeChannelSetting {
  id: string;
  title: string;
  handle: string | null;
  source: "buffer" | "typed" | "search";
  /** What it was found from (her typed text, or Buffer's channel id / name): a change re-resolves. */
  from: string;
}

export interface YouTubePublicSetting {
  state: YouTubeState;
  checked_at: string;
  subscribers?: number;
  views?: number;
  videos?: number;
  read?: number;
}

export type InstagramPath = "public" | "manual" | "oauth";
export interface InstagramPublicSetting {
  path: InstagramPath;
  checked_at: string;
  handle: string | null;
  via?: InstagramPublicVia;
  why?: InstagramWall | "no_handle";
  status?: number | null;
  /** What the profile JSON answered (the first keyless read), for the measurement. */
  api_status?: number | null;
  followers?: number;
  posts?: number;
  avg_likes?: number | null;
}

export interface InstagramManual {
  followers: number;
  avg_reach: number;
  updated_at: string;
}

export interface InstagramReminder {
  on: boolean;
  last_sent_at: string | null;
}

async function connStatus(env: Env, service: "google" | "meta" | "buffer"): Promise<{ status: string; meta: Record<string, unknown> } | null> {
  const r = await env.DB.prepare("SELECT status, meta FROM connections WHERE service = ?").bind(service).first<{ status: string; meta: string }>();
  return r ? { status: r.status, meta: parseJson<Record<string, unknown>>(r.meta, {}) } : null;
}

/** The Buffer channel for a platform, re-reading Buffer once when an older connection lacks serviceId. */
async function bufferChannel(env: Env, platform: "youtube" | "instagram"): Promise<BufferChannel | null> {
  const buf = await connStatus(env, "buffer");
  if (!buf || buf.status === "disconnected") return null;
  const list = (buf.meta.channels as BufferChannel[] | undefined) ?? [];
  const ch = list.find((c) => c.platform === platform) ?? null;
  if (ch && ch.service_id === undefined && buf.status === "ok") {
    // Connected before Buffer's serviceId was read (staging, 25 Sep 2026): one re-read.
    const r = await (await getBuffer(env)).checkKey();
    if (r.ok) {
      await env.DB.prepare("UPDATE connections SET meta = ? WHERE service = 'buffer'").bind(JSON.stringify({ ...buf.meta, channels: r.channels })).run();
      return r.channels.find((c) => c.platform === platform) ?? null;
    }
  }
  return ch;
}

/** "UC…" id, a channel link or an @handle → how to look it up. */
export function parseChannelInput(raw: string): { id: string } | { handle: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const id = t.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/);
  if (id) return { id: id[1] };
  const h = t.match(/(?:youtube\.com\/)?@([\w.\-·]{3,100})/i) ?? t.match(/^([\w.\-]{3,100})$/);
  if (h) return { handle: `@${h[1]}` };
  return null;
}

async function resolveChannel(env: Env, yt: YouTubePublicClient): Promise<YouTubeChannel | null> {
  const saved = await getSetting<YouTubeChannelSetting | null>(env.DB, "youtube_channel", null);
  const typed = await getSetting<string | null>(env.DB, "youtube_channel_typed", null);
  let source: YouTubeChannelSetting["source"];
  let from: string;
  let lookup: () => Promise<YouTubeChannel | null>;
  if (typed) {
    const p = parseChannelInput(typed);
    if (!p) return null;
    source = "typed";
    from = `typed:${typed}`;
    lookup = () => ("id" in p ? yt.channelById(p.id) : yt.channelByHandle(p.handle));
  } else {
    const ch = await bufferChannel(env, "youtube");
    if (!ch) return null;
    if (ch.service_id) {
      source = "buffer";
      from = `buffer:${ch.service_id}`;
      lookup = () => yt.channelById(ch.service_id as string);
    } else {
      // Last resort: Buffer's channel name. A guessed handle first (1 unit), then search (100
      // units) keeping only an exact, single title match — never somebody else's channel.
      source = "search";
      from = `name:${ch.handle}`;
      lookup = async () => {
        const guess = await yt.channelByHandle(ch.handle.replace(/\s+/g, ""));
        if (guess && guess.title.toLowerCase() === ch.handle.toLowerCase()) return guess;
        const hits = (await yt.searchChannels(ch.handle)).filter((h) => h.title.toLowerCase() === ch.handle.toLowerCase());
        return hits.length === 1 ? yt.channelById(hits[0].id) : null;
      };
    }
  }
  if (saved && saved.from === from) return yt.channelById(saved.id);
  const found = await lookup();
  if (found) await setSetting(env.DB, "youtube_channel", { id: found.id, title: found.title, handle: found.handle, source, from } satisfies YouTubeChannelSetting);
  return found;
}

/** YouTube public numbers → account_stats + platform_videos; the light says what happened. */
export async function refreshYouTubePublic(env: Env): Promise<YouTubePublicSetting> {
  const google = await connStatus(env, "google");
  const oauthOk = google?.status === "ok";
  const yt = getYouTubePublic(env);
  const done = async (s: YouTubePublicSetting, light: "green" | "yellow", note: string) => {
    await setSetting(env.DB, "youtube_public", s);
    // A chosen Google sign-in owns the light while it is connected (it reports its own problems).
    if (!oauthOk) await setHealth(env.DB, YT_HEALTH, light, note, light === "green" ? null : YT_GUIDE);
    log.info("stats.youtube.path", { path: "public", state: s.state, read: s.read ?? 0 });
    return s;
  };
  if (!yt) return done({ state: "no_key", checked_at: nowIso() }, "yellow", "Practice mode: YouTube numbers start once a YouTube key is added on Setup.");
  try {
    const ch = await resolveChannel(env, yt);
    if (!ch) {
      const typed = await getSetting<string | null>(env.DB, "youtube_channel_typed", null);
      return done({ state: typed ? "not_found" : "no_channel", checked_at: nowIso() }, "yellow", typed ? "We couldn't find that YouTube channel. Check the name on Stats." : "Type your YouTube channel on Stats so we can read its numbers.");
    }
    const videos = ch.uploads ? await yt.uploads(ch.uploads, 60) : [];
    await upsertVideos(
      env,
      videos.map((v) => ({ platform: "youtube" as const, external_id: v.id, url: `https://youtube.com/shorts/${v.id}`, title: v.title, posted_at: v.published_at, views: v.views, likes: v.likes, comments: v.comments, shares: 0, saves: 0, avg_watch_s: null })),
      "api",
    );
    await env.DB.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES (?, 'youtube', ?, ?, ?, 'api')")
      .bind(newId("acs"), nowIso(), ch.subscribers, recentAverageViews(videos.map((v) => ({ posted_at: v.published_at, views: v.views }))))
      .run();
    if (videos.length) await updateLearnedSlots(env);
    // A full video she uploaded herself (Buffer wouldn't take it) is found by its title: marked Posted.
    if (videos.length) await matchHandoffs(env);
    await recordEvent(env.DB, "stats.youtube.public", null, { videos: videos.length });
    return done({ state: "ok", checked_at: nowIso(), subscribers: ch.subscribers, views: ch.views, videos: ch.videos, read: videos.length }, "green", `Public numbers · ${ch.subscribers.toLocaleString()} subscribers · ${ch.videos.toLocaleString()} videos`);
  } catch (e) {
    const kind: YouTubeFailure = e instanceof YouTubeError ? e.kind : "failed";
    const note = kind === "quota" ? "YouTube asked us to slow down today. We'll read your numbers tomorrow." : kind === "key_refused" ? "YouTube refused this dashboard's key. Your helper can fix it." : "YouTube didn't answer this time. We'll try again tomorrow.";
    return done({ state: kind, checked_at: nowIso() }, "yellow", note);
  }
}

async function instagramHandle(env: Env): Promise<string | null> {
  const typed = await getSetting<string | null>(env.DB, "instagram_handle_typed", null);
  if (typed) return typed.replace(/^@/, "").trim() || null;
  const ch = await bufferChannel(env, "instagram");
  const fromLink = ch?.link?.match(/instagram\.com\/([\w.]+)/i)?.[1];
  return fromLink ?? ch?.handle.replace(/^@/, "").trim() ?? null;
}

/**
 * Instagram: the public numbers when Instagram answers (at most once a day unless forced),
 * otherwise the numbers she typed. Writes the path it took; never leaves the panel blank.
 */
export async function refreshInstagramPublic(env: Env, opts: { force?: boolean } = {}): Promise<InstagramPublicSetting> {
  const meta = await connStatus(env, "meta");
  const prev = await getSetting<InstagramPublicSetting | null>(env.DB, "instagram_public", null);
  const manual = await getSetting<InstagramManual | null>(env.DB, "instagram_manual", null);
  const handle = await instagramHandle(env);
  if (meta?.status === "ok") {
    const s: InstagramPublicSetting = { path: "oauth", checked_at: nowIso(), handle };
    await setSetting(env.DB, "instagram_public", s);
    log.info("stats.instagram.path", { path: "oauth" });
    return s;
  }
  if (!opts.force && prev && prev.path !== "oauth" && prev.handle === handle && Date.now() - Date.parse(prev.checked_at) < IG_CACHE_MS) return prev;

  let s: InstagramPublicSetting;
  if (!handle) {
    s = { path: "manual", checked_at: nowIso(), handle: null, why: "no_handle" };
  } else {
    const r = await readInstagramPublic(env, handle);
    if (r.ok) {
      const likes = r.recent.length ? Math.round(r.recent.reduce((a, x) => a + x.likes, 0) / r.recent.length) : null;
      const views = r.recent.filter((x) => x.views != null);
      const avg = manual?.avg_reach ?? (views.length ? Math.round(views.reduce((a, x) => a + (x.views ?? 0), 0) / views.length) : 0);
      await env.DB.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES (?, 'instagram', ?, ?, ?, 'api')").bind(newId("acs"), nowIso(), r.followers, avg).run();
      s = { path: "public", checked_at: nowIso(), handle, via: r.via, followers: r.followers, posts: r.posts, avg_likes: likes };
    } else {
      s = { path: "manual", checked_at: nowIso(), handle, why: r.why, status: r.status, api_status: r.api_status ?? null };
    }
  }
  await setSetting(env.DB, "instagram_public", s);
  // A chosen Instagram sign-in that needs reconnecting keeps its own red light (with its guide).
  if (meta?.status !== "error") {
    if (s.path === "public") await setHealth(env.DB, IG_HEALTH, "green", `Public numbers · ${(s.followers ?? 0).toLocaleString()} followers`, null);
    else if (manual) await setHealth(env.DB, IG_HEALTH, "green", `Your numbers · ${manual.followers.toLocaleString()} followers, updated ${manual.updated_at.slice(0, 10)}`, null);
    else await setHealth(env.DB, IG_HEALTH, "yellow", "Add your Instagram numbers on Stats (2 minutes, in the Instagram app).", IG_GUIDE);
  }
  log.info("stats.instagram.path", { path: s.path, via: s.via ?? null, why: s.why ?? null, status: s.status ?? null });
  await recordEvent(env.DB, "stats.instagram.path", null, { path: s.path, via: s.via ?? null, why: s.why ?? null });
  return s;
}

/** Her typed Instagram numbers: stored, shown at once, and the light turns green. */
export async function saveInstagramManual(env: Env, followers: number, avgReach: number, actor: string): Promise<InstagramManual> {
  const m: InstagramManual = { followers, avg_reach: avgReach, updated_at: nowIso() };
  await setSetting(env.DB, "instagram_manual", m);
  await env.DB.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES (?, 'instagram', ?, ?, ?, 'manual')").bind(newId("acs"), m.updated_at, followers, avgReach).run();
  const meta = await connStatus(env, "meta");
  if (meta?.status !== "ok" && meta?.status !== "error") await setHealth(env.DB, IG_HEALTH, "green", `Your numbers · ${followers.toLocaleString()} followers, updated ${m.updated_at.slice(0, 10)}`, null);
  await recordEvent(env.DB, "stats.instagram.manual", null, {}, actor);
  log.info("stats.instagram.manual", { saved: true });
  return m;
}

/** Everything no-login, in one call (Update numbers, the daily and weekly lanes). */
export async function refreshPublicStats(env: Env, opts: { force?: boolean } = {}) {
  const youtube = await refreshYouTubePublic(env);
  const instagram = await refreshInstagramPublic(env, opts);
  return { youtube, instagram };
}

/**
 * The monthly "update your Instagram numbers" line for the Monday recap, or null. Due when she
 * turned the reminder on, her typed numbers are 30+ days old (or missing), and the last
 * reminder went out 28+ days ago.
 */
export async function instagramReminderLine(env: Env, now = new Date()): Promise<string | null> {
  const rem = await getSetting<InstagramReminder>(env.DB, "instagram_reminder", { on: false, last_sent_at: null });
  if (!rem.on) return null;
  const manual = await getSetting<InstagramManual | null>(env.DB, "instagram_manual", null);
  const day = 86_400_000;
  const stale = !manual || now.getTime() - Date.parse(manual.updated_at) >= IG_REMIND_AFTER_DAYS * day;
  const quiet = !rem.last_sent_at || now.getTime() - Date.parse(rem.last_sent_at) >= 28 * day;
  if (!stale || !quiet) return null;
  await setSetting(env.DB, "instagram_reminder", { on: true, last_sent_at: now.toISOString() } satisfies InstagramReminder);
  return "Time to update your Instagram numbers: open Stats → Your Instagram numbers (about 2 minutes in the Instagram app).";
}

/** What the Stats screen shows about the no-login paths. */
export async function publicStatsView(env: Env) {
  return {
    youtube: await getSetting<YouTubePublicSetting | null>(env.DB, "youtube_public", null),
    youtubeChannel: await getSetting<YouTubeChannelSetting | null>(env.DB, "youtube_channel", null),
    youtubeTyped: await getSetting<string | null>(env.DB, "youtube_channel_typed", null),
    instagram: await getSetting<InstagramPublicSetting | null>(env.DB, "instagram_public", null),
    instagramManual: await getSetting<InstagramManual | null>(env.DB, "instagram_manual", null),
    instagramReminder: (await getSetting<InstagramReminder>(env.DB, "instagram_reminder", { on: false, last_sent_at: null })).on,
  };
}
