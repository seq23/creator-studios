// Full videos straight to her own YouTube channel: the Worker's side (worker/domain/youtubeDirect.ts
// has the pure rules, jobs/ytupload.py does the upload itself).
//
//   directMode          "on" (connected), "broken" (Google refused the sign-in: red light, Reconnect
//                       YouTube, the video falls back to Upload it yourself), "off" (never connected:
//                       the older path, Buffer or Upload it yourself)
//   youtubeAccessToken  a short-lived access token for the job, refreshed from the stored refresh
//                       token; the refresh token never leaves the Worker
//   youtubeDirectSync   hourly: uploads what is due (7-day window, 3 a day, YouTube's quota day),
//                       follows the Calendar (move → publishAt, taken off → private), reads back
//   reconcileClip       the same for one video at once (after a move or a take-off)
//   applyUpload         the job's answer: read back with videos.list and compare, or the named failure
import type { Env } from "../env";
import { practice } from "./practice";
import { getConnectionSecret, markConnection, saveConnection } from "./connections";
import { parseJson, recordEvent, setHealth } from "./db";
import { nowIso } from "./ids";
import { log } from "./log";
import { dispatchJob } from "../services/github";
import { getYouTubeDirect, type YtFail } from "../services/youtubeDirect";
import {
  capNote,
  HEALTH_NAME,
  intentFor,
  nextQuotaReset,
  QUOTA_NOTE,
  REMOVED_INTENT,
  quotaDay,
  reconcile,
  statusPart,
  THUMB_VERIFY_NOTE,
  UPLOAD_MAX_ATTEMPTS,
  UPLOAD_STUCK_MS,
  UPLOAD_WINDOW_MS,
  verifyReadBack,
  YT_UPLOADS_PER_DAY,
  type DirectMode,
  type Intent,
  type UploadStatus,
} from "../domain/youtubeDirect";
import { composeDescription, type FullVideoDetails, type FullVideoPrivacy } from "../domain/fullVideo";
import { POSTABLE_CLIP_SQL } from "../domain/sourceCheck";

/**
 * youtube.upload puts videos on her channel; youtube.force-ssl reads them back and changes their
 * publish time and privacy (videos.list / videos.update refuse youtube.upload + youtube.readonly with
 * 403 insufficientPermissions: measured on staging 26 Sep 2026). Nothing else. The dashboard never
 * deletes a video (validator youtube-direct), though Google words force-ssl as "edit and delete".
 */
export const YT_UPLOAD_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"];
/** A sign-in without both scopes cannot follow the Calendar: it needs Reconnect YouTube. */
export const RESCOPE_NOTE = "Reconnect YouTube once so the dashboard can also move and hide the videos it uploads (Google asks again for that). Until then new full videos wait on Home under Upload it yourself.";
export function hasAllScopes(scope: string | null | undefined): boolean {
  const got = (scope ?? "").split(/\s+/);
  return YT_UPLOAD_SCOPES.every((s) => got.includes(s));
}
export const RECONNECT_GUIDE = "reconnect-youtube";
export const CONNECT_GUIDE = "connect-youtube-full-videos";
/** YouTube category 26 = Howto & Style (hosting, tablescapes, events); the same one Buffer's posts use. */
export const YT_CATEGORY_ID = "26";

export interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  account_id: string | null;
  scope?: string;
}

export interface UploadRow {
  clip_id: string;
  status: UploadStatus;
  job_id: string | null;
  video_id: string | null;
  privacy: FullVideoPrivacy | null;
  publish_at: string | null;
  actual_privacy: string | null;
  actual_publish_at: string | null;
  thumbnail: "set" | "needs_verify" | "failed" | null;
  reason: string | null;
  note: string | null;
  not_before: string | null;
  attempts: number;
  started_at: string | null;
  verified_at: string | null;
  updated_at: string;
}

export async function directMode(env: Env): Promise<DirectMode> {
  const row = await env.DB.prepare("SELECT status, meta FROM connections WHERE service = 'youtube'").first<{ status: string; meta: string }>();
  if (row?.status === "ok" && !hasAllScopes(parseJson<{ scopes?: string[] }>(row.meta, {}).scopes?.join(" "))) {
    // Connected before the dashboard asked for everything it needs: one reconnect, named.
    await markBroken(env, RESCOPE_NOTE);
    return "broken";
  }
  return row?.status === "ok" ? "on" : row?.status === "error" ? "broken" : "off";
}

