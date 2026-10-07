// Home (section 4): runway, this week, what is waiting, health lights, follow-ups, the quiet
// "Your voice" card, and the notices. Day 358 (docs/reviews/2026-09-26-day-358.md): Home stays one
// phone screen however much piles up. Every list is cut by capSection to HOME_CAPS with its true
// total ("See all (N)"), and every card can be dismissed (POST /api/home/dismiss, Undo = /restore).
// A dismissed card's key names what it said, so a card that changes comes back.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { listHealth, parseJson } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { runwayWeeks, weeklyNeed } from "../domain/runway";
import { weekBounds } from "../domain/slotting";
import { readSettings } from "./settings";
import { dueDealItems } from "./deals";
import { HOME_CAPS, PLATFORMS, type Platform } from "@shared/constants";
import type { ClearingSoon, DumpSummary, HomeNotice, HomeSection, HomeSummary } from "@shared/types";
import { foldHealth } from "@shared/health";
import { chooseEngine, homeVoiceCard } from "../domain/voiceEngine";
import { premiumState } from "../lib/premiumVoice";
import { fullVideoCards } from "../lib/fullVideo";
import { clipFileAction } from "../domain/tidy";
import { log } from "../lib/log";

export const home = new Hono<{ Bindings: Env; Variables: Vars }>();
home.use("*", requireUser);

/** The one way a Home list is cut: at most `cap` items, and the true total. */
export function capSection<T>(list: T[], cap: number): HomeSection<T> {
  return { items: list.slice(0, cap), total: list.length };
}

async function dismissedKeys(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT key FROM dismissals").all<{ key: string }>();
  return new Set(results.map((r) => r.key));
}

/** Drafts whose file is cleared soon (the warning is on): how many, the first date, the space. */
export async function clearingSoon(env: Env, now = new Date()): Promise<ClearingSoon | null> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, full_video, created_at, file_deleted_at, keep_until, delete_warned_at, COALESCE(file_bytes, 0) AS bytes FROM clips WHERE status = 'draft' AND full_video = 0 AND file_deleted_at IS NULL AND delete_warned_at IS NOT NULL",
  ).all<{ id: string; status: string; full_video: number; created_at: string; file_deleted_at: string | null; keep_until: string | null; delete_warned_at: string | null; bytes: number }>();
  let first: string | null = null;
  let drafts = 0;
  let bytes = 0;
  for (const r of results) {
    const a = clipFileAction({ ...r, last_posted_at: null, waiting_post: false, in_kit: false }, now);
    const on = a.do === "warn" ? a.deleteOn : a.do === "delete" ? now.toISOString() : null;
    if (!on) continue;
    drafts++;
    bytes += r.bytes;
    if (!first || on < first) first = on;
  }
  if (!drafts || !first) return null;
  return { key: `clearing:${first.slice(0, 10)}:${drafts}`, drafts, first_on: first, bytes };
}

