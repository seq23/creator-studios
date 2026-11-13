// Photo posts, the stateful parts: make a pack (captions here, pictures and videos by the photo
// maker job, worker/jobs/photopack.ts), plan its posts, send the heads-up, honour Skip, and post
// what is due on the hourly lane (worker/crons/index.ts). shared/photoPosts.ts has the config and
// views, worker/domain/photoPosts.ts the pure rules.
//
// Gates, checked again at the moment of posting (a rule is never only checked when written):
//   - Skip: a skipped post never goes out (the claim below only takes 'scheduled' rows).
//   - Content rules (shared/contentRules.ts): a caption that breaks one is HELD, never posted.
//   - Photos: with face/address rules on, a pack the photo maker has not checked is held; a pack it
//     could not make safe ('blocked') never posts in any studio.
//   - A platform with no token waits ("Connect Facebook"), then is planned again once connected.
import { writerGate } from "./nicheBrief";
import { briefPrompt } from "@shared/nicheBrief";
import { narratesPicture } from "@shared/clipWords";
import type { Env } from "../env";
import { fakeServices } from "../env";
import { parseJson, recordEvent, setHealth } from "./db";
import { mediaToken, newId, nowIso } from "./ids";
import { log, safeError } from "./log";
import { practice } from "./practice";
import { developerEmail, ownerEmail } from "./auth";
import { getLlm } from "../services/openrouter";
import { emailFrame, sendEmail } from "../services/email";
import { getFacebook, facebookConnected } from "../services/facebook";
import { getPinterest, pinterestConnected } from "../services/pinterest";
import { getBuffer, type BufferFacebookPage } from "../services/buffer";
import { bufferState } from "../crons/buffer-sync";
import { readSettings } from "../routes/settings";
import { weekBounds, zonedToUtc } from "../domain/slotting";
import { moveToDate } from "../domain/sync";
import { localDate, planPack, postLine, skipToken, starterCaptions, whenLine } from "../domain/photoPosts";
import { hasRules, parseRules, priceList, textProblems, withAiLabel, type ContentRules } from "@shared/contentRules";
import { loadTaste } from "../domain/studioMemory";
import {
  AI_MADE,
  PACK_MAX_PHOTOS,
  ITEM_LABEL,
  parsePhotoPosts,
  SOCIAL_LABEL,
  SOCIAL_SETUP,
  SOCIALS,
  type ItemKind,
  type PackView,
  type PhotoPostsConfig,
  type PhotosHome,
  type Social,
  type SocialPostStatus,
  type SocialPostView,
} from "@shared/photoPosts";

export const photoConfig = (env: Pick<Env, "PHOTO_POSTS">): PhotoPostsConfig => parsePhotoPosts(env.PHOTO_POSTS);
export const contentRules = (env: Pick<Env, "CONTENT_RULES">): ContentRules => parseRules(env.CONTENT_RULES);

/** Where a pack's files live: the uploads, and what the photo maker writes. */
export const packPhotoKey = (packId: string, id: string) => `packs/${packId}/in/${id}`;
export const packOutPrefix = (packId: string) => `packs/${packId}/out/`;

/** The hard cap per channel per week (locked decision): clips and photo posts together. */
export const WEEKLY_CAP = 10;

async function timeZone(env: Env): Promise<string> {
  return (await readSettings(env).catch(() => null))?.audience_timezone || env.AUDIENCE_TIMEZONE || "America/New_York";
}

// ------------------------------------------------------------------ captions

/**
 * The winners' way, as for clips (owner, 7 Nov 2026, P&P captions v3): never describe what the photo
 * already shows; say who it is for, the moment, the ease or a true reason to book now.
 */
export const PHOTO_V3 =
  "Never describe what the photo shows: the viewer can see it. Each caption adds what the photo cannot: who it is for and the moment (POV, the person it is for, the problem it solves), how easy it is (one form, set up while they are out, you take the credit), or a true reason to book now. The buyer is the hero. Never invent a customer, a review or a count of bookings, and never invite anyone to visit or stop by.";

/** Three short captions from the free AI (OpenRouter free models only), each checked against the rules. */
export async function draftCaptions(env: Env, note: string): Promise<string[]> {
  // The niche brief: researching or failed = a named stop, nothing written (never generic copy).
  const gate = await writerGate(env);
  if (!gate.ok) throw new Error("niche brief not ready");
  const rules = contentRules(env);
  const starters = starterCaptions(note, env.APP_NAME);
  const safeStarters = starters.map((s, i) => (textProblems(s, rules).length ? starterCaptions("", env.APP_NAME)[i] : s));
  if (fakeServices(env) || practice(env, "openrouter")) return safeStarters;
  const rulesLine = [
    rules.banWords.length ? `Never use these words: ${rules.banWords.join(", ")}.` : "",
    rules.blockAddresses ? "Never write a street address, house number or where a customer lives." : "",
    rules.prices.length ? `Only mention a price if it is exactly one of: ${priceList(rules)}. Otherwise no price.` : hasRules(rules) ? "Never mention a price." : "",
  ]
    .filter(Boolean)
    .join(" ");
  try {
    const llm = await getLlm(env);
    const r = await llm.complete({
      system: `You write short social media captions for ${env.APP_NAME}, a local business. Warm, plain, no more than 150 characters each, at most two hashtags, no emojis at the start. ${PHOTO_V3} ${gate.brief ? briefPrompt(gate.brief, "instagram") : ""} ${rulesLine} Reply with JSON only: {"captions": ["...", "...", "..."]} with exactly three different captions.`,
      user: `What the photo shows, in the owner's words: ${note.slice(0, 600) || "(no note: a recent job)"}`,
      json: true,
      maxTokens: 600,
      accept: (t) => /"captions"/.test(t),
    });
    const m = r.ok ? r.text.match(/\{[\s\S]*\}/) : null;
    const list = m ? (JSON.parse(m[0]) as { captions?: unknown }).captions : null;
    const got = Array.isArray(list) ? list.map((c) => String(c ?? "").replace(/\s+/g, " ").trim().slice(0, 220)).filter(Boolean) : [];
    // A draft that breaks a rule is replaced by the starter: the rules win over the AI, always.
    return [0, 1, 2].map((i) => (got[i] && !textProblems(got[i], rules).length && !narratesPicture(got[i], note).length ? got[i] : safeStarters[i]));
  } catch (e) {
    log.warn("photos.captions", { err: safeError(e) });
    return safeStarters;
  }
}

