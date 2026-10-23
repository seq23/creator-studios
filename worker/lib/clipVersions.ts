// Versions of one clip (studio fix, 23 Oct 2026). "Try another version" and the one-tap fixes in
// Review make a new version of the SAME clip: it keeps its number and takes the next letter (5, 5b,
// 5c), and the version it replaces is kept here, files and all, so she can compare and keep the
// best ("Keep this one" swaps it back in). A version's files go only when the clip itself goes.
// Guard: tests/unit/clip-numbers.test.ts.
import type { Env } from "../env";
import { newId } from "./ids";
import { parseJson } from "./db";
import { clipCode } from "@shared/clipNumber";

/** The clip's fields a version carries (everything that differs between two cuts of it). */
export const VERSION_FIELDS = [
  "asset_id", "start_s", "end_s", "recipe", "hook_text", "hook_alt", "caption", "hashtags", "score", "r2_key", "cover_r2_key", "look", "parts", "layout",
  "music", "speech", "muted", "shape", "service", "on_screen", "part_assets", "hidden_reason", "hidden", "version",
  "clip_type", "score_reasons", "hero_asset_id", "files_used", "uses_ai_images", "event_group", "words_pending",
] as const;
type Field = (typeof VERSION_FIELDS)[number];
type Snapshot = Record<Field, unknown>;

/** Save the clip as it is now as one of its versions (before a new version replaces it). */
export async function keepVersion(env: Env, clipId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${VERSION_FIELDS.join(", ")} FROM clips WHERE id = ?`).bind(clipId).first<Snapshot>();
  if (!row || typeof row.r2_key !== "string") return;
  await env.DB.prepare("INSERT INTO clip_versions (id, clip_id, version, snapshot, r2_key, cover_r2_key, score) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("cvr"), clipId, Number(row.version) || 1, JSON.stringify(row), row.r2_key, (row.cover_r2_key as string | null) ?? null, Number(row.score) || 0)
    .run();
}

export interface VersionView {
  id: string;
  version: number;
  code: string;
  score: number;
  score_reasons: string[];
  hook_text: string;
  media_url: string;
  cover_url: string | null;
  created_at: string;
}

/** Her earlier versions of a clip, newest first, each playable on her own screens. */
export async function listVersions(env: Env, clipId: string): Promise<VersionView[]> {
  const clip = await env.DB.prepare("SELECT number FROM clips WHERE id = ?").bind(clipId).first<{ number: number | null }>();
  const { results } = await env.DB.prepare("SELECT id, version, snapshot, score, cover_r2_key, created_at FROM clip_versions WHERE clip_id = ? ORDER BY version DESC").bind(clipId).all<{ id: string; version: number; snapshot: string; score: number; cover_r2_key: string | null; created_at: string }>();
  return results.map((v) => {
    const snap = parseJson<Partial<Snapshot>>(v.snapshot, {});
    return {
      id: v.id,
      version: v.version,
      code: clipCode(clip?.number ?? null, v.version),
      score: Math.round(Number(v.score) || 0),
      score_reasons: parseJson<string[]>(typeof snap.score_reasons === "string" ? snap.score_reasons : null, []),
      hook_text: String(snap.hook_text ?? ""),
      media_url: `/api/clips/${clipId}/versions/${v.id}/media`,
      cover_url: v.cover_r2_key ? `/api/clips/${clipId}/versions/${v.id}/media?cover=1` : null,
      created_at: v.created_at,
    };
  });
}

/** "Keep this one": the chosen version goes back on the clip; the clip as it was becomes a version. */
export async function restoreVersion(env: Env, clipId: string, versionId: string): Promise<boolean> {
  const v = await env.DB.prepare("SELECT snapshot FROM clip_versions WHERE id = ? AND clip_id = ?").bind(versionId, clipId).first<{ snapshot: string }>();
  const snap = parseJson<Partial<Snapshot> | null>(v?.snapshot ?? null, null);
  if (!snap || typeof snap.r2_key !== "string") return false;
  await keepVersion(env, clipId);
  const sets = VERSION_FIELDS.map((f) => `${f} = ?`).join(", ");
  await env.DB.batch([
    env.DB.prepare(`UPDATE clips SET ${sets}, media_version = media_version + 1, pending_look = NULL, pending_layout = NULL, pending_music = NULL, rerender_error = NULL, edited_with = NULL WHERE id = ?`).bind(
      ...VERSION_FIELDS.map((f) => (snap[f] === undefined ? null : snap[f])),
      clipId,
    ),
    env.DB.prepare("DELETE FROM clip_versions WHERE id = ?").bind(versionId),
  ]);
  return true;
}

/** Every file a clip's kept versions hold (deleted with the clip). */
export async function versionFiles(env: Pick<Env, "DB">, clipId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT r2_key, cover_r2_key FROM clip_versions WHERE clip_id = ?").bind(clipId).all<{ r2_key: string; cover_r2_key: string | null }>();
  return results.flatMap((r) => [r.r2_key, r.cover_r2_key]).filter((k): k is string => !!k);
}
