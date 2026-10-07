// Archive and restore (day 358, docs/reviews/2026-09-26-day-358.md). Archive is not delete: an
// archived dump, deal, research brief or voice over leaves its list (and Home) and waits under
// "Show archived"; Restore puts it back. The screens call archive, then offer Undo = restore.
// Also: storage (the meter in Settings, Measure now) and Tidy up (the switch and its ages).
//   POST /api/archive/:kind/:id          kind: dump | deal | brief | voice
//   POST /api/archive/:kind/:id/restore
//   GET  /api/archive/storage            the meter (worker/lib/storage.ts storageReport)
//   POST /api/archive/storage/measure    list the bucket now, then the meter
//   PATCH /api/archive/tidy              { on: boolean }
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { recordEvent, setSetting } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { measureStorage, storageHealth, storageReport } from "../lib/storage";
import { FILES, STORAGE, TIDY } from "../domain/tidy";

export const archive = new Hono<{ Bindings: Env; Variables: Vars }>();
archive.use("*", requireUser);

/** Each archivable thing: its table and key column. One list, read by both routes and the tests. */
export const ARCHIVABLE = {
  dump: { table: "dumps", key: "id" },
  deal: { table: "deals", key: "id" },
  brief: { table: "research_briefs", key: "version" },
  voice: { table: "narrations", key: "id" },
} as const;
type Kind = keyof typeof ARCHIVABLE;

function kindOf(k: string | undefined): Kind | null {
  return k && k in ARCHIVABLE ? (k as Kind) : null;
}

archive.get("/storage", async (c) => c.json({ ...(await storageReport(c.env)), rules: { tidy: TIDY, files: FILES, storage: { yellowAt: STORAGE.yellowAt, redAt: STORAGE.redAt } } }));

archive.post("/storage/measure", async (c) => {
  await measureStorage(c.env);
  await storageHealth(c.env);
  await recordEvent(c.env.DB, "storage.measured", null, {}, c.get("user").email);
  return c.json(await storageReport(c.env));
});

archive.patch("/tidy", requireOwner, async (c) => {
  const body = await readJson<{ on?: boolean }>(c);
  if (typeof body?.on !== "boolean") return fail(c, 400, "Say on or off.");
  await setSetting(c.env.DB, "tidy", { on: body.on });
  await recordEvent(c.env.DB, "settings.tidy", null, { on: body.on }, c.get("user").email);
  return c.json({ ok: true, on: body.on });
});

async function setArchived(c: Context<{ Bindings: Env; Variables: Vars }>, on: boolean) {
  const kind = kindOf(c.req.param("kind"));
  if (!kind) return fail(c, 404, "That can't be archived.");
  const { table, key } = ARCHIVABLE[kind];
  const id = c.req.param("id") ?? "";
  const r = on
    ? await c.env.DB.prepare(`UPDATE ${table} SET archived_at = ?, archived_by = 'her' WHERE ${key} = ?`).bind(nowIso(), id).run()
    : await c.env.DB.prepare(`UPDATE ${table} SET archived_at = NULL, archived_by = NULL WHERE ${key} = ?`).bind(id).run();
  if (!Number(r.meta?.changes ?? 0)) return fail(c, 404, "That is no longer here.");
  await recordEvent(c.env.DB, on ? `${kind}.archived` : `${kind}.restored`, String(id), {}, c.get("user").email);
  log.info(on ? "archive.done" : "archive.restored", { kind });
  return c.json({ ok: true, kind, id, archived: on });
}

archive.post("/:kind/:id", (c) => setArchived(c, true));
archive.post("/:kind/:id/restore", (c) => setArchived(c, false));
