// Review (section 9). OWNED BY: phase 5 (Review).
//
//   GET    /api/clips                 grouped by dump, best score first; ?tab=new|approved|rejected
//                                     &door=&recipe=&platform=&hidden=1
//   POST   /api/clips/:id/approve
//   POST   /api/clips/:id/reject      {reason}  (one of REJECT_REASONS, or none)
//   POST   /api/clips/:id/restore     back to "new" (draft)
//   PATCH  /api/clips/:id             {caption, hashtags, hook_text, swap_hook, platforms, paid_partnership}
//   DELETE /api/clips/:id             permanent: removes the clip and cover from R2
//   POST   /api/clips/bulk            {action: approve|reject|delete, ids[], reason?}
//   POST   /api/clips/:id/look        {look, layout?}  Change look: queues a re-render of this clip
//                                     (a cut job with ref "<dump>/<clip>"); the old file stays live
//   GET    /api/clips/:id/cells       what a grid cell can show: this dump's other clips, approved
//                                     clips from her library, this moment closer
//   POST   /api/clips/:id/replace     {id, key, app}  her own edit from CapCut / InShot / another
//                                     app (uploaded as kind "edit"): header checked here, then the
//                                     cut job's import mode finishes it and swaps it in
//
// Nothing reaches the Calendar without approval (worker/domain/approval.ts decides every move).
// Every decision is an event, so the learning loop reads one table.
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { getSetting, parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { addDays, newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { canTransition, type ClipStatus } from "../domain/approval";
import { PLATFORMS, RECIPES, REJECT_REASONS, REJECTED_RETENTION_DAYS, type Platform, type Recipe } from "@shared/constants";
import type { ClipRow } from "@shared/types";
import { cellCount, cleanGridLayout, defaultGridLayout, editingFromStored, isGridLook, isLookId, LOOK_IDS, lookById, ZOOMS, type GridLayout, type LookId, type StoredEditing } from "../domain/looks";
import { tracksOf } from "../lib/steerStore";
import { draftScript, hasVoiceSample, redoVoiceOver, removeVoiceOver } from "../lib/autoVoice";
import { maxWords } from "../domain/autoVoice";
import { dispatchJob } from "../services/github";
import { checkEdit, editorName, isHandoffApp, HANDOFF } from "../domain/editors";
import { editingNote, pollEditorJobs, startHandback } from "../lib/editorJobs";
import { probeR2 } from "../lib/mp4";
import { clipFileAction, FILES } from "../domain/tidy";
import { FULL_VIDEO_PRIVACY, cleanTags, cleanTitle, composeDescription, studioLink, DESCRIPTION_MAX, type FullVideoDetails, type FullVideoPrivacy } from "../domain/fullVideo";

export const clips = new Hono<{ Bindings: Env; Variables: Vars }>();
clips.use("*", requireUser);

// A full video for YouTube is the whole video: it is never cut, restyled, re-rendered, given
// music or a voice over (validator full-video-uncut). Those buttons don't show on its card; a
// call that asks anyway gets a plain answer, never a re-render.
const CUT_ACTIONS = new Set(["look", "music", "another", "replace", "cells", "voice-over"]);
clips.use("/:id/:action/*", fullVideoGuard);
clips.use("/:id/:action", fullVideoGuard);
async function fullVideoGuard(c: Context<{ Bindings: Env; Variables: Vars }>, next: () => Promise<void>) {
  const action = c.req.param("action");
  if (action && CUT_ACTIONS.has(action)) {
    const row = await c.env.DB.prepare("SELECT full_video FROM clips WHERE id = ?").bind(c.req.param("id")).first<{ full_video: number }>();
    if (row?.full_video) return c.json({ error: "This is your full video for YouTube: it goes up whole, so it isn't cut, restyled or voiced over. Edit its title, description, tags or thumbnail instead.", fix_guide: "review-and-approve-clips" }, 409);
  }
  await next();
}

// ---------------------------------------------------------------- pure rules (unit-tested)

export const AD_TAG = "#ad";
export const MAX_BULK = 500;

/** Paid partnership: a clear #ad disclosure at the end of the caption (FTC), added once, removed cleanly. */
export function withDisclosure(caption: string, paid: boolean): string {
  const stripped = caption.replace(/(\s*#ad\b)+\s*$/i, "").trimEnd();
  if (!paid) return stripped;
  return stripped ? `${stripped} ${AD_TAG}` : AD_TAG;
}

export type ReviewTab = "new" | "approved" | "rejected";

export function tabStatus(tab: string | undefined): ClipStatus {
  return tab === "approved" ? "approved" : tab === "rejected" ? "rejected" : "draft";
}

export function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason.trim()) return null;
  const r = reason.trim().toLowerCase();
  return (REJECT_REASONS as readonly string[]).includes(r) ? r : "other";
}

/** Platforms she ticks: only real platforms, in the fixed order, at least one. */
export function cleanPlatforms(v: unknown): Platform[] | null {
  if (!Array.isArray(v)) return null;
  const out = PLATFORMS.filter((p) => v.includes(p));
  return out.length ? out : null;
}

/** When a rejected clip is removed for good (7 days after she rejected it). */
export function purgeAt(reviewedAt: string | null): string | null {
  return reviewedAt ? addDays(reviewedAt, REJECTED_RETENTION_DAYS) : null;
}

// ---------------------------------------------------------------- list

export interface ReviewClip extends ClipRow {
  reviewed_at: string | null;
  purge_at: string | null;
  /** The Look it is rendered in, and its name; null for clips made before Looks. */
  look: string | null;
  look_name: string | null;
  /** Grid Looks: which moment is in each cell and whose sound plays. */
  layout: GridLayout | null;
  /** A re-render in progress ("Re-rendering, about a minute"); the old file plays meanwhile. */
  pending_look: string | null;
  pending_look_name: string | null;
  /** The plain sentence when the last re-render failed. */
  rerender_error: string | null;
  /** False once the original upload was cleared (7 days): its look can no longer change. */
  source_available: boolean;
  /** Made in another editor (her own edit uploaded back, or a connected editor). */
  edited_with: string | null;
  /** Its name, for "Edited in CapCut". */
  edited_with_name: string | null;
  /** Another editor is working on it right now ("Finishing your edit from CapCut, about a minute"). */
  editing_note: string | null;
  /** Her voice over on this clip: being added, in it (the video plays with it), or it did not work. */
  voice_over: "mixing" | "ready" | "failed" | null;
  /** The song under it (her upload's id), and a Change music in progress ("none" or a song id). */
  music_id: string | null;
  pending_music: string | null;
  /** Her voice over's script (Edit the script in Review) and whether it was made automatically. */
  voice_script: string | null;
  voice_auto: boolean;
  /** The full-video door: its YouTube details, thumbnail links, and where it is (worker/domain/fullVideo.ts). */
  full_video: FullVideoView | null;
  /** Day 358: the video file was cleared 30 days after posting (the cover, numbers and post link stay). */
  file_cleared: boolean;
  /** An unapproved draft whose file is cleared on this date unless she approves it or taps Keep. */
  clears_on: string | null;
}
export interface FullVideoView extends Omit<FullVideoDetails, "thumbnails"> {
  thumbnails: { url: string; t: number }[];
  file_deleted: boolean;
  /** Its YouTube post: planned / in Buffer / posted (with the link) / failed, and YouTube Studio's page for it. */
  post: { status: string; url: string | null; scheduled_at: string } | null;
  studio_url: string;
  /**
   * Connect YouTube (full videos): "on" = it goes to her channel directly (thumbnail and tags
   * included, no Finish in YouTube Studio), "broken" = it needs Reconnect YouTube (meanwhile Upload
   * it yourself), "off" = the older path. upload: where it stands on her channel.
   */
  direct: { mode: "on" | "broken" | "off"; upload: { status: string; video_id: string | null; note: string | null; thumbnail: string | null; publish_at: string | null; privacy: string | null; url: string | null } | null };
}
export interface ReviewGroup {
  /** held_note: "Looks like someone else's video" (worker/domain/sourceCheck.ts), or null. */
  dump: { id: string; door: "new" | "recycle" | "youtube"; created_at: string; ready_at: string | null; status: string; held_note: string | null };
  clips: ReviewClip[];
}
export interface ReviewList {
  tab: ReviewTab;
  groups: ReviewGroup[];
  counts: { new: number; approved: number; rejected: number; hidden: number };
  /** Day 358: a page at a time. `total` = clips matching this tab + filters + search (true count). */
  total: number;
  limit: number;
  offset: number;
  q: string;
}

/** Clips per page in Review (each is a video player: a year of approved clips was 466 phone screens). */
export const REVIEW_PAGE = 12;

interface ClipDb {
  id: string;
  asset_id: string;
  dump_id: string;
  start_s: number;
  end_s: number;
  recipe: Recipe;
  hook_text: string;
  hook_alt: string | null;
  caption: string;
  hashtags: string;
  platforms: string;
  score: number;
  status: ClipStatus;
  reject_reason: string | null;
  paid_partnership: number;
  hidden: number;
  created_at: string;
  reviewed_at: string | null;
  media_token: string | null;
  cover_r2_key: string | null;
  source_file: string;
  door: "new" | "recycle";
  dump_created_at: string;
  dump_ready_at: string | null;
  dump_status: string;
  source_owner: string | null;
  source_note: string | null;
  look: string | null;
  layout: string | null;
  pending_look: string | null;
  rerender_error: string | null;
  media_version: number;
  edited_with: string | null;
  raw_deleted_at: string | null;
  busy_editor: string | null;
  busy_capability: string | null;
  voice_mix: string | null;
  voice_nid: string | null;
  music: string | null;
  pending_music: string | null;
  voice_script: string | null;
  voice_auto: number | null;
  full_video: number;
  youtube: string | null;
  file_deleted_at: string | null;
  yt_post: string | null;
  yt_upload: string | null;
  yt_conn: string | null;
  keep_until: string | null;
  delete_warned_at: string | null;
}

/** "?v=<file version>.<voice over>": changes when the file is swapped or a voice over is mixed in. */
export function mediaVersion(r: { media_version: number; voice_mix: string | null; voice_nid: string | null }): string {
  const parts = [r.media_version ? String(r.media_version) : "", r.voice_mix === "ready" && r.voice_nid ? r.voice_nid : ""].filter(Boolean);
  return parts.length ? `?v=${parts.join(".")}` : "";
}

function toView(r: ClipDb): ReviewClip {
  return {
    id: r.id,
    asset_id: r.asset_id,
    dump_id: r.dump_id,
    start_s: r.start_s,
    end_s: r.end_s,
    recipe: r.recipe,
    hook_text: r.hook_text,
    hook_alt: r.hook_alt,
    caption: r.caption,
    hashtags: r.hashtags,
    platforms: parseJson<Platform[]>(r.platforms, []),
    score: r.score,
    status: r.status,
    reject_reason: r.reject_reason,
    paid_partnership: !!r.paid_partnership,
    hidden: !!r.hidden,
    created_at: r.created_at,
    // ?v= changes whenever the file is swapped (a new look, her edit) or a voice over is mixed in,
    // so a player never keeps an old version cached.
    media_url: r.media_token ? `/media/${r.media_token}${mediaVersion(r)}` : "",
    // The public link expires 30 days after posting; her own screens still show the cover.
    cover_url: r.media_token && r.cover_r2_key ? `/media/${r.media_token}?cover=1${r.media_version ? `&v=${r.media_version}` : ""}` : r.cover_r2_key ? `/api/clips/${r.id}/cover` : null,
    source_file: r.source_file,
    door: r.door,
    reviewed_at: r.reviewed_at,
    purge_at: r.status === "rejected" ? purgeAt(r.reviewed_at) : null,
    look: r.look,
    look_name: lookById(r.look)?.name ?? null,
    layout: parseJson<GridLayout | null>(r.layout, null),
    pending_look: r.pending_look,
    pending_look_name: lookById(r.pending_look)?.name ?? null,
    rerender_error: r.rerender_error,
    source_available: !r.raw_deleted_at,
    edited_with: r.edited_with,
    edited_with_name: editorName(r.edited_with),
    editing_note: editingNote(r.busy_editor, r.busy_capability),
    voice_over: r.voice_mix === "mixing" || r.voice_mix === "ready" || r.voice_mix === "failed" ? r.voice_mix : null,
    music_id: r.music ? r.music.slice("music/".length) : null,
    pending_music: r.pending_music,
    voice_script: r.voice_script,
    voice_auto: !!r.voice_auto,
    full_video: r.full_video ? fullVideoView(r) : null,
    file_cleared: !r.full_video && !!r.file_deleted_at,
    clears_on: clearsOn(r),
  };
}

/** A draft in its warning window: the date its file goes (worker/domain/tidy.ts clipFileAction). */
function clearsOn(r: ClipDb): string | null {
  if (r.full_video || r.status !== "draft" || r.file_deleted_at) return null;
  const a = clipFileAction({ status: r.status, full_video: 0, created_at: r.created_at, file_deleted_at: null, last_posted_at: null, waiting_post: false, in_kit: false, keep_until: r.keep_until, delete_warned_at: r.delete_warned_at }, new Date());
  return a.do === "warn" ? a.deleteOn : null;
}

function fullVideoView(r: ClipDb): FullVideoView {
  const d = parseJson<FullVideoDetails | null>(r.youtube, null);
  const post = parseJson<{ status: string; url: string | null; scheduled_at: string } | null>(r.yt_post, null);
  const up = parseJson<{ status: string; video_id: string | null; note: string | null; thumbnail: string | null; publish_at: string | null; privacy: string | null } | null>(r.yt_upload, null);
  const base = d ?? ({ title: r.hook_text, description: r.caption, chapters: [], tags: [], thumbnails: [], thumb_pick: 0, privacy: "public", width: 0, height: 0, duration_s: r.end_s, size_bytes: 0, studio_done_at: null, handoff: false } as FullVideoDetails);
  return {
    ...base,
    thumbnails: base.thumbnails.map((t, i) => ({ url: r.media_token ? `/media/${r.media_token}?thumb=${i + 1}` : "", t: t.t })),
    file_deleted: !!r.file_deleted_at,
    post,
    studio_url: studioLink(post?.url ?? null),
    direct: { mode: r.yt_conn === "ok" ? "on" : r.yt_conn === "error" ? "broken" : "off", upload: up ? { ...up, url: up.video_id ? `https://www.youtube.com/watch?v=${up.video_id}` : null } : null },
  };
}

const CLIP_SELECT = `SELECT c.id, c.asset_id, c.dump_id, c.start_s, c.end_s, c.recipe, c.hook_text, c.hook_alt, c.caption, c.hashtags,
  c.platforms, c.score, c.status, c.reject_reason, c.paid_partnership, c.hidden, c.created_at, c.reviewed_at, c.media_token, c.cover_r2_key,
  c.look, c.layout, c.pending_look, c.rerender_error, c.media_version, c.edited_with, c.music, c.pending_music, a.raw_deleted_at,
  (SELECT e.editor FROM editor_jobs e WHERE e.clip_id = c.id AND e.status IN ('submitted', 'importing') ORDER BY e.created_at DESC LIMIT 1) AS busy_editor,
  (SELECT e.capability FROM editor_jobs e WHERE e.clip_id = c.id AND e.status IN ('submitted', 'importing') ORDER BY e.created_at DESC LIMIT 1) AS busy_capability,
  a.file_name AS source_file, a.source_owner, a.source_note,
  (SELECT n.mix_status FROM narrations n WHERE n.clip_id = c.id AND n.mix_status IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS voice_mix,
  (SELECT n.id FROM narrations n WHERE n.clip_id = c.id AND n.mix_status IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS voice_nid,
  (SELECT n.script FROM narrations n WHERE n.clip_id = c.id AND n.mix_status IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS voice_script,
  (SELECT n.auto FROM narrations n WHERE n.clip_id = c.id AND n.mix_status IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS voice_auto,
  c.full_video, c.youtube, c.file_deleted_at, c.keep_until, c.delete_warned_at,
  (SELECT json_object('status', p.status, 'url', p.url, 'scheduled_at', p.scheduled_at) FROM posts p WHERE p.clip_id = c.id AND c.full_video = 1 ORDER BY p.created_at DESC LIMIT 1) AS yt_post,
  (SELECT json_object('status', u.status, 'video_id', u.video_id, 'note', u.note, 'thumbnail', u.thumbnail, 'publish_at', u.publish_at, 'privacy', u.privacy) FROM youtube_uploads u WHERE u.clip_id = c.id AND c.full_video = 1) AS yt_upload,
  (SELECT cn.status FROM connections cn WHERE cn.service = 'youtube') AS yt_conn,
  CASE WHEN d.kind = 'full_video' THEN 'youtube' ELSE d.door END AS door, d.created_at AS dump_created_at, d.ready_at AS dump_ready_at, d.status AS dump_status
  FROM clips c JOIN assets a ON a.id = c.asset_id JOIN dumps d ON d.id = c.dump_id`;

clips.get("/", async (c) => {
  // While Review is open it asks connected editors about the clips they are working on.
  try {
    c.executionCtx.waitUntil(pollEditorJobs(c.env).catch(() => undefined));
  } catch {
    // no execution context (unit tests): the hourly lane polls
  }
  const tab = (["new", "approved", "rejected"].includes(c.req.query("tab") ?? "") ? c.req.query("tab") : "new") as ReviewTab;
  const status = tabStatus(tab);
  const door = c.req.query("door");
  const recipe = c.req.query("recipe");
  const platform = c.req.query("platform");
  const showHidden = c.req.query("hidden") === "1";

  const where = ["c.status = ?"];
  const binds: unknown[] = [status];
  if (door === "new" || door === "recycle") {
    where.push("d.door = ?");
    binds.push(door);
  }
  if (recipe && recipe in RECIPES) {
    where.push("c.recipe = ?");
    binds.push(recipe);
  }
  if (platform && (PLATFORMS as readonly string[]).includes(platform)) {
    where.push("EXISTS (SELECT 1 FROM json_each(c.platforms) j WHERE j.value = ?)");
    binds.push(platform);
  }
  // Under the quality bar stays tucked away in "new" unless she asks; decided clips always show.
  if (status === "draft" && !showHidden) where.push("c.hidden = 0");
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (q) {
    where.push("(c.hook_text LIKE ? OR c.caption LIKE ? OR c.hashtags LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? REVIEW_PAGE) || REVIEW_PAGE));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

  const { results } = await c.env.DB.prepare(`${CLIP_SELECT} WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC, c.score DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<ClipDb>();
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM clips c JOIN assets a ON a.id = c.asset_id JOIN dumps d ON d.id = c.dump_id WHERE ${where.join(" AND ")}`).bind(...binds).first<{ n: number }>())?.n ?? 0;

  const groups: ReviewGroup[] = [];
  const byDump = new Map<string, ReviewGroup>();
  for (const r of results) {
    let g = byDump.get(r.dump_id);
    if (!g) {
      g = { dump: { id: r.dump_id, door: r.door, created_at: r.dump_created_at, ready_at: r.dump_ready_at, status: r.dump_status, held_note: null }, clips: [] };
      byDump.set(r.dump_id, g);
      groups.push(g);
    }
    if (r.source_owner === "other" && !g.dump.held_note) g.dump.held_note = r.source_note;
    g.clips.push(toView(r));
  }

  const counts = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'draft' AND hidden = 0 THEN 1 ELSE 0 END) AS new,
       SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN status = 'draft' AND hidden = 1 THEN 1 ELSE 0 END) AS hidden
     FROM clips`,
  ).first<{ new: number | null; approved: number | null; rejected: number | null; hidden: number | null }>();

  const out: ReviewList = {
    tab,
    groups,
    counts: { new: counts?.new ?? 0, approved: counts?.approved ?? 0, rejected: counts?.rejected ?? 0, hidden: counts?.hidden ?? 0 },
    total,
    limit,
    offset,
    q,
  };
  return c.json(out);
});

/** Her own screens show a clip's cover even after its public link expired (day 358). */
clips.get("/:id/cover", async (c) => {
  const row = await c.env.DB.prepare("SELECT cover_r2_key FROM clips WHERE id = ?").bind(c.req.param("id")).first<{ cover_r2_key: string | null }>();
  const obj = row?.cover_r2_key ? await c.env.FILES.get(row.cover_r2_key) : null;
  if (!obj) return fail(c, 404, "No cover for that clip.");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "image/jpeg");
  headers.set("cache-control", "private, max-age=86400");
  return new Response(obj.body, { headers });
});

/**
 * Keep: drafts in their warning window (or the ones named) are kept 60 more days and their
 * warning starts over (worker/domain/tidy.ts FILES.keepDays).
 */
clips.post("/keep", async (c) => {
  const body = await readJson<{ ids?: string[] }>(c);
  const until = new Date(Date.now() + FILES.keepDays * 86400_000).toISOString();
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((x) => typeof x === "string").slice(0, MAX_BULK) : null;
  const r = ids
    ? await c.env.DB.prepare(`UPDATE clips SET keep_until = ?, delete_warned_at = NULL WHERE status = 'draft' AND id IN (SELECT value FROM json_each(?))`).bind(until, JSON.stringify(ids)).run()
    : await c.env.DB.prepare("UPDATE clips SET keep_until = ?, delete_warned_at = NULL WHERE status = 'draft' AND file_deleted_at IS NULL AND delete_warned_at IS NOT NULL").bind(until).run();
  const kept = Number(r.meta?.changes ?? 0);
  await recordEvent(c.env.DB, "clips.kept", null, { kept }, c.get("user").email);
  log.info("clips.kept", { kept });
  return c.json({ ok: true, kept, until });
});

// ---------------------------------------------------------------- decisions

interface Decision {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Posts already handed to Buffer keep their file; she can change them only from the Calendar. */
async function lockedByBuffer(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM posts WHERE clip_id = ? AND status = 'in_buffer' LIMIT 1").bind(id).first();
  return !!row;
}

/** A dump is "reviewed" once no visible draft clip is left; back to "ready" if one returns. */
async function syncDumpStatus(env: Env, dumpIds: Iterable<string>) {
  for (const dumpId of new Set(dumpIds)) {
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE dump_id = ? AND status = 'draft' AND hidden = 0").bind(dumpId).first<{ n: number }>();
    if ((left?.n ?? 0) === 0) await env.DB.prepare("UPDATE dumps SET status = 'reviewed' WHERE id = ? AND status = 'ready'").bind(dumpId).run();
    else await env.DB.prepare("UPDATE dumps SET status = 'ready' WHERE id = ? AND status = 'reviewed'").bind(dumpId).run();
  }
}

async function removeFiles(env: Env, keys: (string | null)[]) {
  const list = keys.filter((k): k is string => !!k);
  if (list.length) await env.FILES.delete(list);
}

async function decide(env: Env, id: string, to: ClipStatus, actor: string, reason: string | null, touched: Set<string>): Promise<Decision> {
  const clip = await env.DB.prepare("SELECT id, dump_id, status, recipe, score, r2_key, cover_r2_key, hidden FROM clips WHERE id = ?").bind(id).first<{
    id: string;
    dump_id: string;
    status: ClipStatus;
    recipe: string;
    score: number;
    r2_key: string;
    cover_r2_key: string | null;
    hidden: number;
  }>();
  if (!clip || clip.status === "deleted") return { ok: false, status: 404, error: "That clip is gone." };
  if (clip.status === to) return { ok: true };
  if (!canTransition(clip.status, to)) return { ok: false, status: 409, error: "That clip can't be changed that way." };
  if ((to === "rejected" || to === "deleted" || to === "draft") && (await lockedByBuffer(env, id)))
    return { ok: false, status: 409, error: "This clip is already loaded into Buffer. Remove it from the Calendar first." };

  const now = nowIso();
  if (to === "deleted") {
    await removeFiles(env, [clip.r2_key, clip.cover_r2_key]);
    await env.DB.batch([
      env.DB.prepare("UPDATE clips SET status = 'deleted', media_token = NULL, reviewed_at = ? WHERE id = ?").bind(now, id),
      env.DB.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = ? AND status = 'planned'").bind(id),
    ]);
  } else if (to === "rejected") {
    await env.DB.batch([
      env.DB.prepare("UPDATE clips SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?").bind(reason, now, id),
      env.DB.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = ? AND status = 'planned'").bind(id),
    ]);
  } else if (to === "approved") {
    // Approving a hidden clip means she wants it: it stops being hidden.
    await env.DB.prepare("UPDATE clips SET status = 'approved', reject_reason = NULL, hidden = 0, reviewed_at = ? WHERE id = ?").bind(now, id).run();
  } else {
    await env.DB.batch([
      env.DB.prepare("UPDATE clips SET status = 'draft', reject_reason = NULL, reviewed_at = NULL WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = ? AND status = 'planned'").bind(id),
    ]);
  }
  const kind = to === "draft" ? "clip.restored" : `clip.${to}`;
  await recordEvent(env.DB, kind, id, { recipe: clip.recipe, score: clip.score, from: clip.status, ...(reason ? { reason } : {}) }, actor);
  touched.add(clip.dump_id);
  return { ok: true };
}

async function single(c: Context<{ Bindings: Env; Variables: Vars }>, to: ClipStatus, reason: string | null = null) {
  const touched = new Set<string>();
  const r = await decide(c.env, c.req.param("id") ?? "", to, c.get("user").email, reason, touched);
  if (!r.ok) return fail(c, (r.status ?? 409) as 404 | 409, r.error ?? "That did not work.", "review-and-approve-clips");
  await syncDumpStatus(c.env, touched);
  log.info("clip.decide", { to });
  return c.json({ ok: true });
}

clips.post("/:id/approve", (c) => single(c, "approved"));
clips.post("/:id/restore", (c) => single(c, "draft"));
clips.post("/:id/reject", async (c) => {
  const body = await readJson<{ reason?: string }>(c);
  return single(c, "rejected", normalizeReason(body?.reason));
});
clips.delete("/:id", (c) => single(c, "deleted"));

clips.post("/bulk", async (c) => {
  const body = await readJson<{ action?: string; ids?: unknown; reason?: string }>(c);
  const action = body?.action;
  if (action !== "approve" && action !== "reject" && action !== "delete") return fail(c, 400, "Pick approve, reject or delete.");
  const ids = Array.isArray(body?.ids) ? [...new Set(body!.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length) return fail(c, 400, "Pick at least one clip.");
  if (ids.length > MAX_BULK) return fail(c, 413, `That's more than ${MAX_BULK} clips at once. Filter the list and try again.`);
  const to: ClipStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "deleted";
  const reason = action === "reject" ? normalizeReason(body?.reason) : null;
  const touched = new Set<string>();
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    const r = await decide(c.env, id, to, c.get("user").email, reason, touched);
    if (r.ok) done++;
    else skipped++;
  }
  await syncDumpStatus(c.env, touched);
  log.info("clip.bulk", { action, done, skipped });
  return c.json({ ok: true, done, skipped });
});

