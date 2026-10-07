import type { Env } from "../env";
import { decryptSecret, encryptSecret } from "./crypto";
import { nowIso } from "./ids";
import { parseJson } from "./db";
import type { ConnectionView } from "@shared/types";

export type Service = ConnectionView["service"];

/** Read a stored vendor key. Returns null when not connected. Never logged. */
export async function getConnectionSecret(env: Env, service: Service): Promise<string | null> {
  const row = await env.DB.prepare("SELECT secret_enc, status FROM connections WHERE service = ?").bind(service).first<{ secret_enc: string | null; status: string }>();
  if (!row?.secret_enc || row.status === "disconnected") return null;
  return decryptSecret(env.SECRETS_KEY, row.secret_enc);
}

export async function saveConnection(env: Env, service: Service, secret: string | null, status: ConnectionView["status"], meta: Record<string, unknown>, lastError: string | null = null) {
  const enc = secret ? await encryptSecret(env.SECRETS_KEY, secret) : null;
  await env.DB.prepare(
    `INSERT INTO connections (service, status, secret_enc, meta, last_ok_at, last_error, updated_at)
     VALUES (?1, ?2, ?3, ?4, CASE WHEN ?2 = 'ok' THEN ?5 ELSE NULL END, ?6, ?5)
     ON CONFLICT(service) DO UPDATE SET
       status = excluded.status,
       secret_enc = COALESCE(excluded.secret_enc, connections.secret_enc),
       meta = excluded.meta,
       last_ok_at = CASE WHEN excluded.status = 'ok' THEN excluded.updated_at ELSE connections.last_ok_at END,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  )
    .bind(service, status, enc, JSON.stringify(meta), nowIso(), lastError)
    .run();
}

export async function markConnection(env: Env, service: Service, status: ConnectionView["status"], lastError: string | null, metaPatch: Record<string, unknown> = {}) {
  const row = await env.DB.prepare("SELECT meta FROM connections WHERE service = ?").bind(service).first<{ meta: string }>();
  const meta = { ...parseJson<Record<string, unknown>>(row?.meta, {}), ...metaPatch };
  await env.DB.prepare(
    `INSERT INTO connections (service, status, meta, last_ok_at, last_error, updated_at)
     VALUES (?1, ?2, ?3, CASE WHEN ?2 = 'ok' THEN ?4 ELSE NULL END, ?5, ?4)
     ON CONFLICT(service) DO UPDATE SET
       status = excluded.status, meta = excluded.meta,
       last_ok_at = CASE WHEN excluded.status = 'ok' THEN excluded.updated_at ELSE connections.last_ok_at END,
       last_error = excluded.last_error, updated_at = excluded.updated_at`,
  )
    .bind(service, status, JSON.stringify(meta), nowIso(), lastError)
    .run();
}

export async function disconnect(env: Env, service: Service) {
  await env.DB.prepare("UPDATE connections SET status = 'disconnected', secret_enc = NULL, updated_at = ? WHERE service = ?").bind(nowIso(), service).run();
}

export async function listConnections(env: Env): Promise<ConnectionView[]> {
  const { results } = await env.DB.prepare("SELECT service, status, meta, last_ok_at, last_error FROM connections").all<{
    service: Service;
    status: ConnectionView["status"];
    meta: string;
    last_ok_at: string | null;
    last_error: string | null;
  }>();
  return results.map((r) => ({ ...r, meta: parseJson<Record<string, unknown>>(r.meta, {}) }));
}
