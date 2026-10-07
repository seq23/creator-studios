// Work done by another editor (docs/EDITORS.md), from start to the clip in Review:
//
//   startDumpCut      Dump → the built-in cut job, or (Who edits > Cutting = a connected editor)
//                     each video is sent to that editor by a private link (/media/source/<token>)
//   queueClipEditors  after a built-in cut: each new clip to the connected captions / polish editor
//   pollEditorJobs    asks each editor how it is doing (Dump and Review ask while they are open,
//                     and the hourly lane); a finished job is imported by the cut job's import
//                     mode, which measures every file again, levels the loudness and makes the cover
//   startHandback     her own edit from CapCut / InShot / another app, uploaded back from Review
//
// Nothing waits on her and nothing is lost: a refused key, used-up credits, an editor error or an
// editor that takes over 3 hours all fall back to the built-in editor, and the editor's light
// (Settings > Connections + health) says what happened, with its fix guide.
import type { Env } from "../env";
import { getSetting, parseJson, recordEvent, setHealth } from "./db";
import { markConnection } from "./connections";
import { mediaToken, newId, nowIso } from "./ids";
import { log, safeError } from "./log";
import { dispatchJob } from "../services/github";
import { getEditor, type EditorFailure, type EditorOutput } from "../services/editors";
import { API_EDITORS, editorChoiceFromStored, editorDef, effectiveEditor, isApiEditor, recipeForLength, type ApiEditorId, type ChoosableCapability, type EditorChoice } from "../domain/editors";

export const EDITOR_POLL_EVERY_MS = 20_000;
export const EDITOR_GIVE_UP_MS = 3 * 3600_000;

export interface EditorJobRow {
  id: string;
  editor: string;
  capability: ChoosableCapability | "handback";
  dump_id: string | null;
  clip_id: string | null;
  asset_id: string | null;
  project_id: string | null;
  source_token: string | null;
  status: "submitted" | "importing" | "done" | "failed";
  error: string | null;
  result: string | null;
  polled_at: string | null;
  created_at: string;
}

/** Stored on the job row: the editor's memo between polls, its outputs, and the clip ids they become. */
export interface EditorJobResult {
  memo?: Record<string, unknown>;
  outputs?: (EditorOutput & { clip_id?: string })[];
  /** Hand-back: her uploaded file. */
  key?: string;
}

export async function connectedEditors(env: Env): Promise<Set<ApiEditorId>> {
  const { results } = await env.DB.prepare(`SELECT service FROM connections WHERE status = 'ok' AND service IN (${API_EDITORS.map(() => "?").join(",")})`)
    .bind(...API_EDITORS)
    .all<{ service: string }>();
  return new Set(results.map((r) => r.service).filter(isApiEditor));
}

export async function editorChoice(env: Env): Promise<EditorChoice> {
  const stored = await getSetting<{ editors?: unknown }>(env.DB, "editing", {});
  return editorChoiceFromStored(stored?.editors);
}

/** The editor's light: the same row its key check writes (Settings > Connections + health). */
export async function editorLight(env: Env, editor: ApiEditorId, failure: EditorFailure | "gave_up" | "failed", what: string) {
  const name = editorDef(editor)!.name;
  if (failure === "auth") {
    await markConnection(env, editor, "error", `${name} says the key is not valid any more.`);
    await setHealth(env.DB, editor, "red", `${name} refused the key; the built-in editor ${what}.`, `reconnect-${editor}`);
  } else if (failure === "credits") {
    await setHealth(env.DB, editor, "yellow", `${name} is out of credits; the built-in editor ${what}.`, `reconnect-${editor}`);
  } else {
    await setHealth(env.DB, editor, "yellow", `${name} didn't finish; the built-in editor ${what}.`, `reconnect-${editor}`);
  }
}

/** The light a key check (Connect, "Check everything now") writes for an editor: one code path for both. */
export async function writeEditorCheckLight(env: Env, editor: ApiEditorId, ok: boolean, error: string | null, meta: Record<string, unknown>) {
  const name = editorDef(editor)!.name;
  const light = !ok ? "red" : meta.low ? "yellow" : "green";
  const note = !ok ? (error ?? "Needs you") : meta.low ? `${name}: under 10% of its credits left; the built-in editor takes over when they run out.` : `${name} connected`;
  await setHealth(env.DB, editor, light, note, light === "green" ? null : `reconnect-${editor}`);
}

// ---------------------------------------------------------------- a dump