/** Google refused the sign-in (revoked at myaccount.google.com, or expired): red light + Reconnect YouTube. */
export async function markBroken(env: Env, why = "YouTube needs you to reconnect. Until then full videos wait for Upload it yourself on Home."): Promise<void> {
  await markConnection(env, "youtube", "error", why);
  await setHealth(env.DB, HEALTH_NAME, "red", why, RECONNECT_GUIDE);
  log.warn("ytdirect.broken", {});
}

/**
 * A short-lived access token (about an hour), refreshed when fewer than 5 minutes are left. This is
 * the only thing a job ever receives; the refresh token stays encrypted in D1. Null = she has to
 * reconnect (the light is already red).
 */
export async function youtubeAccessToken(env: Env): Promise<{ access_token: string; expires_at: string } | null> {
  const raw = await getConnectionSecret(env, "youtube");
  const t = parseJson<StoredToken | null>(raw, null);
  if (!t?.access_token) return null;
  const left = t.expires_at ? Date.parse(t.expires_at) - Date.now() : 0;
  const client = getYouTubeDirect(env);
  // The fake always asks, so a "revoked" scenario is seen at once.
  if (left > 5 * 60_000 && !practice(env, "google_app")) return { access_token: t.access_token, expires_at: t.expires_at! };
  if (!t.refresh_token) {
    await markBroken(env);
    return null;
  }
  const r = await client.refresh(t.refresh_token);
  if (!r.ok) {
    if (r.kind === "revoked" || r.http === 400) await markBroken(env);
    else log.warn("ytdirect.refresh", { http: r.http, kind: r.kind });
    return null;
  }
  const next: StoredToken = { ...t, access_token: r.access_token, expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString() };
  const row = await env.DB.prepare("SELECT meta FROM connections WHERE service = 'youtube'").first<{ meta: string }>();
  await saveConnection(env, "youtube", JSON.stringify(next), "ok", parseJson<Record<string, unknown>>(row?.meta, {}));
  return { access_token: next.access_token, expires_at: next.expires_at! };
}

// ---------------------------------------------------------------- rows

async function row(env: Env, clipId: string): Promise<UploadRow | null> {
  return env.DB.prepare("SELECT * FROM youtube_uploads WHERE clip_id = ?").bind(clipId).first<UploadRow>();
}