// ---------------------------------------------------------------- edit

clips.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ caption?: string; hashtags?: string; hook_text?: string; swap_hook?: boolean; platforms?: unknown; paid_partnership?: boolean }>(c);
  if (!body) return fail(c, 400, "Nothing to save.");
  const clip = await c.env.DB.prepare("SELECT id, status, caption, hashtags, hook_text, hook_alt, platforms, paid_partnership FROM clips WHERE id = ?").bind(id).first<{
    id: string;
    status: ClipStatus;
    caption: string;
    hashtags: string;
    hook_text: string;
    hook_alt: string | null;
    platforms: string;
    paid_partnership: number;
  }>();
  if (!clip || clip.status === "deleted") return fail(c, 404, "That clip is gone.");
  if (await lockedByBuffer(c.env, id)) return fail(c, 409, "This clip is already loaded into Buffer. Remove it from the Calendar first, then edit.", "move-or-remove-a-post");

  let caption = body.caption !== undefined ? String(body.caption).slice(0, 2200) : clip.caption;
  let hook = body.hook_text !== undefined ? String(body.hook_text).trim().slice(0, 200) : clip.hook_text;
  let hookAlt = clip.hook_alt;
  if (body.swap_hook) {
    if (!clip.hook_alt) return fail(c, 409, "This clip has no other hook to swap in.");
    [hook, hookAlt] = [clip.hook_alt, clip.hook_text];
  }
  if (!hook) return fail(c, 422, "The on-screen hook can't be empty.", "edit-a-caption");
  const hashtags = body.hashtags !== undefined ? String(body.hashtags).slice(0, 500) : clip.hashtags;
  let platforms = parseJson<Platform[]>(clip.platforms, []);
  if (body.platforms !== undefined) {
    const p = cleanPlatforms(body.platforms);
    if (!p) return fail(c, 422, "Leave at least one platform ticked, or reject the clip instead.", "review-and-approve-clips");
    platforms = p;
  }
  const paid = body.paid_partnership !== undefined ? !!body.paid_partnership : !!clip.paid_partnership;
  if (body.paid_partnership !== undefined || body.caption !== undefined) caption = withDisclosure(caption, paid);

  await c.env.DB.prepare("UPDATE clips SET caption = ?, hashtags = ?, hook_text = ?, hook_alt = ?, platforms = ?, paid_partnership = ? WHERE id = ?")
    .bind(caption, hashtags, hook, hookAlt, JSON.stringify(platforms), paid ? 1 : 0, id)
    .run();
  // Unticked platforms leave the Calendar too.
  const dropped = PLATFORMS.filter((p) => !platforms.includes(p));
  for (const p of dropped) await c.env.DB.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = ? AND platform = ? AND status = 'planned'").bind(id, p).run();

  const fields = Object.keys(body).filter((k) => ["caption", "hashtags", "hook_text", "swap_hook", "platforms", "paid_partnership"].includes(k));
  await recordEvent(c.env.DB, "clip.edited", id, { fields, paid }, c.get("user").email);
  log.info("clip.edit", { fields: fields.length });
  const row = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json(row ? toView(row) : { ok: true });
});

