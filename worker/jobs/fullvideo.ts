// The full-video door's job (jobs/fullvideo.py): one video, whole. NEVER the cutter, never 9:16
// (validator `full-video-uncut`).
//
// buildSpec   → the dump's one video and where the copy and the three thumbnails go.
// applyResult → checks every file is where it was asked to be, drafts the title, description,
//               chapters and tags from what she said (the free AI with her locked Brand Profile;
//               a starter draft from her own words when the AI is busy), and makes ONE Review item
//               (a clips row with full_video = 1, platforms ["youtube"]). The upload itself is
//               removed right away: the copy is the file now, so the video is stored once.
// onFailure   → the dump says what happened, in plain words.
// fakeRun     → FAKE_SERVICES=1: a tiny real MP4 and three JPEGs where the real job writes them.
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { log } from "../lib/log";
import { recordEvent } from "../lib/db";
import { mediaToken, nowIso } from "../lib/ids";
import { unb64 } from "../lib/crypto";
import { emailFrame, sendEmail } from "../services/email";
import { readSettings } from "../routes/settings";
import { getLlm } from "../services/openrouter";
import { fakeServices } from "../env";
import { kitName, lockedProfile } from "../routes/mediakit";
import { clipCuttingLight } from "../crons/buffer-sync";
import { bufferCanTake, cleanTags, cleanTitle, composeDescription, draftChapters, starterDraft, type FullVideoDetails, type Segment } from "../domain/fullVideo";
import { FAKE_JPG_B64, FAKE_MP4_B64 } from "./cut";

export const fullVideoKey = (dumpId: string, clipId: string) => `full/${dumpId}/${clipId}.mp4`;
export const thumbKey = (dumpId: string, clipId: string, n: number) => `full/${dumpId}/${clipId}-t${n}.jpg`;
/** The one Review item's id, fixed per dump so the spec and the result agree. */
export const fullClipId = (dumpId: string) => `clp_${dumpId.replace(/^dmp_/, "").replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(8, "0")}fv`;

interface Source {
  id: string;
  r2_key: string;
  file_name: string;
}

async function source(env: Env, dumpId: string): Promise<Source> {
  const d = await env.DB.prepare("SELECT kind FROM dumps WHERE id = ?").bind(dumpId).first<{ kind: string }>();
  if (d?.kind !== "full_video") throw new Error("not a full-video dump");
  const a = await env.DB.prepare("SELECT id, r2_key, file_name FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL ORDER BY created_at LIMIT 1").bind(dumpId).first<Source>();
  if (!a) throw new Error("the video is gone");
  return a;
}

export async function buildFullSpec(env: Env, jobId: string, dumpId: string) {
  const a = await source(env, dumpId);
  const clip = fullClipId(dumpId);
  return { job_id: jobId, type: "fullvideo", dump_id: dumpId, source_key: a.r2_key, output_key: fullVideoKey(dumpId, clip), thumb_keys: [1, 2, 3].map((n) => thumbKey(dumpId, clip, n)) };
}

interface FullResult {
  video?: { key?: string; width?: number; height?: number; duration_s?: number; size_bytes?: number };
  transcript?: unknown;
  thumbnails?: { key?: string; t?: number }[];
  engine?: string;
}

/** The job's answer, checked: its own files, a real size and length, segments that are text. */
export function parseFullResult(result: unknown, dumpId: string): { width: number; height: number; duration: number; size: number; segments: Segment[]; thumbs: { key: string; t: number }[] } {
  const r = (result ?? {}) as FullResult;
  const clip = fullClipId(dumpId);
  if (r.video?.key !== fullVideoKey(dumpId, clip)) throw new Error("full video result is not for this dump");
  const width = Number(r.video.width);
  const height = Number(r.video.height);
  const duration = Number(r.video.duration_s);
  const size = Number(r.video.size_bytes);
  if (!(width > 0 && height > 0 && duration > 0 && size > 0)) throw new Error("full video result has no size");
  const thumbs = (r.thumbnails ?? []).map((t, i) => ({ key: String(t.key), t: Number(t.t) || 0, want: thumbKey(dumpId, clip, i + 1) }));
  if (thumbs.length !== 3 || thumbs.some((t) => t.key !== t.want)) throw new Error("full video result needs its three thumbnails");
  const segments = (Array.isArray(r.transcript) ? r.transcript : [])
    .map((s) => s as Partial<Segment>)
    .filter((s) => typeof s.text === "string" && Number.isFinite(Number(s.start)))
    .slice(0, 5000)
    .map((s) => ({ start: Number(s.start), end: Number(s.end ?? s.start), text: String(s.text).slice(0, 500) }));
  return { width, height, duration, size, segments, thumbs: thumbs.map(({ key, t }) => ({ key, t })) };
}

/** Title, description body and tags: the free AI with her voice, or her own first words. */
async function draft(env: Env, segments: Segment[], fileName: string): Promise<{ title: string; body: string; tags: string[] }> {
  const starter = starterDraft(segments, fileName);
  if (fakeServices(env) || !segments.length) return starter;
  const profile = await lockedProfile(env);
  const said = segments.map((s) => s.text).join(" ").slice(0, 12000);
  const llm = await getLlm(env);
  const r = await llm.complete({
    system: `You write the YouTube title, description and tags for a full-length video by the creator ${kitName(env)}, in her voice (${profile?.voice || "warm and direct"}). Never mention: ${profile?.off_limits || "nothing listed"}. Reply with JSON only: {"title": "under 70 characters, no clickbait, no emojis", "description": "2 to 4 short paragraphs a viewer reads under the video, ending with one call to action from: ${profile?.ctas || "subscribe for more"}", "tags": ["8 to 15 search tags"]}.`,
    user: `What she says in the video:\n${said}`,
    json: true,
    maxTokens: 900,
  });
  try {
    const m = r.ok ? r.text.match(/\{[\s\S]*\}/) : null;
    const j = m ? (JSON.parse(m[0]) as { title?: string; description?: string; tags?: unknown }) : null;
    if (!j?.title || !j.description) return starter;
    return { title: cleanTitle(j.title, starter.title), body: String(j.description).slice(0, 4000), tags: cleanTags(j.tags).length ? cleanTags(j.tags) : starter.tags };
  } catch {
    return starter;
  }
}

