// Calendar + scheduling (section 10). The dashboard holds the whole calendar; the hourly
// Buffer sync (crons/buffer-sync.ts) hands Buffer only the next 7 days. Every rule that
// decides something lives in domain/slotting.ts and domain/sync.ts; this file gathers rows.
import { POSTABLE_CLIP_SQL } from "../domain/sourceCheck";
import { reconcileClip } from "../lib/youtubeDirect";
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { log, safeError } from "../lib/log";
import { weekBounds, zonedToUtc, type PlannedPost, type SchedulableClip } from "../domain/slotting";
import { ACTIVE_STATUSES, capRefusal, fillWeek, moveToDate, pickSlotTable, type ExistingPost } from "../domain/sync";
import { readSettings } from "./settings";
import { getBuffer } from "../services/buffer";
import { newId, nowIso } from "../lib/ids";
import { HARD_CAP_PER_CHANNEL_PER_WEEK, PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import type { ClipRow, PostRow } from "@shared/types";

export const posts = new Hono<{ Bindings: Env; Variables: Vars }>();
posts.use("*", requireUser);

/** How far ahead the cron keeps the calendar filled, and the most the button may ask for. */
export const PLAN_AHEAD_WEEKS = 4;
const MAX_PLAN_WEEKS = 12;

const ACTIVE_SQL = `(${ACTIVE_STATUSES.map((s) => `'${s}'`).join(",")})`;

export type PoolClip = Pick<ClipRow, "id" | "hook_text" | "cover_url" | "recipe" | "door" | "platforms" | "score">;

function coverUrl(token: string | null, coverKey: string | null): string | null {
  return token && coverKey ? `/media/${token}?cover=1` : null;
}

async function activePosts(env: Env): Promise<ExistingPost[]> {
  const { results } = await env.DB.prepare(`SELECT id, clip_id, platform, scheduled_at, status FROM posts WHERE status IN ${ACTIVE_SQL}`).all<ExistingPost>();
  return results;
}

async function slotTable(env: Env) {
  const brief = await env.DB.prepare("SELECT body FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ body: string }>();
  const body = parseJson<{ best_times?: unknown } | null>(brief?.body, null);
  return pickSlotTable(body?.best_times);
}

/**
 * Fill open slots from the approved pool, week by week. Idempotent: running it twice adds
 * nothing the second time. `respectHeld` (the cron) leaves alone clips she took off the
 * calendar herself; the "Fill the calendar" button (her own action) uses them again.
 */
export async function planAhead(env: Env, opts: { weeks?: number; startWeek?: number; respectHeld: boolean; actor?: string }): Promise<{ added: number; perPlatform: Record<Platform, number>; slotsFrom: "brief" | "launch" }> {
  const s = await readSettings(env);
  const tz = s.audience_timezone;
  const { slots, source } = await slotTable(env);
  const { results: rows } = await env.DB.prepare(
    `SELECT c.id, c.asset_id, c.score, c.platforms, d.door, c.full_video,
       EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'unscheduled') AS held
     FROM clips c JOIN dumps d ON d.id = c.dump_id
     WHERE ${POSTABLE_CLIP_SQL}`,
  ).all<{ id: string; asset_id: string; score: number; platforms: string; door: "new" | "recycle"; held: number; full_video: number }>();
  const { results: fullRows } = await env.DB.prepare("SELECT id FROM clips WHERE full_video = 1").all<{ id: string }>();
  const fullClipIds = new Set(fullRows.map((r) => r.id));
  const existing = await activePosts(env);
  const hasActive = new Set(existing.map((p) => p.clip_id));
  const clips: SchedulableClip[] = rows
    .filter((r) => !(opts.respectHeld && r.held && !hasActive.has(r.id)))
    .map((r) => ({ id: r.id, asset_id: r.asset_id, score: r.score, door: r.door, full: !!r.full_video, platforms: (r.full_video ? ["youtube"] : parseJson<Platform[]>(r.platforms, [...PLATFORMS])).filter((p): p is Platform => PLATFORMS.includes(p as Platform)) }));

  const caps = Object.fromEntries(PLATFORMS.map((p) => [p, Math.min(s.weekly_caps[p] ?? 0, s.hard_cap_per_channel, HARD_CAP_PER_CHANNEL_PER_WEEK)])) as Record<Platform, number>;
  const weeks = Math.max(1, Math.min(opts.weeks ?? PLAN_AHEAD_WEEKS, MAX_PLAN_WEEKS));
  const startWeek = Math.max(0, Math.min(opts.startWeek ?? 0, MAX_PLAN_WEEKS));
  const now = nowIso();
  const added: (PlannedPost & { id: string })[] = [];
  for (let w = startWeek; w < startWeek + weeks; w++) {
    const { start, end } = weekBounds(new Date(), tz, w);
    const planned = fillWeek({ clips, existing: [...existing], weekStart: start, weekEnd: end, timeZone: tz, caps, slots, now, fullClipIds });
    for (const p of planned) {
      const id = newId("pst");
      existing.push({ id, clip_id: p.clip_id, platform: p.platform, scheduled_at: p.scheduled_at, status: "planned" });
      added.push({ ...p, id });
    }
  }
  if (added.length) {
    await env.DB.batch(added.map((p) => env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES (?, ?, ?, ?, 'planned')").bind(p.id, p.clip_id, p.platform, p.scheduled_at)));
    await recordEvent(env.DB, "posts.planned", null, { count: added.length, slots: source }, opts.actor ?? "system");
  }
  const perPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, added.filter((a) => a.platform === p).length])) as Record<Platform, number>;
  log.info("posts.plan", { added: added.length, weeks, slots: source });
  return { added: added.length, perPlatform, slotsFrom: source };
}

/** Count active posts on a platform in the local week of `iso`, leaving out the given posts. */
async function countInWeek(env: Env, platform: Platform, iso: string, excludeIds: string[]): Promise<number> {
  const s = await readSettings(env);
  const { start, end } = weekBounds(new Date(iso), s.audience_timezone);
  const rows = (await activePosts(env)).filter((p) => p.platform === platform && p.scheduled_at >= start && p.scheduled_at < end && !excludeIds.includes(p.id));
  return rows.length;
}

async function capFor(env: Env, platform: Platform): Promise<number> {
  const s = await readSettings(env);
  return Math.min(s.weekly_caps[platform] ?? 0, s.hard_cap_per_channel, HARD_CAP_PER_CHANNEL_PER_WEEK);
}

/** Pull a post back out of Buffer (move, unschedule, swap). Never loses the post if Buffer is down. */
async function pullFromBuffer(env: Env, bufferPostId: string | null): Promise<void> {
  if (!bufferPostId) return;
  const buffer = await getBuffer(env);
  const ok = await buffer.deletePost(bufferPostId);
  if (!ok) log.warn("posts.buffer_delete_failed");
}

// ---------------------------------------------------------------- reads

posts.get("/", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || to <= from) return fail(c, 400, "Pick a week or a month to show.");
  if (Date.parse(to) - Date.parse(from) > 62 * 86400_000) return fail(c, 400, "Show at most two months at a time.");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.scheduled_at, p.status, p.url, p.error,
       c.hook_text, c.recipe, c.media_token, c.cover_r2_key, d.door
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN dumps d ON d.id = c.dump_id
     WHERE p.scheduled_at >= ? AND p.scheduled_at < ? AND p.status != 'unscheduled'
     ORDER BY p.scheduled_at, p.platform`,
  )
    .bind(new Date(from).toISOString(), new Date(to).toISOString())
    .all<Omit<PostRow, "cover_url"> & { media_token: string | null; cover_r2_key: string | null }>();
  const out: PostRow[] = results.map(({ media_token, cover_r2_key, ...r }) => ({ ...r, cover_url: coverUrl(media_token, cover_r2_key) }));
  return c.json(out);
});

/** Posts per page in Calendar → History (day 358). */
export const HISTORY_PAGE = 20;

/**
 * Calendar → History (day 358): everything that already happened, newest first, a page at a time:
 * posted (with its link), failed (Retry / Let go) and taken off. Filter by what happened and by
 * platform, search the hook. `counts` are true totals, so "21 failed" is never a guess.
 */
posts.get("/history", async (c) => {
  const status = c.req.query("status") ?? "all";
  const platform = c.req.query("platform") ?? "";
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? HISTORY_PAGE) || HISTORY_PAGE));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const now = new Date().toISOString();
  const where = ["(p.status IN ('posted','failed') OR (p.status = 'unscheduled' AND p.scheduled_at < ?))"];
  const binds: unknown[] = [now];
  if (["posted", "failed", "unscheduled"].includes(status)) {
    where.push("p.status = ?");
    binds.push(status);
  }
  if ((PLATFORMS as readonly string[]).includes(platform)) {
    where.push("p.platform = ?");
    binds.push(platform);
  }
  if (q) {
    where.push("c.hook_text LIKE ?");
    binds.push(`%${q}%`);
  }
  const w = where.join(" AND ");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.clip_id, p.platform, p.scheduled_at, p.status, p.url, p.error, p.posted_at, c.hook_text, c.recipe, c.media_token, c.cover_r2_key, c.file_deleted_at, d.door
     FROM posts p JOIN clips c ON c.id = p.clip_id JOIN dumps d ON d.id = c.dump_id WHERE ${w} ORDER BY p.scheduled_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<Omit<PostRow, "cover_url"> & { media_token: string | null; cover_r2_key: string | null; file_deleted_at: string | null; posted_at: string | null }>();
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM posts p JOIN clips c ON c.id = p.clip_id WHERE ${w}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const counts = await c.env.DB.prepare(
    "SELECT SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS posted, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'unscheduled' AND scheduled_at < ? THEN 1 ELSE 0 END) AS unscheduled FROM posts",
  )
    .bind(now)
    .first<{ posted: number | null; failed: number | null; unscheduled: number | null }>();
  return c.json({
    items: results.map(({ media_token, cover_r2_key, file_deleted_at, ...r }) => ({ ...r, cover_url: media_token ? coverUrl(media_token, cover_r2_key) : cover_r2_key ? `/api/clips/${r.clip_id}/cover` : null, file_cleared: !!file_deleted_at })),
    total,
    limit,
    offset,
    counts: { posted: counts?.posted ?? 0, failed: counts?.failed ?? 0, unscheduled: counts?.unscheduled ?? 0 },
  });
});

/** Approved clips that are not on the calendar (the "Approved, not scheduled" column). */
posts.get("/pool", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.hook_text, c.recipe, c.platforms, c.score, c.media_token, c.cover_r2_key, d.door
     FROM clips c JOIN dumps d ON d.id = c.dump_id
     WHERE ${POSTABLE_CLIP_SQL} AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ${ACTIVE_SQL})
     ORDER BY c.score DESC LIMIT 500`,
  ).all<{ id: string; hook_text: string; recipe: ClipRow["recipe"]; platforms: string; score: number; media_token: string | null; cover_r2_key: string | null; door: "new" | "recycle" }>();
  const out: PoolClip[] = results.map((r) => ({ id: r.id, hook_text: r.hook_text, recipe: r.recipe, door: r.door, score: r.score, platforms: parseJson<Platform[]>(r.platforms, [...PLATFORMS]), cover_url: coverUrl(r.media_token, r.cover_r2_key) }));
  return c.json(out);
});

