// "What I dumped" (studio fix, 23 Oct 2026): every file of one dump, with a picture to look at, the
// stage the clip engine gave it (asset_roles), which clips used it (files_used, by clip number), and
// the day its original is cleared to save space. Linked from the dump and from Review.
// Guard: tests/unit/dump-files.test.ts.
import type { Env } from "../env";
import { parseJson } from "./db";
import { RAW_RETENTION_DAYS } from "@shared/constants";
import { clipCode, clipLabel } from "@shared/clipNumber";

/** Plain words for the engine's stages (contract: arrival/before · prep · team · process · finished · detail · hero). */
export const ROLE_LABEL: Record<string, string> = {
  arrival: "Before (arrival)",
  before: "Before (arrival)",
  prep: "Getting ready",
  team: "Team working",
  team_working: "Team working",
  process: "Putting it together",
  finished: "Finished",
  detail: "Close-up detail",
  hero: "Best finished shot (ends clips)",
};
export const roleLabel = (role: string | null): string | null => (role ? (ROLE_LABEL[role.toLowerCase()] ?? role.replace(/_/g, " ")) : null);

export interface DumpFileUse {
  clip_id: string;
  code: string;
  label: string;
  status: string;
  /** This file is the clip's last shot (its hero). */
  hero: boolean;
}

export interface DumpFile {
  id: string;
  file_name: string;
  kind: "photo" | "video";
  size_bytes: number;
  /** Her own screens only (signed in): the original while it is kept, else null. */
  view_url: string | null;
  role: string | null;
  role_label: string | null;
  /** A camera took it (EXIF); false = treated as an AI picture. Null = not read yet. */
  camera: boolean | null;
  taken_at: string | null;
  used_by: DumpFileUse[];
  /** The day the original is cleared (7 days after the clips were ready); null before that is known. */
  clears_on: string | null;
  cleared: boolean;
}

export interface DumpFilesView {
  dump: { id: string; created_at: string; status: string; ready_at: string | null; clip_counts: { distinct?: number; styles?: number; by_type?: Record<string, number> } | null };
  files: DumpFile[];
  /** Files no clip used (she can see what was left out). */
  unused: number;
}

/** The clear date for a dump's originals: ready + RAW_RETENTION_DAYS (worker/crons/daily.ts retention). Pure. */
export function clearsOn(readyAt: string | null): string | null {
  if (!readyAt) return null;
  const t = Date.parse(readyAt.endsWith("Z") ? readyAt : `${readyAt}Z`);
  return Number.isFinite(t) ? new Date(t + (RAW_RETENTION_DAYS + 1) * 86400_000).toISOString().slice(0, 10) : null;
}

export async function dumpFiles(env: Env, dumpId: string): Promise<DumpFilesView | null> {
  const dump = await env.DB.prepare("SELECT id, created_at, status, ready_at, clip_counts FROM dumps WHERE id = ?").bind(dumpId).first<{ id: string; created_at: string; status: string; ready_at: string | null; clip_counts: string | null }>();
  if (!dump) return null;
  const { results: assets } = await env.DB.prepare(
    "SELECT id, file_name, mime_type, size_bytes, role, exif_camera, taken_at, raw_deleted_at FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' ORDER BY created_at",
  )
    .bind(dumpId)
    .all<{ id: string; file_name: string; mime_type: string; size_bytes: number; role: string | null; exif_camera: number | null; taken_at: string | null; raw_deleted_at: string | null }>();
  const { results: clips } = await env.DB.prepare(
    "SELECT id, asset_id, part_assets, files_used, hero_asset_id, number, version, status, style_of FROM clips WHERE dump_id = ? AND status != 'deleted' AND style_of IS NULL ORDER BY number, id",
  )
    .bind(dumpId)
    .all<{ id: string; asset_id: string; part_assets: string | null; files_used: string | null; hero_asset_id: string | null; number: number | null; version: number; status: string; style_of: string | null }>();
  const tz = env.AUDIENCE_TIMEZONE || "America/New_York";
  const uses = new Map<string, DumpFileUse[]>();
  for (const c of clips) {
    const ids = new Set<string>([c.asset_id, ...parseJson<string[]>(c.part_assets, []), ...parseJson<string[]>(c.files_used, [])]);
    for (const id of ids) {
      const list = uses.get(id) ?? [];
      list.push({ clip_id: c.id, code: clipCode(c.number, c.version) || "–", label: clipLabel(dump.created_at, c.number, c.version, tz), status: c.status, hero: c.hero_asset_id === id });
      uses.set(id, list);
    }
  }
  const clear = clearsOn(dump.ready_at);
  const files: DumpFile[] = assets.map((a) => ({
    id: a.id,
    file_name: a.file_name,
    kind: a.mime_type.startsWith("image/") ? "photo" : "video",
    size_bytes: a.size_bytes,
    view_url: a.raw_deleted_at ? null : `/api/dumps/${dumpId}/files/${a.id}/view`,
    role: a.role,
    role_label: roleLabel(a.role),
    camera: a.exif_camera === null ? null : a.exif_camera === 1,
    taken_at: a.taken_at,
    used_by: uses.get(a.id) ?? [],
    clears_on: a.raw_deleted_at ? a.raw_deleted_at.slice(0, 10) : clear,
    cleared: !!a.raw_deleted_at,
  }));
  return {
    dump: { id: dump.id, created_at: dump.created_at, status: dump.status, ready_at: dump.ready_at, clip_counts: parseJson(dump.clip_counts, null) },
    files,
    unused: files.filter((f) => !f.used_by.length).length,
  };
}
