// The one Posts list and the one set of numbers (owner's rulings, 13 Nov 2026; shared/posts.ts).
// Gathers reels (posts + clips) and photo posts (social_posts + pack_items) into one shape, so the
// Calendar shows every upcoming post of every kind with its caption, and Home, the Calendar and
// Settings read the same counts (worker/domain/postCounts.ts). Read-only: every change still goes
// through each kind's own route (routes/posts.ts, routes/clips.ts, routes/photos.ts, routes/bin.ts).
import type { Env } from "../env";
import { parseJson } from "./db";
import { readSettings } from "../routes/settings";
import { readStudioRules } from "./studioRules";
import { weekBounds } from "../domain/slotting";
import { ACTIVE_STATUSES } from "../domain/sync";
import { postCounts, type CountRow } from "../domain/postCounts";
import { HARD_CAP_PER_CHANNEL_PER_WEEK, PLATFORMS, type Platform } from "@shared/constants";
import { isFinalCaption, postText } from "@shared/postText";
import { withAiLabel } from "@shared/contentRules";
import { connectTo, SOCIAL_LABEL, SOCIAL_SETUP, type ItemKind, type Social, type SocialPostStatus } from "@shared/photoPosts";
import { photoKind, POST_KIND_LABEL, splitCaption, type BinItem, type BinList, type BlockedGroup, type PostItem, type PostsList, type PostsSummary, type WeekLimit } from "@shared/posts";

const CLIP_PLATFORM: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };

/** A platform's or a service's own words, in hers: the posting service is never named on the Posts page. */
export function plainWords(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\s+(inside|in|into|from|through|via)\s+Buffer\b/gi, "")
    .replace(/\bBuffer\b/g, "the posting service")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ------------------------------------------------------------------ the one set of numbers

export async function readSummary(env: Env, now = new Date()): Promise<PostsSummary> {
  const s = await readSettings(env);
  const week = weekBounds(now, s.audience_timezone);
  const { results: clipRows } = await env.DB.prepare("SELECT status, scheduled_at, posted_at FROM posts WHERE status IN ('planned', 'in_buffer') OR (status = 'posted' AND COALESCE(posted_at, scheduled_at) >= ?)").bind(week.start).all<Omit<CountRow, "source">>();
  const { results: photoRows } = await env.DB.prepare("SELECT status, scheduled_at, posted_at FROM social_posts WHERE status IN ('scheduled', 'sending') OR (status = 'posted' AND COALESCE(posted_at, scheduled_at) >= ?)").bind(week.start).all<Omit<CountRow, "source">>();
  const rows: CountRow[] = [...clipRows.map((r) => ({ ...r, source: "clip" as const })), ...photoRows.map((r) => ({ ...r, source: "photo" as const }))];
  return postCounts(rows, week, now.toISOString());
}

/** This week's limit per platform, counted exactly as the planner and a move count it. */
export async function clipWeekLimits(env: Env, now = new Date()): Promise<WeekLimit[]> {
  const s = await readSettings(env);
  const { start, end } = weekBounds(now, s.audience_timezone);
  const { results } = await env.DB.prepare(`SELECT platform, COUNT(*) AS n FROM posts WHERE status IN (${ACTIVE_STATUSES.map((x) => `'${x}'`).join(",")}) AND scheduled_at >= ? AND scheduled_at < ? GROUP BY platform`).bind(start, end).all<{ platform: Platform; n: number }>();
  return PLATFORMS.map((p) => ({ platform: p, label: CLIP_PLATFORM[p], used: results.find((r) => r.platform === p)?.n ?? 0, cap: Math.min(s.weekly_caps[p] ?? 0, s.hard_cap_per_channel, HARD_CAP_PER_CHANNEL_PER_WEEK) }));
}

// ------------------------------------------------------------------ reels (posts + clips)

interface ClipPostDb {
  id: string;
  clip_id: string;
  platform: Platform;
  scheduled_at: string;
  status: "planned" | "in_buffer" | "posted" | "failed" | "unscheduled";
  url: string | null;
  error: string | null;
  hook_text: string;
  caption: string;
  hashtags: string;
  media_token: string | null;
  cover_r2_key: string | null;
  media_version: number;
  full_video: number;
  clip_type: string | null;
  uses_ai_images: number | null;
  file_deleted_at: string | null;
  ai_voice: number;
  handed_over: number;
}

