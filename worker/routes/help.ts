// Help center (section 12c). Guides are Markdown in help/guides, bundled into the client at
// build time (import.meta.glob), so a text change needs no code change and still ships with
// the build. The API only stores "Did this work?" and "Report a problem with this guide".
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId } from "../lib/ids";
import { log } from "../lib/log";

export const help = new Hono<{ Bindings: Env; Variables: Vars }>();
help.use("*", requireUser);

help.post("/feedback", async (c) => {
  const body = await readJson<{ slug?: string; worked?: boolean; note?: string; kind?: "worked" | "problem" }>(c);
  if (!body?.slug || !/^[a-z0-9-]{2,80}$/.test(body.slug) || typeof body.worked !== "boolean") return fail(c, 400, "Missing guide.");
  const id = newId("hf");
  await c.env.DB.prepare("INSERT INTO help_feedback (id, guide_slug, worked, note) VALUES (?, ?, ?, ?)")
    .bind(id, body.slug, body.worked ? 1 : 0, (body.note ?? "").slice(0, 1000))
    .run();
  if (body.kind === "problem") await recordEvent(c.env.DB, "help.guide_problem", body.slug, {}, c.get("user").email);
  log.info("help.feedback", { worked: body.worked, problem: body.kind === "problem" });
  return c.json({ ok: true, id });
});