// ---------------------------------------------------------------- planning

/** "Fill the calendar": plan the next weeks now instead of waiting for the hourly run. */
posts.post("/plan", async (c) => {
  const body = (await readJson<{ weeks?: number; start_week?: number }>(c)) ?? {};
  const weeks = Number(body.weeks ?? PLAN_AHEAD_WEEKS);
  const startWeek = Number(body.start_week ?? 0);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_PLAN_WEEKS) return fail(c, 400, `Plan 1 to ${MAX_PLAN_WEEKS} weeks at a time.`);
  if (!Number.isInteger(startWeek) || startWeek < 0 || startWeek > MAX_PLAN_WEEKS) return fail(c, 400, "That week is too far ahead.");
  const approved = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved'").first<{ n: number }>())?.n ?? 0;
  if (!approved) return fail(c, 409, "There are no approved clips yet. Approve some in Review first.", "review-and-approve-clips");
  const r = await planAhead(c.env, { weeks, startWeek, respectHeld: false, actor: c.get("user").email });
  return c.json(r);
});

/** Put one approved clip from the pool onto a day (drag from the pool, or "Add to…" on phone). */
posts.post("/", async (c) => {
  const body = await readJson<{ clip_id?: string; platform?: Platform; scheduled_at?: string }>(c);
  if (!body?.clip_id || !body.platform || !PLATFORMS.includes(body.platform) || !body.scheduled_at || Number.isNaN(Date.parse(body.scheduled_at))) return fail(c, 400, "Pick a clip, a platform and a time.");
  const at = new Date(body.scheduled_at).toISOString();
  if (at <= nowIso()) return fail(c, 422, "That time has already passed. Pick a later one.");
  const clip = await c.env.DB.prepare("SELECT c.status, c.platforms, a.source_owner, a.source_note FROM clips c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.id = ?").bind(body.clip_id).first<{ status: string; platforms: string; source_owner: string | null; source_note: string | null }>();
  if (!clip) return fail(c, 404, "That clip is gone.");
  if (clip.status !== "approved") return fail(c, 409, "Only approved clips can go on the calendar. Approve it in Review first.", "review-and-approve-clips");
  if (clip.source_owner === "other") return fail(c, 409, clip.source_note ?? "Looks like someone else's video. Tap This is my video on its dump if it is yours.", "someone-elses-video");
  if (!parseJson<Platform[]>(clip.platforms, [...PLATFORMS]).includes(body.platform)) return fail(c, 422, `This clip is not set to go to ${PLATFORM_LABEL[body.platform]}. Tick it in Review to allow it.`, "edit-a-caption");
  const dup = await c.env.DB.prepare(`SELECT id FROM posts WHERE clip_id = ? AND platform = ? AND status IN ${ACTIVE_SQL}`).bind(body.clip_id, body.platform).first();
  if (dup) return fail(c, 409, `This clip is already on the calendar for ${PLATFORM_LABEL[body.platform]}.`, "move-or-remove-a-post");
  const refusal = capRefusal(PLATFORM_LABEL[body.platform], await countInWeek(c.env, body.platform, at, []), await capFor(c.env, body.platform));
  if (refusal) return fail(c, 409, refusal, "change-posts-per-week");
  const id = newId("pst");
  await c.env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES (?, ?, ?, ?, 'planned')").bind(id, body.clip_id, body.platform, at).run();
  await recordEvent(c.env.DB, "post.placed", id, { platform: body.platform }, c.get("user").email);
  // A full video already on her channel (taken off earlier) gets its new time on YouTube at once.
  await followYouTube(c.env, [body.clip_id]);
  return c.json({ ok: true, id });
});

