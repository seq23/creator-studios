// The cut job's import mode: videos made by another editor become clips through the same checks
// as the built-in cutter's (docs/EDITORS.md). Two refs (worker/lib/jobStorage.ts CUT_REF):
//   "<dump>/import"         a connected editor cut the dump: its clips (planned ids) become the
//                           dump's clips via applyDumpClips → parseCutResult
//   "<dump>/<clip>/import"  one clip's file is replaced: her own edit (CapCut, InShot, another app)
//                           or a connected editor's captions / polish
// The job (jobs/cut.py import_items) downloads each video, measures it with ffprobe, fits it to
// 1080x1920 without stretching, levels loudness to -14 LUFS and makes the cover. The Worker then
// checks the answer: only the planned clip ids and file names, a tall 9:16 video, and a length
// every ticked platform takes (worker/domain/editors.ts checkEdit).
import type { Env } from "../env";
import { parseJson, recordEvent } from "../lib/db";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { applyDumpClips, CutResultError, remixVoiceOver, rerenderKeys, type CutResultClip } from "./cut";
import { checkEdit, editorName, isHandoffApp, recipeForLength } from "../domain/editors";
import { failRow, queueClipEditors, type EditorJobResult, type EditorJobRow } from "../lib/editorJobs";
import { PLATFORMS, type Platform } from "@shared/constants";

export interface ImportItem {
  src: { url: string } | { key: string };
  clip_id: string;
  asset_id: string | null;
  title: string | null;
  duration_s: number | null;
  output_key: string;
  output_cover_key: string;
  platforms: Platform[];
}

export interface ImportSpec {
  job_id: string;
  type: "cut";
  mode: "import";
  dump_id: string;
  /** The clip being replaced; null when a connected editor cut the whole dump. */
  replace: string | null;
  editor: string;
  items: ImportItem[];
}

async function importingRows(env: Env, dumpId: string, clipId: string | null): Promise<EditorJobRow[]> {
  const { results } = clipId
    ? await env.DB.prepare("SELECT * FROM editor_jobs WHERE clip_id = ? AND status = 'importing' ORDER BY created_at DESC LIMIT 1").bind(clipId).all<EditorJobRow>()
    : await env.DB.prepare("SELECT * FROM editor_jobs WHERE dump_id = ? AND capability = 'cut_from_source' AND status = 'importing' ORDER BY created_at").bind(dumpId).all<EditorJobRow>();
  return results;
}

export async function buildImportSpec(env: Env, jobId: string, dumpId: string, clipId: string | null): Promise<ImportSpec> {
  const rows = await importingRows(env, dumpId, clipId);
  if (!rows.length) throw new Error("nothing to import");
  if (clipId) {
    const clip = await env.DB.prepare("SELECT id, platforms, media_version FROM clips WHERE id = ? AND dump_id = ?").bind(clipId, dumpId).first<{ id: string; platforms: string; media_version: number }>();
    if (!clip) throw new Error("clip missing");
    const row = rows[0];
    const res = parseJson<EditorJobResult>(row.result, {});
    const src = row.capability === "handback" ? (res.key ? { key: res.key } : null) : res.outputs?.[0]?.url ? { url: res.outputs[0].url } : null;
    if (!src) throw new Error("import has no file");
    const keys = rerenderKeys(dumpId, clipId, clip.media_version + 1);
    return {
      job_id: jobId,
      type: "cut",
      mode: "import",
      dump_id: dumpId,
      replace: clipId,
      editor: row.editor,
      items: [{ src, clip_id: clipId, asset_id: null, title: null, duration_s: null, output_key: keys.mp4, output_cover_key: keys.jpg, platforms: parseJson<Platform[]>(clip.platforms, [...PLATFORMS]) }],
    };
  }
  const items: ImportItem[] = [];
  for (const row of rows) {
    for (const o of parseJson<EditorJobResult>(row.result, {}).outputs ?? []) {
      if (!o.clip_id || !o.url) continue;
      items.push({
        src: { url: o.url },
        clip_id: o.clip_id,
        asset_id: row.asset_id,
        title: o.title,
        duration_s: o.duration_s,
        output_key: `clips/${dumpId}/${o.clip_id}.mp4`,
        output_cover_key: `clips/${dumpId}/${o.clip_id}.jpg`,
        platforms: [...PLATFORMS],
      });
    }
  }
  return { job_id: jobId, type: "cut", mode: "import", dump_id: dumpId, replace: null, editor: rows[0].editor, items };
}

/** The measured replacement, as the job reports it. Throws when it is not the file it was asked for. */
export function parseReplaced(result: unknown, expect: { clipId: string; mp4: string; jpg: string }): { width: number; height: number; duration_s: number } {
  const r = (result as { replaced?: Record<string, unknown> } | null)?.replaced;
  if (!r || typeof r !== "object") throw new CutResultError("result has no replacement");
  if (r.clip_id !== expect.clipId || r.r2_key !== expect.mp4 || r.cover_r2_key !== expect.jpg) throw new CutResultError("replacement does not match its clip");
  const width = Number(r.width);
  const height = Number(r.height);
  const duration_s = Number(r.duration_s);
  if (![width, height, duration_s].every((x) => Number.isFinite(x) && x > 0)) throw new CutResultError("replacement was not measured");
  return { width, height, duration_s };
}

