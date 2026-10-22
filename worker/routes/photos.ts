// Photos (shared/photoPosts.ts): add photos, make a pack of posts from them, see what goes out and
// when, Skip one, change a caption. Everything posts on its own; nothing here posts directly.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { fail, readJson } from "../lib/http";
import { dispatchJob } from "../services/github";
import { readSettings } from "./settings";
import { contentRules, createPack, editCaption, makePack, packView, photoConfig, photosHome, schedulePack, skipPost, unskipPost } from "../lib/photoPosts";
import { textProblems } from "@shared/contentRules";

export const photos = new Hono<{ Bindings: Env; Variables: Vars }>();
photos.use("*", requireUser);

const OFF = "Photo posts are not part of this studio yet. Ask your studio host to switch them on.";
const tz = async (env: Env) => (await readSettings(env).catch(() => null))?.audience_timezone || env.AUDIENCE_TIMEZONE || "America/New_York";

photos.get("/", async (c) => c.json(await photosHome(c.env)));

/** A new set of photos (before the files upload). */
photos.post("/packs", async (c) => {
  if (!photoConfig(c.env).on) return fail(c, 409, OFF, "photo-posts");
  const body = await readJson<{ note?: string }>(c);
  return c.json({ id: await createPack(c.env, String(body?.note ?? "")) });
});

photos.get("/packs/:id", async (c) => {
  const v = await packView(c.env, c.req.param("id"), await tz(c.env));
  if (!v) return fail(c, 404, "That set of photos is gone.", "photo-posts");
  return c.json(v);
});

/** Her note about the photos (what it shows): the captions start from it. Checked against the rules. */
photos.patch("/packs/:id", async (c) => {
  const body = await readJson<{ note?: string }>(c);
  const note = String(body?.note ?? "").slice(0, 2000);
  const problems = textProblems(note, contentRules(c.env));
  if (problems.length) return c.json({ ok: false, problems }, 422);
  await c.env.DB.prepare("UPDATE photo_packs SET note = ? WHERE id = ? AND status IN ('uploading', 'failed')").bind(note, c.req.param("id")).run();
  return c.json({ ok: true, problems: [] });
});

/** "Make my posts". */
photos.post("/packs/:id/make", async (c) => {
  if (!photoConfig(c.env).on) return fail(c, 409, OFF, "photo-posts");
  const r = await makePack(c.env, c.req.param("id"), async (env, packId) => {
    const d = await dispatchJob(env, "photopack", packId);
    return { dispatched: d.dispatched, error: d.error };
  });
  if (!r.ok) return fail(c, 409, r.error ?? "That did not work. Try again.", "photo-posts");
  return c.json({ ok: true });
});

/** Remove a photo before the posts are made. */
photos.delete("/packs/:id/photos/:photoId", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key, upload_id FROM pack_photos WHERE id = ? AND pack_id = ?").bind(c.req.param("photoId"), c.req.param("id")).first<{ r2_key: string; upload_id: string | null }>();
  if (!row) return fail(c, 404, "That photo is not in this set.", "photo-posts");
  if (row.upload_id) {
    try {
      await c.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort();
    } catch {
      /* already gone */
    }
  } else await c.env.FILES.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM pack_photos WHERE id = ?").bind(c.req.param("photoId")).run();
  return c.json({ ok: true });
});

/** Her original photo (signed in only: it may show what the photo check blurs). */
photos.get("/:packId/photo/:photoId", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key, mime_type FROM pack_photos WHERE id = ? AND pack_id = ?").bind(c.req.param("photoId"), c.req.param("packId")).first<{ r2_key: string; mime_type: string }>();
  const obj = row ? await c.env.FILES.get(row.r2_key) : null;
  if (!row || !obj) return c.text("Not found", 404);
  return new Response(obj.body, { headers: { "content-type": row.mime_type || "image/jpeg", "cache-control": "private, max-age=3600" } });
});

/** Skip: this post never goes out. */
photos.post("/posts/:id/skip", async (c) => {
  if (!(await skipPost(c.env, c.req.param("id"), c.get("user").email))) return fail(c, 409, "This post already went out or was skipped.", "photo-posts");
  return c.json({ ok: true });
});

/** Undo a Skip. */
photos.post("/posts/:id/unskip", async (c) => {
  if (!(await unskipPost(c.env, c.req.param("id")))) return fail(c, 409, "This post is not skipped.", "photo-posts");
  return c.json({ ok: true });
});

/** A post that did not go out: plan it again (with a fresh heads-up). */
photos.post("/posts/:id/retry", async (c) => {
  const cfg = photoConfig(c.env);
  const r = await c.env.DB.prepare("UPDATE social_posts SET status = 'scheduled', error = NULL, heads_up_at = NULL, scheduled_at = ? WHERE id = ? AND status = 'failed'").bind(new Date(Date.now() + cfg.headsUpHours * 3_600_000).toISOString(), c.req.param("id")).run();
  if (!r.meta.changes) return fail(c, 409, "This post is not waiting for a retry.", "photo-posts");
  return c.json({ ok: true });
});

/** Change a caption: refused in plain words when it breaks a rule. */
photos.patch("/posts/:id", async (c) => {
  const body = await readJson<{ caption?: string }>(c);
  const r = await editCaption(c.env, c.req.param("id"), String(body?.caption ?? ""));
  if (!r.ok) return c.json({ ok: false, problems: r.problems }, 422);
  return c.json({ ok: true, problems: [] });
});

/** The live check the caption box uses before she saves. */
photos.post("/check", async (c) => {
  const body = await readJson<{ text?: string }>(c);
  return c.json({ problems: textProblems(String(body?.text ?? ""), contentRules(c.env)) });
});

/** Plan a ready pack's posts again (only when none were planned, e.g. the studio was just switched on). */
photos.post("/packs/:id/plan", async (c) => c.json({ planned: await schedulePack(c.env, c.req.param("id")) }));