export async function applyFullResult(env: Env, jobId: string, dumpId: string, result: unknown): Promise<void> {
  const a = await source(env, dumpId);
  const p = parseFullResult(result, dumpId);
  const clipId = fullClipId(dumpId);
  for (const key of [fullVideoKey(dumpId, clipId), ...p.thumbs.map((t) => t.key)]) if (!(await env.FILES.head(key))) throw new Error("a full video file is not in storage");
  const d = await draft(env, p.segments, a.file_name);
  const chapters = draftChapters(p.segments, p.duration);
  const details: FullVideoDetails = {
    title: d.title,
    description: d.body,
    chapters,
    tags: d.tags,
    thumbnails: p.thumbs,
    thumb_pick: 0,
    privacy: "public",
    width: p.width,
    height: p.height,
    duration_s: p.duration,
    size_bytes: p.size,
    studio_done_at: null,
    // Landscape or over 3 minutes: Buffer can't post it (YouTube Shorts only), so it is hers to upload.
    handoff: !bufferCanTake({ width: p.width, height: p.height, duration_s: p.duration }),
  };
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, cover_r2_key, media_token, status, full_video, youtube)
       VALUES (?, ?, ?, 0, ?, 'story', ?, ?, '', '["youtube"]', 1, ?, ?, ?, 'draft', 1, ?)`,
    ).bind(clipId, a.id, dumpId, p.duration, d.title, composeDescription(d.body, chapters, d.tags), fullVideoKey(dumpId, clipId), p.thumbs[0].key, mediaToken(), JSON.stringify(details)),
    env.DB.prepare("UPDATE dumps SET status = 'ready', clips_made = 1, ready_at = ?, error_summary = NULL WHERE id = ?").bind(at, dumpId),
    // The copy is the video now: the upload goes at once, so it is stored once.
    env.DB.prepare("UPDATE assets SET raw_deleted_at = ?, duration_s = ? WHERE id = ?").bind(at, p.duration, a.id),
  ]);
  await env.FILES.delete(a.r2_key);
  await recordEvent(env.DB, "fullvideo.ready", dumpId, { job: jobId, seconds: Math.round(p.duration), chapters: chapters.length, words: p.segments.length });
  await clipCuttingLight(env, { status: "done", at });
  log.info("fullvideo.apply", { seconds: Math.round(p.duration), chapters: chapters.length });
  const s = await readSettings(env);
  const { html, text } = emailFrame("Your YouTube video is ready", ["We drafted the title, description, chapters, tags and three thumbnails. Nothing posts until you approve it.", "Pick a thumbnail, check the words, then Approve."], { label: "Review it", url: `${env.PUBLIC_BASE_URL}/review` });
  await sendEmail(env, { kind: "clips_ready", to: s.notify_emails, subject: "Your YouTube video is ready to review", html, text, refId: dumpId });
}

export const fullVideoJob: JobHandler = {
  async buildSpec(env, jobId, refId) {
    return buildFullSpec(env, jobId, refId ?? "");
  },
  async applyResult(env, jobId, refId, result) {
    await applyFullResult(env, jobId, refId ?? "", result);
  },
  async onFailure(env, jobId, refId, safeError) {
    const why = /no_video_stream/.test(safeError) ? "We couldn't read a video in that file. Try exporting it again as an MP4." : "Getting your video ready didn't finish. Dump it again; if it happens twice, your helper can look.";
    await env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(why, refId).run();
    await recordEvent(env.DB, "fullvideo.failed", refId, { job: jobId });
    await clipCuttingLight(env, { status: "failed", at: nowIso() });
    log.warn("fullvideo.failed", { len: safeError.length });
  },
  async onProgress(env, _jobId, refId) {
    if (refId) await env.DB.prepare("UPDATE dumps SET status = 'cutting' WHERE id = ? AND status = 'queued'").bind(refId).run();
  },
  /** FAKE_SERVICES: a tiny real MP4 and three JPEGs where the real job writes them, and a few sentences. */
  async fakeRun(env, jobId, refId) {
    const spec = await buildFullSpec(env, jobId, refId ?? "");
    const mp4 = unb64(FAKE_MP4_B64);
    await env.FILES.put(spec.output_key, mp4, { httpMetadata: { contentType: "video/mp4" } });
    for (const [i, k] of spec.thumb_keys.entries()) await env.FILES.put(k, unb64(FAKE_JPG_B64[i % FAKE_JPG_B64.length]), { httpMetadata: { contentType: "image/jpeg" } });
    const lines = ["Welcome back, today I am showing the whole thing start to finish.", "First the setup, because everything builds on it.", "Now the main step, slowly so you can follow along.", "The finishing touches go last, they make the difference.", "That's the whole thing. Tell me what you'd add."];
    const transcript = Array.from({ length: 20 }, (_, i) => ({ start: i * 30, end: i * 30 + 25, text: lines[i % lines.length] }));
    return { video: { key: spec.output_key, width: 1920, height: 1080, duration_s: 600, size_bytes: mp4.byteLength }, transcript, engine: "fake", thumbnails: spec.thumb_keys.map((key, i) => ({ key, t: [120, 300, 480][i] })) };
  },
};