// ------------------------------------------------------------------ connections and gates

/**
 * Her Facebook Page as Buffer lists it, when it can post (owner, 13 Nov 2026: Facebook through the
 * posting service she already connected, no developer tools). Read from the hourly Buffer check; a
 * studio whose stored check predates this field is checked once, now.
 */
export async function bufferFacebook(env: Env): Promise<BufferFacebookPage | null> {
  if (practice(env, "buffer") && !fakeServices(env)) return null;
  const read = async () => parseJson<{ facebook?: BufferFacebookPage | null }>((await env.DB.prepare("SELECT meta FROM connections WHERE service = 'buffer' AND status = 'ok'").first<{ meta: string }>())?.meta, {});
  let meta = await read();
  if (meta.facebook === undefined) {
    try {
      await bufferState(env, await getBuffer(env), true);
      meta = await read();
    } catch {
      return null;
    }
  }
  const fb = meta.facebook;
  return fb && fb.connected && !fb.paused ? fb : null;
}

/** Whether a platform can post now (after hydrate), and the Setup card to open when not. */
export async function platformReady(env: Env, p: Social): Promise<boolean> {
  if (p === "facebook" && !facebookConnected(env)) return !!(await bufferFacebook(env)) || fakeServices(env);
  if (fakeServices(env)) return true;
  if (p === "facebook") return true;
  if (p === "pinterest") return pinterestConnected(env);
  if (practice(env, "buffer")) return false;
  try {
    const s = await bufferState(env, await getBuffer(env), false);
    return !!s.channels[p as "instagram" | "tiktok"];
  } catch {
    return false;
  }
}

const CONNECT_WHY: Record<Social, string> = {
  facebook: "Facebook posts wait until your Facebook Page is added in Buffer.",
  instagram: "Instagram posts wait until Buffer is connected with your Instagram added.",
  tiktok: "TikTok posts wait until Buffer is connected with your TikTok added.",
  pinterest: "Pins wait until your Pinterest account is connected.",
};
export const connectLabel = (p: Social) => `Connect ${SOCIAL_LABEL[p]}`;

/** The photo check a pack must pass before any of its posts goes out; null = fine. */
export function photoGate(privacy: string, rules: ContentRules): string | null {
  if (privacy === "blocked") return "a face or house number could not be hidden in this photo, so it never posts.";
  if ((rules.blockFaces || rules.blockAddresses) && privacy === "unchecked") return "the photo has not been checked for faces and house numbers yet.";
  return null;
}

// ------------------------------------------------------------------ packs

export async function createPack(env: Env, note: string, aiEdited = false): Promise<string> {
  const id = newId("pck");
  await env.DB.prepare("INSERT INTO photo_packs (id, note, status, ai_edited) VALUES (?, ?, 'uploading', ?)").bind(id, note.slice(0, 2000), aiEdited ? 1 : 0).run();
  return id;
}

/** "Make my posts": captions now, then the photo maker. */
export async function makePack(env: Env, packId: string, dispatch: (env: Env, packId: string) => Promise<{ dispatched: boolean; error: string | null }>): Promise<{ ok: boolean; error: string | null }> {
  const pack = await env.DB.prepare("SELECT status, note FROM photo_packs WHERE id = ?").bind(packId).first<{ status: string; note: string }>();
  if (!pack) return { ok: false, error: "That set of photos is gone." };
  if (pack.status !== "uploading" && pack.status !== "failed") return { ok: false, error: "These posts are already being made." };
  const c = await env.DB.prepare("SELECT SUM(upload_status = 'uploaded') AS done, SUM(upload_status = 'uploading') AS pending FROM pack_photos WHERE pack_id = ?").bind(packId).first<{ done: number | null; pending: number | null }>();
  if (!c?.done) return { ok: false, error: "Add a photo first." };
  if (c.pending) return { ok: false, error: "A photo is still uploading. Keep this page open until it finishes." };
  const gate = await writerGate(env);
  if (!gate.ok) return { ok: false, error: gate.why };
  const captions = await draftCaptions(env, pack.note);
  await env.DB.prepare("UPDATE photo_packs SET status = 'making', error = NULL, captions = ? WHERE id = ?").bind(JSON.stringify(captions), packId).run();
  const r = await dispatch(env, packId);
  if (!r.dispatched) {
    await env.DB.prepare("UPDATE photo_packs SET status = 'failed', error = ? WHERE id = ?").bind(r.error ?? "The photo maker could not start.", packId).run();
    return { ok: false, error: r.error ?? "The photo maker could not start. Try again in a minute." };
  }
  await recordEvent(env.DB, "photos.make", packId, { photos: c.done });
  return { ok: true, error: null };
}

