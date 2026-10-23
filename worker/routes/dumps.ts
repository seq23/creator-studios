// Dump: two doors, notes, the Dump button (section 7). A dump is created before the files
// upload, files attach to it, and Dump flips it to queued and starts the cut job.
import { cleanVoiceNotes } from "@shared/voiceShots";
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
import type { ApiError, AssetRow, DumpList, DumpSummary, SetupStep, SetupWait } from "@shared/types";
import { ensureFirstResearch, setupHeadline, setupSteps } from "../lib/setupWait";

/** Dumps per page on the Dump screen. */
export const DUMP_PAGE = 20;
import { dispatchJob } from "../services/github";
import { pendingRefusal, spaceLine } from "../domain/fullVideo";
import { PLAN_AHEAD_WEEKS } from "./posts";
import { storageUsed } from "../lib/storage";
import { notesWithStartOver, startOverPlan } from "../domain/startOver";
import { answerQuestion, cleanLooksLike, cleanOverride, questionsFor, type PlanOverride, type QuestionVideo } from "@shared/looksLike";
import { servicesOf } from "@shared/services";
import { removeVoiceOver, voiceAllInDump, voiceReady } from "../lib/autoVoice";
import { dumpFiles } from "../lib/dumpFiles";
import { stream } from "./media";
import { PROFILE_IN_USE } from "../lib/profileInUse";

/** Is this clip already loaded into Buffer? (Then it is never removed from here.) */
async function inBuffer(env: Env, clipId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM posts WHERE clip_id = ? AND status IN ('in_buffer', 'posted') LIMIT 1").bind(clipId).first());
}

export const dumps = new Hono<{ Bindings: Env; Variables: Vars }>();
dumps.use("*", requireUser);

interface DumpDb {
  id: string;
  door: "new" | "recycle";
  kind: string;
  notes: string;
  voice_notes: string | null;
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
  looks_like: string | null;
  plan_override: string | null;
  waiting_setup_at: string | null;
}

const SELECT = `SELECT d.id, d.door, d.kind, d.notes, d.voice_notes, d.status, d.error_summary, d.clips_made, d.created_at, d.ready_at, d.steer, d.steer_notes, d.not_followed, d.tried, d.archived_at, d.looks_like, d.plan_override, d.waiting_setup_at,
  (SELECT COUNT(*) FROM assets a WHERE a.dump_id = d.id AND a.upload_status != 'aborted') AS files,
  (SELECT j.progress FROM jobs j WHERE j.ref_id = d.id AND j.type = 'cut' ORDER BY j.created_at DESC LIMIT 1) AS progress,
  (SELECT a.source_note FROM assets a WHERE a.dump_id = d.id AND a.source_owner = 'other' LIMIT 1) AS held_note,
  (SELECT e.editor FROM editor_jobs e WHERE e.dump_id = d.id AND e.capability = 'cut_from_source' AND e.status IN ('submitted', 'importing') LIMIT 1) AS editor,
  (SELECT e.status FROM editor_jobs e WHERE e.dump_id = d.id AND e.capability = 'cut_from_source' AND e.status IN ('submitted', 'importing') LIMIT 1) AS editor_status
  FROM dumps d`;

function view(r: DumpDb, steps: SetupStep[] | null = null): DumpSummary {
  const { editor, editor_status, steer, steer_notes, not_followed, kind, looks_like, plan_override, waiting_setup_at, ...rest } = r;
  const waiting_for = waiting_setup_at && r.status === "uploading" && steps ? steps : null;
  // A connected editor is cutting it (Who edits > Cutting): say who, in her words.
  const name = editorDef(editor)?.name;
  const progress = name && r.status === "cutting" ? { step: editor_status === "importing" ? `Bringing your clips back from ${name}` : `${name} is cutting your videos`, done: 0, total: 1 } : parseJson(r.progress, null);
  return { ...rest, voice_notes: r.voice_notes ?? "", door: kind === "full_video" ? "youtube" : r.door, progress, steer: parseJson(steer, {}), understood: readUnderstood(steer_notes), not_followed: parseJson<NotFollowed[]>(not_followed, []), looks_like: cleanLooksLike(parseJson(looks_like, null)), plan_override: parseJson<PlanOverride>(plan_override, {}), waiting_for };
}

