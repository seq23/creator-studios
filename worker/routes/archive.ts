// Archive and restore (day 358, docs/reviews/2026-09-26-day-358.md). Archive is not delete: an
// archived dump, deal, research brief or voice over leaves its list (and Home) and waits under
// "Show archived"; Restore puts it back. The screens call archive, then offer Undo = restore.
// Also: storage (the meter in Settings, Measure now) and Tidy up (the switch and its ages).
//   POST /api/archive/:kind/:id          kind: dump | deal | brief | voice
//   POST /api/archive/:kind/:id/restore
//   GET  /api/archive/storage            the meter (worker/lib/storage.ts storageReport)
//   POST /api/archive/storage/measure    list the bucket now, then the meter
//   PATCH /api/archive/tidy              { on: boolean }
//   POST /api/archive/storage/own/test   Use your own storage: Test connection (write, read, delete a probe; nothing saved)
//   POST /api/archive/storage/own        the same check, then saved encrypted (connections "storage"); new files go there
//   POST /api/archive/storage/own/remove back to the studio's shared storage (or none); her bucket stays readable, never written or cleared
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { recordEvent, setSetting } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { measureStorage, storageHealth, storageReport } from "../lib/storage";
import { FILES, HOST_STORAGE, STORAGE, TIDY } from "../domain/tidy";
import { saveConnection } from "../lib/connections";
import { decryptSecret } from "../lib/crypto";
import { readOwnStorage, type OwnStorageSaved } from "../lib/practice";
import { ownStorageConfig, probeFiles, S3Files, type OwnStorageFields } from "../services/s3files";

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

archive.get("/storage", async (c) => c.json({ ...(await storageReport(c.env)), rules: { tidy: TIDY, files: FILES, storage: { yellowAt: STORAGE.yellowAt, redAt: STORAGE.redAt }, host: HOST_STORAGE } }));

/** Her pasted fields, checked live (probe). The fetcher is swappable for tests. */
export async function checkOwnStorage(body: Partial<OwnStorageFields> | null, fetcher: typeof fetch = fetch) {
  const parsed = ownStorageConfig(body ?? {});
  if (!parsed.ok) return { ok: false as const, error: parsed.error };
  const probe = await probeFiles(new S3Files(parsed.cfg, fetcher) as unknown as R2Bucket);
  return probe.ok ? { ok: true as const, cfg: parsed.cfg } : { ok: false as const, error: probe.error, step: probe.step };
}

archive.post("/storage/own/test", requireOwner, async (c) => {
  const r = await checkOwnStorage(await readJson<OwnStorageFields>(c));
  log.info("storage.own_test", { ok: r.ok });
  return r.ok ? c.json({ ok: true, line: "Connected: a test file was written, read back and deleted." }) : c.json({ ok: false, error: r.error }, 422);
});

/** What is saved now (current + the buckets she used before); empty when nothing is. */
async function savedStorage(env: Env): Promise<OwnStorageSaved> {
  const row = await env.DB.prepare("SELECT secret_enc FROM connections WHERE service = 'storage'").first<{ secret_enc: string | null }>();
  if (!row?.secret_enc) return { current: null, previous: [] };
  return readOwnStorage(await decryptSecret(env.SECRETS_KEY, row.secret_enc));
}

const same = (a: OwnStorageFields, b: OwnStorageFields) => a.endpoint === b.endpoint && a.bucket === b.bucket;

/** A bucket she leaves stays readable (her old files still open): it joins previous once. */
function retire(saved: OwnStorageSaved, next: OwnStorageFields | null): OwnStorageSaved {
  const previous = saved.current && !(next && same(saved.current, next)) ? [...saved.previous.filter((p) => !same(p, saved.current!)), saved.current] : saved.previous;
  return { current: next, previous: previous.filter((p) => !(next && same(p, next))).slice(-5) };
}

archive.post("/storage/own", requireOwner, async (c) => {
  const r = await checkOwnStorage(await readJson<OwnStorageFields>(c));
  if (!r.ok) return c.json({ ok: false, error: r.error }, 422);
  const { endpoint, bucket, accessKeyId, secretAccessKey } = r.cfg;
  const at = nowIso();
  let saved: OwnStorageSaved;
  try {
    saved = await savedStorage(c.env);
  } catch {
    return fail(c, 409, "Your saved storage settings could not be read, so nothing was changed. Try again in a minute.", "own-storage");
  }
  const next = retire(saved, { endpoint, bucket, access_key_id: accessKeyId, secret_access_key: secretAccessKey });
  await saveConnection(c.env, "storage", JSON.stringify(next), "ok", { bucket, host: new URL(endpoint).host, saved_at: at });
  await recordEvent(c.env.DB, "storage.own_saved", null, { host: new URL(endpoint).host, before: next.previous.length }, c.get("user").email);
  log.info("storage.own_saved");
  return c.json({ ok: true, line: `Saved. New uploads and clips now go to ${bucket}.` });
});

archive.post("/storage/own/remove", requireOwner, async (c) => {
  let saved: OwnStorageSaved;
  try {
    saved = await savedStorage(c.env);
  } catch {
    return fail(c, 409, "Your saved storage settings could not be read, so nothing was changed. Try again in a minute.", "own-storage");
  }
  if (!saved.current) return c.json({ ok: true });
  await saveConnection(c.env, "storage", JSON.stringify(retire(saved, null)), "ok", { removed_at: nowIso() });
  await recordEvent(c.env.DB, "storage.own_removed", null, {}, c.get("user").email);
  log.info("storage.own_removed");
  return c.json({ ok: true });
});

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