home.get("/", async (c) => {
  const db = c.env.DB;
  const s = await readSettings(c.env);
  const dismissed = await dismissedKeys(c.env);
  const shown = <T extends { key: string }>(list: T[]) => list.filter((x) => !dismissed.has(x.key));
  const need = weeklyNeed(s.weekly_caps);
  const approved = (await db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved' AND file_deleted_at IS NULL AND id NOT IN (SELECT clip_id FROM posts WHERE status IN ('posted','in_buffer','planned'))").first<{ n: number }>())?.n ?? 0;

  const { start, end } = weekBounds(new Date(), s.audience_timezone);
  const { results: weekPosts } = await db.prepare("SELECT platform, status FROM posts WHERE scheduled_at >= ? AND scheduled_at < ? AND status != 'unscheduled'").bind(start, end).all<{ platform: Platform; status: string }>();
  const perPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, { posted: 0, cap: s.weekly_caps[p] }])) as Record<Platform, { posted: number; cap: number }>;
  let posted = 0;
  for (const p of weekPosts) {
    if (p.status === "posted") {
      posted++;
      perPlatform[p.platform].posted++;
    }
  }

  const waitingClips = (await db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND hidden = 0").first<{ n: number }>())?.n ?? 0;
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const waitingNew = (await db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND hidden = 0 AND created_at >= ?").bind(weekAgo).first<{ n: number }>())?.n ?? 0;
  const cutting = (await db.prepare("SELECT COUNT(*) AS n FROM dumps WHERE status IN ('queued','cutting')").first<{ n: number }>())?.n ?? 0;
  const briefDraft = await db.prepare("SELECT version FROM research_briefs WHERE status = 'draft' AND archived_at IS NULL ORDER BY version DESC LIMIT 1").first<{ version: number }>();
  const profileLocked = await db.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first();

  // "Needs you": the most urgent first, one on Home at a time; each dismissable (a new brief, a
  // worse light, another batch of drafts, another video comes back).
  const health = await listHealth(db);
  const storage = health.find((h) => h.name === "Storage");
  const soon = await clearingSoon(c.env);
  const cards = (await fullVideoCards(c.env)).map((y) => ({ ...y, key: `yt:${y.kind}:${y.clip_id}` }));
  const notices: HomeNotice[] = [];
  if (!profileLocked) notices.push({ key: "notice:profile", kind: "profile" });
  if (storage?.light === "red") notices.push({ key: "notice:storage:red", kind: "storage", light: "red", line: storage.note });
  for (const y of cards.filter((x) => x.kind === "removal_soon")) notices.push({ key: y.key, kind: "youtube", card: y });
  if (soon) notices.push({ kind: "clearing", ...soon });
  for (const y of cards.filter((x) => x.kind !== "removal_soon")) notices.push({ key: y.key, kind: "youtube", card: y });
  if (profileLocked && briefDraft) notices.push({ key: `notice:brief:${briefDraft.version}`, kind: "brief" });
  if (storage?.light === "yellow") notices.push({ key: "notice:storage:yellow", kind: "storage", light: "yellow", line: storage.note });

  // Deal emails due in the next two days (follow-ups, replies, reports, invoices, rebooks): the
  // same list the Monday recap reads (worker/routes/deals.ts dueDealItems); archived deals are out.
  const due = (await dueDealItems(c.env, new Date(Date.now() + 2 * 86400_000))).map((f) => ({ ...f, key: `due:${f.dealId}:${f.dueAt.slice(0, 10)}` }));

  const recentWhere = "d.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM dismissals x WHERE x.key = 'dump:' || d.id || ':' || d.status)";
  const { results: recent } = await db
    .prepare(
      `SELECT d.id, CASE WHEN d.kind = 'full_video' THEN 'youtube' ELSE d.door END AS door, d.notes, d.status, d.error_summary, d.clips_made, d.created_at, d.ready_at,
        (SELECT COUNT(*) FROM assets a WHERE a.dump_id = d.id AND a.upload_status != 'aborted') AS files,
        (SELECT j.progress FROM jobs j WHERE j.ref_id = d.id AND j.type = 'cut' ORDER BY j.created_at DESC LIMIT 1) AS progress
       FROM dumps d WHERE ${recentWhere} ORDER BY d.created_at DESC LIMIT ?`,
    )
    .bind(HOME_CAPS.recentDumps)
    .all<Omit<DumpSummary, "progress"> & { progress: string | null }>();
  const recentTotal = (await db.prepare(`SELECT COUNT(*) AS n FROM dumps d WHERE ${recentWhere}`).first<{ n: number }>())?.n ?? 0;

  const pv = await premiumState(c.env);
  // A real error only: the built-in job failed, or ElevenLabs refused the key. Yellow (no cloning
  // on her plan, low credits) is not a problem here; the built-in voice covers it.
  const bad = health.find((h) => (h.name === "Voice" || h.name === "Voice · ElevenLabs") && h.light === "red");
  const voice = homeVoiceCard({ hasSample: pv.hasSample, engine: chooseEngine(pv).engine, connection: pv.connection, problem: bad ? { note: bad.note, fix: bad.fix_guide } : null });

  const out: HomeSummary = {
    today: new Date().toISOString(),
    runway: { weeks: runwayWeeks(approved, need), approvedClips: approved, thresholdWeeks: s.runway_threshold_weeks, weeklyNeed: need },
    thisWeek: { posted, planned: weekPosts.length, perPlatform },
    waiting: { clips: waitingClips, clipsThisWeek: waitingNew, dumpsCutting: cutting, briefNeedsApproval: !!briefDraft, profileUnlocked: !profileLocked },
    health: capSection(foldHealth(health), HOME_CAPS.health),
    notices: capSection(shown(notices), HOME_CAPS.notices),
    followups: capSection(shown(due), HOME_CAPS.followups),
    recentDumps: { items: recent.map((r) => ({ ...r, key: `dump:${r.id}:${r.status}`, progress: parseJson(r.progress, null) })), total: recentTotal },
    voice,
  };
  return c.json(out);
});

/** Dismiss a Home card (it stays wherever else it lives); Undo is /restore with the same key. */
home.post("/dismiss", async (c) => {
  const body = await readJson<{ key?: string }>(c);
  const key = (body?.key ?? "").trim();
  if (!/^[a-z]+:[\w:.-]{1,160}$/i.test(key)) return fail(c, 400, "That card can't be dismissed.");
  await c.env.DB.prepare("INSERT INTO dismissals (key) VALUES (?) ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at").bind(key).run();
  log.info("home.dismissed", { kind: key.split(":")[0] });
  return c.json({ ok: true });
});

home.post("/restore", async (c) => {
  const body = await readJson<{ key?: string }>(c);
  const key = (body?.key ?? "").trim();
  if (!key) return fail(c, 400, "That card can't be brought back.");
  await c.env.DB.prepare("DELETE FROM dismissals WHERE key = ?").bind(key).run();
  log.info("home.restored", { kind: key.split(":")[0] });
  return c.json({ ok: true });
});