/** The setup steps, read once, only when a dump on screen is waiting for them. */
async function stepsFor(env: Env, rows: DumpDb[]): Promise<SetupStep[] | null> {
  return rows.some((r) => r.waiting_setup_at && r.status === "uploading") ? setupSteps(env) : null;
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
  const steps = await stepsFor(c.env, results);
  const out: DumpList = { items: results.map((r) => view(r, steps)), total, archived: archivedCount, limit, offset };
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
  return c.json({ dump: view(row, await stepsFor(c.env, [row])), assets: assets.map(({ steer_notes, ...a }) => ({ ...a, understood: readUnderstood(steer_notes) })) });
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
  const body = await readJson<{ notes?: string; steer?: unknown; understood?: unknown; door?: string; voice_notes?: string }>(c);
  const id = c.req.param("id");
  // Notes for the voice (Follow-on V): read by the voice-over script writer whenever voice overs are
  // made for this dump's clips, so they can change after Dump too (worker/lib/autoVoice.ts draftScript).
  if (body?.voice_notes !== undefined) {
    const v = cleanVoiceNotes(body.voice_notes);
    await c.env.DB.prepare("UPDATE dumps SET voice_notes = ? WHERE id = ?").bind(v || null, id).run();
  }
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
  const owner = await c.env.DB.prepare("SELECT status FROM dumps WHERE id = ?").bind(c.req.param("id")).first<{ status: string }>();
  if (owner && (owner.status === "queued" || owner.status === "cutting")) return fail(c, 409, "This dump is being cut. Remove files once its clips are ready.");
  // A file clips were already made from (a finished dump, before Start over with new files): the
  // original goes and the next cut skips it, but the row stays, so its approved, posted and
  // rejected clips are never erased with it (clips.asset_id cascades on delete).
  const used = await c.env.DB.prepare("SELECT 1 FROM clips WHERE asset_id = ? LIMIT 1").bind(c.req.param("assetId")).first();
  if (used && !asset.upload_id) {
    await c.env.FILES.delete(asset.r2_key);
    await c.env.DB.prepare("UPDATE assets SET upload_status = 'aborted', raw_deleted_at = ? WHERE id = ?").bind(nowIso(), c.req.param("assetId")).run();
    return c.json({ ok: true });
  }
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

type Sent = { ok: true; jobId: string | null; editor: string } | { ok: false; status: 404 | 409 | 422 | 502; error: string; fix_guide?: string; setup?: SetupWait };

/** The Dump button. Requires at least one uploaded file; queues the cut job. */
dumps.post("/:id/dump", async (c) => {
  const r = await sendDump(c.env, c.req.param("id"), c.get("user").email, true);
  if (!r.ok) {
    const body: ApiError = { error: r.error, ...(r.fix_guide ? { fix_guide: r.fix_guide } : {}), ...(r.setup ? { setup: r.setup } : {}) };
    return c.json(body, r.status);
  }
  return c.json({ ok: true, jobId: r.jobId, editor: r.editor });
});

/**
 * Send one dump: the Dump button and the automatic send after setup both come here. The flip from
 * 'uploading' to 'queued' is one conditional UPDATE, so a dump is sent at most once even when the
 * button and the automatic send race. `markWaiting`: a setup refusal marks the dump as waiting.
 */
export async function sendDump(env: Env, id: string, email: string | null, markWaiting: boolean): Promise<Sent> {
  const dump = await env.DB.prepare("SELECT id, status, door, kind FROM dumps WHERE id = ?").bind(id).first<{ id: string; status: string; door: string; kind: string }>();
  if (!dump) return { ok: false, status: 404, error: "That dump no longer exists." };
  if (dump.status !== "uploading") return { ok: false, status: 409, error: "This dump was already sent." };
  const counts = await env.DB.prepare(
    "SELECT SUM(CASE WHEN upload_status = 'uploaded' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN upload_status = 'uploading' THEN 1 ELSE 0 END) AS pending FROM assets WHERE dump_id = ?",
  )
    .bind(id)
    .first<{ done: number; pending: number }>();
  if (!counts?.done) return { ok: false, status: 422, error: "Add at least one video first." };
  if (counts.pending) return { ok: false, status: 409, error: "Some videos are still uploading. Keep the page open until they finish." };

  const gate = await briefGate(env);
  if (gate) {
    // Her files are saved: the dump waits for setup and goes by itself once it is done.
    if (markWaiting) await env.DB.prepare("UPDATE dumps SET waiting_setup_at = COALESCE(waiting_setup_at, ?) WHERE id = ? AND status = 'uploading'").bind(nowIso(), id).run();
    // A profile locked but no brief on the way: start it now (once a day at most).
    await ensureFirstResearch(env, email);
    const steps = await setupSteps(env);
    return { ok: false, status: 409, error: setupHeadline(counts.done, steps), fix_guide: gate.fix_guide, setup: { files: counts.done, steps } };
  }

  // The full-video door: one video, whole, through its own job; never the cutter (validator
  // full-video-uncut). Storage: at most one waiting full video per Calendar week, and it must fit.
  if (dump.kind === "full_video") return dumpFullVideo(env, id, counts.done, email);

  // A note never confirmed on screen (an old tab, the API) is still read: nothing she wrote is ignored.
  const noted = await env.DB.prepare("SELECT notes, steer_notes FROM dumps WHERE id = ?").bind(id).first<{ notes: string; steer_notes: string | null }>();
  if (noted?.notes.trim() && !noted.steer_notes) await env.DB.prepare("UPDATE dumps SET steer_notes = ? WHERE id = ?").bind(JSON.stringify(await understand(env, noted.notes)), id).run();
  const { results: unread } = await env.DB.prepare("SELECT id, file_note FROM assets WHERE dump_id = ? AND file_note IS NOT NULL AND file_note != '' AND steer_notes IS NULL").bind(id).all<{ id: string; file_note: string }>();
  for (const a of unread) await env.DB.prepare("UPDATE assets SET steer_notes = ? WHERE id = ?").bind(JSON.stringify(await understand(env, a.file_note)), a.id).run();

  if (!(await claim(env, id))) return { ok: false, status: 409, error: "This dump was already sent." };
  // The built-in cutter, or her connected cutting editor (Settings > Editing > Who edits); a refused
  // editor falls back to the built-in cutter at once (worker/lib/editorJobs.ts).
  const r = await startDumpCut(env, id, env.PUBLIC_BASE_URL);
  if (!r.dispatched) {
    await env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(r.error, id).run();
    return { ok: false, status: 502, error: r.error ?? "The cutting job could not start.", fix_guide: "clips-look-wrong" };
  }
  await env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ?").bind(id).run();
  await recordEvent(env.DB, "dump.sent", id, { door: dump.door, files: counts.done, editor: r.editor }, email ?? undefined);
  log.info("dump.sent", { files: counts.done, editor: r.editor });
  return { ok: true, jobId: r.jobId, editor: r.editor };
}

/** The one place a dump leaves 'uploading': true only for the caller whose UPDATE flipped it. */
async function claim(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE dumps SET status = 'queued', dumped_at = ?, waiting_setup_at = NULL WHERE id = ? AND status = 'uploading'").bind(nowIso(), id).run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * Setup is done (profile locked, brief approved): every dump waiting for it is sent through the
 * Dump button's own path, once each (claim). Nothing waiting = nothing sent. Never throws: the
 * lock or approval that called it already succeeded. Returns the ids that went.
 */
export async function sendWaitingDumps(env: Env, email: string | null): Promise<string[]> {
  const sent: string[] = [];
  try {
    if (await briefGate(env)) return sent;
    const { results } = await env.DB.prepare("SELECT id FROM dumps WHERE waiting_setup_at IS NOT NULL AND status = 'uploading' AND archived_at IS NULL ORDER BY created_at").all<{ id: string }>();
    for (const d of results) {
      const r = await sendDump(env, d.id, email, false);
      if (r.ok) sent.push(d.id);
      else log.warn("dump.auto_send_refused", { status: r.status });
    }
    if (sent.length) log.info("dump.auto_sent", { dumps: sent.length });
  } catch {
    log.warn("dump.auto_send_failed");
  }
  return sent;
}

async function dumpFullVideo(env: Env, id: string, files: number, email: string | null): Promise<Sent> {
  if (files !== 1) return { ok: false, status: 422, error: "A full video for YouTube is one video. Remove the others, or dump them as new videos.", fix_guide: "dump-new-footage" };
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE full_video = 1 AND status IN ('draft', 'approved') AND file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = clips.id AND p.status = 'posted')").first<{ n: number }>();
  const refusal = pendingRefusal(pending?.n ?? 0, PLAN_AHEAD_WEEKS);
  if (refusal) return { ok: false, status: 409, error: refusal, fix_guide: "dump-new-footage" };
  const up = await env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM assets WHERE dump_id = ? AND upload_status = 'uploaded'").bind(id).first<{ n: number }>();
  const space = spaceLine(up?.n ?? 0, Math.max(0, (await storageUsed(env)) - (up?.n ?? 0)));
  if (!space.fits) return { ok: false, status: 409, error: `${space.line}. Delete a few old videos first, or use a smaller export.`, fix_guide: "dump-new-footage" };
  if (!(await claim(env, id))) return { ok: false, status: 409, error: "This dump was already sent." };
  const r = await dispatchJob(env, "fullvideo", id);
  if (!r.dispatched) {
    await env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(r.error, id).run();
    return { ok: false, status: 502, error: r.error ?? "Getting your video ready could not start.", fix_guide: "dump-new-footage" };
  }
  await env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ?").bind(id).run();
  await recordEvent(env.DB, "dump.sent", id, { door: "youtube", files }, email ?? undefined);
  log.info("dump.sent", { files, full_video: true });
  return { ok: true, jobId: r.jobId, editor: "built-in" };
}

/**
 * Section 6 gate: no clips are cut until a Research Brief exists and is approved, and the
 * Brand Profile is locked. Returns null when the gate is open.
 */
export async function briefGate(env: Env): Promise<{ message: string; fix_guide: string } | null> {
  const profile = await env.DB.prepare(`SELECT version FROM brand_profile ${PROFILE_IN_USE}`).first();
  if (!profile) return { message: "Lock your Brand Profile first, so the clips sound like you.", fix_guide: "upload-brand-docs" };
  const brief = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first();
  if (!brief) return { message: "Approve your Research Brief first. It tells the cutter what to look for.", fix_guide: "approve-research-brief" };
  return null;
}

/**
 * Start over (Review): this dump's New clips go (their files and voice overs too); approved,
 * rejected and posted clips stay, and her uploaded videos are never touched. The same videos are
 * cut again with the current settings, plus the notes she adds here.
 */
dumps.post("/:id/start-over", async (c) => {
  const body = await readJson<{ notes?: string }>(c);
  return startOver(c, c.req.param("id"), String(body?.notes ?? ""), "dump.start_over");
});

/**
 * "Change" on the plain line (studio intelligence layer 7): she taps what the footage shows (a
 * service from her Brand Profile, or "Not sure") and/or the kind of video. The dump is re-planned
 * at once: its New clips go and the videos are cut again following her pick, from the shot sheets
 * already saved (no new picture reading).
 */
dumps.post("/:id/looks-like", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ service?: string; shape?: string }>(c);
  const profile = await c.env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
  const pick = cleanOverride(body ?? {}, servicesOf(profile ? parseJson<Record<string, string>>(profile.sections, {}) : null));
  if (!pick.service && !pick.shape) return fail(c, 400, "Pick what these videos show, or the kind of video.", "review-and-approve-clips");
  const now = await c.env.DB.prepare("SELECT plan_override, looks_like FROM dumps WHERE id = ?").bind(id).first<{ plan_override: string | null; looks_like: string | null }>();
  const merged = { ...parseJson<PlanOverride>(now?.plan_override ?? null, {}), ...pick };
  if (pick.service && pick.service !== "unsure") {
    // Studio Memory (layer 8): a service she corrected on "Change" counts like a one-tap answer.
    const seen = cleanLooksLike(parseJson(now?.looks_like ?? null, null));
    await recordEvent(c.env.DB, "dump.question_answered", id, { question: "service", yes: false, from_service: seen?.sure ? seen.service : null, to_service: pick.service, before_videos: 0, replan: true }, c.get("user").email);
  }
  await c.env.DB.prepare("UPDATE dumps SET plan_override = ? WHERE id = ?").bind(JSON.stringify(merged), id).run();
  return startOver(c, id, "", "dump.looks_like_changed");
});

