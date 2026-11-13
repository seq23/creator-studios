// The Rejected bin (owner's ruling, 13 Nov 2026): rejecting never deletes. A reel she rejected and a
// photo post she skipped wait here; "Bring back" returns one to waiting for review (a reel) or to
// its day (a photo post); "Delete for good" removes the made post and its made file, never her
// original photos and videos, and never a post that is planned or already out. Nothing in the bin
// can be planned or sent: the planner, the hourly sync and the photo lane only take approved reels
// and scheduled photo posts. Guard: tests/unit/posts-list.test.ts.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { fail } from "../lib/http";
import { log } from "../lib/log";
import { binList } from "../lib/postsList";
import { deletePostForGood, unskipPost } from "../lib/photoPosts";
import { decide, syncDumpStatus } from "./clips";

export const bin = new Hono<{ Bindings: Env; Variables: Vars }>();
bin.use("*", requireUser);

bin.get("/", async (c) => c.json(await binList(c.env)));

const KEPT = "This one is planned or already went out, so it is kept.";

/** One bin item, deleted for good. Returns why not, in plain words, when it may not be. */
async function removeForGood(env: Env, source: string, id: string, actor: string, touched: Set<string>): Promise<string | null> {
  if (source === "photo") return (await deletePostForGood(env, id, actor)) ? null : "That post is not in the bin any more.";
  const clip = await env.DB.prepare("SELECT status FROM clips WHERE id = ? AND style_of IS NULL").bind(id).first<{ status: string }>();
  if (!clip || clip.status !== "rejected") return "That post is not in the bin any more.";
  const live = await env.DB.prepare("SELECT 1 AS x FROM posts WHERE clip_id = ? AND status IN ('planned', 'in_buffer', 'posted') LIMIT 1").bind(id).first();
  if (live) return KEPT;
  const r = await decide(env, id, "deleted", actor, null, touched);
  return r.ok ? null : (r.error ?? "That did not work. Try again.");
}

/** Bring back: a reel goes back to waiting for review; a photo post goes back on at its time. */
bin.post("/:source{clip|photo}/:id/restore", async (c) => {
  const { source, id } = c.req.param();
  if (source === "photo") {
    if (!(await unskipPost(c.env, id))) return fail(c, 409, "That post is not in the bin any more.");
    return c.json({ ok: true });
  }
  const clip = await c.env.DB.prepare("SELECT status FROM clips WHERE id = ?").bind(id).first<{ status: string }>();
  if (!clip || clip.status !== "rejected") return fail(c, 409, "That post is not in the bin any more.");
  const touched = new Set<string>();
  const r = await decide(c.env, id, "draft", c.get("user").email, null, touched);
  if (!r.ok) return fail(c, (r.status ?? 409) as 404 | 409, r.error ?? "That did not work. Try again.");
  await syncDumpStatus(c.env, touched);
  return c.json({ ok: true });
});

/** Delete for good (the app asks first, on the page). */
bin.delete("/:source{clip|photo}/:id", async (c) => {
  const { source, id } = c.req.param();
  const touched = new Set<string>();
  const why = await removeForGood(c.env, source, id, c.get("user").email, touched);
  await syncDumpStatus(c.env, touched);
  if (why) return fail(c, 409, why);
  log.info("bin.deleted", { source });
  return c.json({ ok: true });
});

/** Empty the whole bin: everything that may be deleted is; anything planned or already out is kept and counted. */
bin.post("/empty", async (c) => {
  const { items } = await binList(c.env);
  const touched = new Set<string>();
  let deleted = 0;
  let kept = 0;
  for (const it of items) {
    if (await removeForGood(c.env, it.source, it.id, c.get("user").email, touched)) kept++;
    else deleted++;
  }
  await syncDumpStatus(c.env, touched);
  log.info("bin.emptied", { deleted, kept });
  return c.json({ ok: true, deleted, kept });
});
