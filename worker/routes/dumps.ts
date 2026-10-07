// Dump: two doors, notes, the Dump button (section 7). A dump is created before the files
// upload, files attach to it, and Dump flips it to queued and starts the cut job.
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { recordEvent, parseJson } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { pollEditorJobs, startDumpCut } from "../lib/editorJobs";
import { editorDef } from "../domain/editors";
import { cleanControls } from "../domain/steer";
import { confirmUnderstood, readUnderstood, tracksOf, understand } from "../lib/steerStore";
import type { NotFollowed } from "@shared/steer";
import type { AssetRow, DumpList, DumpSummary } from "@shared/types";

/** Dumps per page on the Dump screen. */
export const DUMP_PAGE = 20;
import { dispatchJob } from "../services/github";
import { pendingRefusal, spaceLine } from "../domain/fullVideo";
import { PLAN_AHEAD_WEEKS } from "./posts";
import { storageUsed } from "../lib/storage";

export const dumps = new Hono<{ Bindings: Env; Variables: Vars }>();
dumps.use("*", requireUser);

interface DumpDb {
  id: string;
  door: "new" | "recycle";
  kind: string;
  notes: string;
  status: DumpSummary["status"];
  error_summary: string | null;
  clips_made: number;
  created_at: string;
  ready_at: string | null;
  files: number;
  progress: string | null;
  held_note: string | null;
  editor: string | null;
  editor_status: string | null;
  steer: string | null;
  steer_notes: string | null;
  not_followed: string | null;
  tried: string | null;
  archived_at: string | null;
}

const SELECT = `SELECT d.id, d.door, d.kind, d.notes, d.status, d.error_summary, d.clips_made, d.created_at, d.ready_at, d.steer, d.steer_notes, d.not_followed, d.tried, d.archived_at,
  (SELECT COUNT(*) FROM assets a WHERE a.dump_id = d.id AND a.upload_status != 'aborted') AS files,
  (SELECT j.progress FROM jobs j WHERE j.ref_id = d.id AND j.type = 'cut' ORDER BY j.created_at DESC LIMIT 1) AS progress,
  (SELECT a.source_note FROM assets a WHERE a.dump_id = d.id AND a.source_owner = 'other' LIMIT 1) AS held_note,
  (SELECT e.editor FROM editor_jobs e WHERE e.dump_id = d.id AND e.capability = 'cut_from_source' AND e.status IN ('submitted', 'importing') LIMIT 1) AS editor,
  (SELECT e.status FROM editor_jobs e WHERE e.dump_id = d.id AND e.capability = 'cut_from_source' AND e.status IN ('submitted', 'importing') LIMIT 1) AS editor_status
  FROM dumps d`;

function view(r: DumpDb): DumpSummary {
  const { editor, editor_status, steer, steer_notes, not_followed, kind, ...rest } = r;
  // A connected editor is cutting it (Who edits > Cutting): say who, in her words.
  const name = editorDef(editor)?.name;
  const progress = name && r.status === "cutting" ? { step: editor_status === "importing" ? `Bringing your clips back from ${name}` : `${name} is cutting your videos`, done: 0, total: 1 } : parseJson(r.progress, null);
  return { ...rest, door: kind === "full_video" ? "youtube" : r.door, progress, steer: parseJson(steer, {}), understood: readUnderstood(steer_notes), not_followed: parseJson<NotFollowed[]>(not_followed, []) };
}

/** While Dump is open it asks the connected editors how they are doing (throttled per job). */
async function pollWhileOpen(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  try {
    c.executionCtx.waitUntil(pollEditorJobs(c.env).catch(() => undefined));
  } catch {
    // no execution context (unit tests): the hourly lane polls
  }
}

/**
 * Her dumps, newest first, a page at a time (day 358: a year is 50+ dumps). `archived=1` shows the
 * archived ones instead; `q` searches the notes and file names; `status` filters. `total` is the
 * true count for what she asked, so "20 of 52" never lies.
 */
