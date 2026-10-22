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
import { getBuffer } from "../services/buffer";
import { bufferState } from "../crons/buffer-sync";
import { readSettings } from "../routes/settings";
import { weekBounds } from "../domain/slotting";
import { localDate, planPack, postLine, skipToken, starterCaptions, whenLine } from "../domain/photoPosts";
import { hasRules, parseRules, priceList, textProblems, withAiLabel, type ContentRules } from "@shared/contentRules";
import {
  AI_MADE,
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

/** Three short captions from the free AI (OpenRouter free models only), each checked against the rules. */
export async function draftCaptions(env: Env, note: string): Promise<string[]> {
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
      system: `You write short social media captions for ${env.APP_NAME}. Warm, plain, no more than 150 characters each, at most two hashtags, no emojis at the start. ${rulesLine} Reply with JSON only: {"captions": ["...", "...", "..."]} with exactly three different captions.`,
      user: `What the photo shows, in the owner's words: ${note.slice(0, 600) || "(no note: a recent job)"}`,
      json: true,
      maxTokens: 600,
      accept: (t) => /"captions"/.test(t),
    });
    const m = r.ok ? r.text.match(/\{[\s\S]*\}/) : null;
    const list = m ? (JSON.parse(m[0]) as { captions?: unknown }).captions : null;
    const got = Array.isArray(list) ? list.map((c) => String(c ?? "").replace(/\s+/g, " ").trim().slice(0, 220)).filter(Boolean) : [];
    // A draft that breaks a rule is replaced by the starter: the rules win over the AI, always.
    return [0, 1, 2].map((i) => (got[i] && !textProblems(got[i], rules).length ? got[i] : safeStarters[i]));
  } catch (e) {
    log.warn("photos.captions", { err: safeError(e) });
    return safeStarters;
  }
}

// ------------------------------------------------------------------ connections and gates

/** Whether a platform can post now (after hydrate), and the Setup card to open when not. */
export async function platformReady(env: Env, p: Social): Promise<boolean> {
  if (fakeServices(env)) return true;
  if (p === "facebook") return facebookConnected(env);
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
  facebook: "Facebook posts wait until your Facebook Page is connected.",
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
  const plan = planPack(now, cfg, tz, items.map((i) => i.kind), taken, weekFull);
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
  const p = await env.DB.prepare("SELECT scheduled_at FROM social_posts WHERE id = ? AND status = 'skipped'").bind(postId).first<{ scheduled_at: string }>();
  if (!p) return false;
  const cfg = photoConfig(env);
  const at = Date.parse(p.scheduled_at) > now + 3_600_000 ? p.scheduled_at : new Date(now + cfg.headsUpHours * 3_600_000).toISOString();
  await env.DB.prepare("UPDATE social_posts SET status = 'scheduled', skipped_at = NULL, heads_up_at = NULL, scheduled_at = ? WHERE id = ?").bind(at, postId).run();
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
    if (row.platform === "facebook") {
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
  const r = await sendEmail(env, { kind: "heads_up", to: [to], subject: `[Test] ${mail.subject}`, html: mail.html, text: mail.text, refId: results[0].id });
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
  const { results: posts } = await env.DB.prepare("SELECT id, pack_id, item_kind, platform, caption, scheduled_at, status, error, posted_at, url FROM social_posts WHERE pack_id = ? ORDER BY scheduled_at, platform").bind(packId).all<PostRow>();
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
  if (!cfg.on) return { on: false, off_line: "Photo posts are not part of this studio yet. Ask your studio host to switch them on.", stops: [], maker_practice: false, upcoming: [], packs: [], rules: ruleView };
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
  for (const p of cfg.platforms) {
    const ready = await platformReady(env, p);
    await setHealth(env.DB, `Photo posts (${SOCIAL_LABEL[p]})`, ready ? "green" : "grey", ready ? "Connected" : `${connectLabel(p)}: ${CONNECT_WHY[p]}`, ready ? null : `connect-${SOCIAL_SETUP[p] === "buffer" ? "buffer" : p}`);
  }
}

