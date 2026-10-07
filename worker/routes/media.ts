// Public media links (section 13): /media/<long random token>. Buffer fetches the clip
// through this; the token is cleared 30 days after posting, so the link dies with it.
// Range requests are honoured so players can seek. A clip with a voice over mixed in is served
// with it (worker/jobs/voice.ts mix mode), so Review and the posted video both carry her voice.
import { Hono } from "hono";
import type { Env, Vars } from "../env";

export const media = new Hono<{ Bindings: Env; Variables: Vars }>();

/** How long a connected editor may fetch the video it was sent (docs/EDITORS.md). */
export const SOURCE_LINK_HOURS = 6;

/** Stream an R2 object with Range support (players seek; editors download in pieces). */
async function stream(c: { req: { header: (n: string) => string | undefined; raw: Request }; text: (t: string, s: 404) => Response }, files: R2Bucket, key: string, fallbackType: string, disposition?: string): Promise<Response> {
  const range = c.req.header("range");
  const obj = await files.get(key, range ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  if (!headers.get("content-type")) headers.set("content-type", fallbackType);
  if (disposition) headers.set("content-disposition", disposition);
  if (range && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

/**
 * /media/source/<token>: the video a connected editor was sent (a dump's upload, or a clip's
 * file), only while that editor job is waiting for it and for SOURCE_LINK_HOURS at most. The token
 * is cleared as soon as the job finishes or fails, so the link dies with it.
 */
media.get("/source/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[a-z0-9]{30,64}$/.test(token)) return c.text("Not found", 404);
  const row = await c.env.DB.prepare(
    `SELECT e.created_at, a.r2_key AS raw_key, a.raw_deleted_at, cl.r2_key AS clip_key FROM editor_jobs e
       LEFT JOIN assets a ON a.id = e.asset_id LEFT JOIN clips cl ON cl.id = e.clip_id
     WHERE e.source_token = ? AND e.status = 'submitted'`,
  )
    .bind(token)
    .first<{ created_at: string; raw_key: string | null; raw_deleted_at: string | null; clip_key: string | null }>();
  if (!row) return c.text("Not found", 404);
  const age = Date.now() - Date.parse(row.created_at.endsWith("Z") ? row.created_at : `${row.created_at}Z`);
  if (!(age < SOURCE_LINK_HOURS * 3600_000)) return c.text("Not found", 404);
  const key = row.clip_key ?? (row.raw_deleted_at ? null : row.raw_key);
  if (!key) return c.text("Not found", 404);
  return stream(c, c.env.FILES, key, "video/mp4");
});

/** The newest mixed file of a voice over attached to this clip, if one is ready. */
export async function voicedKey(env: Env, clipId: string): Promise<string | null> {
  const n = await env.DB.prepare("SELECT mixed_r2_key FROM narrations WHERE clip_id = ? AND mix_status = 'ready' AND mixed_r2_key IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(clipId).first<{ mixed_r2_key: string }>();
  return n?.mixed_r2_key ?? null;
}

media.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[a-z0-9]{30,64}$/.test(token)) return c.text("Not found", 404);
  const thumb = Number(c.req.query("thumb"));
  const kind = c.req.query("cover") === "1" || thumb ? "cover" : "clip";
  const row = await c.env.DB.prepare("SELECT id, r2_key, cover_r2_key, youtube, file_deleted_at FROM clips WHERE media_token = ? AND status != 'deleted'").bind(token).first<{ id: string; r2_key: string; cover_r2_key: string | null; youtube: string | null; file_deleted_at: string | null }>();
  if (!row) return c.text("Not found", 404);
  // A full video's three thumbnail choices (?thumb=1..3); "Download thumbnail" saves the one she picked.
  if (thumb) {
    const t = (JSON.parse(row.youtube ?? "{}") as { thumbnails?: { key: string }[] }).thumbnails?.[thumb - 1];
    if (!t || !Number.isInteger(thumb)) return c.text("Not found", 404);
    return stream(c, c.env.FILES, t.key, "image/jpeg", c.req.query("download") === "1" ? 'attachment; filename="youtube-thumbnail.jpg"' : undefined);
  }
  // The storage rule removed this full video's file (7 days after it posted, or unapproved for 14 days).
  if (kind === "clip" && row.file_deleted_at) return c.text("This video file was removed to save space. Its thumbnail and words are kept.", 410);
  // A voice over attached and mixed in: Review plays it and Buffer posts it through this same link.
  const voiced = kind === "clip" ? await voicedKey(c.env, row.id) : null;
  const key = kind === "cover" ? row.cover_r2_key : (voiced ?? row.r2_key);
  if (!key) return c.text("Not found", 404);
  // "Save the clip" (Edit in CapCut): the same file, saved to her phone or computer.
  // "Download for YouTube" (a full video she uploads herself) is the same link.
  if (kind === "clip" && c.req.query("download") === "1") return stream(c, c.env.FILES, key, "video/mp4", `attachment; filename="${row.youtube ? "studio-youtube" : "studio-clip"}.mp4"`);
  const range = c.req.header("range");
  const obj = await c.env.FILES.get(key, range ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  if (!headers.get("content-type")) headers.set("content-type", kind === "cover" ? "image/jpeg" : "video/mp4");
  if (range && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});