/** The dump's videos as the one-tap questions show them: a number and what the studio saw (layer 7). */
async function questionVideos(env: Env, id: string): Promise<QuestionVideo[]> {
  const { results } = await env.DB.prepare("SELECT id, shot_sheet FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL ORDER BY created_at").bind(id).all<{ id: string; shot_sheet: string | null }>();
  return results.map((r, i) => {
    const sh = parseJson<{ shots?: { what?: string; state?: string; confidence?: number }[] }>(r.shot_sheet, {});
    const shots = Array.isArray(sh.shots) ? sh.shots : [];
    const what = shots.map((x) => (typeof x.what === "string" ? x.what.trim() : "")).find(Boolean) ?? "";
    return { id: r.id, n: i + 1, what: what.slice(0, 120) || "We couldn't tell what this one shows", before: shots.some((x) => x.state === "before") };
  });
}

async function profileServices(env: Env): Promise<string[]> {
  const profile = await env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
  return servicesOf(profile ? parseJson<Record<string, string>>(profile.sections, {}) : null);
}

/** GET /:id/questions: the one-tap questions under the plain line (layer 7), never one already answered. */
dumps.get("/:id/questions", async (c) => {
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT looks_like, plan_override, status FROM dumps WHERE id = ?").bind(id).first<{ looks_like: string | null; plan_override: string | null; status: string }>();
  if (!d) return fail(c, 404, "That dump no longer exists.");
  const services = await profileServices(c.env);
  const videos = await questionVideos(c.env, id);
  const override = cleanOverride(parseJson(d.plan_override, {}), services, videos.map((v) => v.id));
  const questions = d.status === "ready" ? questionsFor(cleanLooksLike(parseJson(d.looks_like, null)), override, videos, services) : [];
  return c.json({ questions, services, videos });
});

