// The full-video door, after Review: the storage rule, the Home cards and the hand-off match.
//   fullVideoRetention  daily: the video file goes 7 days after it posted (thumbnail, words and
//                       numbers stay) and an unapproved one goes after 14 days (worker/domain/
//                       fullVideo.ts storageAction; Home warns from 3 days before).
//   fullVideoCards      Home: "Finish in YouTube Studio" (thumbnail + tags, which Buffer can't
//                       set), "Upload it yourself" (the hand-off when Buffer won't take it), and
//                       the 3-day warning before an unapproved one is removed.
//   matchHandoffs       after YouTube's public numbers are read: a video she uploaded herself is
//                       found by its title and its post marked Posted, with the link.
import type { Env } from "../env";
import { parseJson, recordEvent } from "./db";
import { nowIso } from "./ids";
import { log } from "./log";
import { storageAction, studioLink, type FullVideoDetails } from "../domain/fullVideo";
import { THUMB_VERIFY_NOTE, YT_VERIFY_URL } from "../domain/youtubeDirect";
import { directMode, uploadStates } from "./youtubeDirect";

interface Row {
  id: string;
  status: string;
  created_at: string;
  r2_key: string;
  media_token: string | null;
  youtube: string | null;
  file_deleted_at: string | null;
  posted_at: string | null;
  post_url: string | null;
  post_status: string | null;
}

const SELECT = `SELECT c.id, c.status, c.created_at, c.r2_key, c.media_token, c.youtube, c.file_deleted_at,
  (SELECT p.posted_at FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted' ORDER BY p.posted_at DESC LIMIT 1) AS posted_at,
  (SELECT p.url FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted' ORDER BY p.posted_at DESC LIMIT 1) AS post_url,
  (SELECT p.status FROM posts p WHERE p.clip_id = c.id ORDER BY p.created_at DESC LIMIT 1) AS post_status
  FROM clips c WHERE c.full_video = 1 AND c.status != 'deleted'`;

export async function fullVideoRetention(env: Env, now = new Date()): Promise<{ deleted: number }> {
  const { results } = await env.DB.prepare(`${SELECT} AND c.file_deleted_at IS NULL LIMIT 200`).all<Row>();
  let deleted = 0;
  for (const r of results) {
    const a = storageAction({ status: r.status, created_at: r.created_at, posted_at: r.posted_at, file_deleted_at: r.file_deleted_at }, now);
    if (a.do !== "delete") continue;
    await env.FILES.delete(r.r2_key);
    // Posted: it stays in the list with its thumbnail, words and numbers. Never approved: it leaves Review.
    await env.DB.prepare(`UPDATE clips SET file_deleted_at = ?${a.why === "unapproved" ? ", status = 'deleted'" : ""} WHERE id = ?`).bind(nowIso(), r.id).run();
    await recordEvent(env.DB, "fullvideo.file_deleted", r.id, { why: a.why });
    deleted++;
  }
  log.info("fullvideo.retention", { checked: results.length, deleted });
  return { deleted };
}

export interface FullVideoCard {
  kind: "finish_in_studio" | "upload_yourself" | "removal_soon" | "youtube_note";
  clip_id: string;
  title: string;
  thumbnail_url: string | null;
  tags: string[];
  studio_url: string;
  download_url: string | null;
  delete_on: string | null;
  note?: string | null;
  link?: { label: string; url: string } | null;
}