async function patchRow(env: Env, clipId: string, p: Partial<UploadRow>): Promise<void> {
  const keys = Object.keys(p) as (keyof UploadRow)[];
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE youtube_uploads SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE clip_id = ?`)
    .bind(...keys.map((k) => p[k] ?? null), nowIso(), clipId)
    .run();
}

interface Candidate {
  clip_id: string;
  dump_id: string;
  post_id: string;
  scheduled_at: string;
  youtube: string | null;
}

/** The video's details as she approved them. */
function details(youtube: string | null): FullVideoDetails | null {
  return parseJson<FullVideoDetails | null>(youtube, null);
}

async function aiVoice(env: Env, clipId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM narrations WHERE clip_id = ? AND mix_status = 'ready' AND ai_generated = 1").bind(clipId).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

/** How many uploads started in YouTube's quota day (Pacific) so far. */
async function startedToday(env: Env, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 26 * 3600_000).toISOString();
  const { results } = await env.DB.prepare("SELECT started_at FROM youtube_uploads WHERE started_at >= ?").bind(since).all<{ started_at: string }>();
  const today = quotaDay(now);
  return results.filter((r) => quotaDay(new Date(r.started_at)) === today).length;
}

/** The active (planned) YouTube post of a full video, or null when it is off the Calendar. */
async function activePost(env: Env, clipId: string): Promise<{ id: string; scheduled_at: string } | null> {
  return env.DB.prepare(`SELECT p.id, p.scheduled_at FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.clip_id = ? AND p.platform = 'youtube' AND p.status = 'planned' AND ${POSTABLE_CLIP_SQL} ORDER BY p.scheduled_at LIMIT 1`)
    .bind(clipId)
    .first<{ id: string; scheduled_at: string }>();
}

// ---------------------------------------------------------------- the job's spec + answer

export const ytRef = (dumpId: string, clipId: string) => `${dumpId}/${clipId}`;
export const YT_REF = /^([A-Za-z0-9_]{1,64})\/(clp_[a-z0-9]{8,40})$/;

export async function buildUploadSpec(env: Env, jobId: string, ref: string | null) {
  const m = YT_REF.exec(ref ?? "");
  if (!m) throw new Error("bad upload ref");
  const [, dumpId, clipId] = m;
  const c = await env.DB.prepare("SELECT r2_key, youtube FROM clips WHERE id = ? AND dump_id = ? AND full_video = 1").bind(clipId, dumpId).first<{ r2_key: string; youtube: string | null }>();
  const d = details(c?.youtube ?? null);
  const r = await row(env, clipId);
  if (!c || !d || !r?.privacy) throw new Error("the video is gone");
  const intent: Intent = { privacyStatus: r.privacy, publishAt: r.publish_at };
  const ai = await aiVoice(env, clipId);
  const thumb = d.thumbnails[d.thumb_pick]?.key ?? null;
  return {
    job_id: jobId,
    type: "ytupload",
    clip_id: clipId,
    video_key: c.r2_key,
    thumb_key: thumb,
    size_bytes: d.size_bytes,
    content_type: "video/mp4",
    metadata: {
      snippet: { title: d.title, description: composeDescription(d.description, d.chapters, d.tags), tags: d.tags, categoryId: YT_CATEGORY_ID },
      status: statusPart(intent, ai),
    },
    // Sent again without a publish time when YouTube refuses the one given (invalidPublishAt): the
    // video still lands, safely private, and the read-back names the fix.
    fallback_status: statusPart({ privacyStatus: "private", publishAt: null }, ai),
    chunk_bytes: 8 * 1024 * 1024,
  };
}

export interface UploadOutcome {
  outcome?: "uploaded" | "quota" | "upload_limit" | "revoked" | "scope" | "failed";
  video_id?: string;
  thumbnail?: "set" | "needs_verify" | "failed" | "none";
  publish_at_rejected?: boolean;
  resumed?: number;
  http?: number;
  reason?: string;
}

async function markPosted(env: Env, clipId: string, videoId: string) {
  const post = await env.DB.prepare("SELECT id FROM posts WHERE clip_id = ? AND platform = 'youtube' AND status IN ('planned','failed') ORDER BY scheduled_at LIMIT 1").bind(clipId).first<{ id: string }>();
  if (post) await env.DB.prepare("UPDATE posts SET status = 'posted', url = ?, posted_at = ?, error = NULL WHERE id = ?").bind(`https://www.youtube.com/watch?v=${videoId}`, nowIso(), post.id).run();
}

/**
 * Read one uploaded video back and compare with what was intended; the row and the post follow.
 * `published`: its publish time has passed, so YouTube should now show it public (a video still
 * private with the same time is YouTube running late: checked again next hour, not a mismatch).
 */
async function readBackAndVerify(env: Env, clipId: string, token: string, published = false, removed = false): Promise<boolean> {
  const r = await row(env, clipId);
  if (!r?.video_id || !r.privacy) return false;
  const got = await getYouTubeDirect(env).listVideos(token, [r.video_id]);
  if (!got.ok) {
    await nameFailure(env, clipId, got, "read_back");
    return false;
  }
  const back = got.items[r.video_id] ?? null;
  // What YouTube answered, exactly (status fields only, never content): the measurement behind the verdict.
  await recordEvent(env.DB, "ytdirect.readback", clipId, { video_id: r.video_id, found: !!back, privacyStatus: back?.privacyStatus ?? null, publishAt: back?.publishAt ?? null, uploadStatus: back?.uploadStatus ?? null, failureReason: back?.failureReason ?? null, rejectionReason: back?.rejectionReason ?? null });
  const planned: Intent = { privacyStatus: r.privacy, publishAt: r.publish_at };
  if (published && back?.privacyStatus === "private" && back.publishAt && r.publish_at && Math.abs(Date.parse(back.publishAt) - Date.parse(r.publish_at)) < 1000) return false;
  const intent: Intent = published ? { privacyStatus: "public", publishAt: null } : removed ? REMOVED_INTENT : planned;
  const v = verifyReadBack(intent, back);
  const at = nowIso();
  if (!v.ok) {
    await patchRow(env, clipId, { status: "mismatch", reason: v.why, note: v.note, actual_privacy: back?.privacyStatus ?? null, actual_publish_at: back?.publishAt ?? null, verified_at: at });
    await setHealth(env.DB, HEALTH_NAME, "red", v.note, v.guide);
    await recordEvent(env.DB, "ytdirect.mismatch", clipId, { why: v.why });
    log.warn("ytdirect.mismatch", { why: v.why });
    return false;
  }
  if (removed) {
    // Off the Calendar and proven private with no publish time on YouTube: kept, never posted.
    await patchRow(env, clipId, { status: "removed", actual_privacy: back!.privacyStatus, actual_publish_at: back!.publishAt, verified_at: at });
    log.info("ytdirect.verified", { removed: true });
    return true;
  }
  const live = !intent.publishAt;
  await patchRow(env, clipId, { status: live ? "live" : "scheduled", privacy: intent.privacyStatus, publish_at: intent.publishAt, reason: null, note: null, actual_privacy: back!.privacyStatus, actual_publish_at: back!.publishAt, verified_at: at });
  // Live = where she chose (public, unlisted or private): the Calendar post is done, with its link.
  if (live) await markPosted(env, clipId, r.video_id);
  log.info("ytdirect.verified", { live, privacy: intent.privacyStatus, published });
  return true;
}

