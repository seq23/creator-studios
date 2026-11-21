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
//   enforceBudget  over 90% of the ceiling: the same kinds of file, earlier, least harm first
//   uploadRefusal  an upload that would not fit (or a studio with nowhere to put it): the calm words
//   tidyDaily      archive what is finished (never deletes)
//
// The ceiling (owner, 21 Nov 2026): a studio on the host's storage has its registry share of it
// (HOST_STORAGE in worker/domain/tidy.ts: at most 1.5 GB, all studios under 4 GB); a studio with its
// own storage (Settings → Storage) has its own free 10 GB; a studio with neither (Hadiyah) has none
// and every upload points her to Use your own storage.
import type { Env } from "../env";
import { getSetting, parseJson, recordEvent, setHealth, setSetting } from "./db";
import { nowIso } from "./ids";
import { log } from "./log";
import { gbWords } from "@shared/bytes";
import { RAW_RETENTION_DAYS, RAW_WARN_DAYS } from "@shared/constants";
import { budgetPlan, briefArchiveDue, clipFileAction, dealArchiveDue, dumpArchiveDue, filesPlace, HOST_STORAGE, STORAGE, storageLight, storageLimitBytes, TIDY, voiceArchiveDue, type BudgetCandidate, type FilesPlace } from "../domain/tidy";
import { layersOf, mayClear, OWN_STORAGE_NEEDED_WORDS } from "../services/s3files";

export interface StorageKind {
  key: "clips_posted" | "clips_waiting" | "clips_drafts" | "clips_rejected" | "full_videos" | "raw" | "voice" | "music" | "docs" | "other";
  label: string;
  bytes: number;
  count: number;
  rule: string;
}

export interface StorageReport {
  /** where new files go: her own storage, the studio host's shared storage, or nowhere yet */
  place: FilesPlace;
  /** her own storage, when added: the bucket and the address's host (never a key) */
  own: { bucket: string; host: string; since: string | null } | null;
  /** with her own storage: what is still on the host's shared storage (clears by the shared rules) */
  host_left_bytes: number;
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
  /** per place: what her own bucket and the host's hold */
  own_bytes?: number;
  host_bytes?: number;
  old_bytes?: number;
  measured_at: string;
}

/** Her own storage as the meter shows it: bucket, address host, since when. Null when none is saved. */
export async function ownStorageView(env: Env): Promise<{ bucket: string; host: string; since: string | null } | null> {
  const row = await env.DB.prepare("SELECT meta, updated_at FROM connections WHERE service = 'storage' AND secret_enc IS NOT NULL AND status != 'disconnected'").first<{ meta: string; updated_at: string }>().catch(() => null);
  if (!row) return null;
  const m = parseJson<{ bucket?: string; host?: string; saved_at?: string }>(row.meta, {});
  return { bucket: m.bucket ?? "", host: m.host ?? "", since: m.saved_at ?? row.updated_at ?? null };
}

