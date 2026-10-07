// Pull her results from the stats connections (BUILD_PLAN.md sections 3 step 8, 6, phase 8).
// jobs/metrics.py reads Instagram (Instagram API with Instagram Login: media + insights) and
// YouTube (Data API statistics + Analytics average view duration) with the tokens handed to it
// in the signed spec, matches her videos to dashboard posts by link, and reports numbers only.
//
// Learning loop: after every sync (and every TikTok import) `updateLearnedSlots` recomputes her
// best posting slots from real results. A platform gets learned slots only once it has at least
// 4 weeks of posted history (domain/learning.ts). They are stored in the settings key
// `learned_slots` as Partial<Record<Platform, Slot[]>> for the Calendar planner to read;
// `posting_slots_source` is left as it is (the planner owns that switch).
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { PLATFORMS, type Platform, type Slot } from "@shared/constants";
import { markConnection } from "../lib/connections";
import { recordEvent, setHealth, setSetting } from "../lib/db";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { learnSlots, type Observation } from "../domain/learning";
import { readSettings } from "../routes/settings";
import { freshToken, markStatsConnectionFailed, STATS_HEALTH_NAME, STATS_RECONNECT_GUIDE, type StatsProvider } from "../routes/oauth";

export interface VideoRow {
  platform: Platform;
  external_id: string;
  url: string | null;
  title: string | null;
  posted_at: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avg_watch_s: number | null;
  /** Set by the job when it matched this video to a dashboard post by link. */
  post_id?: string | null;
}

interface MetricRow {
  post_id: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avg_watch_s: number | null;
}

interface MetricsResult {
  metrics?: MetricRow[];
  videos?: VideoRow[];
  accounts?: { platform: Platform; followers: number; avg_views: number }[];
  errors?: { provider: StatsProvider; kind: "expired" | "rate_limit" | "failed" }[];
  providers?: StatsProvider[];
}

const n = (x: unknown) => Math.max(0, Math.floor(Number(x) || 0));

/** Insert or refresh her videos; links them to a dashboard post when the link matches. */
export async function upsertVideos(env: Env, videos: VideoRow[], source: "api" | "import"): Promise<number> {
  const now = nowIso();
  let count = 0;
  for (const v of videos) {
    if (!PLATFORMS.includes(v.platform) || !v.external_id) continue;
    await env.DB.prepare(
      `INSERT INTO platform_videos (id, platform, external_id, url, title, posted_at, views, likes, comments, shares, saves, avg_watch_s, source, post_id, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE((SELECT id FROM posts WHERE id = ?15), (SELECT id FROM posts WHERE url IS NOT NULL AND url = ?4 LIMIT 1)), ?14)
       ON CONFLICT(platform, external_id) DO UPDATE SET
         url = COALESCE(excluded.url, platform_videos.url), title = COALESCE(excluded.title, platform_videos.title),
         posted_at = COALESCE(excluded.posted_at, platform_videos.posted_at), views = excluded.views, likes = excluded.likes,
         comments = excluded.comments,
         -- A source that cannot see shares / saves (YouTube's public numbers) reports 0: keep what a richer read found.
         shares = CASE WHEN excluded.shares > 0 THEN excluded.shares ELSE platform_videos.shares END,
         saves = CASE WHEN excluded.saves > 0 THEN excluded.saves ELSE platform_videos.saves END,
         avg_watch_s = COALESCE(excluded.avg_watch_s, platform_videos.avg_watch_s), source = excluded.source,
         post_id = COALESCE(excluded.post_id, platform_videos.post_id), captured_at = excluded.captured_at`,
    )
      .bind(newId("pv"), v.platform, String(v.external_id).slice(0, 300), v.url?.slice(0, 500) ?? null, v.title?.slice(0, 300) ?? null, v.posted_at, n(v.views), n(v.likes), n(v.comments), n(v.shares), n(v.saves), v.avg_watch_s ?? null, source, now, v.post_id ?? null)
      .run();
    count++;
  }
  // A dashboard post that matched a platform video gets its numbers in `metrics` too.
  await env.DB.prepare(
    `INSERT INTO metrics (id, post_id, captured_at, views, likes, comments, shares, saves, avg_watch_s)
     SELECT 'met_' || lower(hex(randomblob(6))), pv.post_id, ?, pv.views, pv.likes, pv.comments, pv.shares, pv.saves, pv.avg_watch_s
     FROM platform_videos pv WHERE pv.post_id IS NOT NULL AND pv.captured_at = ?`,
  )
    .bind(now, now)
    .run();
  return count;
}