/**
 * POST /:id/answer {id, yes?, service?, before_assets?}: one tap. "Yes" only records it; a service
 * or before videos re-plan the dump at once from the saved shot sheets (no new picture reading).
 * Every answer is remembered (Studio Memory, layer 8: events "dump.question_answered").
 */
dumps.post("/:id/answer", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ id?: string; yes?: boolean; service?: string; before_assets?: string[] }>(c);
  if (body?.id !== "service" && body?.id !== "before") return fail(c, 400, "That question isn't one we asked.", "review-and-approve-clips");
  const d = await c.env.DB.prepare("SELECT looks_like, plan_override FROM dumps WHERE id = ?").bind(id).first<{ looks_like: string | null; plan_override: string | null }>();
  if (!d) return fail(c, 404, "That dump no longer exists.");
  const services = await profileServices(c.env);
  const videos = await questionVideos(c.env, id);
  const now = cleanOverride(parseJson(d.plan_override, {}), services, videos.map((v) => v.id));
  const asked = cleanOverride({ service: body.service, before_assets: body.before_assets }, services, videos.map((v) => v.id));
  if (body.id === "service" && body.service && !asked.service) return fail(c, 400, "Pick one of the services in your Brand Profile.", "review-and-approve-clips");
  const { override, replan } = answerQuestion(now, { id: body.id, yes: body.yes, service: asked.service, before_assets: asked.before_assets });
  await c.env.DB.prepare("UPDATE dumps SET plan_override = ? WHERE id = ?").bind(JSON.stringify(override), id).run();
  const seen = cleanLooksLike(parseJson(d.looks_like, null));
  await recordEvent(c.env.DB, "dump.question_answered", id, { question: body.id, yes: body.yes === true, from_service: seen?.sure ? seen.service : null, to_service: asked.service ?? null, before_videos: asked.before_assets?.length ?? 0, replan }, c.get("user").email);
  if (!replan) return c.json({ ok: true, replan: false });
  return startOver(c, id, "", "dump.looks_like_changed");
});

