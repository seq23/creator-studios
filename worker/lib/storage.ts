// Day 358 (docs/reviews/2026-09-26-day-358.md): the storage meter, the file rules, the hard budget
// and the tidy (archive) rules, run by the daily lane (worker/crons/daily.ts). The rules themselves
// are pure in worker/domain/tidy.ts; this file reads and writes D1 and R2 and logs through log.ts.
//
//   storageReport  what the files take, by kind (every file: clips + covers, voice overs + mixes,
//                  raw uploads, full videos, music, docs, anything else in the bucket)
//   measureStorage lists the bucket (the truth), fills file sizes rows don't have yet, and keeps
//                  what no row owns as "other"
//   clipFileRules  posted clip files after 30 days (not kit clips), drafts after 60 days with the
//                  Home warning first
//   enforceBudget  over 90% of 10 GB: the same kinds of file, earlier, least harm first
//   tidyDaily      archive what is finished (never deletes)
import type { Env } from "../env";
import { getSetting, recordEvent, setHealth, setSetting } from "./db";
import { nowIso } from "./ids";
import { log } from "./log";
import { gbWords } from "@shared/bytes";
import { budgetPlan, briefArchiveDue, clipFileAction, dealArchiveDue, dumpArchiveDue, STORAGE, storageLight, TIDY, voiceArchiveDue, type BudgetCandidate } from "../domain/tidy";

export interface StorageKind {
  key: "clips_posted" | "clips_waiting" | "clips_drafts" | "clips_rejected" | "full_videos" | "raw" | "voice" | "music" | "docs" | "other";
  label: string;
  bytes: number;
  count: number;
  rule: string;
}

export interface StorageReport {
  used_bytes: number;
  limit_bytes: number;
  budget_bytes: number;
  free_bytes: number;
  light: "green" | "yellow" | "red";
  line: string;
  kinds: StorageKind[];
  measured_at: string | null;
  tidy_on: boolean;
}

interface Measured {
  listed_bytes: number;
  other_bytes: number;
  measured_at: string;
}

const LEDGER_SQL = `SELECT
  (SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE upload_status = 'uploaded' AND raw_deleted_at IS NULL) AS raw_b,
  (SELECT COUNT(*) FROM assets WHERE upload_status = 'uploaded' AND raw_deleted_at IS NULL) AS raw_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes,0)),0) FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL AND EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')) AS posted_b,
  (SELECT COUNT(*) FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL AND EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')) AS posted_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes,0)),0) FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')) AS waiting_b,
  (SELECT COUNT(*) FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')) AS waiting_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes,0)),0) FROM clips WHERE full_video = 0 AND status = 'draft' AND file_deleted_at IS NULL) AS drafts_b,
  (SELECT COUNT(*) FROM clips WHERE full_video = 0 AND status = 'draft' AND file_deleted_at IS NULL) AS drafts_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes,0)),0) FROM clips WHERE full_video = 0 AND status = 'rejected') AS rejected_b,
  (SELECT COUNT(*) FROM clips WHERE full_video = 0 AND status = 'rejected') AS rejected_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes, json_extract(youtube, '$.size_bytes'), 0)),0) FROM clips WHERE full_video = 1 AND file_deleted_at IS NULL AND status != 'deleted') AS full_b,
  (SELECT COUNT(*) FROM clips WHERE full_video = 1 AND file_deleted_at IS NULL AND status != 'deleted') AS full_n,
  (SELECT COALESCE(SUM(COALESCE(file_bytes,0)),0) FROM narrations) AS voice_b,
  (SELECT COUNT(*) FROM narrations WHERE r2_key IS NOT NULL) AS voice_n,
  (SELECT COALESCE(SUM(size_bytes),0) FROM music_tracks) AS music_b,
  (SELECT COUNT(*) FROM music_tracks) AS music_n,
  (SELECT COALESCE(SUM(size_bytes),0) FROM brand_docs) AS docs_b,
  (SELECT COUNT(*) FROM brand_docs) AS docs_n`;

type Ledger = Record<"raw" | "posted" | "waiting" | "drafts" | "rejected" | "full" | "voice" | "music" | "docs", { b: number; n: number }>;