// ---------------------------------------------------------------- a full video for YouTube

async function fullRow(env: Env, id: string) {
  return env.DB.prepare("SELECT id, status, youtube, full_video FROM clips WHERE id = ?").bind(id).first<{ id: string; status: ClipStatus; youtube: string | null; full_video: number }>();
}

/**
 * Her edits to a full video: title, description body, tags, which of the three thumbnails, and
 * the privacy (Public / Unlisted / Private; Buffer sends it to YouTube). The description YouTube
 * gets is rebuilt with the chapters and hashtags (composeDescription).
 */
clips.patch("/:id/youtube", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ title?: string; description?: string; tags?: unknown; thumb_pick?: number; privacy?: string; chapters?: unknown }>(c);
  const row = await fullRow(c.env, id);
  if (!row || row.status === "deleted" || !row.full_video) return fail(c, 404, "That video is gone.");
  if (await lockedByBuffer(c.env, id)) return fail(c, 409, "This video is already loaded into Buffer. Remove it from the Calendar first, then edit.", "move-or-remove-a-post");
  // Already on her channel (Connect YouTube): words and thumbnail live on YouTube now.
  const up = await c.env.DB.prepare("SELECT status FROM youtube_uploads WHERE clip_id = ? AND (video_id IS NOT NULL OR status = 'uploading')").bind(id).first<{ status: string }>();
  if (up) return fail(c, 409, up.status === "uploading" ? "This video is uploading to your channel right now. Change it in YouTube Studio once it's up." : "This video is already on your YouTube channel. Change its words or thumbnail in YouTube Studio; move it on the Calendar to change its time.", "post-a-full-video");
  const d = parseJson<FullVideoDetails | null>(row.youtube, null);
  if (!d) return fail(c, 404, "That video is gone.");
  if (body?.title !== undefined) {
    if (!String(body.title).trim()) return fail(c, 422, "The title can't be empty.", "review-and-approve-clips");
    d.title = cleanTitle(body.title, d.title);
  }
  if (body?.description !== undefined) d.description = String(body.description).slice(0, DESCRIPTION_MAX - 1500);
  if (body?.tags !== undefined) d.tags = cleanTags(body.tags);
  if (body?.thumb_pick !== undefined) {
    const n = Number(body.thumb_pick);
    if (!Number.isInteger(n) || n < 0 || n >= d.thumbnails.length) return fail(c, 422, "Pick one of the three thumbnails.");
    d.thumb_pick = n;
  }
  if (body?.privacy !== undefined) {
    if (!(FULL_VIDEO_PRIVACY as readonly string[]).includes(String(body.privacy))) return fail(c, 422, "Pick Public, Unlisted or Private.");
    d.privacy = body.privacy as FullVideoPrivacy;
  }
  if (Array.isArray(body?.chapters)) {
    d.chapters = (body!.chapters as { t?: unknown; title?: unknown }[])
      .map((x) => ({ t: Math.max(0, Math.floor(Number(x.t) || 0)), title: String(x.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80) }))
      .filter((x) => x.title)
      .sort((a, b) => a.t - b.t)
      .slice(0, 30);
  }
  const cover = d.thumbnails[d.thumb_pick]?.key ?? null;
  await c.env.DB.prepare("UPDATE clips SET youtube = ?, hook_text = ?, caption = ?, cover_r2_key = COALESCE(?, cover_r2_key) WHERE id = ?")
    .bind(JSON.stringify(d), d.title, composeDescription(d.description, d.chapters, d.tags), cover, id)
    .run();
  await recordEvent(c.env.DB, "fullvideo.edited", id, { fields: Object.keys(body ?? {}) }, c.get("user").email);
  const r = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json(r ? toView(r) : { ok: true });
});