posts.post("/swap", async (c) => {
  const body = await readJson<{ a?: string; b?: string }>(c);
  if (!body?.a || !body.b || body.a === body.b) return fail(c, 400, "Pick two different posts to swap.");
  const rows = await Promise.all([body.a, body.b].map((id) => c.env.DB.prepare("SELECT id, clip_id, platform, scheduled_at, status, buffer_post_id FROM posts WHERE id = ?").bind(id).first<ExistingPost & { buffer_post_id: string | null }>()));
  const [a, b] = rows;
  if (!a || !b) return fail(c, 404, "One of those posts is gone. Refresh the calendar.");
  for (const p of [a, b]) {
    if (p.status === "posted") return fail(c, 409, "A post that already went out cannot be swapped.");
    if (p.status === "unscheduled") return fail(c, 409, "That post was taken off the calendar. Refresh the calendar.");
  }
  if (a.scheduled_at <= nowIso() || b.scheduled_at <= nowIso()) return fail(c, 422, "One of those times has already passed. Pick later posts.");
  // Same platform: counts cannot change. Different platforms: each lands in the other's week.
  if (a.platform !== b.platform) {
    for (const [moving, target] of [
      [a, b],
      [b, a],
    ] as const) {
      const refusal = capRefusal(PLATFORM_LABEL[moving.platform], await countInWeek(c.env, moving.platform, target.scheduled_at, [a.id, b.id]), await capFor(c.env, moving.platform));
      if (refusal) return fail(c, 409, refusal, "change-posts-per-week");
    }
  }
  await pullFromBuffer(c.env, a.buffer_post_id);
  await pullFromBuffer(c.env, b.buffer_post_id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE posts SET scheduled_at = ?, status = 'planned', buffer_post_id = NULL, error = NULL, retries = 0 WHERE id = ?").bind(b.scheduled_at, a.id),
    c.env.DB.prepare("UPDATE posts SET scheduled_at = ?, status = 'planned', buffer_post_id = NULL, error = NULL, retries = 0 WHERE id = ?").bind(a.scheduled_at, b.id),
  ]);
  await recordEvent(c.env.DB, "posts.swapped", a.id, { other: b.id }, c.get("user").email);
  await followYouTube(c.env, [a.clip_id, b.clip_id]);
  return c.json({ ok: true });
});