async function ledger(env: Env): Promise<Ledger> {
  const r = (await env.DB.prepare(LEDGER_SQL).first<Record<string, number>>()) ?? {};
  const pair = (k: string) => ({ b: Number(r[`${k}_b`] ?? 0), n: Number(r[`${k}_n`] ?? 0) });
  return { raw: pair("raw"), posted: pair("posted"), waiting: pair("waiting"), drafts: pair("drafts"), rejected: pair("rejected"), full: pair("full"), voice: pair("voice"), music: pair("music"), docs: pair("docs") };
}

const ledgerTotal = (l: Ledger) => Object.values(l).reduce((s, x) => s + x.b, 0);

export async function tidyOn(env: Env): Promise<boolean> {
  return (await getSetting<{ on?: boolean }>(env.DB, "tidy", { on: true })).on !== false;
}

/** What the files take, by kind, with each kind's rule in her words. */
export async function storageReport(env: Env): Promise<StorageReport> {
  const l = await ledger(env);
  const m = await getSetting<Measured | null>(env.DB, "storage_report", null);
  const other = m?.other_bytes ?? 0;
  const used = ledgerTotal(l) + other;
  const light = storageLight(used);
  const kinds: StorageKind[] = [
    { key: "clips_posted", label: "Posted clips", bytes: l.posted.b, count: l.posted.n, rule: "Cleared 30 days after posting (the cover, numbers and post link stay). Clips in your media kit are kept." },
    { key: "clips_drafts", label: "Clips waiting for review", bytes: l.drafts.b, count: l.drafts.n, rule: "Cleared 60 days after they were made, with a warning on Home a week before. Tap Keep to keep them." },
    { key: "clips_waiting", label: "Approved, not posted yet", bytes: l.waiting.b, count: l.waiting.n, rule: "Always kept." },
    { key: "clips_rejected", label: "Rejected clips", bytes: l.rejected.b, count: l.rejected.n, rule: "Cleared 7 days after you reject them." },
    { key: "raw", label: "Your original videos", bytes: l.raw.b, count: l.raw.n, rule: "Cleared 7 days after they are cut into clips." },
    { key: "full_videos", label: "Full videos for YouTube", bytes: l.full.b, count: l.full.n, rule: "Cleared 7 days after posting, or 14 days if never approved (warned on Home first)." },
    { key: "voice", label: "Voice overs", bytes: l.voice.b, count: l.voice.n, rule: "Kept with their clip." },
    { key: "music", label: "My music", bytes: l.music.b, count: l.music.n, rule: "Kept until you remove a song." },
    { key: "docs", label: "Brand docs", bytes: l.docs.b, count: l.docs.n, rule: "Kept until you remove them." },
    { key: "other", label: "Other files", bytes: other, count: 0, rule: "Pictures, your voice sample and edits you uploaded." },
  ];
  const free = Math.max(0, STORAGE.limitBytes - used);
  return {
    used_bytes: used,
    limit_bytes: STORAGE.limitBytes,
    budget_bytes: STORAGE.budgetBytes,
    free_bytes: free,
    light,
    line: `${gbWords(used)} of 10 GB used · ${gbWords(free)} free`,
    kinds: kinds.sort((a, b) => b.bytes - a.bytes),
    measured_at: m?.measured_at ?? null,
    tidy_on: await tidyOn(env),
  };
}

/** Storage in use (bytes): the report's total. Used before a dump (free space) and by the light. */
export async function storageUsed(env: Env): Promise<number> {
  return (await storageReport(env)).used_bytes;
}

/**
 * List the bucket (the truth), fill the file sizes rows don't have yet, and keep what no row owns
 * as "other". At 1,000 objects a page, 10 GB of clips is a handful of list calls.
 */
