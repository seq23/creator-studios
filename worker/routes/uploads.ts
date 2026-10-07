// Chunked, resumable uploads straight into R2 (section 7). The browser asks for an upload,
// PUTs 10 MB parts through the Worker (R2 multipart), and completes. A dropped connection
// resumes: the client keeps the uploadId + finished part etags, and can ask which parts R2
// already has. Raw files are keyed raw/<dumpId>/<assetId>; nothing about the file name
// appears in the key or in logs.
import { storageReport } from "../lib/storage";
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { ACCEPTED_DOC_TYPES, ACCEPTED_VIDEO_TYPES, UPLOAD_PART_SIZE } from "@shared/constants";
import { MAX_EDIT_BYTES } from "../domain/editors";

export const uploads = new Hono<{ Bindings: Env; Variables: Vars }>();
uploads.use("*", requireUser);

/** Her own songs for the music bed (Settings > Editing > My music). */
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024;

type Kind = "video" | "brand_doc" | "research_upload" | "voice_sample" | "kit_photo" | "music" | "edit";

function keyFor(kind: Kind, parentId: string | null, id: string): string {
  switch (kind) {
    case "video":
      return `raw/${parentId}/${id}`;
    case "brand_doc":
      return `brain/${id}`;
    case "research_upload":
      return `research/${id}`;
    case "voice_sample":
      return `voice/sample/${id}`;
    case "kit_photo":
      return `kit/photo/${id}`;
    case "music":
      return `music/${id}`;
    case "edit":
      return `edits/${parentId}/${id}`;
  }
}

function acceptable(kind: Kind, mime: string): boolean {
  if (kind === "video") return ACCEPTED_VIDEO_TYPES.includes(mime) || mime.startsWith("video/");
  if (kind === "brand_doc" || kind === "research_upload") return ACCEPTED_DOC_TYPES.includes(mime) || mime.startsWith("text/");
  if (kind === "voice_sample") return mime.startsWith("audio/") || mime.startsWith("video/");
  if (kind === "kit_photo") return mime.startsWith("image/");
  if (kind === "music") return mime.startsWith("audio/");
  if (kind === "edit") return mime.startsWith("video/");
  return false;
}

/** Start: registers the row for the kind and opens an R2 multipart upload. */
uploads.post("/start", async (c) => {
  const body = await readJson<{ kind: Kind; parentId?: string; fileName: string; size: number; mimeType: string; fileNote?: string; contentHash?: string }>(c);
  if (!body?.kind || !body.fileName || !body.mimeType || typeof body.size !== "number") return fail(c, 400, "Missing file details.");
  if (!acceptable(body.kind, body.mimeType)) return fail(c, 422, "That file type is not supported here.", "clips-look-wrong");
  if (body.size <= 0) return fail(c, 422, "That file is empty.");
  if (body.kind === "music" && body.size > MUSIC_MAX_BYTES) return fail(c, 413, "That song is over 25 MB. Export it as an MP3 or M4A and try again.", "looks-and-styles");
  if (body.kind === "edit") {
    // Her edit from CapCut / InShot for one clip (Review > Edit in CapCut > Replace with my edit).
    if (body.size > MAX_EDIT_BYTES) return fail(c, 413, "That video is over 1 GB. Export it at 1080p and try again.", "edit-in-capcut");
    const clip = body.parentId ? await c.env.DB.prepare("SELECT id FROM clips WHERE id = ? AND status != 'deleted'").bind(body.parentId).first() : null;
    if (!clip) return fail(c, 404, "That clip is gone.", "edit-in-capcut");
  }
  const kind = body.kind;
  const id = newId(kind === "video" ? "ast" : kind === "brand_doc" ? "doc" : "upl");
  const parent = body.parentId ?? null;

  if (kind === "video") {
    if (!parent) return fail(c, 400, "Pick a dump first.");
    const dump = await c.env.DB.prepare("SELECT id, status FROM dumps WHERE id = ?").bind(parent).first<{ id: string; status: string }>();
    if (!dump) return fail(c, 404, "That dump no longer exists.");
    if (dump.status !== "uploading") return fail(c, 409, "That dump was already sent for cutting. Start a new one.");
    if (body.contentHash) {
      const dup = await c.env.DB.prepare("SELECT id FROM assets WHERE content_hash = ? AND upload_status = 'uploaded' LIMIT 1").bind(body.contentHash).first();
      if (dup) return fail(c, 409, "You already uploaded this exact video before. Recycled videos need a new file only if it changed.");
    }
  }

  const key = keyFor(kind, parent, id);
  const mp = await c.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: body.mimeType } });

  if (kind === "video") {
    await c.env.DB.prepare(
      "INSERT INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_id, upload_status, file_note, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)",
    )
      .bind(id, parent, body.fileName.slice(0, 200), body.mimeType, body.size, key, mp.uploadId, body.fileNote ?? null, body.contentHash ?? null)
      .run();
  } else if (kind === "brand_doc") {
    await c.env.DB.prepare("INSERT INTO brand_docs (id, file_name, mime_type, size_bytes, r2_key, extract_status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .bind(id, body.fileName.slice(0, 200), body.mimeType, body.size, key)
      .run();
  } else if (kind === "research_upload") {
    await c.env.DB.prepare("INSERT INTO research_uploads (id, file_name, r2_key) VALUES (?, ?, ?)").bind(id, body.fileName.slice(0, 200), key).run();
  }
  // voice_sample, kit_photo, music and edit rows are written by their own routes on complete.

  log.info("upload.start", { kind, parts: Math.ceil(body.size / UPLOAD_PART_SIZE) });
  return c.json({ id, key, uploadId: mp.uploadId, partSize: UPLOAD_PART_SIZE });
});