dumps.get("/", async (c) => {
  await pollWhileOpen(c);
  const archived = c.req.query("archived") === "1";
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const status = c.req.query("status") ?? "";
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? DUMP_PAGE) || DUMP_PAGE));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const where = [archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL"];
  const binds: unknown[] = [];
  if (q) {
    where.push("(d.notes LIKE ? OR EXISTS (SELECT 1 FROM assets a WHERE a.dump_id = d.id AND a.file_name LIKE ?))");
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (status === "held") where.push("EXISTS (SELECT 1 FROM assets a WHERE a.dump_id = d.id AND a.source_owner = 'other')");
  else if (["uploading", "queued", "cutting", "ready", "reviewed", "failed"].includes(status)) {
    where.push("d.status = ?");
    binds.push(status);
  }
  const w = where.join(" AND ");
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE ${w} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<DumpDb>();
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM dumps d WHERE ${w}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const archivedCount = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NOT NULL").first<{ n: number }>())?.n ?? 0;
  const out: DumpList = { items: results.map(view), total, archived: archivedCount, limit, offset };
  return c.json(out);
});

/** Which door, as stored: "youtube" is door 'new' with kind 'full_video' (the full-video door). */
function doorColumns(door: unknown): { door: "new" | "recycle"; kind: "clips" | "full_video" } | null {
  if (door === "new" || door === "recycle") return { door, kind: "clips" };
  if (door === "youtube") return { door: "new", kind: "full_video" };
  return null;
}

dumps.post("/", async (c) => {
  const body = await readJson<{ door: string; notes?: string }>(c);
  const cols = doorColumns(body?.door);
  if (!cols) return fail(c, 400, "Pick which videos these are: new videos, old posts, or a full video for YouTube.");
  const id = newId("dmp");
  await c.env.DB.prepare("INSERT INTO dumps (id, door, kind, notes, status) VALUES (?, ?, ?, ?, 'uploading')").bind(id, cols.door, cols.kind, (body!.notes ?? "").slice(0, 4000)).run();
  return c.json({ id });
});

/** Before Dump on the full-video door: this video's size and the free space left of 10 GB. */
dumps.get("/:id/space", async (c) => {
  const up = await c.env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM assets WHERE dump_id = ? AND upload_status = 'uploaded'").bind(c.req.param("id")).first<{ n: number }>();
  // The upload is already in storage: what is left after it is kept is what counts.
  const used = await storageUsed(c.env);
  const s = spaceLine(up?.n ?? 0, Math.max(0, used - (up?.n ?? 0)));
  return c.json({ upload_bytes: up?.n ?? 0, used_bytes: used, ...s });
});

dumps.get("/:id", async (c) => {
  const row = await c.env.DB.prepare(`${SELECT} WHERE d.id = ?`).bind(c.req.param("id")).first<DumpDb>();
  if (!row) return fail(c, 404, "That dump no longer exists.");
  const { results: assets } = await c.env.DB.prepare(
    "SELECT id, dump_id, file_name, mime_type, size_bytes, upload_status, file_note, steer_notes, original_platform, original_posted_at, original_views FROM assets WHERE dump_id = ? ORDER BY created_at",
  )
    .bind(row.id)
    .all<Omit<AssetRow, "understood"> & { steer_notes: string | null }>();
  return c.json({ dump: view(row), assets: assets.map(({ steer_notes, ...a }) => ({ ...a, understood: readUnderstood(steer_notes) })) });
});

/** "This is my video": she confirms a held video is her own; its clips may go on the calendar. */
dumps.post("/:id/mine", async (c) => {
  const r = await c.env.DB.prepare("UPDATE assets SET source_owner = 'confirmed' WHERE dump_id = ? AND source_owner = 'other'").bind(c.req.param("id")).run();
  if (!r.meta.changes) return fail(c, 404, "Nothing on this dump is waiting for that.");
  await recordEvent(c.env.DB, "dump.source_confirmed", c.req.param("id"), { videos: r.meta.changes }, c.get("user").email);
  return c.json({ ok: true, videos: r.meta.changes });
});

/**
 * Here's what we understood: a note (the dump's or a video's) read into controls, before she
 * presses Dump. Rules always; the free AI too when it is connected. Nothing is stored here.
 */
dumps.post("/understand", async (c) => {
  const body = await readJson<{ text?: string }>(c);
  return c.json(await understand(c.env, String(body?.text ?? "").slice(0, 4000)));
});