/** Move a post: a new time, or a new day keeping its time of day. Failed posts move back to planned. */
posts.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ scheduled_at?: string; date?: string }>(c);
  const post = await c.env.DB.prepare("SELECT id, clip_id, platform, scheduled_at, status, buffer_post_id FROM posts WHERE id = ?").bind(id).first<ExistingPost & { buffer_post_id: string | null }>();
  if (!post) return fail(c, 404, "That post is gone. Refresh the calendar.");
  if (post.status === "posted") return fail(c, 409, "This one already went out, so it cannot move.");
  if (post.status === "unscheduled") return fail(c, 409, "That post was taken off the calendar. Refresh the calendar.");
  const s = await readSettings(c.env);
  let at: string | null = null;
  if (body?.date) at = moveToDate(post.scheduled_at, body.date, s.audience_timezone, zonedToUtc);
  else if (body?.scheduled_at && !Number.isNaN(Date.parse(body.scheduled_at))) at = new Date(body.scheduled_at).toISOString();
  if (!at) return fail(c, 400, "Pick a day to move it to.");
  if (at <= nowIso()) return fail(c, 422, "That time has already passed. Pick a later day.");
  const refusal = capRefusal(PLATFORM_LABEL[post.platform], await countInWeek(c.env, post.platform, at, [post.id]), await capFor(c.env, post.platform));
  if (refusal) return fail(c, 409, refusal, "change-posts-per-week");
  await pullFromBuffer(c.env, post.buffer_post_id);
  await c.env.DB.prepare("UPDATE posts SET scheduled_at = ?, status = 'planned', buffer_post_id = NULL, error = NULL, retries = 0 WHERE id = ?").bind(at, id).run();
  await recordEvent(c.env.DB, "post.moved", id, { platform: post.platform }, c.get("user").email);
  await followYouTube(c.env, [post.clip_id]);
  return c.json({ ok: true, scheduled_at: at });
});