/** "Finish in YouTube Studio": she set the thumbnail and tags there (Buffer can't); the Home card goes away. */
clips.post("/:id/youtube/studio-done", async (c) => {
  const id = c.req.param("id");
  const row = await fullRow(c.env, id);
  if (!row?.full_video) return fail(c, 404, "That video is gone.");
  const d = parseJson<FullVideoDetails>(row.youtube, {} as FullVideoDetails);
  d.studio_done_at = nowIso();
  await c.env.DB.prepare("UPDATE clips SET youtube = ? WHERE id = ?").bind(JSON.stringify(d), id).run();
  await recordEvent(c.env.DB, "fullvideo.studio_done", id, {}, c.get("user").email);
  return c.json({ ok: true });
});

/**
 * The last resort, when Buffer won't take it: she uploads it herself ("Download for YouTube",
 * then YouTube Studio) and pastes the link here; without a link, the daily public-stats read
 * finds it by its title and marks it posted.
 */
clips.post("/:id/youtube/posted", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ url?: string }>(c);
  const url = String(body?.url ?? "").trim();
  const vid = url.match(/(?:v=|youtu\.be\/|shorts\/|studio\.youtube\.com\/video\/)([\w-]{11})/)?.[1];
  if (!vid) return fail(c, 422, "Paste the video's YouTube link (it has watch?v= or youtu.be in it).", "move-or-remove-a-post");
  const row = await fullRow(c.env, id);
  if (!row?.full_video) return fail(c, 404, "That video is gone.");
  const link = `https://www.youtube.com/watch?v=${vid}`;
  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE clip_id = ? AND platform = 'youtube' ORDER BY created_at DESC LIMIT 1").bind(id).first<{ id: string }>();
  if (post) await c.env.DB.prepare("UPDATE posts SET status = 'posted', url = ?, posted_at = ?, error = NULL WHERE id = ?").bind(link, nowIso(), post.id).run();
  else await c.env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at, status, url, posted_at) VALUES (?, ?, 'youtube', ?, 'posted', ?, ?)").bind(newId("pst"), id, nowIso(), link, nowIso()).run();
  await recordEvent(c.env.DB, "fullvideo.posted_by_hand", id, {}, c.get("user").email);
  return c.json({ ok: true, url: link });
});

