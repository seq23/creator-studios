// Stats (BUILD_PLAN.md section 4 "What's working: top clips, best times, best cut styles",
// sections 4b and 17 for the TikTok export, phase 8 learning loop).
//   GET  /api/stats                 accounts per platform, top videos, best times, best cut
//                                   styles, learning status + learned slots, last sync/import
//   POST /api/stats/sync            the no-login numbers now (YouTube public, Instagram public
//                                   or typed; lib/publicStats.ts), plus the metrics job when a
//                                   Google / Instagram sign-in is connected (extra detail only)
//   POST /api/stats/youtube-channel {channel}  her channel (@handle, link or UC… id), typed once
//   POST /api/stats/instagram-handle {handle}  her Instagram handle when Buffer doesn't know it
//   POST /api/stats/instagram-numbers {followers, avg_reach}  "Your Instagram numbers" form
//   POST /api/stats/instagram-reminder {on}    "Remind me monthly" (a line in the Monday recap)
//   POST /api/stats/tiktok-import   TikTok Studio export → her TikTok results: the .zip TikTok
//                                   hands her (the CSV inside is read) or the CSV itself
//                                   (multipart field "file", a raw body, or JSON {csv});
//                                   columns documented in worker/domain/tiktokImport.ts
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { markConnection } from "../lib/connections";
import { getSetting, recordEvent, setHealth, setSetting } from "../lib/db";
import { fail } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { dispatchJob } from "../services/github";
import { PLATFORMS, RECIPES, type Platform, type Slot } from "@shared/constants";
import { bucketByTime, historyDays, LEARN_MIN_DAYS, learningReady, rankRecipes } from "../domain/learning";
import { parseTikTokExport, recentAverageViews } from "../domain/tiktokImport";
import { loadObservations, updateLearnedSlots, upsertVideos } from "../jobs/metrics";
import { readSettings } from "./settings";
import { csvEntries, isZip, listZip, looksLikeXlsx, readZipEntry } from "../lib/unzip";
import { publicStatsView, refreshInstagramPublic, refreshPublicStats, refreshYouTubePublic, saveInstagramManual, parseChannelInput } from "../lib/publicStats";
import { readJson } from "../lib/http";

export const stats = new Hono<{ Bindings: Env; Variables: Vars }>();
stats.use("*", requireUser);

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