/** Dump pressed: the built-in cut job, or each video to her connected cutting editor. */
export async function startDumpCut(env: Env, dumpId: string, sourceBase: string): Promise<{ dispatched: boolean; jobId: string | null; editor: "built-in" | ApiEditorId; error: string | null }> {
  // A full video for YouTube is never cut, by us or a connected editor (validator full-video-uncut).
  const kind = await env.DB.prepare("SELECT kind FROM dumps WHERE id = ?").bind(dumpId).first<{ kind: string }>();
  if (kind?.kind === "full_video") return { dispatched: false, jobId: null, editor: "built-in", error: "A full video for YouTube goes up whole; it is never cut." };
  const choice = await editorChoice(env);
  const editor = effectiveEditor(choice, "cut_from_source", await connectedEditors(env));
  if (editor !== "built-in") {
    const sent = await sendDumpToEditor(env, dumpId, editor, sourceBase);
    if (sent) return { dispatched: true, jobId: null, editor, error: null };
  }
  const r = await dispatchJob(env, "cut", dumpId);
  return { dispatched: r.dispatched, jobId: r.jobId, editor: "built-in", error: r.error };
}

async function sendDumpToEditor(env: Env, dumpId: string, editor: ApiEditorId, sourceBase: string): Promise<boolean> {
  const client = await getEditor(env, editor);
  if (!client) return false;
  const { results: assets } = await env.DB.prepare("SELECT id FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL ORDER BY created_at").bind(dumpId).all<{ id: string }>();
  if (!assets.length) return false;
  for (const a of assets) {
    const id = newId("edj");
    const token = mediaToken();
    await env.DB.prepare("INSERT INTO editor_jobs (id, editor, capability, dump_id, asset_id, source_token, status) VALUES (?, ?, 'cut_from_source', ?, ?, ?, 'submitted')").bind(id, editor, dumpId, a.id, token).run();
    const r = await client.submit(`${sourceBase}/media/source/${token}`, "cut_from_source", "Studio dump");
    if (!r.ok) {
      await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = ?, source_token = NULL, updated_at = ? WHERE dump_id = ? AND status = 'submitted'").bind(`submit ${r.failure}`, nowIso(), dumpId).run();
      await editorLight(env, editor, r.failure, "cut the dump instead");
      log.warn("editor.submit.failed", { editor, failure: r.failure });
      return false;
    }
    await env.DB.prepare("UPDATE editor_jobs SET project_id = ?, updated_at = ? WHERE id = ?").bind(r.projectId, nowIso(), id).run();
  }
  await recordEvent(env.DB, "dump.sent_to_editor", dumpId, { editor, videos: assets.length });
  log.info("editor.dump.sent", { editor, videos: assets.length });
  return true;
}

// ---------------------------------------------------------------- clips after a built-in cut

/** New clips go to her connected captions editor (else her polish editor). Returns how many were sent. */
export async function queueClipEditors(env: Env, clipIds: string[], sourceBase: string, only?: ChoosableCapability): Promise<number> {
  const choice = await editorChoice(env);
  const connected = await connectedEditors(env);
  const cap: ChoosableCapability | null = only ?? (effectiveEditor(choice, "caption", connected) !== "built-in" ? "caption" : effectiveEditor(choice, "enhance", connected) !== "built-in" ? "enhance" : null);
  if (!cap) return 0;
  const editor = effectiveEditor(choice, cap, connected);
  if (editor === "built-in") return 0;
  const client = await getEditor(env, editor);
  if (!client) return 0;
  let sent = 0;
  for (const clipId of clipIds) {
    const clip = await env.DB.prepare("SELECT id, dump_id, hook_text FROM clips WHERE id = ? AND status != 'deleted'").bind(clipId).first<{ id: string; dump_id: string; hook_text: string }>();
    if (!clip) continue;
    // Once an editor failed (or is still working) on this clip for this job, it is not sent again: no loops.
    const before = await env.DB.prepare("SELECT status FROM editor_jobs WHERE clip_id = ? AND capability = ? ORDER BY created_at DESC LIMIT 1").bind(clip.id, cap).first<{ status: string }>();
    if (before && before.status !== "done") continue;
    const id = newId("edj");
    const token = mediaToken();
    await env.DB.prepare("INSERT INTO editor_jobs (id, editor, capability, dump_id, clip_id, source_token, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')").bind(id, editor, cap, clip.dump_id, clip.id, token).run();
    const r = await client.submit(`${sourceBase}/media/source/${token}`, cap, clip.hook_text);
    if (!r.ok) {
      await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = ?, source_token = NULL, updated_at = ? WHERE id = ?").bind(`submit ${r.failure}`, nowIso(), id).run();
      await clipFallback(env, { id, editor, capability: cap, clip_id: clip.id, dump_id: clip.dump_id } as EditorJobRow, r.failure);
      break; // a refused key or no credits refuses the rest too
    }
    await env.DB.prepare("UPDATE editor_jobs SET project_id = ?, updated_at = ? WHERE id = ?").bind(r.projectId, nowIso(), id).run();
    sent++;
  }
  if (sent) log.info("editor.clips.sent", { editor, cap, clips: sent });
  return sent;
}