export async function fullVideoCards(env: Env, now = new Date()): Promise<FullVideoCard[]> {
  const { results } = await env.DB.prepare(SELECT).all<Row>();
  const out: FullVideoCard[] = [];
  // Connect YouTube (full videos): connected = no Finish in YouTube Studio and no Upload it yourself
  // (the thumbnail, tags and time go up with the video), except as the fallback of a named failure.
  const mode = await directMode(env);
  const uploads = mode === "off" ? new Map() : await uploadStates(env, results.map((r) => r.id));
  for (const r of results) {
    const d = parseJson<FullVideoDetails | null>(r.youtube, null);
    if (!d) continue;
    const base = {
      clip_id: r.id,
      title: d.title,
      thumbnail_url: r.media_token && d.thumbnails.length ? `/media/${r.media_token}?thumb=${d.thumb_pick + 1}&download=1` : null,
      tags: d.tags,
      studio_url: studioLink(r.post_url),
      download_url: r.media_token && !r.file_deleted_at ? `/media/${r.media_token}?download=1` : null,
      delete_on: null,
    };
    const a = storageAction({ status: r.status, created_at: r.created_at, posted_at: r.posted_at, file_deleted_at: r.file_deleted_at }, now);
    if (a.do === "warn") out.push({ ...base, kind: "removal_soon", delete_on: a.deleteOn });
    if (mode !== "off") {
      const u = uploads.get(r.id);
      const waiting = r.status === "approved" && !r.posted_at && !r.file_deleted_at;
      if (u?.status === "failed" || u?.status === "mismatch" || (mode === "broken" && waiting && !u?.video_id)) {
        const note = u?.note ?? "YouTube needs you to reconnect (Connect → Reconnect YouTube). Meanwhile you can upload it yourself.";
        if (waiting && !u?.video_id) out.push({ ...base, kind: "upload_yourself", studio_url: "https://www.youtube.com/upload", note });
        else out.push({ ...base, kind: "youtube_note", note, studio_url: u?.video_id ? `https://studio.youtube.com/video/${u.video_id}/edit` : base.studio_url, link: u?.video_id ? { label: "Open in YouTube Studio", url: `https://studio.youtube.com/video/${u.video_id}/edit` } : null });
      } else if (u?.thumbnail === "needs_verify") {
        out.push({ ...base, kind: "youtube_note", note: `“${d.title}” is on your channel. ${THUMB_VERIFY_NOTE}, then set the thumbnail in YouTube Studio.`, link: { label: "Verify my channel", url: YT_VERIFY_URL } });
      } else if (u?.status === "queued" && u.note) {
        out.push({ ...base, kind: "youtube_note", note: u.note, link: null });
      }
      continue;
    }
    if (d.handoff && r.status === "approved" && !r.posted_at && !r.file_deleted_at) out.push({ ...base, kind: "upload_yourself", studio_url: "https://www.youtube.com/upload" });
    else if (r.posted_at && !d.studio_done_at) out.push({ ...base, kind: "finish_in_studio" });
  }
  return out;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A handed-off full video she uploaded herself, found in her channel's public uploads by its title. */
export async function matchHandoffs(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(`${SELECT} AND c.youtube LIKE '%"handoff":true%'`).all<Row>();
  let found = 0;
  for (const r of results) {
    if (r.posted_at) continue;
    const d = parseJson<FullVideoDetails | null>(r.youtube, null);
    if (!d?.title) continue;
    const { results: vids } = await env.DB.prepare("SELECT external_id, title, posted_at FROM platform_videos WHERE platform = 'youtube' AND (posted_at IS NULL OR posted_at >= ?) ORDER BY posted_at DESC LIMIT 100").bind(r.created_at).all<{ external_id: string; title: string | null; posted_at: string | null }>();
    const v = vids.find((x) => norm(x.title) === norm(d.title));
    if (!v) continue;
    const url = `https://www.youtube.com/watch?v=${v.external_id}`;
    const post = await env.DB.prepare("SELECT id FROM posts WHERE clip_id = ? AND platform = 'youtube' ORDER BY created_at DESC LIMIT 1").bind(r.id).first<{ id: string }>();
    const at = v.posted_at ?? nowIso();
    if (post) await env.DB.prepare("UPDATE posts SET status = 'posted', url = ?, posted_at = ?, error = NULL WHERE id = ?").bind(url, at, post.id).run();
    await recordEvent(env.DB, "fullvideo.handoff_found", r.id, {});
    found++;
  }
  if (found) log.info("fullvideo.handoff_found", { found });
  return found;
}
