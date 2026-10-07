import type { Env } from "../env";
import { newId, nowIso } from "./ids";

/** Read one JSON setting with a typed default. */
export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), nowIso())
    .run();
}

export async function recordEvent(db: D1Database, kind: string, refId: string | null, detail: Record<string, unknown> = {}, actor = "system") {
  await db
    .prepare("INSERT INTO events (id, kind, ref_id, detail, actor) VALUES (?, ?, ?, ?, ?)")
    .bind(newId("evt"), kind, refId, JSON.stringify(detail), actor)
    .run();
}

export async function setHealth(db: D1Database, name: string, light: "green" | "yellow" | "red" | "grey", note: string, fixGuide: string | null = null) {
  await db
    .prepare(
      "INSERT INTO health (name, light, note, fix_guide, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET light = excluded.light, note = excluded.note, fix_guide = excluded.fix_guide, checked_at = excluded.checked_at",
    )
    .bind(name, light, note, fixGuide, nowIso())
    .run();
}

export async function listHealth(db: D1Database) {
  const { results } = await db.prepare("SELECT name, light, note, fix_guide, checked_at FROM health ORDER BY name").all<{
    name: string;
    light: "green" | "yellow" | "red" | "grey";
    note: string;
    fix_guide: string | null;
    checked_at: string;
  }>();
  return results;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type Db = Env["DB"];