export async function applyImport(env: Env, jobId: string, dumpId: string, clipId: string | null, result: unknown): Promise<void> {
  const rows = await importingRows(env, dumpId, clipId);
  if (!rows.length) throw new CutResultError("nothing was being imported");
  if (!clipId) {
    const planned = new Set(rows.flatMap((r) => (parseJson<EditorJobResult>(r.result, {}).outputs ?? []).map((o) => o.clip_id).filter((x): x is string => !!x)));
    await applyDumpClips(env, jobId, dumpId, result, { editor: rows[0].editor, planned });
    return;
  }
  const row = rows[0];
  const clip = await env.DB.prepare("SELECT id, status, r2_key, cover_r2_key, platforms, media_version FROM clips WHERE id = ? AND dump_id = ?").bind(clipId, dumpId).first<{
    id: string;
    status: string;
    r2_key: string;
    cover_r2_key: string | null;
    platforms: string;
    media_version: number;
  }>();
  const keys = rerenderKeys(dumpId, clipId, (clip?.media_version ?? 0) + 1);
  if (!clip || clip.status === "deleted") {
    await env.FILES.delete([keys.mp4, keys.jpg]);
    await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = 'clip deleted', updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    return;
  }
  const measured = parseReplaced(result, { clipId, mp4: keys.mp4, jpg: keys.jpg });
  const app = isHandoffApp(row.editor) ? (row.editor === "other" ? "your editing app" : editorName(row.editor)!) : (editorName(row.editor) ?? "the editor");
  const ok = checkEdit(measured, parseJson<Platform[]>(clip.platforms, [...PLATFORMS]), app);
  if (!ok.ok) {
    await env.FILES.delete([keys.mp4, keys.jpg]);
    await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = 'checks', updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    await env.DB.prepare("UPDATE clips SET rerender_error = ? WHERE id = ?").bind(`${ok.error} The clip is unchanged.`, clipId).run();
    if (row.capability !== "handback") await failRow(env, row, "result failed the checks", "failed");
    log.warn("cut.import.refused", { handback: row.capability === "handback" });
    return;
  }
  await env.DB.prepare(
    `UPDATE clips SET r2_key = ?, cover_r2_key = ?, edited_with = ?, look = NULL, layout = NULL, pending_look = NULL, pending_layout = NULL, rerender_error = NULL,
       media_version = media_version + 1 WHERE id = ?`,
  )
    .bind(keys.mp4, keys.jpg, row.editor, clipId)
    .run();
  const old = [clip.r2_key, clip.cover_r2_key].filter((k): k is string => !!k && k !== keys.mp4 && k !== keys.jpg);
  if (old.length) await env.FILES.delete(old);
  await env.DB.prepare("UPDATE editor_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  // Her uploaded edit is kept only until it is in place.
  if (row.capability === "handback") {
    const key = parseJson<EditorJobResult>(row.result, {}).key;
    if (key) await env.FILES.delete(key);
  }
  await remixVoiceOver(env, clipId);
  await recordEvent(env.DB, "clip.replaced", clipId, { editor: row.editor, capability: row.capability, seconds: Math.round(measured.duration_s) });
  log.info("cut.import.apply", { capability: row.capability });
  // Captions came back: her polish editor (if any) takes it from here.
  if (row.capability === "caption") await queueClipEditors(env, [clipId], env.PUBLIC_BASE_URL, "enhance");
}

export async function importFailed(env: Env, dumpId: string, clipId: string | null, safeError: string): Promise<void> {
  const rows = await importingRows(env, dumpId, clipId);
  for (const row of rows) {
    if (row.capability === "handback") {
      await env.DB.prepare("UPDATE editor_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(safeError.slice(0, 120), nowIso(), row.id).run();
      await env.DB.prepare("UPDATE clips SET rerender_error = ? WHERE id = ?").bind("We couldn't use that video. Export it again as an MP4 and upload it; the clip is unchanged.", row.clip_id).run();
    } else {
      await failRow(env, row, `import ${safeError.slice(0, 60)}`, "failed");
      if (!clipId) break; // failRow already failed every video of the dump and started the built-in cut
    }
  }
  log.warn("cut.import.failed", { clip: !!clipId });
}

/** FAKE_SERVICES=1: the import writes tiny real files where the job would, and answers like the job. */
export async function fakeImport(env: Env, jobId: string, dumpId: string, clipId: string | null, options: Record<string, unknown>, mp4: Uint8Array, jpg: Uint8Array): Promise<unknown> {
  const spec = await buildImportSpec(env, jobId, dumpId, clipId);
  for (const it of spec.items) {
    await env.FILES.put(it.output_key, mp4, { httpMetadata: { contentType: "video/mp4" } });
    await env.FILES.put(it.output_cover_key, jpg, { httpMetadata: { contentType: "image/jpeg" } });
  }
  if (spec.replace) {
    // A test may say what the job would measure (e.g. a landscape edit the Worker must refuse).
    const m = (options.measured ?? {}) as { width?: number; height?: number; duration_s?: number };
    const it = spec.items[0];
    return { replaced: { clip_id: it.clip_id, r2_key: it.output_key, cover_r2_key: it.output_cover_key, width: m.width ?? 1080, height: m.height ?? 1920, duration_s: m.duration_s ?? 24 } };
  }
  const clips: CutResultClip[] = spec.items.map((it, i) => {
    const d = it.duration_s ?? 30;
    return {
      id: it.clip_id,
      asset_id: it.asset_id ?? "",
      start_s: 0,
      end_s: d,
      recipe: recipeForLength(d),
      hook_text: it.title ?? "A clip from your dump",
      hook_alt: null,
      caption: it.title ?? "",
      hashtags: [],
      platforms: it.platforms,
      score: [0.82, 0.74, 0.66][i % 3],
      r2_key: it.output_key,
      cover_r2_key: it.output_cover_key,
      look: null,
      parts: [[0, d]],
      layout: null,
    };
  });
  return { clips, engine: { transcript: spec.editor, picker: spec.editor, crop: spec.editor, subtitles: spec.editor } };
}