/** Each kind of original's rule, in her words, for where it lives. Pure. */
export function rawRuleWords(place: FilesPlace): string {
  if (place === "own") return `In your own storage: cleared ${RAW_RETENTION_DAYS} days after they are cut into clips, with an email ${RAW_WARN_DAYS.join(" and ")} days before (Download all, or Keep them). A dump you keep is never cleared.`;
  return `On the studio's shared storage: cleared ${HOST_STORAGE.rawAfterClipsDays} days after their clips are made, or ${HOST_STORAGE.rawAfterUploadDays} days after upload, whichever comes first, with an email ${HOST_STORAGE.warnDays} days before when studio email is set up. To keep originals longer, use your own storage.`;
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
  const place = filesPlace(env);
  const limit = storageLimitBytes(place, env);
  const l = await ledger(env);
  const m = await getSetting<Measured | null>(env.DB, "storage_report", null);
  const other = m?.other_bytes ?? 0;
  const used = ledgerTotal(l) + other;
  const light = limit > 0 ? storageLight(used, limit) : "yellow";
  const kinds: StorageKind[] = [
    { key: "clips_posted", label: "Posted clips", bytes: l.posted.b, count: l.posted.n, rule: "Cleared 30 days after posting (the cover, numbers and post link stay). Clips in your media kit are kept." },
    { key: "clips_drafts", label: "Clips waiting for review", bytes: l.drafts.b, count: l.drafts.n, rule: "Cleared 60 days after they were made, with a warning on Home a week before. Tap Keep to keep them." },
    { key: "clips_waiting", label: "Approved, not posted yet", bytes: l.waiting.b, count: l.waiting.n, rule: "Always kept." },
    { key: "clips_rejected", label: "Rejected clips", bytes: l.rejected.b, count: l.rejected.n, rule: "Kept in the Rejected bin until you delete them. Cleared early only if storage is still over the limit." },
    { key: "raw", label: "Your original videos", bytes: l.raw.b, count: l.raw.n, rule: rawRuleWords(place) },
    { key: "full_videos", label: "Full videos for YouTube", bytes: l.full.b, count: l.full.n, rule: "Cleared 7 days after posting, or 14 days if never approved (warned on Home first)." },
    { key: "voice", label: "Voice overs", bytes: l.voice.b, count: l.voice.n, rule: "Kept with their clip." },
    { key: "music", label: "My music", bytes: l.music.b, count: l.music.n, rule: "Kept until you remove a song." },
    { key: "docs", label: "Brand docs", bytes: l.docs.b, count: l.docs.n, rule: "Kept until you remove them." },
    { key: "other", label: "Other files", bytes: other, count: 0, rule: "Pictures, your voice sample and edits you uploaded." },
  ];
  const free = Math.max(0, limit - used);
  const line =
    place === "none"
      ? "No storage yet: add your own to upload"
      : place === "own"
        ? `${gbWords(used)} of your free 10 GB used · ${gbWords(free)} free`
        : `${gbWords(used)} of ${gbWords(limit)} shared storage used · ${gbWords(free)} free`;
  return {
    place,
    own: place === "own" ? await ownStorageView(env) : null,
    host_left_bytes: place === "own" ? (m?.host_bytes ?? 0) : 0,
    used_bytes: used,
    limit_bytes: limit,
    budget_bytes: Math.floor(limit * STORAGE.redAt),
    free_bytes: free,
    light,
    line,
    kinds: kinds.sort((a, b) => b.bytes - a.bytes),
    measured_at: m?.measured_at ?? null,
    tidy_on: await tidyOn(env),
  };
}

/**
 * List the bucket (the truth), fill the file sizes rows don't have yet, and keep what no row owns
 * as "other". At 1,000 objects a page, 10 GB of clips is a handful of list calls.
 */