/** Take a post off the calendar: the clip goes back to the approved pool (and out of Buffer). */
posts.post("/:id/unschedule", async (c) => {
  const id = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT status, buffer_post_id, platform, clip_id FROM posts WHERE id = ?").bind(id).first<{ status: string; buffer_post_id: string | null; platform: Platform; clip_id: string }>();
  if (!post) return fail(c, 404, "That post is gone. Refresh the calendar.");
  if (post.status === "posted") return fail(c, 409, "This one already went out, so it cannot be taken off.");
  if (post.status === "unscheduled") return c.json({ ok: true });
  await pullFromBuffer(c.env, post.buffer_post_id);
  await c.env.DB.prepare("UPDATE posts SET status = 'unscheduled', buffer_post_id = NULL WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, "post.unscheduled", id, { platform: post.platform }, c.get("user").email);
  await followYouTube(c.env, [post.clip_id]);
  return c.json({ ok: true });
});

/** "Try again" on a failed post: back to planned with a fresh retry budget. */
posts.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT status FROM posts WHERE id = ?").bind(id).first<{ status: string }>();
  if (!post) return fail(c, 404, "That post is gone. Refresh the calendar.");
  if (post.status !== "failed") return fail(c, 409, "Only a failed post can be tried again.");
  // A post that failed long ago goes out within the hour, not at its old date (day 358: History → Retry).
  const soon = new Date(Date.now() + 3600_000).toISOString();
  await c.env.DB.prepare("UPDATE posts SET status = 'planned', buffer_post_id = NULL, error = NULL, retries = 0, scheduled_at = MAX(scheduled_at, ?) WHERE id = ?").bind(soon, id).run();
  await recordEvent(c.env.DB, "post.retry", id, {}, c.get("user").email);
  return c.json({ ok: true });
});

/**
 * A full video already on her channel (Connect YouTube) follows the Calendar at once: moved → its
 * publish time changes on YouTube, taken off → private and kept (never deleted). A YouTube problem
 * never undoes her Calendar change: it is named on the light and the hourly run tries again.
 */
async function followYouTube(env: Env, clipIds: string[]): Promise<void> {
  for (const id of new Set(clipIds)) {
    try {
      await reconcileClip(env, id);
    } catch (e) {
      log.warn("ytdirect.follow", { err: safeError(e) });
    }
  }
}
