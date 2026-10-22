// The photo maker (jobs/photopack.py, GitHub Actions with ffmpeg, the same runner that cuts clips):
// one pack of photos → a slow-zoom reel, a before/after video when a before and an after photo
// exist, a carousel of checked photos, and the photo check (faces and house numbers blurred).
//
// buildSpec   → the pack's photos (key + role) and exactly where each output goes; with a Hugging
//               Face token (Setup "Connect Hugging Face", or the studio's HF_TOKEN secret) the reel
//               asks for realistic motion (owner's word 22 Oct 2026), with the slow zoom as the
//               fallback the job uses whenever the free model is busy or fails. No token: no
//               motion block, so the job makes no Hugging Face call at all.
// applyResult → every output must be in the pack's out folder and in storage; then
//               worker/lib/photoPosts.ts finishPack stores it and plans the posts.
// onFailure   → the pack says what happened, in plain words.
// fakeRun     → FAKE_SERVICES=1 (local, e2e): tiny real files where the real job writes them,
//               photo check "clean". Practice mode (a studio with no job runner): nothing can be
//               rendered or checked in the Worker, so the carousel uses the JPEG/PNG uploads as
//               they are, the videos wait for the photo maker, and the photo check stays
//               "unchecked" (a studio with face/address rules holds every post until it runs).
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { fakeServices } from "../env";
import { unb64 } from "../lib/crypto";
import { log } from "../lib/log";
import { contentRules, finishPack, packOutPrefix, type MadeItem } from "../lib/photoPosts";
import { FAKE_JPG_B64, FAKE_MP4_B64 } from "./cut";
import type { ItemKind } from "@shared/photoPosts";

interface PhotoRow {
  id: string;
  role: "main" | "before" | "after";
  r2_key: string;
  mime_type: string;
}

async function photos(env: Env, packId: string): Promise<PhotoRow[]> {
  const { results } = await env.DB.prepare("SELECT id, role, r2_key, mime_type FROM pack_photos WHERE pack_id = ? AND upload_status = 'uploaded' ORDER BY created_at").bind(packId).all<PhotoRow>();
  return results;
}

export const outKeys = (packId: string, n: number) => {
  const o = packOutPrefix(packId);
  return {
    reel: `${o}reel.mp4`,
    reel_cover: `${o}reel.jpg`,
    before_after: `${o}before-after.mp4`,
    before_after_cover: `${o}before-after.jpg`,
    carousel: Array.from({ length: n }, (_, i) => `${o}photo-${i + 1}.jpg`),
  };
};

/** A before AND an after photo make a before/after. */
export const hasBeforeAfter = (ps: Pick<PhotoRow, "role">[]) => ps.some((p) => p.role === "before") && ps.some((p) => p.role === "after");

export async function buildPackSpec(env: Env, jobId: string, packId: string) {
  const ps = await photos(env, packId);
  if (!ps.length) throw new Error("the pack has no photos");
  const rules = contentRules(env);
  return {
    job_id: jobId,
    type: "photopack",
    pack_id: packId,
    photos: ps.map((p) => ({ key: p.r2_key, role: p.role })),
    // The photo check always runs; with these on, a face or house number it cannot hide blocks the pack.
    blur_faces: true,
    blur_numbers: true,
    strict: rules.blockFaces || rules.blockAddresses,
    out: outKeys(packId, ps.length),
    before_after: hasBeforeAfter(ps),
    ...motionSpec(env),
  };
}

/**
 * Realistic motion for the reel: present only when the studio has a Hugging Face token. The token
 * travels only in this signed spec (as the research job's keys do), is never logged, and the job
 * falls back to the slow zoom on any failure. Pure.
 */
export function motionSpec(env: Pick<Env, "HF_TOKEN">): { motion?: { engine: "hf-wan2.2"; hf_token: string } } {
  const token = (env.HF_TOKEN ?? "").trim();
  return token ? { motion: { engine: "hf-wan2.2", hf_token: token } } : {};
}

interface PackResult {
  privacy?: { status?: string; faces?: number; numbers?: number };
  /** How the reel moved: "realistic" (the open-source model) or "slow-zoom" (ffmpeg; also the fallback). */
  motion?: string;
  items?: { kind?: string; key?: string | null; cover_key?: string | null; images?: string[] }[];
}

