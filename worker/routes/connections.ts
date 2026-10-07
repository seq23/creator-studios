// Connect accounts (section 4b). Paste-a-key services are checked live and stored
// encrypted. Meta/Google OAuth for stats is Phase 3 and registers its start/callback here.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { disconnect, listConnections, saveConnection, type Service } from "../lib/connections";
import { recordEvent, setHealth } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { log } from "../lib/log";
import { checkBufferKey, checkEditor, checkElevenLabs, checkFirecrawl, checkHunter, checkOpenRouter } from "../services/keychecks";
import { API_EDITORS, isApiEditor } from "../domain/editors";
import { writeEditorCheckLight } from "../lib/editorJobs";
import type { KeyCheck } from "../services/keychecks";
import { writeLight as writeYouTubeLight } from "../lib/youtubeDirect";
import { dropPremiumVoice, ensurePremiumVoice, planFromMeta, recheckElevenLabs, writeElevenLabsLight } from "../lib/premiumVoice";

export const connections = new Hono<{ Bindings: Env; Variables: Vars }>();
connections.use("*", requireUser);

connections.get("/", async (c) => c.json(await listConnections(c.env)));

export const CHECKS: Partial<Record<Service, (env: Env, key: string) => Promise<KeyCheck>>> = {
  buffer: checkBufferKey,
  openrouter: checkOpenRouter,
  firecrawl: checkFirecrawl,
  hunter: checkHunter,
  elevenlabs: checkElevenLabs,
  ...Object.fromEntries(API_EDITORS.map((e) => [e, checkEditor(e)])),
};

/** Paste a key → live check → stored encrypted only if it works. */
connections.post("/:service/key", requireOwner, async (c) => {
  const service = c.req.param("service") as Service;
  const check = CHECKS[service];
  if (!check) return fail(c, 404, "That service does not take a pasted key.");
  const body = await readJson<{ key?: string }>(c);
  const key = body?.key?.trim();
  if (!key || key.length < 8 || key.length > 512) return fail(c, 400, "Paste the whole key.");
  const r = await check(c.env, key);
  if (!r.ok) {
    await saveConnection(c.env, service, null, "error", r.meta, r.error);
    return fail(c, 422, r.error ?? "That key did not work.", `connect-${service}`);
  }
  await saveConnection(c.env, service, key, "ok", r.meta);
  await writeServiceHealth(c.env, service, true, null, r.meta);
  await recordEvent(c.env.DB, "connection.ok", service, {}, c.get("user").email);
  log.info("connection.ok", { service });
  const note = (r as KeyCheck & { note?: string }).note ?? null;
  return c.json({ ok: true, meta: r.meta, note });
});

/** Re-run the check with the stored key (the "Check again" button). */
connections.post("/:service/recheck", async (c) => {
  const service = c.req.param("service") as Service;
  const check = CHECKS[service];
  if (!check) return fail(c, 404, "That service cannot be rechecked here.");
  const { getConnectionSecret, markConnection } = await import("../lib/connections");
  const key = await getConnectionSecret(c.env, service);
  if (!key) return fail(c, 409, "Not connected yet.", `connect-${service}`);
  if (service === "elevenlabs") {
    // One code path with the daily lane: a slow answer is not a refused key, and the light and
    // the connection come from the same read.
    await recheckElevenLabs(c.env);
    const row = (await listConnections(c.env)).find((x) => x.service === "elevenlabs");
    return row?.status === "ok" ? c.json({ ok: true, meta: row.meta }) : fail(c, 422, row?.last_error ?? "ElevenLabs did not answer. Try again in a minute.", "reconnect-elevenlabs");
  }
  const r = await check(c.env, key);
  await markConnection(c.env, service, r.ok ? "ok" : "error", r.error, r.meta);
  await writeServiceHealth(c.env, service, r.ok, r.error ?? null, r.meta);
  return r.ok ? c.json({ ok: true, meta: r.meta }) : fail(c, 422, r.error ?? "Check failed.", `reconnect-${service}`);
});

/**
 * The health rows a key check owns. Buffer's are the hourly lane's: "Buffer" plus one light per
 * channel, written by the same code the cron and "Check everything now" run, so a pasted key and
 * the next hourly check can never disagree (a missing channel is yellow, a failed post stays red).
 * The bare `buffer` row is not written here: it read red for a missing platform and green for a
 * channel with a failed post, and Settings had to fold it away.
 */
export async function writeServiceHealth(env: Env, service: Service, ok: boolean, error: string | null, meta: Record<string, unknown> = {}) {
  if (service === "buffer") {
    await (await import("../crons/buffer-sync")).recheckEverything(env);
    return;
  }
  if (service === "elevenlabs") {
    // The one "Voice · ElevenLabs" light (never a bare "elevenlabs" row beside it), then the
    // premium clone from the sample she already saved, if her plan allows it.
    const plan = planFromMeta(meta);
    await writeElevenLabsLight(env, ok && plan ? { state: "ok", plan } : { state: "refused" });
    if (ok) await ensurePremiumVoice(env);
    return;
  }
  if (isApiEditor(service)) {
    // A connected editor's light: yellow when its credits are nearly gone (when its API says so).
    await writeEditorCheckLight(env, service, ok, error, meta);
    return;
  }
  await setHealth(env.DB, service, ok ? "green" : "red", ok ? "Connected" : (error ?? "Needs you"), ok ? null : `reconnect-${service}`);
}

connections.post("/:service/disconnect", requireOwner, async (c) => {
  const service = c.req.param("service") as Service;
  // The clone lives in her ElevenLabs account: delete it while the key still works.
  if (service === "elevenlabs") await dropPremiumVoice(c.env, "disconnect");
  await disconnect(c.env, service);
  if (service === "elevenlabs") await writeElevenLabsLight(c.env, { state: "not_connected" });
  else if (service === "youtube") await writeYouTubeLight(c.env);
  else await setHealth(c.env.DB, service, "grey", "Disconnected", `connect-${service}`);
  await recordEvent(c.env.DB, "connection.disconnected", service, {}, c.get("user").email);
  return c.json({ ok: true });
});

connections.post("/disconnect-all", requireOwner, async (c) => {
  const all: Service[] = ["buffer", "openrouter", "firecrawl", "resend", "hunter", "meta", "google", "tiktok", "github", "elevenlabs", "youtube", ...API_EDITORS];
  await dropPremiumVoice(c.env, "disconnect");
  for (const s of all) {
    await disconnect(c.env, s);
    if (s === "elevenlabs") await writeElevenLabsLight(c.env, { state: "not_connected" });
    else if (s === "youtube") await writeYouTubeLight(c.env);
    else await setHealth(c.env.DB, s, "grey", "Disconnected", `connect-${s}`);
  }
  await recordEvent(c.env.DB, "connection.disconnected_all", null, {}, c.get("user").email);
  return c.json({ ok: true });
});