/** Upload one part. Body is the raw bytes. Returns the etag the client must keep. */
uploads.put("/:id/parts/:n", async (c) => {
  const key = c.req.query("key");
  const uploadId = c.req.query("uploadId");
  const n = Number(c.req.param("n"));
  if (!key || !uploadId || !Number.isInteger(n) || n < 1 || n > 10_000) return fail(c, 400, "Bad part request.");
  if (!c.req.raw.body) return fail(c, 400, "Empty part.");
  const part = await putPart(c.env.FILES, key, uploadId, n, c.req.raw.body);
  if (!part) return fail(c, 502, "That piece did not upload. It will retry.");
  return c.json(part);
});

/**
 * One multipart piece, streamed from the request into R2 (never buffered). Shared by the
 * browser upload above and the job output upload in routes/jobs.ts, so both use one protocol.
 */
export async function putPart(files: R2Bucket, key: string, uploadId: string, n: number, body: ReadableStream): Promise<{ partNumber: number; etag: string } | null> {
  try {
    const part = await files.resumeMultipartUpload(key, uploadId).uploadPart(n, body);
    return { partNumber: part.partNumber, etag: part.etag };
  } catch (e) {
    log.warn("upload.part", { n, err: e instanceof Error ? e.name : "error" });
    return null;
  }
}

/** Assemble the pieces. Returns the object size, or null when R2 refused. */
export async function completeParts(files: R2Bucket, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<number | null> {
  try {
    const obj = await files.resumeMultipartUpload(key, uploadId).complete([...parts].sort((a, b) => a.partNumber - b.partNumber));
    return obj.size;
  } catch (e) {
    log.warn("upload.complete", { err: e instanceof Error ? e.name : "error" });
    return null;
  }
}

/** Complete: R2 assembles the object; the row flips to uploaded. */
uploads.post("/:id/complete", async (c) => {
  const body = await readJson<{ key: string; uploadId: string; parts: { partNumber: number; etag: string }[] }>(c);
  if (!body?.key || !body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) return fail(c, 400, "Missing upload parts.");
  const size = await completeParts(c.env.FILES, body.key, body.uploadId, body.parts);
  if (size === null) return fail(c, 502, "The upload could not be finished. Try again; your finished pieces are kept.");
  await c.env.DB.prepare("UPDATE assets SET upload_status = 'uploaded', size_bytes = ?, upload_id = NULL WHERE id = ?").bind(size, c.req.param("id")).run();
  log.info("upload.complete", { bytes: size });
  return c.json({ ok: true, size });
});

uploads.post("/:id/abort", async (c) => {
  const body = await readJson<{ key: string; uploadId: string }>(c);
  if (!body?.key || !body.uploadId) return fail(c, 400, "Missing upload details.");
  try {
    await c.env.FILES.resumeMultipartUpload(body.key, body.uploadId).abort();
  } catch {
    // already gone
  }
  await c.env.DB.prepare("UPDATE assets SET upload_status = 'aborted' WHERE id = ? AND upload_status = 'uploading'").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Storage used and free (every file, worker/lib/storage.ts): Dump shows it before every upload. */
uploads.get("/storage", async (c) => {
  const r = await storageReport(c.env);
  return c.json({ bytes: r.used_bytes, limit: r.limit_bytes, free: r.free_bytes, light: r.light, line: r.line, checked_at: nowIso() });
});