/** The job's answer, checked: only this pack's out folder, known kinds, a known photo check. Pure. */
export function parsePackResult(result: unknown, packId: string): { items: MadeItem[]; privacy: "unchecked" | "clean" | "fixed" | "blocked"; detail: Record<string, number>; motion: "realistic" | "slow-zoom" } {
  const r = (result ?? {}) as PackResult;
  const o = packOutPrefix(packId);
  const mine = (k: unknown): k is string => typeof k === "string" && k.startsWith(o) && !k.includes("..");
  const status = r.privacy?.status;
  const privacy = status === "clean" || status === "fixed" || status === "blocked" || status === "unchecked" ? status : "blocked";
  const items: MadeItem[] = [];
  for (const it of r.items ?? []) {
    const kind = it.kind as ItemKind;
    if (!["reel", "before_after", "carousel"].includes(kind)) throw new Error("photo pack result has an unknown piece");
    if (it.key != null && !mine(it.key)) throw new Error("photo pack result is not for this pack");
    if (it.cover_key != null && !mine(it.cover_key)) throw new Error("photo pack result is not for this pack");
    const images = (it.images ?? []).filter(mine);
    if ((it.images ?? []).length !== images.length) throw new Error("photo pack result is not for this pack");
    items.push({ kind, r2_key: it.key ?? null, cover_r2_key: it.cover_key ?? null, images });
  }
  if (!items.length) throw new Error("photo pack result made nothing");
  return { items, privacy, detail: { faces: Number(r.privacy?.faces) || 0, numbers: Number(r.privacy?.numbers) || 0 }, motion: r.motion === "realistic" ? "realistic" : "slow-zoom" };
}

export const photoPackJob: JobHandler = {
  buildSpec: (env, jobId, refId) => buildPackSpec(env, jobId, refId ?? ""),
  async applyResult(env, _jobId, refId, result) {
    const packId = refId ?? "";
    const p = parsePackResult(result, packId);
    for (const it of p.items) for (const k of [it.r2_key, it.cover_r2_key, ...it.images]) if (k && !(await env.FILES.head(k))) throw new Error("a photo pack file is not in storage");
    await finishPack(env, packId, p.items, p.privacy, p.detail);
    log.info("photos.made", { pieces: p.items.length, privacy: p.privacy, motion: p.motion });
  },
  async onFailure(env, _jobId, refId, safeError) {
    await env.DB.prepare("UPDATE photo_packs SET status = 'failed', error = ? WHERE id = ?").bind(`The photo maker stopped: ${safeError}`.slice(0, 300), refId).run();
  },
  async fakeRun(env, _jobId, refId) {
    const packId = refId ?? "";
    const ps = await photos(env, packId);
    const keys = outKeys(packId, ps.length);
    if (fakeServices(env)) {
      const jpg = unb64(FAKE_JPG_B64[0]);
      const mp4 = unb64(FAKE_MP4_B64);
      await env.FILES.put(keys.reel, mp4, { httpMetadata: { contentType: "video/mp4" } });
      await env.FILES.put(keys.reel_cover, jpg, { httpMetadata: { contentType: "image/jpeg" } });
      for (const k of keys.carousel) await env.FILES.put(k, jpg, { httpMetadata: { contentType: "image/jpeg" } });
      const items = [
        { kind: "reel", key: keys.reel, cover_key: keys.reel_cover },
        { kind: "carousel", key: null, cover_key: null, images: keys.carousel },
      ];
      if (hasBeforeAfter(ps)) {
        await env.FILES.put(keys.before_after, mp4, { httpMetadata: { contentType: "video/mp4" } });
        await env.FILES.put(keys.before_after_cover, jpg, { httpMetadata: { contentType: "image/jpeg" } });
        items.push({ kind: "before_after", key: keys.before_after, cover_key: keys.before_after_cover });
      }
      return { privacy: { status: "clean", faces: 0, numbers: 0 }, items };
    }
    // Practice: the uploads as they are (JPEG/PNG only: a HEIC needs the photo maker), nothing rendered or checked.
    const usable = ps.filter((p) => p.mime_type === "image/jpeg" || p.mime_type === "image/png");
    const images: string[] = [];
    for (const [i, p] of usable.entries()) {
      const obj = await env.FILES.get(p.r2_key);
      if (!obj) continue;
      const k = keys.carousel[i];
      await env.FILES.put(k, await obj.arrayBuffer(), { httpMetadata: { contentType: p.mime_type } });
      images.push(k);
    }
    const items: { kind: string; key: string | null; cover_key: string | null; images?: string[] }[] = [{ kind: "reel", key: null, cover_key: null }];
    if (images.length) items.push({ kind: "carousel", key: null, cover_key: null, images });
    if (hasBeforeAfter(ps)) items.push({ kind: "before_after", key: null, cover_key: null });
    return { privacy: { status: "unchecked" }, items };
  },
};
