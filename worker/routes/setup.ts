// Setup (studio brief §3): the guided screen where a studio's owner pastes each of her own service
// keys. Every step: where to get it, Test key (one live read-only probe, nothing saved), Save (the
// same probe, then stored AES-GCM encrypted in D1 connections.secret_enc with SECRETS_KEY), Remove.
// Until a step has a key its feature runs in practice mode (worker/lib/practice.ts).
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { disconnect, listConnections, saveConnection, type Service } from "../lib/connections";
import { recordEvent, setHealth } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { log } from "../lib/log";
import { hasEnvKey } from "../lib/practice";
import { checkGithubRunner, checkGoogleApp, checkMetaApp, checkResend, checkYouTubeKey, type KeyCheck } from "../services/keychecks";
import { CHECKS, writeServiceHealth } from "./connections";
import { SETUP_STEPS, setupStep, type SetupServiceId, type SetupStatus, type SetupView } from "@shared/setup";

export const setup = new Hono<{ Bindings: Env; Variables: Vars }>();
setup.use("*", requireUser);

const LIGHT: Partial<Record<SetupServiceId, string>> = {
  resend: "Email (Resend)",
  github: "Job runner (GitHub)",
  youtube_api: "YouTube numbers",
  google_app: "Google sign-in",
  meta_app: "Instagram sign-in",
};

/** The pasted fields → the value stored (a bare key, or JSON for a multi-field step). Pure. */
export function storedValue(id: SetupServiceId, fields: Record<string, string>): { value: string; plain: Record<string, string> } | { error: string } {
  const step = setupStep(id)!;
  const clean: Record<string, string> = {};
  for (const f of step.fields) {
    const v = (fields[f.name] ?? "").trim();
    if (!v && !f.optional) return { error: `Paste the ${f.label.toLowerCase()}.` };
    if (v.length > 400) return { error: `The ${f.label.toLowerCase()} is too long. Paste just the value.` };
    if (v) clean[f.name] = v;
  }
  const plain = Object.fromEntries(step.fields.filter((f) => f.plain && clean[f.name]).map((f) => [f.name, clean[f.name]]));
  if (step.fields.length === 1) return { value: clean.key, plain };
  return { value: JSON.stringify(clean), plain };
}

/** One live read-only probe of the pasted fields. */
export async function probe(env: Env, id: SetupServiceId, fields: Record<string, string>): Promise<KeyCheck & { note?: string }> {
  const f = (k: string) => (fields[k] ?? "").trim();
  switch (id) {
    case "resend":
      return checkResend(env, f("key"));
    case "youtube_api":
      return checkYouTubeKey(env, f("key"));
    case "google_app":
      return checkGoogleApp(env, f("client_id"), f("client_secret"));
    case "meta_app":
      return checkMetaApp(env, f("app_id"), f("app_secret"));
    case "github":
      return checkGithubRunner(env, f("token"), f("repo"));
    default: {
      const check = CHECKS[id as Service];
      if (!check) return { ok: false, error: "That service does not take a key here.", meta: {} };
      return check(env, f("key"));
    }
  }
}

export async function setupView(env: Env, isOwner: boolean): Promise<SetupView> {
  const rows = new Map((await listConnections(env)).map((r) => [r.service as string, r]));
  const steps: SetupStatus[] = SETUP_STEPS.map((s) => {
    const row = rows.get(s.id);
    const shown = Object.fromEntries(Object.entries((row?.meta ?? {}) as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && s.fields.some((f) => f.plain && f.name === k)) as [string, string][]);
    // meta.host: no key of her own, the host's runs it (worker/lib/connections.ts listConnections) → "provided" below.
    if (row && row.status === "ok" && !row.meta.host) return { id: s.id, state: "live", shown, last_error: null };
    if (row && row.status === "error") return { id: s.id, state: "error", shown, last_error: row.last_error };
    if (s.secrets.length && hasEnvKey(env, s.id)) return { id: s.id, state: "provided", shown: {}, last_error: null };
    return { id: s.id, state: "practice", shown: {}, last_error: null };
  });
  const github = steps.find((s) => s.id === "github")!;
  return {
    steps,
    redirects: { google: `${env.PUBLIC_BASE_URL}/api/oauth/google/callback`, meta: `${env.PUBLIC_BASE_URL}/api/oauth/meta/callback` },
    // The job repository's JOB_SHARED_SECRET: only the owner sees it, and only when she runs her own job repository.
    job_secret: isOwner && github.state !== "provided" ? env.JOB_SHARED_SECRET : null,
  };
}

setup.get("/", async (c) => c.json(await setupView(c.env, c.get("user").role === "owner")));

function stepOr404(id: string | undefined): SetupServiceId | null {
  return id && setupStep(id) ? (id as SetupServiceId) : null;
}

/** Test key: one live read-only probe; nothing is stored. */
setup.post("/:service/test", requireOwner, async (c) => {
  const id = stepOr404(c.req.param("service"));
  if (!id) return fail(c, 404, "Unknown setup step.");
  const body = (await readJson<{ fields?: Record<string, string> }>(c)) ?? {};
  const parsed = storedValue(id, body.fields ?? {});
  if ("error" in parsed) return fail(c, 400, parsed.error);
  const r = await probe(c.env, id, body.fields ?? {});
  log.info("setup.test", { service: id, ok: r.ok });
  return r.ok ? c.json({ ok: true, meta: r.meta, note: r.note ?? null }) : fail(c, 422, r.error ?? "That key did not work.", setupStep(id)!.guide);
});

/** Save: the same probe, then the value is stored encrypted. A key that fails is never stored. */
setup.post("/:service/save", requireOwner, async (c) => {
  const id = stepOr404(c.req.param("service"));
  if (!id) return fail(c, 404, "Unknown setup step.");
  const body = (await readJson<{ fields?: Record<string, string> }>(c)) ?? {};
  const parsed = storedValue(id, body.fields ?? {});
  if ("error" in parsed) return fail(c, 400, parsed.error);
  const r = await probe(c.env, id, body.fields ?? {});
  if (!r.ok) return fail(c, 422, r.error ?? "That key did not work.", setupStep(id)!.guide);
  await saveConnection(c.env, id as Service, parsed.value, "ok", { ...r.meta, ...parsed.plain });
  if (CHECKS[id as Service]) await writeServiceHealth(c.env, id as Service, true, null, r.meta);
  else await setHealth(c.env.DB, LIGHT[id] ?? id, "green", "Set up", null);
  await recordEvent(c.env.DB, "setup.saved", id, {}, c.get("user").email);
  log.info("setup.saved", { service: id });
  return c.json({ ok: true, note: r.note ?? null });
});

/** Remove: the stored key is deleted; the feature goes back to practice (or to the host's key). */
setup.post("/:service/remove", requireOwner, async (c) => {
  const id = stepOr404(c.req.param("service"));
  if (!id) return fail(c, 404, "Unknown setup step.");
  await disconnect(c.env, id as Service);
  await setHealth(c.env.DB, LIGHT[id] ?? id, "grey", "Practice mode", setupStep(id)!.guide);
  await recordEvent(c.env.DB, "setup.removed", id, {}, c.get("user").email);
  return c.json({ ok: true });
});