// ---------------------------------------------------------------- Change look (re-render one clip)

export interface LookChangeState {
  status: ClipStatus;
  look: string | null;
  pending_look: string | null;
  raw_deleted_at: string | null;
  in_buffer: boolean;
}

/**
 * Why a clip's look can't change right now, as the sentence she sees, or null when it can.
 * Pure (unit-tested): the route only loads the state and acts on the answer.
 */
export function lookChangeRefusal(clip: LookChangeState | null, look: unknown, sameLayout: boolean, sameLookOk = false): { status: 404 | 409 | 422; error: string } | null {
  if (!clip || clip.status === "deleted") return { status: 404, error: "That clip is gone." };
  if (!isLookId(look)) return { status: 422, error: "Pick one of the looks in the list." };
  if (clip.in_buffer) return { status: 409, error: "This clip is already loaded into Buffer. Remove it from the Calendar first, then change its look." };
  if (clip.pending_look) return { status: 409, error: "This clip is already getting a new look. It will be ready in about a minute." };
  if (clip.raw_deleted_at) return { status: 409, error: "The original video for this clip was cleared after 7 days, so its look can't change. Dump that video again to get new looks." };
  // Change music keeps the look on purpose (sameLookOk); a Change look to the same look is refused.
  if (!sameLookOk && clip.look === look && (!isGridLook(look) || sameLayout)) return { status: 409, error: "It already has that look. Pick a different one." };
  return null;
}