const CLIP_POST_SQL = `SELECT p.id, p.clip_id, p.platform, p.scheduled_at, p.status, p.url, p.error,
    c.hook_text, c.caption, c.hashtags, c.media_token, c.cover_r2_key, c.media_version, c.full_video, c.clip_type, c.uses_ai_images, c.file_deleted_at,
    (SELECT COUNT(*) FROM narrations n WHERE n.clip_id = c.id AND n.mix_status = 'ready' AND n.ai_generated = 1) AS ai_voice,
    EXISTS (SELECT 1 FROM posts q WHERE q.clip_id = c.id AND q.status = 'in_buffer') AS handed_over
  FROM posts p JOIN clips c ON c.id = p.clip_id`;

function clipItem(r: ClipPostDb, aiNoteAll: boolean): PostItem {
  const kind = r.full_video ? "video" : "reel";
  const aiMade = r.ai_voice > 0 || aiNoteAll || !!r.uses_ai_images;
  // The words exactly as they post (shared/postText.ts); only the tracking on her link is left off.
  const caption = postText({ caption: r.caption, hashtags: r.hashtags, aiMade, link: "", source: r.platform, campaign: "", tag: "", final: !!r.clip_type && r.clip_type !== "imported" });
  const state: PostItem["state"] = r.status === "posted" ? "posted" : r.status === "failed" ? "failed" : r.status === "unscheduled" ? "off" : "coming";
  const live = state === "coming" || state === "failed";
  const v = r.media_version ? `?v=${r.media_version}` : "";
  const final = !!r.clip_type && r.clip_type !== "imported";
  // Older clips keep their tags apart from the caption; the engine's final captions carry their own.
  const tagsApart = !final && !isFinalCaption(String(r.caption ?? "").replace(/\r/g, "").trim());
  return {
    id: r.id,
    source: "clip",
    kind,
    kind_label: POST_KIND_LABEL[kind],
    platform: r.platform,
    platform_label: CLIP_PLATFORM[r.platform] ?? r.platform,
    scheduled_at: r.scheduled_at,
    state,
    reason: state === "failed" ? `Did not go out: ${plainWords(r.error) || "the platform said no"}` : null,
    headline: r.hook_text || "Untitled",
    caption_line: splitCaption(r.caption).first,
    caption,
    edit: live && !r.handed_over ? { caption: r.caption, tags: tagsApart ? r.hashtags : null } : null,
    edit_note: !live ? null : r.handed_over ? "This one is already lined up to go out. To change the words, take it off the calendar first, then add it back." : null,
    thumb_url: r.media_token && r.cover_r2_key ? `/media/${r.media_token}?cover=1${r.media_version ? `&v=${r.media_version}` : ""}` : r.cover_r2_key ? `/api/clips/${r.clip_id}/cover` : null,
    video_url: r.media_token && !r.file_deleted_at ? `/media/${r.media_token}${v}` : null,
    images: [],
    url: r.url,
    can: { move: live, swap: live, remove: live, retry: state === "failed" },
    ref_id: r.clip_id,
  };
}

// ------------------------------------------------------------------ photo posts (social_posts + pack_items)

interface PhotoPostDb {
  id: string;
  pack_id: string;
  item_kind: ItemKind;
  platform: Social;
  caption: string;
  scheduled_at: string;
  status: SocialPostStatus;
  error: string | null;
  url: string | null;
  skipped_at: string | null;
  r2_key: string | null;
  cover_r2_key: string | null;
  images: string | null;
  media_token: string | null;
  ai_made: number | null;
}

const PHOTO_POST_SQL = `SELECT s.id, s.pack_id, s.item_kind, s.platform, s.caption, s.scheduled_at, s.status, s.error, s.url, s.skipped_at,
    i.r2_key, i.cover_r2_key, i.images, i.media_token, i.ai_made
  FROM social_posts s LEFT JOIN pack_items i ON i.pack_id = s.pack_id AND i.kind = s.item_kind`;