/**
 * ONE ADD (owner, 13 Nov 2026: "Photos and Dump become one"). The photos in an upload also become
 * photo posts: each is COPIED into a new set, so the upload and the set never share a file (deleting
 * one never breaks the other), and the set is made at once. A file named "before…" and one named
 * "after…" become the before and after pair. Returns how many photos went into the set: 0 when
 * photo posts are not part of this studio, the upload has no photos, or the copy failed (the reels
 * are still made). Never throws.
 */
export async function packFromDump(env: Env, dumpId: string, dispatch: (env: Env, packId: string) => Promise<{ dispatched: boolean; error: string | null }>): Promise<number> {
  try {
    if (!photoConfig(env).on) return 0;
    const { results } = await env.DB.prepare("SELECT file_name, mime_type, size_bytes, r2_key FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND mime_type LIKE 'image/%' ORDER BY created_at LIMIT ?")
      .bind(dumpId, PACK_MAX_PHOTOS)
      .all<{ file_name: string; mime_type: string; size_bytes: number; r2_key: string }>();
    if (!results.length) return 0;
    const dump = await env.DB.prepare("SELECT notes FROM dumps WHERE id = ?").bind(dumpId).first<{ notes: string }>();
    const note = dump?.notes && !textProblems(dump.notes, contentRules(env)).length ? dump.notes : "";
    const packId = await createPack(env, note);
    const befores = results.filter((a) => /before/i.test(a.file_name));
    const afters = results.filter((a) => /after/i.test(a.file_name));
    const pair = befores.length === 1 && afters.length === 1;
    let copied = 0;
    for (const a of results) {
      const src = await env.FILES.get(a.r2_key);
      if (!src) continue;
      const id = newId("pph");
      const key = packPhotoKey(packId, id);
      await env.FILES.put(key, src.body, { httpMetadata: { contentType: a.mime_type } });
      const role = pair && a === befores[0] ? "before" : pair && a === afters[0] ? "after" : "main";
      await env.DB.prepare("INSERT INTO pack_photos (id, pack_id, role, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded')")
        .bind(id, packId, role, a.file_name, a.mime_type, a.size_bytes, key)
        .run();
      copied++;
    }
    if (!copied) return 0;
    const made = await makePack(env, packId, dispatch);
    if (!made.ok) log.warn("photos.from_upload_not_made", { photos: copied });
    return copied;
  } catch (e) {
    log.warn("photos.from_upload", { err: safeError(e) });
    return 0;
  }
}

export interface MadeItem {
  kind: ItemKind;
  r2_key: string | null;
  cover_r2_key: string | null;
  images: string[];
}