/** GET /:id/services: what "Change" offers (the locked Brand Profile's services, never code's). */
dumps.get("/:id/services", async (c) => {
  const profile = await c.env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
  return c.json({ services: servicesOf(profile ? parseJson<Record<string, string>>(profile.sections, {}) : null) });
});

export async function startOver(c: Context<{ Bindings: Env; Variables: Vars }>, id: string, notesIn: string, event: "dump.start_over" | "dump.looks_like_changed"): Promise<Response> {
  const dump = await c.env.DB.prepare("SELECT id, status, kind, notes FROM dumps WHERE id = ?").bind(id).first<{ id: string; status: string; kind: string; notes: string }>();
  const { results: rows } = await c.env.DB.prepare("SELECT id, status, r2_key, cover_r2_key FROM clips WHERE dump_id = ?").bind(id).all<{ id: string; status: string; r2_key: string; cover_r2_key: string | null }>();
  const clipsNow = [];
  for (const r of rows) clipsNow.push({ id: r.id, status: r.status, in_buffer: r.status === "draft" ? await inBuffer(c.env, r.id) : false });
  const sources = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL").bind(id).first<{ n: number }>())?.n ?? 0;
  const plan = startOverPlan(dump, clipsNow, sources);
  if (plan.refusal) return fail(c, plan.refusal.status, plan.refusal.error, "review-and-approve-clips");
  const gate = await briefGate(c.env);
  if (gate) return fail(c, 409, gate.message, gate.fix_guide);
  for (const clipId of plan.remove) {
    const r = rows.find((x) => x.id === clipId)!;
    await removeVoiceOver(c.env, clipId);
    await c.env.FILES.delete([r.r2_key, r.cover_r2_key].filter((k): k is string => !!k));
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE clips SET status = 'deleted', media_token = NULL, reviewed_at = ? WHERE id = ? AND status = 'draft'").bind(nowIso(), clipId),
      c.env.DB.prepare("UPDATE posts SET status = 'unscheduled' WHERE clip_id = ? AND status = 'planned'").bind(clipId),
    ]);
  }
  const added = notesIn.slice(0, 1000);
  if (added.trim()) {
    const notes = notesWithStartOver(dump!.notes, added);
    await c.env.DB.prepare("UPDATE dumps SET notes = ?, steer_notes = ? WHERE id = ?").bind(notes, JSON.stringify(await understand(c.env, notes)), id).run();
  }
  await c.env.DB.prepare("UPDATE dumps SET status = 'queued', error_summary = NULL, not_followed = NULL, tried = NULL WHERE id = ?").bind(id).run();
  const r = await startDumpCut(c.env, id, c.env.PUBLIC_BASE_URL);
  if (!r.dispatched) {
    await c.env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(r.error, id).run();
    return fail(c, 502, r.error ?? "The cutting job could not start.", "clips-look-wrong");
  }
  await c.env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, event, id, { removed: plan.remove.length, kept: plan.keep, notes: !!added.trim() }, c.get("user").email);
  log.info(event, { removed: plan.remove.length, kept: plan.keep });
  return c.json({ ok: true, removed: plan.remove.length, kept: plan.keep, jobId: r.jobId });
}