export async function measureStorage(env: Env, now = new Date()): Promise<{ listed: number; filled: number; gone: number }> {
  const sizes = new Map<string, number>();
  let listed = 0;
  const byPlace = { own: 0, host: 0, old: 0 };
  // Every place her files live is listed on its own; in her bucket (and ones she used before) only
  // the studio's own folders (OWN_PREFIXES), never anything else she keeps there.
  let complete = env.FILES_UNSURE !== "1";
  for (const layer of layersOf(env.FILES)) {
    for (const prefix of layer.prefixes ?? [undefined]) {
      let cursor: string | undefined;
      let done = false;
      try {
        for (let i = 0; i < 200; i++) {
          const page = await layer.files.list({ cursor, limit: 1000, ...(prefix ? { prefix } : {}) });
          for (const o of page.objects) {
            if (!sizes.has(o.key)) listed += o.size;
            sizes.set(o.key, o.size);
            byPlace[layer.place] += o.size;
          }
          if (!page.truncated) {
            done = true;
            break;
          }
          cursor = page.cursor;
        }
      } catch (e) {
        log.warn("storage.list_failed", { place: layer.place, name: (e as Error).name });
      }
      complete &&= done;
    }
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
  // The bucket is the truth: an original that is in no place any more (cleared by hand, or a bucket
  // emptied) stops counting, so the meter and the clean-up emails never speak of files that are gone.
  // Only after every place listed in full (a list that failed, or settings we could not read, is
  // "unknown", never "gone"), and never an upload from the last day.
  let gone = 0;
  if (complete) {
    const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
    const { results: raws } = await env.DB.prepare("SELECT id, r2_key FROM assets WHERE upload_status = 'uploaded' AND raw_deleted_at IS NULL AND created_at < ? LIMIT 5000").bind(dayAgo).all<{ id: string; r2_key: string }>();
    const missing = raws.filter((a) => !sizes.has(a.r2_key));
    const at = nowIso();
    for (let i = 0; i < missing.length; i += 50) await env.DB.batch(missing.slice(i, i + 50).map((a) => env.DB.prepare("UPDATE assets SET raw_deleted_at = ? WHERE id = ? AND raw_deleted_at IS NULL").bind(at, a.id)));
    gone = missing.length;
    if (gone) await recordEvent(env.DB, "storage.originals_gone", null, { files: gone });
  }
  const other = Math.max(0, listed - ledgerTotal(await ledger(env)));
  await setSetting(env.DB, "storage_report", { listed_bytes: listed, other_bytes: other, own_bytes: byPlace.own, host_bytes: byPlace.host, old_bytes: byPlace.old, measured_at: nowIso() } satisfies Measured);
  log.info("storage.measured", { listed_mb: Math.round(listed / 1024 ** 2), own_mb: Math.round(byPlace.own / 1024 ** 2), host_mb: Math.round(byPlace.host / 1024 ** 2), filled, gone, complete });
  return { listed, filled, gone };
}

/**
 * A file just written (an upload that is not an original, a job's output such as a clip) counts at
 * once: added to "other" until the daily measure sets the exact figure from the bucket.
 */
export async function countNewFile(env: Env, bytes: number): Promise<void> {
  if (!(bytes > 0)) return;
  const m = await getSetting<Measured | null>(env.DB, "storage_report", null);
  await setSetting(env.DB, "storage_report", { listed_bytes: (m?.listed_bytes ?? 0) + bytes, other_bytes: (m?.other_bytes ?? 0) + bytes, own_bytes: m?.own_bytes, host_bytes: m?.host_bytes, old_bytes: m?.old_bytes, measured_at: m?.measured_at ?? nowIso() } satisfies Measured);
}

/** A job may not start writing on the host's shared storage once the studio's share is full. Null = fine. */
export async function jobOutputRefusal(env: Env): Promise<string | null> {
  if (filesPlace(env) !== "host") return null;
  const r = await storageReport(env);
  return r.used_bytes >= r.limit_bytes ? `SHARE_FULL: ${gbWords(r.used_bytes)} of ${gbWords(r.limit_bytes)} shared storage is used` : null;
}

/**
 * Before an upload starts (worker/routes/uploads.ts): null when it fits, else the calm words.
 * Nowhere to put it (no own storage, no host share), or past the host share counting the uploads
 * still in flight, points her to Use your own storage. Her own storage is never refused here: her
 * bucket's own limits apply.
 */
export async function uploadRefusal(env: Env, bytes: number): Promise<{ status: 409; error: string; fix_guide: string } | null> {
  const place = filesPlace(env);
  if (place === "own") return null;
  if (place === "none") return { status: 409, error: OWN_STORAGE_NEEDED_WORDS, fix_guide: "own-storage" };
  const r = await storageReport(env);
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const inFlight = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE upload_status = 'uploading' AND created_at > ?1)
          + (SELECT COALESCE(SUM(size_bytes),0) FROM pack_photos WHERE upload_status = 'uploading' AND created_at > ?1)
          + (SELECT COALESCE(SUM(size_bytes),0) FROM past_videos WHERE upload_status = 'uploading' AND created_at > ?1) AS n`,
  )
    .bind(dayAgo)
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));
  const after = r.used_bytes + Number(inFlight?.n ?? 0) + bytes;
  if (after <= r.limit_bytes) return null;
  const left = Math.max(0, r.limit_bytes - r.used_bytes - Number(inFlight?.n ?? 0));
  return {
    status: 409,
    error: `This file (${gbWords(bytes)}) would not fit: your studio's shared storage is ${gbWords(r.limit_bytes)} and ${gbWords(left)} is free. Originals clear ${HOST_STORAGE.rawAfterClipsDays} days after their clips are made. To upload more now, add your own storage in Settings → Storage (Cloudflare R2 is free up to 10 GB).`,
    fix_guide: "own-storage",
  };
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
  const r = await storageReport(env);
  const used = r.used_bytes;
  // Nowhere of her own and no host share: nothing here to hold under a ceiling (and nothing to delete).
  if (r.place === "none" || used <= r.budget_bytes) return { cleared: 0, enough: true, used };
  const kit = await kitClipIds(env);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const { results: raws } = await env.DB.prepare(
    r.place === "own"
      ? // Her own storage: only originals she was already warned about (the 3-day email went: worker/lib/retention.ts), never a kept dump.
        "SELECT a.id, a.size_bytes AS bytes, COALESCE(d.ready_at, d.created_at) AS at FROM assets a JOIN dumps d ON d.id = a.dump_id WHERE a.raw_deleted_at IS NULL AND a.upload_status = 'uploaded' AND d.status IN ('ready','reviewed') AND d.kind = 'clips' AND d.originals_kept = 0 AND EXISTS (SELECT 1 FROM file_notices n WHERE n.dump_id = d.id AND n.stage = '3')"
      : // The host's shared storage: any original already cut into clips (the shared rule clears them within
        // days anyway), except a dump she kept before, until its heads-up email has stood its full days.
        `SELECT a.id, a.r2_key AS key, a.size_bytes AS bytes, COALESCE(d.ready_at, d.created_at) AS at FROM assets a JOIN dumps d ON d.id = a.dump_id WHERE a.raw_deleted_at IS NULL AND a.upload_status = 'uploaded' AND d.status IN ('ready','reviewed') AND d.kind = 'clips' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.ref_id = d.id AND j.status IN ('queued','dispatched','running'))
           AND (d.originals_kept = 0 OR EXISTS (SELECT 1 FROM file_notices n WHERE n.dump_id = d.id AND n.stage = '3' AND n.sent_at <= '${new Date(now.getTime() - HOST_STORAGE.warnDays * 86400_000).toISOString()}'))`,
  ).all<{ id: string; key?: string; bytes: number; at: string }>();
  const { results: rejected } = await env.DB.prepare("SELECT id, COALESCE(file_bytes,0) AS bytes, COALESCE(reviewed_at, created_at) AS at FROM clips WHERE status = 'rejected' AND full_video = 0").all<{ id: string; bytes: number; at: string }>();
  const { results: posted } = await env.DB.prepare(
    `SELECT c.id, COALESCE(c.file_bytes,0) AS bytes, (SELECT MAX(p.posted_at) FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted') AS at
     FROM clips c WHERE c.full_video = 0 AND c.status = 'approved' AND c.file_deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('planned','in_buffer'))
       AND EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted' AND p.posted_at < ?)`,
  )
    .bind(weekAgo)
    .all<{ id: string; bytes: number; at: string }>();
  const clearable: typeof raws = [];
  for (const x of raws) if (!x.key || (await mayClear(env.FILES, x.key))) clearable.push(x);
  const candidates: BudgetCandidate[] = [
    ...clearable.map(({ key: _key, ...x }) => ({ kind: "raw" as const, ...x })),
    ...rejected.map((x) => ({ kind: "rejected_clip" as const, ...x })),
    ...posted.filter((x) => !kit.has(x.id)).map((x) => ({ kind: "posted_clip" as const, ...x })),
  ];
  const plan = budgetPlan(used, candidates, r.budget_bytes);
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
  log.info("storage.budget", { place: r.place, over_mb: Math.round((used - r.budget_bytes) / 1024 ** 2), cleared: plan.clear.length, enough: plan.enough });
  return { cleared: plan.clear.length, enough: plan.enough, used: plan.after };
}