/** The photo maker's answer: store what it made, the photo check, then plan the posts. */
export async function finishPack(env: Env, packId: string, items: MadeItem[], privacy: "unchecked" | "clean" | "fixed" | "blocked", detail: Record<string, number>, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM pack_items WHERE pack_id = ?").bind(packId).run();
  // AI-edited photos (the owner's tick): every piece made from them carries the label, the photo set too.
  const edited = !!(await env.DB.prepare("SELECT ai_edited FROM photo_packs WHERE id = ?").bind(packId).first<{ ai_edited: number }>())?.ai_edited;
  for (const it of items) {
    await env.DB.prepare("INSERT INTO pack_items (id, pack_id, kind, r2_key, cover_r2_key, images, media_token, ai_made) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId("pki"), packId, it.kind, it.r2_key, it.cover_r2_key, JSON.stringify(it.images), mediaToken(), AI_MADE[it.kind] || edited ? 1 : 0)
      .run();
  }
  await env.DB.prepare("UPDATE photo_packs SET status = 'ready', ready_at = ?, privacy = ?, privacy_detail = ?, error = NULL WHERE id = ?").bind(nowIso(), privacy, JSON.stringify(detail), packId).run();
  await schedulePack(env, packId, now);
}

/** Plan the pack's posts (once): auto-post with a heads-up first, Skip any time before. */
export async function schedulePack(env: Env, packId: string, now = Date.now()): Promise<number> {
  const cfg = photoConfig(env);
  if (!cfg.on) return 0;
  const already = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_posts WHERE pack_id = ?").bind(packId).first<{ n: number }>();
  if (already?.n) return 0;
  const pack = await env.DB.prepare("SELECT captions FROM photo_packs WHERE id = ?").bind(packId).first<{ captions: string }>();
  const captions = parseJson<string[]>(pack?.captions, []);
  const { results: items } = await env.DB.prepare("SELECT kind FROM pack_items WHERE pack_id = ?").bind(packId).all<{ kind: ItemKind }>();
  const tz = await timeZone(env);
  const { results: future } = await env.DB.prepare("SELECT platform, scheduled_at FROM social_posts WHERE status IN ('scheduled', 'waiting', 'sending', 'posted') AND scheduled_at >= ?").bind(new Date(now - 7 * 86_400_000).toISOString()).all<{ platform: Social; scheduled_at: string }>();
  const taken = new Set(future.map((r) => `${r.platform}|${localDate(Date.parse(r.scheduled_at), tz)}`));
  const weekCounts = new Map<string, number>();
  const weekFull = (platform: Social, at: string): boolean => {
    const w = weekBounds(new Date(at), tz);
    const k = `${platform}|${w.start}`;
    if (!weekCounts.has(k)) weekCounts.set(k, 0);
    const photo = future.filter((r) => r.platform === platform && r.scheduled_at >= w.start && r.scheduled_at < w.end).length;
    return photo + (weekCounts.get(k) ?? 0) >= WEEKLY_CAP;
  };
  // Clip posts on the same channels count toward the same cap.
  const { results: clipPosts } = await env.DB.prepare("SELECT platform, scheduled_at FROM posts WHERE status IN ('planned', 'in_buffer', 'posted') AND scheduled_at >= ?").bind(new Date(now - 7 * 86_400_000).toISOString()).all<{ platform: string; scheduled_at: string }>();
  for (const cp of clipPosts) {
    if (!(SOCIALS as readonly string[]).includes(cp.platform)) continue;
    const w = weekBounds(new Date(cp.scheduled_at), tz);
    const k = `${cp.platform}|${w.start}`;
    weekCounts.set(k, (weekCounts.get(k) ?? 0) + 1);
  }
  // "Less like this" on a kind of photo post (owner, 13 Nov 2026): that kind is left out while another remains.
  const less = new Set((await loadTaste(env)).less);
  const kinds = items.map((i) => i.kind);
  const wanted = kinds.filter((k) => !less.has(`photo:${k}`));
  const plan = planPack(now, cfg, tz, wanted.length ? wanted : kinds, taken, weekFull);
  const order: Record<Social, number> = { facebook: 0, instagram: 1, tiktok: 2, pinterest: 0 };
  for (const p of plan) {
    const caption = captions[order[p.platform] % Math.max(1, captions.length)] ?? "";
    await env.DB.prepare("INSERT INTO social_posts (id, pack_id, item_kind, platform, caption, scheduled_at, status) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')").bind(newId("spo"), packId, p.kind, p.platform, caption, p.scheduled_at).run();
  }
  log.info("photos.planned", { posts: plan.length });
  return plan.length;
}

// ------------------------------------------------------------------ Skip

/** Skip: the post never goes out. Only a post that has not started going out can be skipped. */
export async function skipPost(env: Env, postId: string, actor: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE social_posts SET status = 'skipped', skipped_at = ? WHERE id = ? AND status IN ('scheduled', 'waiting', 'held', 'failed')").bind(nowIso(), postId).run();
  if (r.meta.changes) await recordEvent(env.DB, "photos.skip", postId, {}, actor);
  return !!r.meta.changes;
}

/** Undo a Skip while there is still time: it goes back on at its time, or the next free day. */
export async function unskipPost(env: Env, postId: string, now = Date.now()): Promise<boolean> {
  const p = await env.DB.prepare("SELECT scheduled_at FROM social_posts WHERE id = ? AND status = 'skipped' AND deleted_at IS NULL").bind(postId).first<{ scheduled_at: string }>();
  if (!p) return false;
  const cfg = photoConfig(env);
  const at = Date.parse(p.scheduled_at) > now + 3_600_000 ? p.scheduled_at : new Date(now + cfg.headsUpHours * 3_600_000).toISOString();
  await env.DB.prepare("UPDATE social_posts SET status = 'scheduled', skipped_at = NULL, heads_up_at = NULL, scheduled_at = ? WHERE id = ?").bind(at, postId).run();
  return true;
}

/**
 * Move a photo post to another day, keeping its time of day (the Posts sheet, 13 Nov 2026). Only a
 * post that has not gone out and was not skipped; never into the past; one post per platform a day
 * (the same rule the planner keeps). A fresh heads-up goes out before the new time.
 */
export async function movePost(env: Env, postId: string, date: string, now = Date.now()): Promise<{ ok: boolean; error?: string; scheduled_at?: string }> {
  const p = await env.DB.prepare("SELECT platform, scheduled_at FROM social_posts WHERE id = ? AND status IN ('scheduled', 'waiting', 'held') AND deleted_at IS NULL").bind(postId).first<{ platform: Social; scheduled_at: string }>();
  if (!p) return { ok: false, error: "This post already went out or was skipped, so it cannot move." };
  const tz = await timeZone(env);
  const at = moveToDate(p.scheduled_at, date, tz, zonedToUtc);
  if (!at) return { ok: false, error: "Pick a day to move it to." };
  if (Date.parse(at) <= now) return { ok: false, error: "That time has already passed. Pick a later day." };
  const { results: same } = await env.DB.prepare("SELECT scheduled_at FROM social_posts WHERE platform = ? AND id != ? AND status IN ('scheduled', 'waiting', 'sending', 'posted') AND deleted_at IS NULL").bind(p.platform, postId).all<{ scheduled_at: string }>();
  if (same.some((r) => localDate(Date.parse(r.scheduled_at), tz) === date)) return { ok: false, error: `${SOCIAL_LABEL[p.platform]} already has a photo post that day. Pick another day.` };
  await env.DB.prepare("UPDATE social_posts SET scheduled_at = ?, heads_up_at = NULL WHERE id = ? AND status IN ('scheduled', 'waiting', 'held')").bind(at, postId).run();
  return { ok: true, scheduled_at: at };
}

/**
 * "Delete for good" from the Rejected bin: only a post she skipped. The post is gone for good (it
 * can never be brought back, planned or sent), and the piece the studio made for it leaves storage
 * once no other post uses it. Her original photos (packs/<id>/in/) are never touched.
 */
export async function deletePostForGood(env: Env, postId: string, actor: string): Promise<boolean> {
  const p = await env.DB.prepare("SELECT pack_id, item_kind FROM social_posts WHERE id = ? AND status = 'skipped' AND deleted_at IS NULL").bind(postId).first<{ pack_id: string; item_kind: ItemKind }>();
  if (!p) return false;
  const r = await env.DB.prepare("UPDATE social_posts SET deleted_at = ? WHERE id = ? AND status = 'skipped' AND deleted_at IS NULL").bind(nowIso(), postId).run();
  if (!r.meta.changes) return false;
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_posts WHERE pack_id = ? AND item_kind = ? AND deleted_at IS NULL").bind(p.pack_id, p.item_kind).first<{ n: number }>();
  if (!left?.n) {
    const item = await env.DB.prepare("SELECT id, r2_key, cover_r2_key, images FROM pack_items WHERE pack_id = ? AND kind = ?").bind(p.pack_id, p.item_kind).first<{ id: string; r2_key: string | null; cover_r2_key: string | null; images: string }>();
    if (item) {
      const made = packOutPrefix(p.pack_id);
      const keys = [item.r2_key, item.cover_r2_key, ...parseJson<string[]>(item.images, [])].filter((k): k is string => !!k && k.startsWith(made));
      if (keys.length) await env.FILES.delete(keys);
      await env.DB.prepare("DELETE FROM pack_items WHERE id = ?").bind(item.id).run();
    }
  }
  await recordEvent(env.DB, "photos.deleted", postId, {}, actor);
  return true;
}

/** Change a caption: refused in plain words when it breaks a rule (and checked again at posting). */
export async function editCaption(env: Env, postId: string, caption: string): Promise<{ ok: boolean; problems: string[] }> {
  const text = String(caption ?? "").replace(/\r/g, "").trim().slice(0, 2000);
  const problems = textProblems(text, contentRules(env));
  if (problems.length) return { ok: false, problems };
  const r = await env.DB.prepare("UPDATE social_posts SET caption = ?, status = CASE WHEN status = 'held' THEN 'scheduled' ELSE status END, error = CASE WHEN status = 'held' THEN NULL ELSE error END WHERE id = ? AND status IN ('scheduled', 'waiting', 'held')").bind(text, postId).run();
  return { ok: !!r.meta.changes, problems: r.meta.changes ? [] : ["This post has already gone out or was skipped."] };
}

// ------------------------------------------------------------------ the hourly lane

interface PostRow {
  id: string;
  pack_id: string;
  item_kind: ItemKind;
  platform: Social;
  caption: string;
  scheduled_at: string;
  status: SocialPostStatus;
  error: string | null;
  posted_at: string | null;
  url: string | null;
}

interface ItemRow {
  id: string;
  kind: ItemKind;
  r2_key: string | null;
  cover_r2_key: string | null;
  images: string;
  media_token: string | null;
  ai_made: number;
}

export const mediaUrl = (env: Env, token: string, part: "video" | "cover" | number) => `${env.PUBLIC_BASE_URL}/media/p/${token}/${part === "video" ? "video" : part === "cover" ? "cover" : `img/${part}`}`;

/** Post one due row. Returns what happened, in a word. */
export async function sendPost(env: Env, row: PostRow): Promise<SocialPostStatus> {
  // Claim it: a post she skipped in the meantime is no longer 'scheduled' and is left alone.
  const claim = await env.DB.prepare("UPDATE social_posts SET status = 'sending' WHERE id = ? AND status = 'scheduled'").bind(row.id).run();
  if (!claim.meta.changes) return "skipped";
  const rules = contentRules(env);
  const hold = async (why: string): Promise<SocialPostStatus> => {
    await env.DB.prepare("UPDATE social_posts SET status = 'held', error = ? WHERE id = ?").bind(why.slice(0, 300), row.id).run();
    return "held";
  };
  const wait = async (why: string): Promise<SocialPostStatus> => {
    await env.DB.prepare("UPDATE social_posts SET status = 'waiting', error = ? WHERE id = ?").bind(why, row.id).run();
    return "waiting";
  };
  const pack = await env.DB.prepare("SELECT privacy FROM photo_packs WHERE id = ?").bind(row.pack_id).first<{ privacy: string }>();
  const item = await env.DB.prepare("SELECT id, kind, r2_key, cover_r2_key, images, media_token, ai_made FROM pack_items WHERE pack_id = ? AND kind = ?").bind(row.pack_id, row.item_kind).first<ItemRow>();
  if (!pack || !item?.media_token) return hold("its pictures are gone.");
  const problems = textProblems(row.caption, rules);
  if (problems.length) return hold(problems[0]);
  const gate = photoGate(pack.privacy, rules);
  if (gate) return pack.privacy === "blocked" ? hold(gate) : wait("photo-check");
  const images = parseJson<string[]>(item.images, []);
  const video = item.kind !== "carousel";
  if (video ? !item.r2_key : !images.length) return wait("photo-maker");
  if (!(await platformReady(env, row.platform))) return wait(`connect:${row.platform}`);

  const aiMade = !!item.ai_made;
  const flagged = row.platform === "instagram" || row.platform === "tiktok"; // Buffer carries the platform AI flag
  const text = flagged ? row.caption : withAiLabel(row.caption, aiMade);
  let result: { ok: boolean; id: string | null; url: string | null; error: string | null };
  try {
    if (row.platform === "facebook" && !facebookConnected(env)) {
      // No Page token of her own: through Buffer, where her Page is already added.
      const page = await bufferFacebook(env);
      if (!page) return wait("connect:facebook");
      const r = await (await getBuffer(env)).createPost({
        channelId: page.id,
        platform: "facebook",
        text,
        title: env.APP_NAME,
        mediaUrl: mediaUrl(env, item.media_token, video ? "video" : 0),
        imageUrls: video ? undefined : images.map((_, i) => mediaUrl(env, item.media_token!, i)),
        scheduledAt: new Date().toISOString(),
      });
      result = { ok: r.ok, id: r.id, url: null, error: r.error };
    } else if (row.platform === "facebook") {
      const fb = getFacebook(env);
      result = video ? await fb.postVideo({ videoUrl: mediaUrl(env, item.media_token, "video"), text }) : await fb.postPhotos({ imageUrls: images.map((_, i) => mediaUrl(env, item.media_token!, i)), text });
    } else if (row.platform === "pinterest") {
      const imageUrl = video ? mediaUrl(env, item.media_token, "cover") : mediaUrl(env, item.media_token, 0);
      result = await getPinterest(env).createPin({ imageUrl, title: env.APP_NAME, text, link: null });
    } else {
      const buffer = await getBuffer(env);
      const state = await bufferState(env, buffer, false);
      const channel = state.channels[row.platform];
      if (!channel) return wait(`connect:${row.platform}`);
      if (!video) return hold("Instagram and TikTok take the videos only.");
      const r = await buffer.createPost({ channelId: channel.id, platform: row.platform, text, title: env.APP_NAME, mediaUrl: mediaUrl(env, item.media_token, "video"), scheduledAt: new Date().toISOString(), aiGenerated: aiMade });
      result = { ok: r.ok, id: r.id, url: null, error: r.error };
    }
  } catch (e) {
    result = { ok: false, id: null, url: null, error: safeError(e) };
  }
  if (!result.ok) {
    await env.DB.prepare("UPDATE social_posts SET status = 'failed', error = ? WHERE id = ?").bind((result.error ?? "The platform said no.").slice(0, 300), row.id).run();
    await setHealth(env.DB, `Photo posts (${SOCIAL_LABEL[row.platform]})`, "red", result.error ?? "A post did not go out.", "photo-posts");
    return "failed";
  }
  await env.DB.prepare("UPDATE social_posts SET status = 'posted', posted_at = ?, external_id = ?, url = ?, error = NULL WHERE id = ?").bind(nowIso(), result.id, result.url, row.id).run();
  await setHealth(env.DB, `Photo posts (${SOCIAL_LABEL[row.platform]})`, "green", "Posting", null);
  return "posted";
}

type HeadsUpRow = { id: string; platform: Social; item_kind: ItemKind; caption: string; scheduled_at: string };

/** Browser-showable uploads (a HEIC is not: Chrome and most phones' browsers cannot draw it). */
const SHOWABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The card picture: the made (checked) cover first, else the first showable upload, else null. Pure. */
export function packThumb(packId: string, photos: { id: string; mime_type: string }[], made: string | null): string | null {
  if (made) return made;
  const ph = photos.find((p) => SHOWABLE.has((p.mime_type ?? "").toLowerCase()));
  return ph ? `/api/photos/${packId}/photo/${ph.id}` : null;
}

/** The heads-up email for these posts: one line each with its own Skip link. */
async function headsUpEmail(env: Env, rows: HeadsUpRow[]) {
  const tz = await timeZone(env);
  const lines: string[] = [`${rows.length === 1 ? "This post goes" : `These ${rows.length} posts go`} out on their own. Nothing to do if they look fine.`];
  for (const [i, p] of rows.entries()) {
    const link = `${env.PUBLIC_BASE_URL}/skip/${await skipToken(env.SESSION_SECRET, p.id)}`;
    const line = `${i + 1}. ${whenLine(p.scheduled_at, tz)} · ${SOCIAL_LABEL[p.platform]} · ${ITEM_LABEL[p.item_kind]}: “${p.caption.slice(0, 120)}”`;
    lines.push(line, `Skip this one: ${link}`);
  }
  lines.push("To see them all, open Photos in your studio.");
  const subject = `Going out soon: ${rows.length} post${rows.length === 1 ? "" : "s"}`;
  const frame = emailFrame(subject, lines, { label: "Open Photos", url: `${env.PUBLIC_BASE_URL}/photos` });
  return { subject: `${subject} · ${env.APP_NAME}`, html: frame.html, text: frame.text };
}

/**
 * The heads-up: one email listing what goes out in the next day, each with its own Skip link.
 * Only posts that CAN go out are announced: a post on a platform that is not connected waits
 * (status 'waiting', "Connect …") and gets its own fresh heads-up when it is planned again
 * (replanWaiting). 22 Oct 2026: an owner must never be told a post is "going out" that cannot.
 */
export async function sendHeadsUp(env: Env, now = Date.now()): Promise<number> {
  const cfg = photoConfig(env);
  const until = new Date(now + cfg.headsUpHours * 3_600_000 + 3_600_000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, platform, item_kind, caption, scheduled_at FROM social_posts WHERE status = 'scheduled' AND heads_up_at IS NULL AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20").bind(until).all<HeadsUpRow>();
  const ready = new Map<Social, boolean>();
  const going: HeadsUpRow[] = [];
  for (const p of results) {
    if (!ready.has(p.platform)) ready.set(p.platform, await platformReady(env, p.platform));
    if (ready.get(p.platform)) going.push(p);
  }
  if (!going.length) return 0;
  const to = await ownerEmail(env);
  if (!to) return 0;
  const mail = await headsUpEmail(env, going);
  const r = await sendEmail(env, { kind: "heads_up", to: [to], subject: mail.subject, html: mail.html, text: mail.text, refId: going[0].id });
  for (const p of going) await env.DB.prepare("UPDATE social_posts SET heads_up_at = ? WHERE id = ?").bind(nowIso(), p.id).run();
  log.info("photos.heads_up", { posts: going.length, ok: r.ok });
  return going.length;
}

/**
 * A test heads-up for one pack, to the host developer ONLY (DEVELOPER_EMAIL), whatever the
 * platforms: proves the email end to end without writing to the owner. Marks nothing.
 */
export async function sendTestHeadsUp(env: Env, packId: string): Promise<{ ok: boolean; posts: number; error?: string }> {
  const to = developerEmail(env);
  if (!to) return { ok: false, posts: 0, error: "no developer email" };
  const { results } = await env.DB.prepare("SELECT id, platform, item_kind, caption, scheduled_at FROM social_posts WHERE pack_id = ? AND status IN ('scheduled', 'waiting', 'held') ORDER BY scheduled_at LIMIT 20").bind(packId).all<HeadsUpRow>();
  if (!results.length) return { ok: false, posts: 0, error: "no posts in this pack" };
  const mail = await headsUpEmail(env, results);
  const r = await sendEmail(env, { kind: "heads_up", to: [to], subject: `[Test] ${mail.subject}`, html: mail.html, text: mail.text, refId: results[0].id, requested: true });
  log.info("photos.heads_up_test", { posts: results.length, ok: r.ok });
  return { ok: r.ok, posts: results.length, error: r.ok ? undefined : "send failed" };
}

/** Posts that waited on a connection go back on the plan once it is there (with a fresh heads-up). */
export async function replanWaiting(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, platform, error, pack_id FROM social_posts WHERE status = 'waiting'").all<{ id: string; platform: Social; error: string | null; pack_id: string }>();
  let n = 0;
  const cfg = photoConfig(env);
  for (const p of results) {
    const why = p.error ?? "";
    let ready = false;
    if (why.startsWith("connect:")) ready = await platformReady(env, p.platform);
    else if (why === "photo-check" || why === "photo-maker") {
      const pk = await env.DB.prepare("SELECT privacy FROM photo_packs WHERE id = ?").bind(p.pack_id).first<{ privacy: string }>();
      ready = !!pk && !photoGate(pk.privacy, contentRules(env)) && !practice(env, "github");
    }
    if (!ready) continue;
    await env.DB.prepare("UPDATE social_posts SET status = 'scheduled', error = NULL, heads_up_at = NULL, scheduled_at = ? WHERE id = ? AND status = 'waiting'").bind(new Date(now + cfg.headsUpHours * 3_600_000).toISOString(), p.id).run();
    n++;
  }
  return n;
}

/** The hourly lane: heads-ups, re-plans, then everything due. Rule 0: it always reports what it did. */
export async function photoPostsTick(env: Env, now = Date.now()): Promise<{ headsUp: number; replanned: number; posted: number; held: number; waiting: number; failed: number }> {
  const out = { headsUp: 0, replanned: 0, posted: 0, held: 0, waiting: 0, failed: 0 };
  if (!photoConfig(env).on) return out;
  out.replanned = await replanWaiting(env, now);
  out.headsUp = await sendHeadsUp(env, now);
  const { results } = await env.DB.prepare("SELECT id, pack_id, item_kind, platform, caption, scheduled_at, status, error, posted_at, url FROM social_posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 12").bind(new Date(now).toISOString()).all<PostRow>();
  for (const r of results) {
    const s = await sendPost(env, r);
    if (s === "posted") out.posted++;
    else if (s === "held") out.held++;
    else if (s === "waiting") out.waiting++;
    else if (s === "failed") out.failed++;
  }
  log.info("photos.tick", out);
  return out;
}

// ------------------------------------------------------------------ views

function waitingOn(error: string | null): { line: string | null; connect: string | null } {
  if (!error) return { line: null, connect: null };
  if (error.startsWith("connect:")) {
    const p = error.slice(8) as Social;
    return { line: SOCIAL_LABEL[p] ? connectLabel(p) : "a connection", connect: SOCIAL_SETUP[p] ?? null };
  }
  if (error === "photo-check" || error === "photo-maker") return { line: "Connect the photo maker (Clip cutting on Setup), which checks the photo and makes the videos", connect: "github" };
  return { line: null, connect: null };
}

export function postView(r: PostRow, tz: string, cover: string | null): SocialPostView {
  const w = r.status === "waiting" ? waitingOn(r.error) : { line: null, connect: null };
  return {
    id: r.id,
    pack_id: r.pack_id,
    item_kind: r.item_kind,
    platform: r.platform,
    caption: r.caption,
    scheduled_at: r.scheduled_at,
    status: r.status,
    line: postLine({ ...r, error: r.status === "waiting" ? null : r.error }, tz, w.line),
    connect: w.connect,
    url: r.url,
    cover_url: cover,
  };
}

const PRIVACY_LINE: Record<string, string> = {
  unchecked: "Not checked for faces and house numbers yet.",
  clean: "Checked: no faces or house numbers showing.",
  fixed: "Checked: faces and house numbers are blurred.",
  blocked: "This photo could not be made safe, so it will not post.",
};

export async function packView(env: Env, packId: string, tz: string): Promise<PackView | null> {
  const p = await env.DB.prepare("SELECT id, status, note, created_at, privacy, captions, error FROM photo_packs WHERE id = ?").bind(packId).first<{ id: string; status: PackView["status"]; note: string; created_at: string; privacy: PackView["privacy"]; captions: string; error: string | null }>();
  if (!p) return null;
  const { results: photos } = await env.DB.prepare("SELECT id, role, mime_type FROM pack_photos WHERE pack_id = ? AND upload_status = 'uploaded' ORDER BY created_at").bind(packId).all<{ id: string; role: "main" | "before" | "after"; mime_type: string }>();
  const { results: items } = await env.DB.prepare("SELECT id, kind, r2_key, cover_r2_key, images, media_token, ai_made FROM pack_items WHERE pack_id = ?").bind(packId).all<ItemRow>();
  const { results: posts } = await env.DB.prepare("SELECT id, pack_id, item_kind, platform, caption, scheduled_at, status, error, posted_at, url FROM social_posts WHERE pack_id = ? AND deleted_at IS NULL ORDER BY scheduled_at, platform").bind(packId).all<PostRow>();
  const coverOf = (kind: ItemKind) => {
    const it = items.find((i) => i.kind === kind);
    if (!it?.media_token) return null;
    if (it.cover_r2_key) return mediaUrl(env, it.media_token, "cover");
    return parseJson<string[]>(it.images, []).length ? mediaUrl(env, it.media_token, 0) : null;
  };
  return {
    id: p.id,
    status: p.status,
    note: p.note,
    created_at: p.created_at,
    privacy: p.privacy,
    privacy_line: PRIVACY_LINE[p.privacy] ?? "",
    error: p.error,
    photos: photos.map((ph) => ({ id: ph.id, role: ph.role, url: `/api/photos/${packId}/photo/${ph.id}` })),
    thumb_url: packThumb(packId, photos, coverOf("carousel") ?? coverOf("reel") ?? coverOf("before_after")),
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      label: ITEM_LABEL[i.kind],
      ai_made: !!i.ai_made,
      media_url: i.r2_key && i.media_token ? mediaUrl(env, i.media_token, "video") : null,
      cover_url: coverOf(i.kind),
      images: i.media_token ? parseJson<string[]>(i.images, []).map((_, n) => mediaUrl(env, i.media_token!, n)) : [],
    })),
    captions: parseJson<string[]>(p.captions, []),
    posts: posts.map((r) => postView(r, tz, coverOf(r.item_kind))),
  };
}