/** A named failure from YouTube or Google: the row, the light and the fallback, never silent. */
async function nameFailure(env: Env, clipId: string, f: Pick<YtFail, "kind" | "http"> & { reason?: string | null }, step: string): Promise<void> {
  const now = new Date();
  log.warn("ytdirect.fail", { step, kind: f.kind, http: f.http, reason: (f.reason ?? "").slice(0, 40) });
  await recordEvent(env.DB, "ytdirect.fail", clipId, { step, kind: f.kind, http: f.http, reason: f.reason ?? null });
  if (f.kind === "scope") {
    await markBroken(env, RESCOPE_NOTE);
    return;
  }
  if (f.kind === "quota" || f.kind === "upload_limit") {
    // Waits for tomorrow's allowance: yellow, nothing for her to do.
    const r = await row(env, clipId);
    const uploaded = !!r?.video_id;
    await patchRow(env, clipId, { status: uploaded ? r!.status : "queued", reason: f.kind, note: QUOTA_NOTE, not_before: nextQuotaReset(now), job_id: uploaded ? r!.job_id : null });
    await setHealth(env.DB, HEALTH_NAME, "yellow", QUOTA_NOTE, CONNECT_GUIDE);
    return;
  }
  if (f.kind === "revoked") {
    await markBroken(env);
    const r = await row(env, clipId);
    if (!r?.video_id) await patchRow(env, clipId, { status: "failed", reason: "revoked", note: "YouTube needs you to reconnect. Tap Reconnect YouTube on Connect; until then, Upload it yourself." });
    return;
  }
  const r = await row(env, clipId);
  const attempts = (r?.attempts ?? 0) + (step === "upload" ? 1 : 0);
  if (!r?.video_id && attempts < UPLOAD_MAX_ATTEMPTS) {
    await patchRow(env, clipId, { status: "queued", attempts, reason: "retry", note: "The upload didn't finish. It tries again within the hour.", job_id: null });
    await setHealth(env.DB, HEALTH_NAME, "yellow", "An upload didn't finish; it tries again within the hour.", CONNECT_GUIDE);
    return;
  }
  const note = r?.video_id ? "YouTube didn't answer when we checked this video. It is on your channel; we check again within the hour." : "The upload to YouTube didn't work twice. Upload it yourself from Home; nothing is lost.";
  if (!r?.video_id) await patchRow(env, clipId, { status: "failed", attempts, reason: "failed", note });
  await setHealth(env.DB, HEALTH_NAME, r?.video_id ? "yellow" : "red", note, r?.video_id ? CONNECT_GUIDE : "upload-it-yourself");
}