interface CellClipDb {
  id: string;
  dump_id: string;
  hook_text: string;
  start_s: number;
  end_s: number;
  look: string | null;
  media_token: string | null;
  cover_r2_key: string | null;
  media_version: number;
  status: ClipStatus;
}

export interface CellOption {
  id: string;
  hook_text: string;
  seconds: number;
  look_name: string | null;
  cover_url: string | null;
}

function cellOption(r: CellClipDb): CellOption {
  return {
    id: r.id,
    hook_text: r.hook_text,
    seconds: Math.round((r.end_s - r.start_s) * 10) / 10,
    look_name: lookById(r.look)?.name ?? null,
    // The public link expires 30 days after posting; her own screens still show the cover.
    cover_url: r.media_token && r.cover_r2_key ? `/media/${r.media_token}?cover=1${r.media_version ? `&v=${r.media_version}` : ""}` : r.cover_r2_key ? `/api/clips/${r.id}/cover` : null,
  };
}

const CELL_SELECT = "SELECT id, dump_id, hook_text, start_s, end_s, look, media_token, cover_r2_key, media_version, status FROM clips";

/** What a grid cell can show: this dump's other clips, approved clips from her library, this moment closer. */
clips.get("/:id/cells", async (c) => {
  const clip = await c.env.DB.prepare(`${CELL_SELECT} WHERE id = ?`).bind(c.req.param("id")).first<CellClipDb>();
  if (!clip || clip.status === "deleted") return fail(c, 404, "That clip is gone.");
  const { results: same } = await c.env.DB.prepare(`${CELL_SELECT} WHERE dump_id = ? AND id != ? AND status != 'deleted' ORDER BY score DESC LIMIT 40`).bind(clip.dump_id, clip.id).all<CellClipDb>();
  const { results: library } = await c.env.DB.prepare(`${CELL_SELECT} WHERE dump_id != ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 40`).bind(clip.dump_id).all<CellClipDb>();
  return c.json({ self: cellOption(clip), dump: same.map(cellOption), library: library.map(cellOption), zooms: ZOOMS });
});

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface RerenderRow {
  id: string;
  dump_id: string;
  status: ClipStatus;
  look: string | null;
  layout: string | null;
  pending_look: string | null;
  raw_deleted_at: string | null;
  edited_with: string | null;
}