function photoMedia(r: Pick<PhotoPostDb, "r2_key" | "cover_r2_key" | "images" | "media_token">): { thumb: string | null; video: string | null; images: string[] } {
  const pics = parseJson<string[]>(r.images, []);
  if (!r.media_token) return { thumb: null, video: null, images: [] };
  const base = `/media/p/${r.media_token}`;
  const images = pics.map((_, n) => `${base}/img/${n}`);
  return { thumb: r.cover_r2_key ? `${base}/cover` : (images[0] ?? null), video: r.r2_key ? `${base}/video` : null, images };
}

function photoReason(r: PhotoPostDb): string | null {
  if (r.status === "held") return `Stopped before posting: ${plainWords(r.error) || "it broke a studio rule"}`;
  if (r.status === "failed") return `Did not go out: ${plainWords(r.error) || "the platform said no"}`;
  if (r.status !== "waiting") return null;
  if (r.error?.startsWith("connect:")) return `${SOCIAL_LABEL[r.error.slice(8) as Social] ?? "This account"} is not connected yet. It goes out once it is.`;
  return "The photo check is not set up yet. It goes out once the photo is checked for faces and house numbers.";
}

function photoItem(r: PhotoPostDb): PostItem {
  const m = photoMedia(r);
  const kind = photoKind(r.item_kind, m.images.length);
  const flagged = r.platform === "instagram" || r.platform === "tiktok"; // these carry the platform's own AI flag instead of the words
  const caption = flagged ? r.caption : withAiLabel(r.caption, !!r.ai_made);
  const state: PostItem["state"] = r.status === "posted" ? "posted" : r.status === "failed" ? "failed" : r.status === "skipped" ? "off" : r.status === "waiting" || r.status === "held" ? "waiting" : "coming";
  const editable = r.status === "scheduled" || r.status === "waiting" || r.status === "held";
  const words = splitCaption(r.caption);
  return {
    id: r.id,
    source: "photo",
    kind,
    kind_label: POST_KIND_LABEL[kind],
    platform: r.platform,
    platform_label: SOCIAL_LABEL[r.platform] ?? r.platform,
    scheduled_at: r.scheduled_at,
    state,
    reason: photoReason(r),
    headline: words.first || POST_KIND_LABEL[kind],
    caption_line: words.next,
    caption,
    edit: editable ? { caption: r.caption, tags: null } : null,
    edit_note: r.status === "sending" ? "This one is going out right now." : null,
    thumb_url: m.thumb,
    video_url: kind === "photo" || kind === "photo_set" ? null : m.video,
    images: kind === "photo" || kind === "photo_set" ? m.images : [],
    url: r.url,
    can: { move: editable, swap: false, remove: editable || r.status === "failed", retry: r.status === "failed" },
    ref_id: r.pack_id,
  };
}

// ------------------------------------------------------------------ the list

function blockedGroups(items: PostItem[], raw: Map<string, PhotoPostDb>): BlockedGroup[] {
  const groups = new Map<string, BlockedGroup>();
  const put = (key: string, label: string, action: BlockedGroup["action"], item: PostItem) => {
    const g = groups.get(key) ?? { key, label, action, posts: [] };
    g.posts.push(item);
    groups.set(key, g);
  };
  for (const it of items) {
    const r = raw.get(it.id);
    if (it.state === "failed") put("failed", "Did not go out", { label: "How to fix ›", to: "/help/a-post-failed" }, it);
    else if (r?.status === "held") put("held", "Stopped by a studio rule", null, it);
    else if (r?.error?.startsWith("connect:")) {
      const p = r.error.slice(8) as Social;
      put(`connect:${p}`, `Waiting on ${SOCIAL_LABEL[p] ?? "a connection"}`, { label: "Connect ›", to: connectTo(SOCIAL_SETUP[p] ?? p) }, it);
    } else put("photo-check", "Waiting on the photo check", { label: "Set it up ›", to: "/setup#setup-github" }, it);
  }
  return [...groups.values()];
}