stats.get("/", async (c) => {
  const s = await readSettings(c.env);
  const obs = await loadObservations(c.env);
  const buckets = bucketByTime(obs, s.audience_timezone);

  const { results: accounts } = await c.env.DB.prepare(
    "SELECT a.platform, a.followers, a.avg_views, a.captured_at, a.source FROM account_stats a WHERE a.captured_at = (SELECT MAX(b.captured_at) FROM account_stats b WHERE b.platform = a.platform) GROUP BY a.platform",
  ).all<{ platform: Platform; followers: number; avg_views: number; captured_at: string; source: string }>();

  // Top videos: dashboard clips (with their hook) and her platform history, by views.
  const { results: topClips } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT p.id AS id, p.platform AS platform, c.hook_text AS title, c.recipe AS recipe, p.url AS url, COALESCE(p.posted_at, p.scheduled_at) AS posted_at,
              (SELECT m.views FROM metrics m WHERE m.post_id = p.id ORDER BY m.captured_at DESC LIMIT 1) AS views,
              (SELECT m.likes FROM metrics m WHERE m.post_id = p.id ORDER BY m.captured_at DESC LIMIT 1) AS likes, 'dashboard' AS origin
         FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.status = 'posted' AND EXISTS (SELECT 1 FROM metrics m WHERE m.post_id = p.id)
       UNION ALL
       SELECT pv.id, pv.platform, pv.title, NULL, pv.url, pv.posted_at, pv.views, pv.likes, pv.source
         FROM platform_videos pv WHERE pv.post_id IS NULL
     ) ORDER BY views DESC LIMIT 10`,
  ).all<{ id: string; platform: Platform; title: string | null; recipe: string | null; url: string | null; posted_at: string | null; views: number; likes: number; origin: string }>();

  const bestTimes = {} as Record<Platform, { day: number; hour: number; posts: number; avg_views: number }[]>;
  const learning = {} as Record<Platform, { videos: number; days: number; needDays: number; ready: boolean }>;
  for (const p of PLATFORMS) {
    bestTimes[p] = buckets.filter((b) => b.platform === p).slice(0, 5).map(({ day, hour, posts, avg_views }) => ({ day, hour, posts, avg_views }));
    learning[p] = { videos: obs.filter((o) => o.platform === p).length, days: historyDays(obs, p), needDays: LEARN_MIN_DAYS, ready: learningReady(obs, p) };
  }
  const bestRecipes = rankRecipes(obs.filter((o) => o.recipe).map((o) => ({ recipe: o.recipe as string, views: o.views }))).map((r) => ({ ...r, label: RECIPES[r.recipe as keyof typeof RECIPES]?.label ?? r.recipe }));

  const conns = await c.env.DB.prepare("SELECT service, status, meta, last_ok_at FROM connections WHERE service IN ('meta', 'google', 'tiktok')").all<{ service: string; status: string; meta: string; last_ok_at: string | null }>();
  const job = await c.env.DB.prepare("SELECT id, status, safe_error, created_at FROM jobs WHERE type = 'metrics' ORDER BY created_at DESC LIMIT 1").first();

  return c.json({
    accounts,
    topClips,
    bestTimes,
    bestRecipes,
    learning,
    learnedSlots: await getSetting<Partial<Record<Platform, Slot[]>>>(c.env.DB, "learned_slots", {}),
    learnedAt: await getSetting<string | null>(c.env.DB, "learned_slots_at", null),
    connections: conns.results.map((r) => ({ service: r.service, status: r.status, last_ok_at: r.last_ok_at, meta: JSON.parse(r.meta || "{}") })),
    job,
    timezone: s.audience_timezone,
    public: await publicStatsView(c.env),
    recapOn: s.features.weekly_recap,
  });
});

stats.post("/sync", async (c) => {
  // No-login numbers first, always (owner decision 25 Sep 2026); nothing waits on a sign-in.
  const pub = await refreshPublicStats(c.env, { force: true });
  const signedIn = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE service IN ('meta', 'google') AND status = 'ok'").first<{ n: number }>();
  let jobId: string | null = null;
  let jobError: string | null = null;
  if (signedIn?.n) {
    const r = await dispatchJob(c.env, "metrics", null);
    if (r.dispatched) jobId = r.jobId;
    else jobError = r.error ?? "The sign-in stats could not start.";
  }
  await recordEvent(c.env.DB, "metrics.sync", jobId, { youtube: pub.youtube.state, instagram: pub.instagram.path }, c.get("user").email);
  log.info("stats.sync", { youtube: pub.youtube.state, instagram: pub.instagram.path, sign_in_job: !!jobId });
  return c.json({ ok: true, youtube: pub.youtube, instagram: pub.instagram, jobId, jobError });
});

stats.post("/youtube-channel", async (c) => {
  const body = await readJson<{ channel?: unknown }>(c);
  const raw = typeof body?.channel === "string" ? body.channel.trim().slice(0, 200) : "";
  if (raw && !parseChannelInput(raw)) return fail(c, 422, "Type your channel as @name or paste its link from YouTube.", "your-youtube-numbers");
  await setSetting(c.env.DB, "youtube_channel_typed", raw || null);
  const yt = await refreshYouTubePublic(c.env);
  if (raw && yt.state === "not_found") return fail(c, 422, "We couldn't find that YouTube channel. Copy the @name from your channel page and try again.", "your-youtube-numbers");
  return c.json({ ok: true, youtube: yt, channel: (await publicStatsView(c.env)).youtubeChannel });
});

stats.post("/instagram-handle", async (c) => {
  const body = await readJson<{ handle?: unknown }>(c);
  const raw = typeof body?.handle === "string" ? body.handle.trim().replace(/^@/, "").slice(0, 60) : "";
  if (raw && !/^[\w.]{1,30}$/.test(raw)) return fail(c, 422, "Type your Instagram name as it shows on your profile, like @yourname.", "update-instagram-numbers");
  await setSetting(c.env.DB, "instagram_handle_typed", raw || null);
  return c.json({ ok: true, instagram: await refreshInstagramPublic(c.env, { force: true }) });
});

stats.post("/instagram-numbers", async (c) => {
  const body = await readJson<{ followers?: unknown; avg_reach?: unknown }>(c);
  const whole = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Number(x.replace(/[,\s]/g, "")) : NaN);
  const followers = whole(body?.followers);
  const reach = whole(body?.avg_reach);
  if (!Number.isInteger(followers) || followers < 0 || followers > 1_000_000_000) return fail(c, 422, "Type your follower count as a whole number, like 4820.", "update-instagram-numbers");
  if (!Number.isInteger(reach) || reach < 0 || reach > 1_000_000_000) return fail(c, 422, "Type your average reach or views as a whole number, like 1500.", "update-instagram-numbers");
  const saved = await saveInstagramManual(c.env, followers, reach, c.get("user").email);
  return c.json({ ok: true, manual: saved });
});

stats.post("/instagram-reminder", async (c) => {
  const body = await readJson<{ on?: unknown }>(c);
  const on = body?.on !== false;
  await setSetting(c.env.DB, "instagram_reminder", { on, last_sent_at: null });
  log.info("stats.instagram.reminder", { on });
  return c.json({ ok: true, on });
});

type Upload = { bytes: Uint8Array } | { text: string };

async function readUpload(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Upload | null> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return null;
    if (file.size > MAX_IMPORT_BYTES) throw new RangeError("too big");
    return { bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as { csv?: unknown } | null;
    return typeof body?.csv === "string" ? { text: body.csv } : null;
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length > MAX_IMPORT_BYTES) throw new RangeError("too big");
  return buf.length ? { bytes: buf } : null;
}

const TOO_BIG = "That file is too big. The TikTok export is usually under 1 MB; pick the Content file.";
const GUIDE = "upload-your-tiktok-export";

/**
 * The CSV text of an upload. TikTok Studio's "Download data → CSV" hands her a .zip with the
 * CSV inside (proven 25 Sep 2026): read it. A real Excel file (also a zip, but with
 * [Content_Types].xml) is the only thing refused as Excel.
 */
export async function uploadToCsv(up: Upload): Promise<{ csv: string } | { status: 400 | 413 | 422; error: string }> {
  if ("text" in up) return up.text.length > MAX_IMPORT_BYTES ? { status: 413, error: TOO_BIG } : { csv: up.text };
  const bytes = up.bytes;
  if (!isZip(bytes)) return { csv: new TextDecoder().decode(bytes) };
  let entries;
  try {
    entries = listZip(bytes);
  } catch {
    return { status: 422, error: "That zip file could not be opened. Download it again from TikTok Studio and upload the new one." };
  }
  if (looksLikeXlsx(entries)) return { status: 422, error: "That is an Excel file. In TikTok Studio, pick CSV when you download, then upload that (the zip it gives you is fine)." };
  const csvs = csvEntries(entries);
  if (!csvs.length) return { status: 422, error: "That zip has no CSV file inside. In TikTok Studio, pick CSV when you download, then upload the zip it gives you." };
  // One CSV (TikTok's Content_<name>.zip holds just Content.csv). With several, the Content
  // file first, then the rest in order; the first one that reads as a TikTok export wins.
  const ordered = [...csvs].sort((a, b) => Number(/content/i.test(b.name)) - Number(/content/i.test(a.name)));
  let first: string | null = null;
  for (const e of ordered) {
    if (e.size > MAX_IMPORT_BYTES) return { status: 413, error: TOO_BIG };
    let text: string;
    try {
      text = new TextDecoder().decode(await readZipEntry(bytes, e));
    } catch {
      return { status: 422, error: "That zip file could not be opened. Download it again from TikTok Studio and upload the new one." };
    }
    first ??= text;
    if (parseTikTokExport(text).kind !== "unknown") return { csv: text };
  }
  return { csv: first ?? "" };
}

stats.post("/tiktok-import", async (c) => {
  let up: Upload | null;
  try {
    up = await readUpload(c);
  } catch {
    return fail(c, 413, TOO_BIG, GUIDE);
  }
  if (!up) return fail(c, 400, "Pick the file you downloaded from TikTok Studio (the zip or the CSV inside it).", GUIDE);
  const got = await uploadToCsv(up);
  if ("error" in got) {
    log.info("tiktok.import.refused", { status: got.status });
    return fail(c, got.status, got.error, GUIDE);
  }
  const csv = got.csv;
  const zipped = "bytes" in up && isZip(up.bytes);

  const parsed = parseTikTokExport(csv);
  if (parsed.kind === "unknown") return fail(c, 422, "This doesn't look like a TikTok Studio export. Download the Content file (CSV) and upload that.", GUIDE);

  const now = nowIso();
  let videos = 0;
  if (parsed.kind === "content") {
    videos = await upsertVideos(
      c.env,
      parsed.videos.map((v) => ({ ...v, platform: "tiktok" as const })),
      "import",
    );
  }
  // Account row: follower count from this file (or the last known), average views of recent videos.
  const prev = await c.env.DB.prepare("SELECT followers FROM account_stats WHERE platform = 'tiktok' ORDER BY captured_at DESC LIMIT 1").first<{ followers: number }>();
  const { results: all } = await c.env.DB.prepare("SELECT posted_at, views FROM platform_videos WHERE platform = 'tiktok'").all<{ posted_at: string | null; views: number }>();
  await c.env.DB.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES (?, 'tiktok', ?, ?, ?, 'import')")
    .bind(newId("acs"), now, parsed.followers ?? prev?.followers ?? 0, recentAverageViews(all))
    .run();
  await markConnection(c.env, "tiktok", "ok", null, { via: "import", last_import_at: now, videos: all.length });
  await setHealth(c.env.DB, "TikTok stats", "green", `Imported · ${all.length} videos`, null);
  const learned = await updateLearnedSlots(c.env);
  await recordEvent(c.env.DB, "tiktok.import", null, { videos, kind: parsed.kind, skipped: parsed.skipped, zipped }, c.get("user").email);
  log.info("tiktok.import", { videos, skipped: parsed.skipped, kind: parsed.kind, zipped });
  return c.json({ ok: true, kind: parsed.kind, videos, skipped: parsed.skipped, followers: parsed.followers, zipped, learned: Object.keys(learned) });
});