async function rerenderRow(env: Env, id: string): Promise<RerenderRow | null> {
  return env.DB.prepare("SELECT c.id, c.dump_id, c.status, c.look, c.layout, c.pending_look, c.edited_with, a.raw_deleted_at FROM clips c JOIN assets a ON a.id = c.asset_id WHERE c.id = ?")
    .bind(id)
    .first<RerenderRow>();
}

clips.post("/:id/look", async (c) => {
  const body = await readJson<{ look?: string; layout?: unknown }>(c);
  return rerender(c, c.req.param("id"), body?.look, body?.layout, {});
});

/** Change music: none, or one of her songs; the clip keeps its look. Her own edit (CapCut) keeps its music. */
clips.post("/:id/music", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ music?: string }>(c);
  const row = await rerenderRow(c.env, id);
  if (row?.edited_with) return fail(c, 409, "This clip is your own edit, so its music stays as you made it. Change it in your editing app and upload it again.", "looks-and-styles");
  const tracks = await tracksOf(c.env);
  const music = body?.music === "none" ? "none" : tracks.find((t) => t.id === body?.music)?.id;
  if (!music) return fail(c, 422, "Pick No music or one of your songs.", "looks-and-styles");
  return rerender(c, id, row?.look ?? "clean", undefined, { music, sameLookOk: true });
});

/** Try another version: a different look, picked at random from the ones in her mix. */
clips.post("/:id/another", async (c) => {
  const id = c.req.param("id");
  const row = await rerenderRow(c.env, id);
  const editing = editingFromStored(await getSetting<StoredEditing>(c.env.DB, "editing", {}));
  const pool = editing.looks.filter((l) => l !== row?.look);
  const pick = (pool.length ? pool : LOOK_IDS.filter((l) => l !== row?.look))[crypto.getRandomValues(new Uint32Array(1))[0] % Math.max(1, pool.length || LOOK_IDS.length - 1)];
  return rerender(c, id, pick, undefined, {});
});

/** Queue a re-render of one clip (a new look, new cells, or new music); the old file plays until it is ready. */
async function rerender(c: Ctx, id: string, look: unknown, layoutInput: unknown, opts: { music?: string; sameLookOk?: boolean }) {
  const row = await rerenderRow(c.env, id);
  let layout: GridLayout | null = null;
  if (row && isLookId(look) && isGridLook(look)) {
    if (layoutInput !== undefined) {
      layout = cleanGridLayout(look, layoutInput);
      if (!layout) return fail(c, 422, `Pick something for all ${cellCount(look)} cells, with this clip in at least one of them.`, "looks-and-styles");
      for (const cell of layout.cells) {
        if (cell.kind !== "clip") continue;
        const other = await c.env.DB.prepare("SELECT dump_id, status FROM clips WHERE id = ?").bind(cell.clip_id).first<{ dump_id: string; status: ClipStatus }>();
        if (!other || other.status === "deleted" || (other.dump_id !== row.dump_id && other.status !== "approved"))
          return fail(c, 422, "One of the cells points at a clip that is gone. Pick it again.", "looks-and-styles");
      }
    } else if (opts.sameLookOk && row.look === look && row.layout) {
      layout = parseJson<GridLayout | null>(row.layout, null);
    } else {
      const { results } = await c.env.DB.prepare("SELECT id FROM clips WHERE dump_id = ? AND id != ? AND status != 'deleted' ORDER BY score DESC LIMIT 8").bind(row.dump_id, row.id).all<{ id: string }>();
      layout = defaultGridLayout(look, results.map((r) => r.id));
    }
  }
  const state = row ? { ...row, in_buffer: await lockedByBuffer(c.env, id) } : null;
  const sameLayout = !!row && JSON.stringify(parseJson(row.layout, null)) === JSON.stringify(layout);
  const refused = lookChangeRefusal(state, look, sameLayout, !!opts.sameLookOk);
  if (refused) return fail(c, refused.status, refused.error, "looks-and-styles");
  // The old file stays live; the job writes <clip>-v<n+1>.mp4 and applyRerender swaps it in.
  await c.env.DB.prepare("UPDATE clips SET pending_look = ?, pending_layout = ?, pending_music = ?, rerender_error = NULL WHERE id = ?")
    .bind(look as LookId, layout ? JSON.stringify(layout) : null, opts.music ?? null, id)
    .run();
  const job = await dispatchJob(c.env, "cut", `${row!.dump_id}/${id}`);
  if (!job.dispatched) {
    await c.env.DB.prepare("UPDATE clips SET pending_look = NULL, pending_layout = NULL, pending_music = NULL, rerender_error = ? WHERE id = ?").bind("We couldn't start the new look. Try again in a minute.", id).run();
    return fail(c, 502, "We couldn't start the new look. Try again in a minute.", "reconnect-github");
  }
  await c.env.DB.prepare("UPDATE clips SET rerender_job_id = ? WHERE id = ?").bind(job.jobId, id).run();
  await recordEvent(c.env.DB, opts.music ? "clip.music_requested" : "clip.look_requested", id, { look, from: row!.look, music: opts.music ? (opts.music === "none" ? "none" : "song") : undefined }, c.get("user").email);
  log.info("clip.look", { grid: !!layout });
  const updated = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json({ jobId: job.jobId, clip: updated ? toView(updated) : null });
}