// ---------------------------------------------------------------- her own edit

/** Her edit is uploaded and its header checked: the cut job's import mode finishes it (loudness, cover). */
export async function startHandback(env: Env, clip: { id: string; dump_id: string }, app: string, key: string): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const busy = await env.DB.prepare("SELECT 1 AS x FROM editor_jobs WHERE clip_id = ? AND status IN ('submitted', 'importing') LIMIT 1").bind(clip.id).first();
  if (busy) return { ok: false, error: "This clip is already being finished. It will be ready in about a minute." };
  const id = newId("edj");
  await env.DB.prepare("INSERT INTO editor_jobs (id, editor, capability, dump_id, clip_id, status, result) VALUES (?, ?, 'handback', ?, ?, 'importing', ?)")
    .bind(id, app, clip.dump_id, clip.id, JSON.stringify({ key } satisfies EditorJobResult))
    .run();
  const job = await dispatchJob(env, "cut", `${clip.dump_id}/${clip.id}/import`);
  if (!job.dispatched) {
    await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = 'dispatch', updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
    return { ok: false, error: "We couldn't start finishing your edit. Try again in a minute." };
  }
  return { ok: true, jobId: job.jobId };
}

// ---------------------------------------------------------------- polling

/** Ask the editors how their jobs are doing. Throttled per job; safe to call on every screen load. */
export async function pollEditorJobs(env: Env, opts: { dumpId?: string; now?: number } = {}): Promise<{ polled: number; imported: number; fellBack: number }> {
  const now = opts.now ?? Date.now();
  const due = new Date(now - EDITOR_POLL_EVERY_MS).toISOString();
  const where = ["status = 'submitted'", "capability != 'handback'", "(polled_at IS NULL OR polled_at < ?)"];
  const binds: unknown[] = [due];
  if (opts.dumpId) {
    where.push("dump_id = ?");
    binds.push(opts.dumpId);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM editor_jobs WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT 10`).bind(...binds).all<EditorJobRow>();
  let imported = 0;
  let fellBack = 0;
  for (const row of results) {
    try {
      const outcome = await pollOne(env, row, now);
      if (outcome === "imported") imported++;
      if (outcome === "fallback") fellBack++;
    } catch (e) {
      log.error("editor.poll", { editor: row.editor, err: safeError(e) });
    }
  }
  return { polled: results.length, imported, fellBack };
}

async function pollOne(env: Env, row: EditorJobRow, now: number): Promise<"working" | "imported" | "fallback"> {
  const editor = row.editor as ApiEditorId;
  const cap = row.capability as ChoosableCapability;
  const stamp = new Date(now).toISOString();
  if (now - Date.parse(row.created_at.endsWith("Z") ? row.created_at : `${row.created_at}Z`) > EDITOR_GIVE_UP_MS) {
    await failRow(env, row, "gave up after 3 hours", "gave_up");
    return "fallback";
  }
  const client = isApiEditor(editor) ? await getEditor(env, editor) : null;
  if (!client) {
    await failRow(env, row, "editor disconnected", "failed");
    return "fallback";
  }
  const saved = parseJson<EditorJobResult>(row.result, {});
  const r = await client.poll(row.project_id ?? "", cap, saved.memo ?? {});
  if (!r.ok) {
    if (r.failure === "busy" || (r.failure === "other" && r.status >= 500)) {
      await env.DB.prepare("UPDATE editor_jobs SET polled_at = ? WHERE id = ?").bind(stamp, row.id).run();
      return "working";
    }
    await failRow(env, row, `poll ${r.failure}`, r.failure);
    return "fallback";
  }
  if (r.state === "working") {
    await env.DB.prepare("UPDATE editor_jobs SET polled_at = ?, result = ? WHERE id = ?").bind(stamp, JSON.stringify({ ...saved, memo: r.memo ?? saved.memo }), row.id).run();
    return "working";
  }
  if (r.state === "failed" || !r.outputs.length) {
    await failRow(env, row, "editor failed", "failed");
    return "fallback";
  }
  const outputs = r.outputs.slice(0, 20).map((o) => ({ ...o, clip_id: cap === "cut_from_source" ? newId("clp", 16) : (row.clip_id ?? undefined) }));
  await env.DB.prepare("UPDATE editor_jobs SET status = 'importing', polled_at = ?, source_token = NULL, result = ?, updated_at = ? WHERE id = ?")
    .bind(stamp, JSON.stringify({ ...saved, outputs } satisfies EditorJobResult), stamp, row.id)
    .run();
  if (cap === "cut_from_source") {
    // A dump is imported once, when every one of its videos is back.
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM editor_jobs WHERE dump_id = ? AND capability = 'cut_from_source' AND status = 'submitted'").bind(row.dump_id).first<{ n: number }>();
    if ((left?.n ?? 0) === 0) await dispatchJob(env, "cut", `${row.dump_id}/import`);
  } else {
    await dispatchJob(env, "cut", `${row.dump_id}/${row.clip_id}/import`);
  }
  log.info("editor.done", { editor, cap, outputs: outputs.length });
  return "imported";
}

/** An editor job that did not work out: the built-in editor does the job instead. */
export async function failRow(env: Env, row: Pick<EditorJobRow, "id" | "editor" | "capability" | "dump_id" | "clip_id">, error: string, failure: EditorFailure | "gave_up" | "failed") {
  await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = ?, source_token = NULL, updated_at = ? WHERE id = ?").bind(error.slice(0, 120), nowIso(), row.id).run();
  if (row.capability === "cut_from_source") {
    await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = 'another video of this dump failed', source_token = NULL, updated_at = ? WHERE dump_id = ? AND capability = 'cut_from_source' AND status IN ('submitted', 'importing')")
      .bind(nowIso(), row.dump_id)
      .run();
    if (isApiEditor(row.editor)) await editorLight(env, row.editor, failure === "gave_up" ? "failed" : failure, "cut the dump instead");
    const dump = await env.DB.prepare("SELECT status FROM dumps WHERE id = ?").bind(row.dump_id).first<{ status: string }>();
    if (dump && dump.status === "cutting") {
      const r = await dispatchJob(env, "cut", row.dump_id);
      await recordEvent(env.DB, "dump.editor_fallback", row.dump_id, { editor: row.editor, dispatched: r.dispatched });
    }
    return;
  }
  if (row.capability === "handback") return;
  await clipFallback(env, row, failure);
}

async function clipFallback(env: Env, row: Pick<EditorJobRow, "editor" | "capability" | "clip_id">, failure: EditorFailure | "gave_up" | "failed") {
  if (!row.clip_id) return;
  const name = editorDef(row.editor)?.name ?? "The editor";
  if (isApiEditor(row.editor)) await editorLight(env, row.editor, failure === "gave_up" ? "failed" : failure, row.capability === "caption" ? "captioned the clips instead" : "kept the clips as they were");
  if (row.capability === "caption") {
    // The clip was rendered without captions for the editor to add them: the built-in captions go back on.
    const clip = await env.DB.prepare("SELECT dump_id, look FROM clips WHERE id = ? AND status != 'deleted'").bind(row.clip_id).first<{ dump_id: string; look: string | null }>();
    if (clip?.look) {
      await env.DB.prepare("UPDATE clips SET pending_look = look, pending_layout = layout, rerender_error = ? WHERE id = ?").bind(`${name} couldn't add captions, so the built-in captions are going back on.`, row.clip_id).run();
      const job = await dispatchJob(env, "cut", `${clip.dump_id}/${row.clip_id}`);
      if (job.dispatched) await env.DB.prepare("UPDATE clips SET rerender_job_id = ? WHERE id = ?").bind(job.jobId, row.clip_id).run();
    }
  }
}

/** What Review shows while another editor works on a clip. */
export function editingNote(editor: string | null, capability: string | null): string | null {
  if (!editor || !capability) return null;
  const name = editorDef(editor)?.name ?? (editor === "capcut" ? "CapCut" : editor === "inshot" ? "InShot" : null);
  if (capability === "handback") return `Finishing your edit${name ? ` from ${name}` : ""}, about a minute`;
  if (capability === "caption") return `${name ?? "Your editor"} is adding captions`;
  if (capability === "enhance") return `${name ?? "Your editor"} is polishing this clip`;
  return null;
}

/** The clip a finished editor job becomes, before the cut job's import measures it (length decides the recipe). */
export function plannedRecipe(duration: number | null): ReturnType<typeof recipeForLength> {
  return recipeForLength(duration ?? 30);
}