/** Every result with a posting time: her platform videos plus dashboard posts with metrics. */
export async function loadObservations(env: Env): Promise<(Observation & { recipe: string | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT pv.platform AS platform, pv.posted_at AS posted_at, pv.views AS views,
            (SELECT c.recipe FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.id = pv.post_id) AS recipe
       FROM platform_videos pv WHERE pv.posted_at IS NOT NULL
     UNION ALL
     SELECT p.platform, COALESCE(p.posted_at, p.scheduled_at),
            (SELECT m.views FROM metrics m WHERE m.post_id = p.id ORDER BY m.captured_at DESC LIMIT 1), c.recipe
       FROM posts p JOIN clips c ON c.id = p.clip_id
      WHERE p.status = 'posted' AND EXISTS (SELECT 1 FROM metrics m WHERE m.post_id = p.id)
        AND p.id NOT IN (SELECT post_id FROM platform_videos WHERE post_id IS NOT NULL)`,
  ).all<{ platform: Platform; posted_at: string; views: number | null; recipe: string | null }>();
  return results.map((r) => ({ platform: r.platform, posted_at: r.posted_at, views: r.views ?? 0, recipe: r.recipe }));
}

/** Recompute learned slots from real results and store them for the planner. */
export async function updateLearnedSlots(env: Env): Promise<Partial<Record<Platform, Slot[]>>> {
  const s = await readSettings(env);
  const learned = learnSlots(await loadObservations(env), s.audience_timezone, s.weekly_caps);
  if (Object.keys(learned).length > 0) {
    await setSetting(env.DB, "learned_slots", learned);
    await setSetting(env.DB, "learned_slots_at", nowIso());
    await recordEvent(env.DB, "learning.slots", null, { platforms: Object.keys(learned).length });
  }
  log.info("learning.slots", { platforms: Object.keys(learned).length });
  return learned;
}

async function buildSpec(env: Env, jobId: string) {
  const { results: posts } = await env.DB.prepare(
    "SELECT id, platform, url, COALESCE(posted_at, scheduled_at) AS posted_at FROM posts WHERE status = 'posted' AND url IS NOT NULL AND COALESCE(posted_at, scheduled_at) >= ? ORDER BY posted_at DESC LIMIT 500",
  )
    .bind(new Date(Date.now() - 180 * 86_400_000).toISOString())
    .all<{ id: string; platform: Platform; url: string; posted_at: string }>();
  const meta = await freshToken(env, "meta");
  const google = await freshToken(env, "google");
  return {
    job_id: jobId,
    type: "metrics",
    posts,
    instagram: meta ? { access_token: meta.access_token, user_id: meta.account_id } : null,
    youtube: google ? { access_token: google.access_token, channel_id: google.account_id } : null,
    max_videos: 60,
  };
}

async function connectedProviders(env: Env): Promise<StatsProvider[]> {
  const { results } = await env.DB.prepare("SELECT service FROM connections WHERE service IN ('meta', 'google') AND status = 'ok'").all<{ service: StatsProvider }>();
  return results.map((r) => r.service);
}

export const metricsJob: JobHandler = {
  async buildSpec(env, jobId) {
    return buildSpec(env, jobId);
  },

  async applyResult(env, jobId, refId, raw) {
    void refId;
    const r = (raw ?? {}) as MetricsResult;
    let metricRows = 0;
    for (const m of r.metrics ?? []) {
      if (typeof m?.post_id !== "string") continue;
      const res = await env.DB.prepare(
        "INSERT INTO metrics (id, post_id, captured_at, views, likes, comments, shares, saves, avg_watch_s) SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM posts WHERE id = ?",
      )
        .bind(newId("met"), nowIso(), n(m.views), n(m.likes), n(m.comments), n(m.shares), n(m.saves), m.avg_watch_s ?? null, m.post_id)
        .run();
      metricRows += res.meta.changes ?? 0;
    }
    const videos = await upsertVideos(env, (r.videos ?? []).filter((v) => v.platform === "instagram" || v.platform === "youtube"), "api");
    for (const a of r.accounts ?? []) {
      if (!PLATFORMS.includes(a.platform)) continue;
      await env.DB.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES (?, ?, ?, ?, ?, 'api')").bind(newId("acs"), a.platform, nowIso(), n(a.followers), n(a.avg_views)).run();
    }
    const errored = new Set<StatsProvider>();
    for (const e of r.errors ?? []) {
      if (e.provider !== "meta" && e.provider !== "google") continue;
      errored.add(e.provider);
      const who = e.provider === "meta" ? "Instagram" : "YouTube";
      if (e.kind === "expired") await markStatsConnectionFailed(env, e.provider, `${who} needs you to reconnect.`);
      else await setHealth(env.DB, STATS_HEALTH_NAME[e.provider], "yellow", e.kind === "rate_limit" ? `${who} asked us to slow down. We'll try again next week.` : `${who} didn't answer this time. We'll try again next week.`, STATS_RECONNECT_GUIDE[e.provider]);
    }
    const ran = r.providers ?? (await connectedProviders(env));
    for (const p of ran) {
      if (errored.has(p)) continue;
      const count = (r.videos ?? []).filter((v) => v.platform === (p === "meta" ? "instagram" : "youtube")).length;
      await markConnection(env, p, "ok", null, { last_sync_at: nowIso(), videos: count });
      await setHealth(env.DB, STATS_HEALTH_NAME[p], "green", `Synced · ${count} videos`, null);
    }
    await updateLearnedSlots(env);
    await recordEvent(env.DB, "metrics.synced", jobId, { metrics: metricRows, videos });
    log.info("metrics.apply", { metrics: metricRows, videos, errors: errored.size });
  },

  async onFailure(env, jobId, refId, safeError) {
    void refId;
    for (const p of await connectedProviders(env)) await setHealth(env.DB, STATS_HEALTH_NAME[p], "yellow", "The last stats sync did not finish. It runs again next week.", STATS_RECONNECT_GUIDE[p]);
    await recordEvent(env.DB, "metrics.failed", jobId, { len: safeError.length });
    log.warn("metrics.failed");
  },

  /**
   * Fake runner: plausible numbers for every posted dashboard post, plus six weeks of her
   * Instagram / YouTube history for each connected provider (enough for the learning loop).
   * options.fail = "meta" | "google" returns the expired-token failure shape for that provider.
   */
  async fakeRun(env, jobId, refId, options) {
    void refId;
    const spec = await buildSpec(env, jobId);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const metrics: MetricRow[] = spec.posts.map((p) => {
      const views = Math.round(400 + rnd() * 9000);
      return { post_id: p.id, views, likes: Math.round(views * 0.06), comments: Math.round(views * 0.008), shares: Math.round(views * 0.01), saves: Math.round(views * 0.012), avg_watch_s: Math.round(6 + rnd() * 14) };
    });
    const videos: VideoRow[] = [];
    const accounts: MetricsResult["accounts"] = [];
    const errors: MetricsResult["errors"] = [];
    const providers: StatsProvider[] = [];
    const plan: [StatsProvider, Platform, boolean][] = [
      ["meta", "instagram", !!spec.instagram],
      ["google", "youtube", !!spec.youtube],
    ];
    for (const [prov, platform, connected] of plan) {
      if (options.fail === prov) {
        errors.push({ provider: prov, kind: "expired" });
        continue;
      }
      if (!connected) continue;
      providers.push(prov);
      // 18 videos over the last 6 weeks; evenings do better, so the learning loop has a signal.
      for (let i = 0; i < 18; i++) {
        const d = new Date(Date.now() - (i * 42 * 86_400_000) / 18 - 86_400_000);
        const hour = [9, 12, 16, 19, 20, 21][i % 6];
        d.setUTCHours(hour + 4, 0, 0, 0);
        const evening = hour >= 19 ? 2.2 : 1;
        const views = Math.round((platform === "instagram" ? 1800 : 900) * evening * (0.6 + rnd()));
        videos.push({ platform, external_id: `fake_${platform}_${i}`, url: null, title: null, posted_at: d.toISOString(), views, likes: Math.round(views * 0.05), comments: Math.round(views * 0.006), shares: Math.round(views * 0.01), saves: Math.round(views * 0.01), avg_watch_s: Math.round(8 + rnd() * 12) });
      }
      const mine = videos.filter((v) => v.platform === platform);
      accounts.push({ platform, followers: platform === "instagram" ? 4820 : 1260, avg_views: Math.round(mine.reduce((s, v) => s + v.views, 0) / mine.length) });
    }
    return { metrics, videos, accounts, errors, providers };
  },
};