/** "Add voice over to all clips in this dump" (Review): one voice job run for every quiet clip still without one. */
dumps.post("/:id/voice-all", async (c) => {
  const id = c.req.param("id");
  if (!(await c.env.DB.prepare("SELECT id FROM dumps WHERE id = ?").bind(id).first())) return fail(c, 404, "That dump no longer exists.");
  if (!(await voiceReady(c.env))) return fail(c, 409, "Pick a voice first: a stock voice in Settings → Sound, or record your own on Voice overs.", "record-your-voice");
  const r = await voiceAllInDump(c.env, id);
  if (r.clips && !r.started) return fail(c, 502, "The voice overs could not start. Try again in a minute.", "reconnect-github");
  return c.json({ ok: true, clips: r.clips });
});

/** What I dumped (studio fix): every file, its stage, which clips used it, when its original is cleared. */
dumps.get("/:id/files", async (c) => {
  const view = await dumpFiles(c.env, c.req.param("id"));
  if (!view) return fail(c, 404, "That dump is gone.", "what-i-dumped");
  return c.json(view);
});

/** One dumped file, for her own screens (signed in): the original while it is kept. Range requests work. */
dumps.get("/:id/files/:assetId/view", async (c) => {
  const a = await c.env.DB.prepare("SELECT r2_key, mime_type, raw_deleted_at FROM assets WHERE id = ? AND dump_id = ? AND upload_status = 'uploaded'").bind(c.req.param("assetId"), c.req.param("id")).first<{ r2_key: string; mime_type: string; raw_deleted_at: string | null }>();
  if (!a || a.raw_deleted_at) return c.text("Not found", 404);
  return stream(c, c.env.FILES, a.r2_key, a.mime_type || "application/octet-stream");
});