/** Notes, the chips she tapped (steer; {} = Surprise me) and the reading of the note she saw. */
dumps.patch("/:id", async (c) => {
  const body = await readJson<{ notes?: string; steer?: unknown; understood?: unknown; door?: string }>(c);
  const id = c.req.param("id");
  // She can change which videos these are (new or old posts) until she presses Dump.
  const cols = doorColumns(body?.door);
  if (cols) await c.env.DB.prepare("UPDATE dumps SET door = ?, kind = ? WHERE id = ? AND status = 'uploading'").bind(cols.door, cols.kind, id).run();
  if (body?.notes !== undefined) {
    const notes = String(body.notes).slice(0, 4000);
    await c.env.DB.prepare("UPDATE dumps SET notes = ? WHERE id = ? AND status = 'uploading'").bind(notes, id).run();
    if (body.understood !== undefined) {
      const u = notes.trim() ? await confirmUnderstood(c.env, notes, body.understood) : null;
      await c.env.DB.prepare("UPDATE dumps SET steer_notes = ? WHERE id = ? AND status = 'uploading'").bind(u ? JSON.stringify(u) : null, id).run();
    }
  }
  if (body?.steer !== undefined) {
    const { controls } = cleanControls(body.steer, await tracksOf(c.env));
    await c.env.DB.prepare("UPDATE dumps SET steer = ? WHERE id = ? AND status = 'uploading'").bind(JSON.stringify(controls), id).run();
  }
  return c.json({ ok: true });
});

/** Per-file details (note, and for recycle: where/when it was posted and rough views). */
dumps.patch("/:id/assets/:assetId", async (c) => {
  const body = await readJson<{ fileNote?: string; originalPlatform?: string; originalPostedAt?: string; originalViews?: number; understood?: unknown }>(c);
  // A video's own note steers that video's clips: read it now so the screen can say what we understood.
  let understood = null;
  if (body?.fileNote !== undefined) {
    understood = body.fileNote.trim() ? await confirmUnderstood(c.env, body.fileNote, body.understood) : null;
    await c.env.DB.prepare("UPDATE assets SET steer_notes = ? WHERE id = ? AND dump_id = ?").bind(understood ? JSON.stringify(understood) : null, c.req.param("assetId"), c.req.param("id")).run();
  }
  await c.env.DB.prepare(
    "UPDATE assets SET file_note = COALESCE(?, file_note), original_platform = COALESCE(?, original_platform), original_posted_at = COALESCE(?, original_posted_at), original_views = COALESCE(?, original_views) WHERE id = ? AND dump_id = ?",
  )
    .bind(body?.fileNote ?? null, body?.originalPlatform ?? null, body?.originalPostedAt ?? null, body?.originalViews ?? null, c.req.param("assetId"), c.req.param("id"))
    .run();
  return c.json({ ok: true, understood });
});

dumps.delete("/:id/assets/:assetId", async (c) => {
  const asset = await c.env.DB.prepare("SELECT r2_key, upload_id FROM assets WHERE id = ? AND dump_id = ?").bind(c.req.param("assetId"), c.req.param("id")).first<{ r2_key: string; upload_id: string | null }>();
  if (!asset) return fail(c, 404, "That file is not in this dump.");
  if (asset.upload_id) {
    try {
      await c.env.FILES.resumeMultipartUpload(asset.r2_key, asset.upload_id).abort();
    } catch {
      /* already gone */
    }
  } else {
    await c.env.FILES.delete(asset.r2_key);
  }
  await c.env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(c.req.param("assetId")).run();
  return c.json({ ok: true });
});