/** The ytupload job's answer (worker/jobs/ytupload.ts). */
export async function applyUpload(env: Env, jobId: string, ref: string | null, result: unknown): Promise<void> {
  const m = YT_REF.exec(ref ?? "");
  if (!m) throw new Error("bad upload ref");
  const clipId = m[2];
  const r = (result ?? {}) as UploadOutcome;
  const current = await row(env, clipId);
  if (!current || current.job_id !== jobId) {
    log.warn("ytdirect.stale_result", {});
    return;
  }
  if (r.outcome !== "uploaded" || !r.video_id || !/^[\w-]{11}$/.test(r.video_id)) {
    const kind = r.outcome === "quota" ? "quota" : r.outcome === "upload_limit" ? "upload_limit" : r.outcome === "revoked" ? "revoked" : r.outcome === "scope" ? "scope" : "other";
    await nameFailure(env, clipId, { kind, http: Number(r.http) || 0, reason: r.reason ?? null }, "upload");
    return;
  }
  const thumbnail = r.thumbnail === "set" || r.thumbnail === "needs_verify" || r.thumbnail === "failed" ? r.thumbnail : null;
  await patchRow(env, clipId, { video_id: r.video_id, thumbnail, status: "uploading", note: null, reason: null });
  if (r.publish_at_rejected) {
    // YouTube refused the time: the job sent it again as private with no time. What YouTube holds now:
    await patchRow(env, clipId, { privacy: "private", publish_at: null });
    const d = await env.DB.prepare("SELECT youtube FROM clips WHERE id = ?").bind(clipId).first<{ youtube: string | null }>();
    const want = details(d?.youtube ?? null)?.privacy ?? "public";
    await patchRow(env, clipId, { status: "mismatch", reason: "publish_at", note: "YouTube didn't take the time it goes public. It is safe as private: move it on the Calendar to set the time again." });
    await setHealth(env.DB, HEALTH_NAME, "red", "YouTube didn't take a publish time. Move the video on the Calendar to set it again.", "move-or-remove-a-post");
    await recordEvent(env.DB, "ytdirect.publish_at_rejected", clipId, { wanted: want });
    return;
  }
  const tok = await youtubeAccessToken(env);
  if (!tok) return;
  const ok = await readBackAndVerify(env, clipId, tok.access_token);
  await recordEvent(env.DB, "ytdirect.uploaded", clipId, { verified: ok, resumed: Number(r.resumed) || 0, thumbnail });
  if (ok) await writeLight(env);
}

export async function uploadJobFailed(env: Env, ref: string | null): Promise<void> {
  const m = YT_REF.exec(ref ?? "");
  if (!m) return;
  await nameFailure(env, m[2], { kind: "other", http: 0 }, "upload");
}

// ---------------------------------------------------------------- follow the Calendar

/** One video: move → new publishAt, taken off → private (kept), time come → read back. */
export async function reconcileClip(env: Env, clipId: string, now = new Date(), token?: string): Promise<void> {
  const r = await row(env, clipId);
  if (!r?.video_id) return;
  const c = await env.DB.prepare("SELECT youtube FROM clips WHERE id = ?").bind(clipId).first<{ youtube: string | null }>();
  const d = details(c?.youtube ?? null);
  if (!d) return;
  const post = await activePost(env, clipId);
  const posted = !!(await env.DB.prepare("SELECT 1 AS x FROM posts WHERE clip_id = ? AND platform = 'youtube' AND status = 'posted'").bind(clipId).first());
  const action = reconcile({ status: r.status, video_id: r.video_id, privacy: d.privacy, intended: r.privacy ? { privacyStatus: r.privacy, publishAt: r.publish_at } : null, post, posted }, now);
  if (action.do === "none") return;
  const access = token ?? (await youtubeAccessToken(env))?.access_token;
  if (!access) return;
  if (action.do === "read_back") {
    await readBackAndVerify(env, clipId, access, true);
    return;
  }
  const res = await getYouTubeDirect(env).updateStatus(access, r.video_id, statusPart(action.intent, await aiVoice(env, clipId)));
  if (!res.ok) {
    if (res.kind === "publish_at") {
      await patchRow(env, clipId, { status: "mismatch", reason: "publish_at", note: "YouTube didn't take the new time. It is safe as private: pick another time on the Calendar (at least 15 minutes ahead)." });
      await setHealth(env.DB, HEALTH_NAME, "red", "YouTube didn't take a new publish time. Pick another time on the Calendar.", "move-or-remove-a-post");
      return;
    }
    await nameFailure(env, clipId, res, "update");
    return;
  }
  const removed = !post;
  // YouTube's answer to videos.update is the video's new status: checked at once. videos.list lags an
  // update by a little (measured on staging 26 Sep 2026: a read right after answered the previous
  // publishAt three times in a row), so the list read-back confirms it on the next sync, 2+ minutes on.
  const ans = res.status;
  await recordEvent(env.DB, "ytdirect.update_answer", clipId, { video_id: r.video_id, privacyStatus: ans.privacyStatus, publishAt: ans.publishAt, uploadStatus: ans.uploadStatus ?? null });
  const v = verifyReadBack(action.intent, ans);
  if (!v.ok) {
    await patchRow(env, clipId, { status: "mismatch", reason: v.why, note: v.note, privacy: action.intent.privacyStatus, publish_at: action.intent.publishAt, actual_privacy: ans.privacyStatus, actual_publish_at: ans.publishAt });
    await setHealth(env.DB, HEALTH_NAME, "red", v.note, v.guide);
    log.warn("ytdirect.mismatch", { why: v.why, step: "update" });
    return;
  }
  await patchRow(env, clipId, { privacy: action.intent.privacyStatus, publish_at: action.intent.publishAt, status: removed ? "removed" : action.intent.publishAt ? "scheduled" : "live", note: removed ? "Taken off the Calendar: it is private on your channel and kept." : null, reason: null, actual_privacy: ans.privacyStatus, actual_publish_at: ans.publishAt, verified_at: null });
  await recordEvent(env.DB, removed ? "ytdirect.made_private" : "ytdirect.moved", clipId, {});
  log.info("ytdirect.update", { removed, scheduled: !!action.intent.publishAt });
}