/** The Storage light from the full report: yellow at 70%, red at 90% (the budget could not get under it). */
export async function storageHealth(env: Env): Promise<StorageReport> {
  const r = await storageReport(env);
  if (r.place === "none") {
    await setHealth(env.DB, "Storage", "yellow", "No storage yet. Add your own in Settings → Storage to upload videos and photos", "own-storage");
    return r;
  }
  if (env.FILES_UNSURE === "1") {
    await setHealth(env.DB, "Storage", "yellow", `${r.line}. Your storage settings could not be read, so nothing in your storage is counted as gone. Save them again in Settings → Storage`, "own-storage");
    return r;
  }
  const held = await getSetting<{ kept_waiting?: number }>(env.DB, "retention_held", {});
  if (r.light === "green" && (held.kept_waiting ?? 0) > 0) {
    const n = held.kept_waiting!;
    await setHealth(env.DB, "Storage", "yellow", `${r.line}. ${n} ${n === 1 ? "upload you kept stays" : "uploads you kept stay"} on the shared storage until studio email is set up, so you get the heads-up before they clear`, "setup-email");
    return r;
  }
  const note = r.light === "green" ? r.line : r.light === "yellow" ? `${r.line}. Filling up: see what takes the space in Settings` : `${r.line}. Almost full: new videos may not upload${r.place === "host" ? ". Add your own storage in Settings → Storage" : ""}`;
  await setHealth(env.DB, "Storage", r.light, note, r.light === "green" ? null : r.place === "host" ? "own-storage" : "storage-almost-full");
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