/** The Dump button. Requires at least one uploaded file; queues the cut job. */
dumps.post("/:id/dump", async (c) => {
  const id = c.req.param("id");
  const dump = await c.env.DB.prepare("SELECT id, status, door, kind FROM dumps WHERE id = ?").bind(id).first<{ id: string; status: string; door: string; kind: string }>();
  if (!dump) return fail(c, 404, "That dump no longer exists.");
  if (dump.status !== "uploading") return fail(c, 409, "This dump was already sent.");
  const counts = await c.env.DB.prepare(
    "SELECT SUM(CASE WHEN upload_status = 'uploaded' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN upload_status = 'uploading' THEN 1 ELSE 0 END) AS pending FROM assets WHERE dump_id = ?",
  )
    .bind(id)
    .first<{ done: number; pending: number }>();
  if (!counts?.done) return fail(c, 422, "Add at least one video first.");
  if (counts.pending) return fail(c, 409, "Some videos are still uploading. Keep the page open until they finish.");

  const gate = await briefGate(c.env);
  if (gate) return fail(c, 409, gate.message, gate.fix_guide);

  // The full-video door: one video, whole, through its own job; never the cutter (validator
  // full-video-uncut). Storage: at most one waiting full video per Calendar week, and it must fit.
  if (dump.kind === "full_video") return dumpFullVideo(c, id, counts.done);

  // A note never confirmed on screen (an old tab, the API) is still read: nothing she wrote is ignored.
  const noted = await c.env.DB.prepare("SELECT notes, steer_notes FROM dumps WHERE id = ?").bind(id).first<{ notes: string; steer_notes: string | null }>();
  if (noted?.notes.trim() && !noted.steer_notes) await c.env.DB.prepare("UPDATE dumps SET steer_notes = ? WHERE id = ?").bind(JSON.stringify(await understand(c.env, noted.notes)), id).run();
  const { results: unread } = await c.env.DB.prepare("SELECT id, file_note FROM assets WHERE dump_id = ? AND file_note IS NOT NULL AND file_note != '' AND steer_notes IS NULL").bind(id).all<{ id: string; file_note: string }>();
  for (const a of unread) await c.env.DB.prepare("UPDATE assets SET steer_notes = ? WHERE id = ?").bind(JSON.stringify(await understand(c.env, a.file_note)), a.id).run();

  await c.env.DB.prepare("UPDATE dumps SET status = 'queued', dumped_at = ? WHERE id = ?").bind(nowIso(), id).run();
  // The built-in cutter, or her connected cutting editor (Settings > Editing > Who edits); a refused
  // editor falls back to the built-in cutter at once (worker/lib/editorJobs.ts).
  const r = await startDumpCut(c.env, id, c.env.PUBLIC_BASE_URL);
  if (!r.dispatched) {
    await c.env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(r.error, id).run();
    return fail(c, 502, r.error ?? "The cutting job could not start.", "clips-look-wrong");
  }
  await c.env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, "dump.sent", id, { door: dump.door, files: counts.done, editor: r.editor }, c.get("user").email);
  log.info("dump.sent", { files: counts.done, editor: r.editor });
  return c.json({ ok: true, jobId: r.jobId, editor: r.editor });
});

async function dumpFullVideo(c: Context<{ Bindings: Env; Variables: Vars }>, id: string, files: number) {
  if (files !== 1) return fail(c, 422, "A full video for YouTube is one video. Remove the others, or dump them as new videos.", "dump-new-footage");
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE full_video = 1 AND status IN ('draft', 'approved') AND file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = clips.id AND p.status = 'posted')").first<{ n: number }>();
  const refusal = pendingRefusal(pending?.n ?? 0, PLAN_AHEAD_WEEKS);
  if (refusal) return fail(c, 409, refusal, "dump-new-footage");
  const up = await c.env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM assets WHERE dump_id = ? AND upload_status = 'uploaded'").bind(id).first<{ n: number }>();
  const space = spaceLine(up?.n ?? 0, Math.max(0, (await storageUsed(c.env)) - (up?.n ?? 0)));
  if (!space.fits) return fail(c, 409, `${space.line}. Delete a few old videos first, or use a smaller export.`, "dump-new-footage");
  await c.env.DB.prepare("UPDATE dumps SET status = 'queued', dumped_at = ? WHERE id = ?").bind(nowIso(), id).run();
  const r = await dispatchJob(c.env, "fullvideo", id);
  if (!r.dispatched) {
    await c.env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(r.error, id).run();
    return fail(c, 502, r.error ?? "Getting your video ready could not start.", "dump-new-footage");
  }
  await c.env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, "dump.sent", id, { door: "youtube", files }, c.get("user").email);
  log.info("dump.sent", { files, full_video: true });
  return c.json({ ok: true, jobId: r.jobId, editor: "built-in" });
}

/**
 * Section 6 gate: no clips are cut until a Research Brief exists and is approved, and the
 * Brand Profile is locked. Returns null when the gate is open.
 */
export async function briefGate(env: Env): Promise<{ message: string; fix_guide: string } | null> {
  const profile = await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 ORDER BY version DESC LIMIT 1").first();
  if (!profile) return { message: "Lock your Brand Profile first, so the clips sound like you.", fix_guide: "upload-brand-docs" };
  const brief = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first();
  if (!brief) return { message: "Approve your Research Brief first. It tells the cutter what to look for.", fix_guide: "approve-research-brief" };
  return null;
}