/** How long after a change the list read-back waits (videos.list lags videos.update). */
export const READBACK_AFTER_UPDATE_MS = 2 * 60_000;

// ---------------------------------------------------------------- hourly

/** Uploads what is due, follows the Calendar, reads back what went public. Counts only in logs. */
export async function youtubeDirectSync(env: Env, now = new Date()): Promise<{ dispatched: number; waiting: number; reconciled: number }> {
  const mode = await directMode(env);
  if (mode === "off") return { dispatched: 0, waiting: 0, reconciled: 0 };
  const iso = now.toISOString();
  let dispatched = 0;
  let waiting = 0;

  // A job still "uploading" long after it started failed without calling back.
  const { results: stuck } = await env.DB.prepare("SELECT clip_id FROM youtube_uploads WHERE status = 'uploading' AND video_id IS NULL AND started_at < ?").bind(new Date(now.getTime() - UPLOAD_STUCK_MS).toISOString()).all<{ clip_id: string }>();
  for (const s of stuck) await nameFailure(env, s.clip_id, { kind: "other", http: 0 }, "upload");

  if (mode === "on") {
    // Reconnected: videos that fell back only because of the sign-in go again.
    await env.DB.prepare("UPDATE youtube_uploads SET status = 'queued', reason = NULL, note = NULL, job_id = NULL, updated_at = ? WHERE status = 'failed' AND reason = 'revoked' AND video_id IS NULL").bind(iso).run();
    const { results: due } = await env.DB.prepare(
      `SELECT c.id AS clip_id, c.dump_id, p.id AS post_id, p.scheduled_at, c.youtube FROM posts p JOIN clips c ON c.id = p.clip_id
       LEFT JOIN youtube_uploads u ON u.clip_id = c.id
       WHERE c.full_video = 1 AND p.platform = 'youtube' AND p.status = 'planned' AND ${POSTABLE_CLIP_SQL}
         AND p.scheduled_at <= ? AND (u.clip_id IS NULL OR (u.status = 'queued' AND (u.not_before IS NULL OR u.not_before <= ?)))
       ORDER BY p.scheduled_at LIMIT 20`,
    )
      .bind(new Date(now.getTime() + UPLOAD_WINDOW_MS).toISOString(), iso)
      .all<Candidate>();
    let today = await startedToday(env, now);
    for (const cand of due) {
      const d = details(cand.youtube);
      if (!d) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO youtube_uploads (clip_id, status) VALUES (?, 'queued')").bind(cand.clip_id).run();
      const cap = capNote(today);
      if (cap) {
        await patchRow(env, cand.clip_id, { reason: "cap", note: cap, not_before: nextQuotaReset(now) });
        waiting++;
        continue;
      }
      const intent = intentFor(d.privacy, cand.scheduled_at, now);
      const job = await dispatchJob(env, "ytupload", ytRef(cand.dump_id, cand.clip_id));
      await patchRow(env, cand.clip_id, { status: "uploading", job_id: job.jobId, privacy: intent.privacyStatus, publish_at: intent.publishAt, started_at: iso, reason: null, note: job.dispatched ? null : "The upload couldn't start; it tries again within the hour.", not_before: null });
      if (!job.dispatched) {
        await patchRow(env, cand.clip_id, { status: "queued", job_id: null, started_at: null });
        continue;
      }
      today++;
      dispatched++;
    }
  }

  // Follow the Calendar for everything already on her channel.
  let reconciled = 0;
  let confirmed = 0;
  const { results: onYouTube } = await env.DB.prepare("SELECT clip_id FROM youtube_uploads WHERE video_id IS NOT NULL AND status IN ('scheduled','live','removed','mismatch') LIMIT 50").all<{ clip_id: string }>();
  if (onYouTube.length && mode === "on") {
    const tok = await youtubeAccessToken(env);
    if (tok) {
      for (const u of onYouTube) {
        await reconcileClip(env, u.clip_id, now, tok.access_token);
        reconciled++;
      }
      // Every change is confirmed with videos.list once YouTube has caught up: a take-off must read
      // private with no publish time, a move its new time.
      const { results: pending } = await env.DB.prepare("SELECT clip_id, status FROM youtube_uploads WHERE video_id IS NOT NULL AND verified_at IS NULL AND status IN ('scheduled','live','removed') AND updated_at <= ?").bind(new Date(now.getTime() - READBACK_AFTER_UPDATE_MS).toISOString()).all<{ clip_id: string; status: string }>();
      for (const p of pending) {
        await readBackAndVerify(env, p.clip_id, tok.access_token, false, p.status === "removed");
        confirmed++;
      }
    }
  }
  await writeLight(env);
  log.info("ytdirect.sync", { mode, dispatched, waiting, reconciled, confirmed });
  return { dispatched, waiting, reconciled };
}