// ---------------------------------------------------------------- her own edit (hand-back)

/**
 * "Replace with my edit": her finished video from CapCut, InShot or another app, already uploaded
 * (kind "edit", key edits/<clip>/<upload>). The header is read here so a wrong shape or length is
 * refused at once, in words that say what to change in the app; the cut job then measures it
 * again, levels the loudness, makes the cover and swaps it in (the current file plays meanwhile).
 */
clips.post("/:id/replace", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ id?: string; key?: string; app?: string }>(c);
  const app = isHandoffApp(body?.app) ? body!.app! : "other";
  const appName = app === "other" ? "your editing app" : HANDOFF[app as keyof typeof HANDOFF].name;
  const clip = await c.env.DB.prepare("SELECT id, dump_id, status, platforms FROM clips WHERE id = ?").bind(id).first<{ id: string; dump_id: string; status: ClipStatus; platforms: string }>();
  if (!clip || clip.status === "deleted") return fail(c, 404, "That clip is gone.");
  const key = String(body?.key ?? "");
  if (!/^upl_[a-z0-9]{8,40}$/.test(String(body?.id ?? "")) || key !== `edits/${id}/${body!.id}`) return fail(c, 400, "That upload is not an edit of this clip.", "edit-in-capcut");
  if (await lockedByBuffer(c.env, id)) {
    await c.env.FILES.delete(key);
    return fail(c, 409, "This clip is already loaded into Buffer. Remove it from the Calendar first, then replace it.", "move-or-remove-a-post");
  }
  const probe = await probeR2(c.env.FILES, key);
  const ok = checkEdit(probe, parseJson<Platform[]>(clip.platforms, [...PLATFORMS]), appName);
  if (!ok.ok) {
    await c.env.FILES.delete(key);
    return fail(c, 422, ok.error, "edit-in-capcut");
  }
  const started = await startHandback(c.env, clip, app, key);
  if (!started.ok) return fail(c, 409, started.error, "edit-in-capcut");
  await c.env.DB.prepare("UPDATE clips SET rerender_error = NULL WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, "clip.edit_uploaded", id, { app, seconds: Math.round(probe!.duration_s) }, c.get("user").email);
  log.info("clip.handback", { app });
  const row = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json({ jobId: started.jobId, clip: row ? toView(row) : null, measured: probe });
});

// ---------------------------------------------------------------- her voice over on a clip (Review)

/** Remove: the clip goes back to its own sound (the voice over and its mixed file are deleted). */
clips.post("/:id/voice-over/remove", async (c) => {
  const id = c.req.param("id");
  if (await lockedByBuffer(c.env, id)) return fail(c, 409, "This clip is already loaded into Buffer. Remove it from the Calendar first.", "move-or-remove-a-post");
  const n = await removeVoiceOver(c.env, id);
  if (!n) return fail(c, 404, "This clip has no voice over.", "record-your-voice");
  await recordEvent(c.env.DB, "voice.removed", id, {}, c.get("user").email);
  const row = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json({ ok: true, clip: row ? toView(row) : null });
});

/** Add voice over (Review): a script to start from, fitted to the clip, and whether her voice is saved yet. */
clips.post("/:id/voice-over/draft", async (c) => {
  const clip = await c.env.DB.prepare("SELECT id, hook_text, caption, start_s, end_s, speech FROM clips WHERE id = ? AND status != 'deleted'").bind(c.req.param("id")).first<{ id: string; hook_text: string; caption: string; start_s: number; end_s: number; speech: number | null }>();
  if (!clip) return fail(c, 404, "That clip is gone.");
  return c.json({ script: await draftScript(c.env, clip), has_voice: await hasVoiceSample(c.env) });
});

/** Add, or Redo with her own words: the script she wrote is voiced and mixed into just this clip. */
clips.post("/:id/voice-over", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ script?: string }>(c);
  const script = String(body?.script ?? "").replace(/\s+/g, " ").trim();
  const clip = await c.env.DB.prepare("SELECT start_s, end_s, status FROM clips WHERE id = ?").bind(id).first<{ start_s: number; end_s: number; status: ClipStatus }>();
  if (!clip || clip.status === "deleted") return fail(c, 404, "That clip is gone.");
  if (script.length < 10) return fail(c, 422, "Write a sentence or two for the voice over.", "record-your-voice");
  const seconds = clip.end_s - clip.start_s;
  const words = script.split(" ").length;
  if (words > maxWords(seconds)) return fail(c, 422, `That's ${words} words; this ${Math.round(seconds)}-second clip has room for about ${maxWords(seconds)}. Shorten it a little.`, "record-your-voice");
  if (!(await hasVoiceSample(c.env))) return fail(c, 409, "Record your voice first, on Voice overs.", "record-your-voice");
  if (await lockedByBuffer(c.env, id)) return fail(c, 409, "This clip is already loaded into Buffer. Remove it from the Calendar first.", "move-or-remove-a-post");
  const r = await redoVoiceOver(c.env, id, script);
  if (!r.batch) return fail(c, 502, "The voice over could not start. Try again in a minute.", "reconnect-github");
  await recordEvent(c.env.DB, "voice.redo", id, { words }, c.get("user").email);
  const row = await c.env.DB.prepare(`${CLIP_SELECT} WHERE c.id = ?`).bind(id).first<ClipDb>();
  return c.json({ ok: true, clip: row ? toView(row) : null });
});