export async function photosHome(env: Env): Promise<PhotosHome> {
  const cfg = photoConfig(env);
  const rules = contentRules(env);
  const tz = await timeZone(env);
  const ruleView = { banWords: rules.banWords, prices: priceList(rules), blockAddresses: rules.blockAddresses, blockFaces: rules.blockFaces };
  if (!cfg.on) return { on: false, off_line: "Photo posts are not part of this studio yet. Ask your helper to switch them on.", stops: [], maker_practice: false, upcoming: [], packs: [], rules: ruleView };
  const stops: PhotosHome["stops"] = [];
  for (const p of cfg.platforms) if (!(await platformReady(env, p))) stops.push({ platform: p, label: connectLabel(p), setup: SOCIAL_SETUP[p], why: CONNECT_WHY[p] });
  const { results: packIds } = await env.DB.prepare("SELECT id FROM photo_packs ORDER BY created_at DESC LIMIT 20").all<{ id: string }>();
  const packs: PackView[] = [];
  for (const { id } of packIds) {
    const v = await packView(env, id, tz);
    if (v) packs.push(v);
  }
  const upcoming = packs
    .flatMap((p) => p.posts)
    // Skipped ones stay in place (with Undo) until their time passes: nothing jumps under her.
    .filter((p) => p.status === "scheduled" || p.status === "waiting" || p.status === "held" || p.status === "failed" || (p.status === "skipped" && Date.parse(p.scheduled_at) > Date.now()))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return { on: true, off_line: null, stops, maker_practice: !fakeServices(env) && practice(env, "github"), upcoming, packs, rules: ruleView };
}

/** Health rows for the platforms she has not connected yet: the NAMED stops, with their Setup card. */
export async function photoStopLights(env: Env): Promise<void> {
  const cfg = photoConfig(env);
  if (!cfg.on) return;
  // A platform this studio does not post to keeps no light (owner, 7 Nov 2026: P&P has no Pinterest).
  for (const p of SOCIALS.filter((x) => !cfg.platforms.includes(x))) await env.DB.prepare("DELETE FROM health WHERE name = ?").bind(`Photo posts (${SOCIAL_LABEL[p]})`).run();
  for (const p of cfg.platforms) {
    const ready = await platformReady(env, p);
    await setHealth(env.DB, `Photo posts (${SOCIAL_LABEL[p]})`, ready ? "green" : "grey", ready ? "Connected" : `${connectLabel(p)}: ${CONNECT_WHY[p]}`, ready ? null : `connect-${SOCIAL_SETUP[p] === "buffer" ? "buffer" : p}`);
  }
}