/** The one light: grey not connected, red needs you, yellow waiting/thumbnail, green working. */
export async function writeLight(env: Env): Promise<void> {
  const mode = await directMode(env);
  if (mode === "off") {
    await setHealth(env.DB, HEALTH_NAME, "grey", "Not connected: full videos go through Upload it yourself", CONNECT_GUIDE);
    return;
  }
  if (mode === "broken") {
    const why = (await env.DB.prepare("SELECT last_error FROM connections WHERE service = 'youtube'").first<{ last_error: string | null }>())?.last_error;
    await setHealth(env.DB, HEALTH_NAME, "red", why ?? "YouTube needs you to reconnect.", RECONNECT_GUIDE);
    return;
  }
  const bad = await env.DB.prepare("SELECT note, reason FROM youtube_uploads WHERE status IN ('mismatch','failed') ORDER BY updated_at DESC LIMIT 1").first<{ note: string; reason: string | null }>();
  if (bad) {
    await setHealth(env.DB, HEALTH_NAME, "red", bad.note, bad.reason === "publish_at" ? "move-or-remove-a-post" : "upload-it-yourself");
    return;
  }
  const wait = await env.DB.prepare("SELECT note FROM youtube_uploads WHERE status = 'queued' AND note IS NOT NULL ORDER BY updated_at DESC LIMIT 1").first<{ note: string }>();
  const thumb = await env.DB.prepare("SELECT 1 AS x FROM youtube_uploads WHERE thumbnail = 'needs_verify' LIMIT 1").first();
  const acct = (await env.DB.prepare("SELECT meta FROM connections WHERE service = 'youtube'").first<{ meta: string }>())?.meta;
  const account = parseJson<{ account?: string }>(acct, {}).account;
  if (wait) await setHealth(env.DB, HEALTH_NAME, "yellow", wait.note, CONNECT_GUIDE);
  else if (thumb) await setHealth(env.DB, HEALTH_NAME, "yellow", `${THUMB_VERIFY_NOTE}.`, CONNECT_GUIDE);
  else await setHealth(env.DB, HEALTH_NAME, "green", `Connected${account ? ` · ${account}` : ""} · up to ${YT_UPLOADS_PER_DAY} full videos a day`, null);
}

/** For Review and Home: where a full video stands on her channel. */
export async function uploadStates(env: Env, clipIds: string[]): Promise<Map<string, UploadRow>> {
  if (!clipIds.length) return new Map();
  const { results } = await env.DB.prepare(`SELECT * FROM youtube_uploads WHERE clip_id IN (${clipIds.map(() => "?").join(",")})`).bind(...clipIds).all<UploadRow>();
  return new Map(results.map((r) => [r.clip_id, r]));
}
