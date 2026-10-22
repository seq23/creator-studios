// The one-time "What's new" note (studios/<slug>.json "whatsNew"): shown to the owner until she
// taps Got it, then never again. Stored per user and per note id (whats_new_seen), so a later
// note with a new id shows once the same way. Guard: tests/unit/whats-new.test.ts.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { fail } from "../lib/http";
import { parseWhatsNew, type WhatsNew } from "@shared/photoPosts";

export const whatsNew = new Hono<{ Bindings: Env; Variables: Vars }>();
whatsNew.use("*", requireUser);

/** The note to show this user now, or null (none set, not the owner, or already dismissed). */
export async function noteFor(env: Env, user: { id: string; role: string }): Promise<WhatsNew | null> {
  const note = parseWhatsNew(env.WHATS_NEW);
  if (!note || user.role !== "owner") return null;
  const seen = await env.DB.prepare("SELECT 1 AS x FROM whats_new_seen WHERE user_id = ? AND note_id = ?").bind(user.id, note.id).first();
  return seen ? null : note;
}

whatsNew.get("/", async (c) => c.json({ note: await noteFor(c.env, c.get("user")) }));

/** Got it: never shown to this user again. */
whatsNew.post("/:id/seen", async (c) => {
  const note = parseWhatsNew(c.env.WHATS_NEW);
  if (!note || note.id !== c.req.param("id")) return fail(c, 404, "That note is gone.");
  await c.env.DB.prepare("INSERT OR IGNORE INTO whats_new_seen (user_id, note_id) VALUES (?, ?)").bind(c.get("user").id, note.id).run();
  return c.json({ ok: true });
});