export async function postsList(env: Env, now = new Date()): Promise<PostsList> {
  const s = await readSettings(env);
  const rules = await readStudioRules(env);
  const { results: clipRows } = await env.DB.prepare(`${CLIP_POST_SQL} WHERE p.status IN ('planned', 'in_buffer', 'failed') ORDER BY p.scheduled_at, p.platform LIMIT 500`).all<ClipPostDb>();
  const { results: photoRows } = await env.DB.prepare(`${PHOTO_POST_SQL} WHERE s.status IN ('scheduled', 'sending', 'waiting', 'held', 'failed') AND s.deleted_at IS NULL ORDER BY s.scheduled_at, s.platform LIMIT 500`).all<PhotoPostDb>();
  const raw = new Map(photoRows.map((r) => [r.id, r]));
  const all = [...clipRows.map((r) => clipItem(r, rules.ai_note === "all")), ...photoRows.map(photoItem)].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at) || a.platform_label.localeCompare(b.platform_label));
  return {
    tz: s.audience_timezone,
    summary: await readSummary(env, now),
    posts: all.filter((p) => p.state === "coming"),
    blocked: blockedGroups(all.filter((p) => p.state !== "coming"), raw),
    limits: await clipWeekLimits(env, now),
    bin: await binCount(env),
  };
}

/** One post of either kind, whatever its state (the sheet opens it from the list, the week or the month). */
export async function postItem(env: Env, id: string): Promise<PostItem | null> {
  const clip = await env.DB.prepare(`${CLIP_POST_SQL} WHERE p.id = ?`).bind(id).first<ClipPostDb>();
  if (clip) return clipItem(clip, (await readStudioRules(env)).ai_note === "all");
  const photo = await env.DB.prepare(`${PHOTO_POST_SQL} WHERE s.id = ? AND s.deleted_at IS NULL`).bind(id).first<PhotoPostDb>();
  return photo ? photoItem(photo) : null;
}

// ------------------------------------------------------------------ the Rejected bin

/** A rejected reel (never one of its other looks: they go with it) or a photo post she skipped. */
const BIN_CLIPS = "c.status = 'rejected' AND c.style_of IS NULL";
const BIN_PHOTOS = "s.status = 'skipped' AND s.deleted_at IS NULL";

export async function binCount(env: Env): Promise<number> {
  const a = await env.DB.prepare(`SELECT COUNT(*) AS n FROM clips c WHERE ${BIN_CLIPS}`).first<{ n: number }>();
  const b = await env.DB.prepare(`SELECT COUNT(*) AS n FROM social_posts s WHERE ${BIN_PHOTOS}`).first<{ n: number }>();
  return (a?.n ?? 0) + (b?.n ?? 0);
}

export async function binList(env: Env): Promise<BinList> {
  const { results: clips } = await env.DB.prepare(`SELECT c.id, c.hook_text, c.reviewed_at, c.media_token, c.cover_r2_key, c.full_video FROM clips c WHERE ${BIN_CLIPS} ORDER BY c.reviewed_at DESC LIMIT 300`).all<{ id: string; hook_text: string; reviewed_at: string | null; media_token: string | null; cover_r2_key: string | null; full_video: number }>();
  const { results: photos } = await env.DB.prepare(`${PHOTO_POST_SQL} WHERE ${BIN_PHOTOS} ORDER BY s.skipped_at DESC LIMIT 300`).all<PhotoPostDb>();
  const items: BinItem[] = [
    ...clips.map((c) => ({
      id: c.id,
      source: "clip" as const,
      kind_label: POST_KIND_LABEL[c.full_video ? "video" : "reel"],
      headline: c.hook_text || "Untitled",
      thumb_url: c.media_token && c.cover_r2_key ? `/media/${c.media_token}?cover=1` : c.cover_r2_key ? `/api/clips/${c.id}/cover` : null,
      rejected_at: c.reviewed_at,
    })),
    ...photos.map((p) => {
      const it = photoItem(p);
      return { id: p.id, source: "photo" as const, kind_label: `${it.kind_label} · ${it.platform_label}`, headline: it.headline, thumb_url: it.thumb_url, rejected_at: p.skipped_at };
    }),
  ].sort((a, b) => (b.rejected_at ?? "").localeCompare(a.rejected_at ?? ""));
  return { tz: (await readSettings(env)).audience_timezone, items };
}