export async function measureStorage(env: Env): Promise<{ listed: number; filled: number }> {
  const sizes = new Map<string, number>();
  let listed = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const page = await env.FILES.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      sizes.set(o.key, o.size);
      listed += o.size;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  let filled = 0;
  const { results: clips } = await env.DB.prepare("SELECT id, r2_key, cover_r2_key FROM clips WHERE file_bytes IS NULL AND status != 'deleted' AND file_deleted_at IS NULL LIMIT 2000").all<{ id: string; r2_key: string; cover_r2_key: string | null }>();
  const stmts: D1PreparedStatement[] = [];
  for (const c of clips) {
    if (!sizes.has(c.r2_key)) continue;
    stmts.push(env.DB.prepare("UPDATE clips SET file_bytes = ? WHERE id = ?").bind((sizes.get(c.r2_key) ?? 0) + (c.cover_r2_key ? (sizes.get(c.cover_r2_key) ?? 0) : 0), c.id));
  }
  const { results: narr } = await env.DB.prepare("SELECT id, r2_key, mixed_r2_key FROM narrations WHERE file_bytes IS NULL LIMIT 2000").all<{ id: string; r2_key: string | null; mixed_r2_key: string | null }>();
  for (const n of narr) {
    const b = (n.r2_key ? (sizes.get(n.r2_key) ?? 0) : 0) + (n.mixed_r2_key ? (sizes.get(n.mixed_r2_key) ?? 0) : 0);
    if (!n.r2_key && !n.mixed_r2_key) continue;
    stmts.push(env.DB.prepare("UPDATE narrations SET file_bytes = ? WHERE id = ?").bind(b, n.id));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  filled = stmts.length;
  const other = Math.max(0, listed - ledgerTotal(await ledger(env)));
  await setSetting(env.DB, "storage_report", { listed_bytes: listed, other_bytes: other, measured_at: nowIso() } satisfies Measured);
  log.info("storage.measured", { listed_mb: Math.round(listed / 1024 ** 2), filled, other_mb: Math.round(other / 1024 ** 2) });
  return { listed, filled };
}

// ---------------------------------------------------------------- file rules

interface ClipFactsRow {
  id: string;
  status: string;
  full_video: number;
  created_at: string;
  file_deleted_at: string | null;
  keep_until: string | null;
  delete_warned_at: string | null;
  r2_key: string;
  last_posted_at: string | null;
  waiting_post: number;
}

const FACTS_SQL = `SELECT c.id, c.status, c.full_video, c.created_at, c.file_deleted_at, c.keep_until, c.delete_warned_at, c.r2_key,
  (SELECT MAX(p.posted_at) FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted') AS last_posted_at,
  EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('planned','in_buffer')) AS waiting_post
  FROM clips c WHERE c.full_video = 0 AND c.status IN ('draft','approved') AND c.file_deleted_at IS NULL`;

/** Clip ids in her media kit (the published version or her draft): their files are always kept. */
export async function kitClipIds(env: Env): Promise<Set<string>> {
  const kit = await env.DB.prepare("SELECT draft FROM media_kit WHERE id = 1").first<{ draft: string | null }>();
  const pub = await env.DB.prepare("SELECT content FROM media_kit_versions ORDER BY version DESC LIMIT 1").first<{ content: string }>();
  const ids = (json: string | null | undefined): string[] => {
    if (!json) return [];
    try {
      const v = JSON.parse(json) as { showcase?: unknown; featured_clip_ids?: unknown };
      const list = Array.isArray(v.showcase) ? v.showcase : Array.isArray(v.featured_clip_ids) ? v.featured_clip_ids : [];
      return list.map(String);
    } catch {
      return [];
    }
  };
  return new Set([...ids(kit?.draft), ...ids(pub?.content)]);
}

/**
 * Posted clip files after 30 days (never kit clips), unapproved drafts after 60 days: the draft's
 * warning is recorded the first day it is due (Home shows it from then) and a draft is cleared only
 * once that warning is at least 7 days old.
 */
export async function clipFileRules(env: Env, now = new Date()): Promise<{ posted: number; drafts: number; warned: number }> {
  const kit = await kitClipIds(env);
  const { results } = await env.DB.prepare(`${FACTS_SQL} LIMIT 3000`).all<ClipFactsRow>();
  let posted = 0;
  let drafts = 0;
  let warned = 0;
  const at = nowIso();
  for (const r of results) {
    const a = clipFileAction({ ...r, waiting_post: !!r.waiting_post, in_kit: kit.has(r.id) }, now);
    if (a.do === "warn" && !r.delete_warned_at) {
      await env.DB.prepare("UPDATE clips SET delete_warned_at = ? WHERE id = ? AND delete_warned_at IS NULL").bind(at, r.id).run();
      warned++;
    } else if (a.do === "delete") {
      await env.FILES.delete(r.r2_key);
      if (a.why === "posted") {
        // The cover, its numbers and the post link stay; the video file and its public link go.
        await env.DB.prepare("UPDATE clips SET file_deleted_at = ?, media_token = NULL, file_bytes = 0 WHERE id = ?").bind(at, r.id).run();
        // its voice-over mix is another copy of the same video: it goes too (the script stays)
        await clearMixes(env, r.id);
        posted++;
      } else {
        await env.DB.prepare("UPDATE clips SET file_deleted_at = ?, status = 'deleted', media_token = NULL, file_bytes = 0 WHERE id = ? AND status = 'draft'").bind(at, r.id).run();
        await clearMixes(env, r.id);
        drafts++;
      }
      await recordEvent(env.DB, "storage.clip_file_cleared", r.id, { why: a.why });
    }
  }
  log.info("storage.clip_rules", { checked: results.length, posted, drafts, warned });
  return { posted, drafts, warned };
}

/** A clip's voice-over mixes (copies of the clip with her voice in): cleared with the clip's file. */
async function clearMixes(env: Env, clipId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, mixed_r2_key FROM narrations WHERE clip_id = ? AND mixed_r2_key IS NOT NULL").bind(clipId).all<{ id: string; mixed_r2_key: string }>();
  if (!results.length) return;
  await env.FILES.delete(results.map((n) => n.mixed_r2_key));
  for (const n of results) await env.DB.prepare("UPDATE narrations SET mixed_r2_key = NULL, file_bytes = 0 WHERE id = ?").bind(n.id).run();
}

/**
 * Over the hard budget (90% of 10 GB): clear the same kinds of file the rules clear anyway, earlier,
 * least harm first (originals already cut, rejected clips, clips posted a week ago). Never an
 * approved clip waiting to post, a kit clip or a draft (drafts only ever go by their warned rule).
 */
export async function enforceBudget(env: Env, now = new Date()): Promise<{ cleared: number; enough: boolean; used: number }> {
  const used = await storageUsed(env);
  if (used <= STORAGE.budgetBytes) return { cleared: 0, enough: true, used };
  const kit = await kitClipIds(env);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const { results: raws } = await env.DB.prepare(
    "SELECT a.id, a.size_bytes AS bytes, COALESCE(d.ready_at, d.created_at) AS at FROM assets a JOIN dumps d ON d.id = a.dump_id WHERE a.raw_deleted_at IS NULL AND a.upload_status = 'uploaded' AND d.status IN ('ready','reviewed') AND d.kind = 'clips'",
  ).all<{ id: string; bytes: number; at: string }>();
  const { results: rejected } = await env.DB.prepare("SELECT id, COALESCE(file_bytes,0) AS bytes, COALESCE(reviewed_at, created_at) AS at FROM clips WHERE status = 'rejected' AND full_video = 0").all<{ id: string; bytes: number; at: string }>();
  const { results: posted } = await env.DB.prepare(
    `SELECT c.id, COALESCE(c.file_bytes,0) AS bytes, (SELECT MAX(p.posted_at) FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted') AS at
     FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('planned','in_buffer'))
       AND EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted' AND p.posted_at < ?)`,
  )
    .bind(weekAgo)
    .all<{ id: string; bytes: number; at: string }>();
  const candidates: BudgetCandidate[] = [
    ...raws.map((x) => ({ kind: "raw" as const, ...x })),
    ...rejected.map((x) => ({ kind: "rejected_clip" as const, ...x })),
    ...posted.filter((x) => !kit.has(x.id)).map((x) => ({ kind: "posted_clip" as const, ...x })),
  ];
  const plan = budgetPlan(used, candidates);
  const at = nowIso();
  for (const c of plan.clear) {
    if (c.kind === "raw") {
      const a = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(c.id).first<{ r2_key: string }>();
      if (a) await env.FILES.delete(a.r2_key);
      await env.DB.prepare("UPDATE assets SET raw_deleted_at = ? WHERE id = ?").bind(at, c.id).run();
    } else {
      const cl = await env.DB.prepare("SELECT r2_key, cover_r2_key FROM clips WHERE id = ?").bind(c.id).first<{ r2_key: string; cover_r2_key: string | null }>();
      if (c.kind === "rejected_clip") {
        if (cl) await env.FILES.delete([cl.r2_key, ...(cl.cover_r2_key ? [cl.cover_r2_key] : [])]);
        await env.DB.prepare("UPDATE clips SET status = 'deleted', media_token = NULL, file_bytes = 0 WHERE id = ?").bind(c.id).run();
      } else {
        if (cl) await env.FILES.delete(cl.r2_key);
        await env.DB.prepare("UPDATE clips SET file_deleted_at = ?, media_token = NULL, file_bytes = 0 WHERE id = ?").bind(at, c.id).run();
        await clearMixes(env, c.id);
      }
    }
  }
  if (plan.clear.length) await recordEvent(env.DB, "storage.budget", null, { cleared: plan.clear.length, mb: Math.round((used - plan.after) / 1024 ** 2), enough: plan.enough });
  log.info("storage.budget", { over_mb: Math.round((used - STORAGE.budgetBytes) / 1024 ** 2), cleared: plan.clear.length, enough: plan.enough });
  return { cleared: plan.clear.length, enough: plan.enough, used: plan.after };
}

/** The Storage light from the full report: yellow at 70%, red at 90% (the budget could not get under it). */
export async function storageHealth(env: Env): Promise<StorageReport> {
  const r = await storageReport(env);
  const note = r.light === "green" ? r.line : r.light === "yellow" ? `${r.line}. Filling up: see what takes the space in Settings` : `${r.line}. Almost full: new videos may not upload`;
  await setHealth(env.DB, "Storage", r.light, note, r.light === "green" ? null : "storage-almost-full");
  return r;
}

// ---------------------------------------------------------------- tidy (archive, never delete)

export async function tidyDaily(env: Env, now = new Date()): Promise<{ dumps: number; deals: number; briefs: number; voice: number; forgotten: number } | null> {
  if (!(await tidyOn(env))) {
    log.info("tidy.off");
    return null;
  }
  const at = nowIso();
  let dumps = 0;
  const { results: ds } = await env.DB.prepare(
    "SELECT d.id, d.status, d.created_at, d.ready_at, (SELECT COUNT(*) FROM clips c WHERE c.dump_id = d.id AND c.status = 'draft' AND c.hidden = 0) AS visible_drafts FROM dumps d WHERE d.archived_at IS NULL AND d.status IN ('reviewed','failed','ready','uploading') LIMIT 2000",
  ).all<{ id: string; status: string; created_at: string; ready_at: string | null; visible_drafts: number }>();
  for (const d of ds) {
    if (!dumpArchiveDue(d, now)) continue;
    await env.DB.prepare("UPDATE dumps SET archived_at = ?, archived_by = 'tidy' WHERE id = ? AND archived_at IS NULL").bind(at, d.id).run();
    dumps++;
  }
  let deals = 0;
  const { results: dl } = await env.DB.prepare("SELECT id, stage, closed_at, paid_at, updated_at FROM deals WHERE archived_at IS NULL LIMIT 2000").all<{ id: string; stage: string; closed_at: string | null; paid_at: string | null; updated_at: string }>();
  for (const d of dl) {
    if (!dealArchiveDue(d, now)) continue;
    await env.DB.prepare("UPDATE deals SET archived_at = ?, archived_by = 'tidy' WHERE id = ? AND archived_at IS NULL").bind(at, d.id).run();
    deals++;
  }
  let briefs = 0;
  const { results: bs } = await env.DB.prepare("SELECT version, status, created_at FROM research_briefs WHERE archived_at IS NULL AND status = 'superseded'").all<{ version: number; status: string; created_at: string }>();
  for (const b of bs) {
    if (!briefArchiveDue(b, now)) continue;
    await env.DB.prepare("UPDATE research_briefs SET archived_at = ?, archived_by = 'tidy' WHERE version = ?").bind(at, b.version).run();
    briefs++;
  }
  let voice = 0;
  const { results: ns } = await env.DB.prepare("SELECT id, status, clip_id, created_at FROM narrations WHERE archived_at IS NULL AND status IN ('failed','ready') LIMIT 2000").all<{ id: string; status: string; clip_id: string | null; created_at: string }>();
  for (const n of ns) {
    if (!voiceArchiveDue(n, now)) continue;
    await env.DB.prepare("UPDATE narrations SET archived_at = ?, archived_by = 'tidy' WHERE id = ?").bind(at, n.id).run();
    voice++;
  }
  const cutoff = new Date(now.getTime() - TIDY.dismissalForgetDays * 86400_000).toISOString();
  const f = await env.DB.prepare("DELETE FROM dismissals WHERE dismissed_at < ?").bind(cutoff).run();
  const forgotten = Number(f.meta?.changes ?? 0);
  log.info("tidy.done", { dumps, deals, briefs, voice, forgotten });
  return { dumps, deals, briefs, voice, forgotten };
}
