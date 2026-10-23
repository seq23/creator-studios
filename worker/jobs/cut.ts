// Cut a dump into clips (section 8). OWNED BY: phase 4 (Editing engine).
//
// buildSpec   → everything jobs/cut.py needs: the dump, its uploaded videos (R2 keys, notes,
//               recycle fields), the locked Brand Profile, the approved brief, the caps and
//               the recipe bounds. Door B applies the 90-day cooldown and "best past
//               performers first" here, so the job never has to know the rules.
// applyResult → validates the job's clip list (parseCutResult), inserts the clips in one
//               batch, flips the dump to "ready" and sends the "Clips ready" email.
// onFailure   → the dump goes to "failed" with a plain sentence she can act on.
// fakeRun     → FAKE_SERVICES=1: 6–12 realistic clips per dump, with tiny real MP4/JPEG
//               objects written to R2 so Review's player and covers work locally.
//
// Looks (worker/domain/looks.ts, jobs/looks.json): the spec carries the rotation of her enabled
// Looks and each Look resolved with her Settings > Editing switches, so a dump's clips vary;
// every clip comes back with its `look`, its `parts` and (grids) its `layout`.
// A job whose ref is "<dumpId>/<clipId>" is a re-render of one clip in the Look she picked in
// Review ("Change look"): the old file stays live until the new one is swapped in here.
import { getConnectionSecret } from "../lib/connections";
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { log } from "../lib/log";
import { parseJson, recordEvent } from "../lib/db";
import { clipCuttingLight } from "../crons/buffer-sync";
import { heldSentence, sourceVerdict, type SourceMark, type SourceOwner } from "../domain/sourceCheck";
import { mediaToken, newId, nowIso } from "../lib/ids";
import { unb64 } from "../lib/crypto";
import { emailFrame, sendEmail } from "../services/email";
import { readSettings } from "../routes/settings";
import { weeklyNeed } from "../domain/runway";
import { rankRecycle, recyclePlatforms, type PriorPost } from "../domain/cooldown";
import { PLATFORMS, QUALITY_BAR, RECIPES, type Platform, type Recipe } from "@shared/constants";
import {
  brandingFor,
  cellCount,
  cleanGridLayout,
  defaultGridLayout,
  editingFromStored,
  isGridLook,
  isLookId,
  lookForClip,
  resolveLook,
  rotationFor,
  type Branding,
  type GridLayout,
  type LookId,
  type ResolvedLook,
  type StoredEditing,
} from "../domain/looks";
import { getSetting } from "../lib/db";
import { CUT_REF } from "../lib/jobStorage";
import { voiceReady, autoVoiceDump, removeVoiceOver } from "../lib/autoVoice";
import { cleanControls, mergeControls, recipesAllowed, steerLook, steerMusic, steerPlatforms, steerRecipes, steerTarget, whatWeTried } from "../domain/steer";
import { readUnderstood, tracksOf } from "../lib/steerStore";
import type { NotFollowed, SteerControls } from "@shared/steer";
import { applyImport, buildImportSpec, fakeImport, importFailed, type ImportSpec } from "./cut_import";
import { connectedEditors, editorChoice, queueClipEditors } from "../lib/editorJobs";
import { effectiveEditor } from "../domain/editors";
import { dispatchJob } from "../services/github";
import { readSound } from "../routes/settings";
import { libraryTrack, type CameraSound } from "@shared/sound";
import { parseNotes } from "../domain/steer";
import { servicesOf } from "@shared/services";
import { textProblems, type ContentRules } from "@shared/contentRules";
import { contentRules } from "../lib/photoPosts";
import { loadMemory, type MemorySummary } from "../domain/studioMemory";
import { cleanLooksLike, cleanOverride, isShape, type PlanOverride, type Shape } from "@shared/looksLike";
import type { StudioRules } from "@shared/studioRules";
import { readStudioRules } from "../lib/studioRules";
import { latestPlaybook, type NichePlaybook } from "../lib/niche";
import { cleanFixes, type FixKey } from "@shared/fixes";
import { clipCode } from "@shared/clipNumber";
import { keepVersion } from "../lib/clipVersions";

/** A cut job's ref: a dump ("dmp_…"), or one clip of it to re-render ("dmp_…/clp_…"). */
export function parseCutRef(refId: string | null): { dumpId: string; clipId: string | null; import: boolean; again: boolean } | null {
  const m = CUT_REF.exec(refId ?? "");
  if (!m || (m[3] === "again" && !m[2])) return null;
  return { dumpId: m[1], clipId: m[2] ?? null, import: m[3] === "import", again: m[3] === "again" };
}

/** Everything a render needs from her settings: the editing switches, her songs, her branding. */
export async function renderContext(env: Env): Promise<{ editing: ReturnType<typeof editingFromStored>; own: ReturnType<typeof editingFromStored>; music: { r2_key: string }[]; branding: Branding }> {
  const stored = editingFromStored(await getSetting<StoredEditing>(env.DB, "editing", {}));
  // A connected captions editor (Who edits > Captions) adds the words: the built-in render leaves them off.
  const captionsElsewhere = effectiveEditor(await editorChoice(env), "caption", await connectedEditors(env)) !== "built-in";
  const editing = captionsElsewhere ? { ...stored, captions: false } : stored;
  const { results: tracks } = await env.DB.prepare("SELECT r2_key FROM music_tracks ORDER BY created_at").all<{ r2_key: string }>();
  const profile = await env.DB.prepare("SELECT sections FROM brand_profile WHERE locked = 1 ORDER BY version DESC LIMIT 1").first<{ sections: string }>();
  const buffer = await env.DB.prepare("SELECT meta FROM connections WHERE service = 'buffer' AND status = 'ok'").first<{ meta: string }>();
  const channels = parseJson<{ channels?: { platform?: string; handle?: string }[] }>(buffer?.meta, {}).channels ?? [];
  return {
    editing,
    own: stored,
    music: editing.music ? tracks.map((t) => ({ r2_key: t.r2_key })) : [],
    branding: brandingFor(profile ? parseJson<Record<string, string>>(profile.sections, {}) : null, channels),
  };
}

// ---------------------------------------------------------------- spec

export interface CutSpecAsset {
  id: string;
  r2_key: string;
  mime_type: string;
  duration_s: number | null;
  file_note: string | null;
  original_platform: string | null;
  original_posted_at: string | null;
  original_views: number | null;
  /** Platforms this asset's clips may go to (Door B: outside the cooldown). */
  allowed_platforms: Platform[];
  /** This video's own note, when it asks for something different from the dump (it wins for this video's clips). */
  steer?: SteerSpec;
  /** Its file name as uploaded ("new", "final", "after" in a name = a polished hero). */
  file_name?: string;
  /** A camera Make/Model is in its EXIF (studio fix): false = treated as an AI picture. Videos are camera footage. */
  exif_camera: boolean;
  /** When the camera took it (EXIF DateTimeOriginal, camera local time), for grouping one event. */
  taken_at?: string | null;
}

/** Everything the job must honor from her chips and notes (worker/domain/steer.ts). */
export interface SteerSpec {
  rotation: LookId[];
  looks: Partial<Record<LookId, ResolvedLook>>;
  music: { r2_key: string }[];
  recipes: Record<Recipe, { minS: number; maxS: number }>;
  allowed_recipes: Recipe[];
  count: number | null;
  include: string[];
  avoid: string[];
  /** Camera sound for these clips (shared/sound.ts); a video's own note may set it for that video. */
  camera?: CameraSound;
}

export interface CutSpec {
  job_id: string;
  type: "cut";
  /** The studio's own OpenRouter key for picking moments (null: the job's fallback picker). Travels only in the signed spec. */
  llm_key?: string | null;
  dump_id: string;
  door: "new" | "recycle";
  notes: string;
  assets: CutSpecAsset[];
  skipped_assets: { id: string; reason: "cooldown" | "identical_file" }[];
  brand_profile: Record<string, string> | null;
  brief: unknown;
  weekly_caps: Record<Platform, number>;
  weekly_need: number;
  /** Candidates to make: 2–3× the weekly need, ranked, the rest hidden. */
  target_clips: { min: number; max: number };
  recipes: Record<Recipe, { minS: number; maxS: number }>;
  quality_bar: number;
  output_prefix: string;
  /** Clip k takes rotation[k % length] (rotationFor: her enabled Looks, varied per dump). */
  rotation: LookId[];
  /** Each Look in the rotation, resolved with her Settings > Editing switches. */
  looks: Partial<Record<LookId, ResolvedLook>>;
  branding: Branding;
  /** Her own songs (Settings > Editing > My music), only when the music bed is on. */
  music: { r2_key: string }[];
  /** Her chips and notes, resolved (the fields above already carry the dump-wide ones). */
  steer: SteerSpec;
  /** The camera's own sound: auto (keep talking, drop background talk), keep, or off (music instead). */
  camera: CameraSound;
  /** The services the footage can show, from the locked Brand Profile only (shared/services.ts). */
  services: string[];
  /** The studio's content rules (shared/contentRules.ts), enforced by jobs/protect.py. */
  content_rules: ContentRules;
  /** Studio Memory (worker/domain/studioMemory.ts): read by jobs/plan.py and jobs/critic.py. */
  memory: MemorySummary;
  /** What the vision model saw in each video before (jobs/see.py), so a re-plan looks no again. */
  shot_sheets: Record<string, unknown>;
  /** Her pick on "Change" (the plain line): the service and/or the story shape. */
  plan_override: PlanOverride;
  /** The studio's clip rules (shared/studioRules.ts): call to action, Made with AI, clips per dump, bar, local words, prices. */
  studio_rules: StudioRules;
  /** What converts in this studio's niche, researched monthly (jobs/niche_research.py); null before the first run. */
  niche_playbook: NichePlaybook | null;
}

/** Try another version with her notes: the clip's videos cut again, away from the moment she has. */
export interface AgainSpec extends Omit<CutSpec, "type"> {
  type: "cut";
  mode: "again";
  clip_id: string;
  change_request: string;
  /** Her one-tap fixes in Review (shared/fixes.ts keys); their words are in change_request too. */
  fixes: FixKey[];
  avoid_windows: { asset_id: string; start: number; end: number }[];
}

/** One stretch of a source video for a re-render: a raw upload or, when that is gone, a clip file. */
export interface RerenderStretch {
  src: string;
  start: number;
  end: number;
  zoom?: number;
}

export interface RerenderSpec {
  job_id: string;
  type: "cut";
  mode: "rerender";
  dump_id: string;
  clip_id: string;
  asset_id: string;
  recipe: Recipe;
  hook_text: string;
  look_id: LookId;
  look: ResolvedLook;
  parts: RerenderStretch[];
  cells: RerenderStretch[] | null;
  voice: number;
  branding: Branding;
  music: { r2_key: string }[];
  /** Cut with the camera sound off: it stays off in every new look, with music under it. */
  muted: boolean;
  output_key: string;
  output_cover_key: string;
}

/** Platforms a recycled asset may go to: the cooldown per platform from its known past post. */
export function allowedPlatformsFor(asset: { original_platform: string | null; original_posted_at: string | null }, priors: PriorPost[], door: "new" | "recycle", now: Date, cooldownDays: number): Platform[] {
  if (door === "new") return [...PLATFORMS];
  const prior = [...priors];
  const p = asset.original_platform as Platform | null;
  if (p && (PLATFORMS as readonly string[]).includes(p)) {
    // Unknown date on a known platform: treat it as recent (safer to wait than to look reposted).
    prior.push({ platform: p, posted_at: asset.original_posted_at ? new Date(asset.original_posted_at).toISOString() : now.toISOString() });
  }
  return recyclePlatforms(prior, [...PLATFORMS], now, cooldownDays);
}

/**
 * How many distinct clips a dump should give: the studio's own setting (Settings → Your clips,
 * shared/studioRules.ts clip_target), sized to the footage by the engine inside it. It used to be
 * 2–3 per open calendar slot, which had nothing to do with what was dumped (studio fix, 23 Oct 2026).
 */
export function targetClips(rules: Pick<StudioRules, "clip_target">): { min: number; max: number } {
  return { min: rules.clip_target.min, max: rules.clip_target.max };
}

interface AssetDb {
  id: string;
  r2_key: string;
  mime_type: string;
  duration_s: number | null;
  file_note: string | null;
  steer_notes: string | null;
  original_platform: string | null;
  original_posted_at: string | null;
  original_views: number | null;
  content_hash: string | null;
  shot_sheet: string | null;
  file_name: string;
  exif_camera: number | null;
  taken_at: string | null;
}

async function buildSpec(env: Env, jobId: string, refId: string | null): Promise<CutSpec | RerenderSpec | ImportSpec | AgainSpec> {
  const ref = parseCutRef(refId);
  if (!ref) throw new Error("cut job has no dump");
  if (ref.import) return buildImportSpec(env, jobId, ref.dumpId, ref.clipId);
  if (ref.again && ref.clipId) return buildAgainSpec(env, jobId, ref.dumpId, ref.clipId);
  if (ref.clipId) return buildRerenderSpec(env, jobId, ref.dumpId, ref.clipId);
  return buildDumpSpec(env, jobId, ref.dumpId);
}

async function buildDumpSpec(env: Env, jobId: string, dumpId: string): Promise<CutSpec> {
  const dump = await env.DB.prepare("SELECT id, door, kind, notes, steer, steer_notes, plan_override FROM dumps WHERE id = ?").bind(dumpId).first<{ id: string; door: "new" | "recycle"; kind: string; notes: string; steer: string | null; steer_notes: string | null; plan_override: string | null }>();
  if (!dump) throw new Error("dump missing");
  // A full video for YouTube never goes through the cutter (validator full-video-uncut).
  if (dump.kind === "full_video") throw new Error("a full video is never cut");
  const { results: rows } = await env.DB.prepare(
    "SELECT id, r2_key, mime_type, duration_s, file_note, steer_notes, original_platform, original_posted_at, original_views, content_hash, shot_sheet, file_name, exif_camera, taken_at FROM assets WHERE dump_id = ? AND upload_status = 'uploaded' AND raw_deleted_at IS NULL ORDER BY created_at",
  )
    .bind(dumpId)
    .all<AssetDb>();
  const s = await readSettings(env);
  const now = new Date();
  // Her chips and notes (worker/domain/steer.ts): per control, a video's note > a chip > the dump's note > surprise.
  const ctx = await renderContext(env);
  const tracks = await tracksOf(env);
  const chips = cleanControls(parseJson(dump.steer, {}), tracks).controls;
  const dumpNote = readUnderstood(dump.steer_notes)?.controls ?? {};
  const dumpCtl = mergeControls(chips, dumpNote).controls;
  const steerSpec = (ctl: SteerControls, seed: string): SteerSpec => {
    const music = steerMusic(ctl, tracks, ctx.music);
    const rotation = rotationFor(ctl.looks?.length ? (ctl.looks as LookId[]) : ctx.editing.looks, seed);
    return {
      rotation,
      looks: Object.fromEntries(rotation.map((id) => [id, steerLook(resolveLook(id, ctx.editing, music.length > 0), ctl)])) as SteerSpec["looks"],
      music,
      recipes: steerRecipes(ctl),
      allowed_recipes: recipesAllowed(ctl),
      count: ctl.count ?? null,
      include: ctl.include ?? [],
      avoid: ctl.avoid ?? [],
      ...(ctl.camera ? { camera: ctl.camera } : {}),
    };
  };
  const skipped: CutSpec["skipped_assets"] = [];
  const assets: CutSpecAsset[] = [];
  const ordered = dump.door === "recycle" ? rankRecycle(rows) : rows;
  for (const a of ordered) {
    let priors: PriorPost[] = [];
    if (a.content_hash) {
      // Never the identical file: a byte-identical video from another dump that already made clips is skipped.
      const twin = await env.DB.prepare("SELECT a.id FROM assets a WHERE a.content_hash = ? AND a.id != ? AND EXISTS (SELECT 1 FROM clips c WHERE c.asset_id = a.id AND c.status != 'deleted') LIMIT 1")
        .bind(a.content_hash, a.id)
        .first();
      if (twin) {
        skipped.push({ id: a.id, reason: "identical_file" });
        continue;
      }
      const { results: posted } = await env.DB.prepare(
        "SELECT p.platform, p.posted_at FROM posts p JOIN clips c ON c.id = p.clip_id JOIN assets a ON a.id = c.asset_id WHERE a.content_hash = ? AND p.status = 'posted' AND p.posted_at IS NOT NULL",
      )
        .bind(a.content_hash)
        .all<PriorPost>();
      priors = posted;
    }
    const assetCtl = mergeControls(chips, dumpNote, readUnderstood(a.steer_notes)?.controls ?? {}).controls;
    const allowed = steerPlatforms(allowedPlatformsFor(a, priors, dump.door, now, s.recycle_cooldown_days), assetCtl);
    if (!allowed.length) {
      skipped.push({ id: a.id, reason: "cooldown" });
      continue;
    }
    assets.push({
      id: a.id,
      r2_key: a.r2_key,
      mime_type: a.mime_type,
      duration_s: a.duration_s,
      file_note: a.file_note,
      original_platform: a.original_platform,
      original_posted_at: a.original_posted_at,
      original_views: a.original_views,
      allowed_platforms: allowed,
      file_name: a.file_name,
      // A video is camera footage (real footage only); a photo with no camera Make/Model is an AI picture.
      exif_camera: a.mime_type.startsWith("image/") ? a.exif_camera === 1 : true,
      taken_at: a.taken_at,
      ...(readUnderstood(a.steer_notes)?.said.length ? { steer: steerSpec(assetCtl, `${dump.id}:${a.id}`) } : {}),
    });
  }
  const profile = await env.DB.prepare("SELECT sections FROM brand_profile WHERE locked = 1 ORDER BY version DESC LIMIT 1").first<{ sections: string }>();
  const brief = await env.DB.prepare("SELECT body FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ body: string }>();
  const need = weeklyNeed(s.weekly_caps);
  const rules = await readStudioRules(env);
  const steer = steerSpec(dumpCtl, dump.id);
  const sections = profile ? parseJson<Record<string, string>>(profile.sections, {}) : null;
  const services = servicesOf(sections);
  const sheets: Record<string, unknown> = {};
  for (const a of rows) {
    const sh = parseJson<unknown>(a.shot_sheet, null);
    if (sh && assets.some((x) => x.id === a.id)) sheets[a.id] = sh;
  }
  return {
    job_id: jobId,
    type: "cut",
    llm_key: await getConnectionSecret(env, "openrouter"),
    dump_id: dump.id,
    door: dump.door,
    notes: dump.notes,
    assets,
    skipped_assets: skipped,
    brand_profile: sections,
    brief: brief ? parseJson<unknown>(brief.body, null) : null,
    weekly_caps: s.weekly_caps,
    weekly_need: need,
    target_clips: steerTarget(dumpCtl, targetClips(rules)),
    recipes: steer.recipes,
    // The studio's review bar (0..100 in studio_rules.bar), here on the engine's older 0..1 scale.
    quality_bar: rules.bar / 100,
    output_prefix: `clips/${dump.id}/`,
    rotation: steer.rotation,
    looks: steer.looks,
    branding: ctx.branding,
    music: steer.music,
    steer,
    camera: dumpCtl.camera ?? (await readSound(env)).camera,
    services,
    // Layer 5 (jobs/protect.py): faces and house numbers blurred, the never-list, real prices only.
    content_rules: contentRules(env),
    // Layer 8: what this studio learned (approvals, rejections, notes, her answers, views); layer 9's approach.
    memory: await loadMemory(env),
    shot_sheets: sheets,
    plan_override: cleanOverride(parseJson(dump.plan_override, {}), services, rows.map((r) => r.id)),
    studio_rules: rules,
    niche_playbook: await latestPlaybook(env),
  };
}

/** The clip's stretches, as [asset id, start, end] (its own video). */
async function buildAgainSpec(env: Env, jobId: string, dumpId: string, clipId: string): Promise<AgainSpec> {
  const clip = await env.DB.prepare("SELECT id, asset_id, start_s, end_s, parts, part_assets, again_notes, again_fixes, files_used FROM clips WHERE id = ? AND dump_id = ?").bind(clipId, dumpId).first<{ id: string; asset_id: string; start_s: number; end_s: number; parts: string | null; part_assets: string | null; again_notes: string | null; again_fixes: string | null; files_used: string | null }>();
  if (!clip) throw new Error("clip missing");
  const base = await buildDumpSpec(env, jobId, dumpId);
  const notes = (clip.again_notes ?? "").trim();
  // Her notes steer this version like a video's own note (moment, hook, pace, look, music, camera sound).
  const asked = parseNotes(notes, await tracksOf(env)).controls;
  // A before -> after clip is cut again from every video it joins.
  const owners = parseJson<unknown>(clip.part_assets, null);
  const partOwners = Array.isArray(owners) ? owners.map(String) : [];
  // Every file the clip used (photos included, files_used from the engine), so a re-plan can swap its ending or opening.
  const used = parseJson<unknown>(clip.files_used, null);
  const fixes = cleanFixes(parseJson<unknown>(clip.again_fixes, []));
  // "Use a photo ending" may reach for any photo of this dump; the others keep to the clip's own files.
  const photos = fixes.includes("photo_ending") ? base.assets.filter((a) => a.mime_type.startsWith("image/")).map((a) => a.id) : [];
  const mine = new Set([clip.asset_id, ...partOwners, ...(Array.isArray(used) ? used.map(String) : []), ...photos]);
  const assets = base.assets.filter((a) => mine.has(a.id)).map((a) => ({ ...a, ...(Object.keys(asked).length ? { steer: { ...(a.steer ?? base.steer), ...againSteer(base, asked) } } : {}) }));
  if (!assets.length) throw new Error("clip source cleared");
  return {
    ...base,
    mode: "again",
    clip_id: clipId,
    assets,
    skipped_assets: [],
    target_clips: { min: 1, max: 1 },
    change_request: notes.slice(0, 1000),
    fixes,
    avoid_windows: clipParts(clip).map(([start, end], i) => ({ asset_id: partOwners.length === clipParts(clip).length ? partOwners[i]! : clip.asset_id, start, end })),
  };
}

/** What her "what to change" notes override in the dump's steer for one new version. */
function againSteer(base: CutSpec, asked: SteerControls): Partial<SteerSpec> {
  const out: Partial<SteerSpec> = {};
  if (asked.camera) out.camera = asked.camera;
  if (asked.looks?.length) {
    out.rotation = asked.looks.filter(isLookId) as LookId[];
    out.looks = Object.fromEntries(out.rotation.map((id) => [id, base.looks[id] ?? resolveLook(id, editingFromStored({}), base.music.length > 0)])) as SteerSpec["looks"];
  }
  if (asked.pace || asked.captions) {
    const rot = out.rotation ?? base.rotation;
    out.rotation = rot;
    out.looks = Object.fromEntries(rot.map((id) => [id, steerLook((out.looks ?? base.looks)[id] ?? resolveLook(id, editingFromStored({}), base.music.length > 0), asked)])) as SteerSpec["looks"];
  }
  if (asked.length) {
    out.recipes = steerRecipes(asked);
    out.allowed_recipes = recipesAllowed(asked);
  }
  if (asked.include) out.include = asked.include;
  if (asked.avoid) out.avoid = asked.avoid;
  return out;
}

interface ClipSourceDb {
  id: string;
  dump_id: string;
  asset_id: string;
  start_s: number;
  end_s: number;
  recipe: Recipe;
  hook_text: string;
  r2_key: string;
  parts: string | null;
  part_assets: string | null;
  layout: string | null;
  pending_look: string | null;
  pending_layout: string | null;
  pending_music: string | null;
  music: string | null;
  media_version: number;
  raw_key: string;
  raw_deleted_at: string | null;
  asset_duration: number | null;
}

const CLIP_SOURCE_SQL = `SELECT c.id, c.dump_id, c.asset_id, c.start_s, c.end_s, c.recipe, c.hook_text, c.r2_key, c.parts, c.part_assets, c.layout, c.pending_look, c.pending_layout, c.pending_music, c.music, c.muted,
  c.media_version, a.r2_key AS raw_key, a.raw_deleted_at, a.duration_s AS asset_duration FROM clips c JOIN assets a ON a.id = c.asset_id`;

/** The file names a re-render writes: the clip's id and the next version, inside its dump's folder. */
export function rerenderKeys(dumpId: string, clipId: string, version: number): { mp4: string; jpg: string } {
  return { mp4: `clips/${dumpId}/${clipId}-v${version}.mp4`, jpg: `clips/${dumpId}/${clipId}-v${version}.jpg` };
}

/** The stretches a clip plays, in order: its saved parts, else start → end. */
export function clipParts(c: { start_s: number; end_s: number; parts: string | null }): [number, number][] {
  const saved = parseJson<unknown>(c.parts, null);
  if (Array.isArray(saved) && saved.length && saved.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > p[0]))
    return saved as [number, number][];
  return [[c.start_s, c.end_s]];
}

/** Where a clip's picture can come from for a re-render: its raw upload while it is kept, else its own file. */
export function clipSource(c: Pick<ClipSourceDb, "raw_key" | "raw_deleted_at" | "r2_key" | "start_s" | "end_s">, length: number): RerenderStretch {
  if (!c.raw_deleted_at) return { src: c.raw_key, start: c.start_s, end: c.start_s + length };
  return { src: c.r2_key, start: 0, end: Math.min(length, c.end_s - c.start_s) };
}

/**
 * Where each part of a clip is read from for a new look: its own video. A clip joining several
 * videos (before -> after, clips.part_assets) reads each part from that part's upload.
 */
async function partSources(env: Env, clip: Pick<ClipSourceDb, "raw_key" | "part_assets" | "dump_id">, parts: [number, number][]): Promise<RerenderStretch[]> {
  const owners = parseJson<unknown>(clip.part_assets, null);
  if (!Array.isArray(owners) || owners.length !== parts.length) return parts.map(([start, end]) => ({ src: clip.raw_key, start, end }));
  const out: RerenderStretch[] = [];
  for (const [i, [start, end]] of parts.entries()) {
    const a = await env.DB.prepare("SELECT r2_key, raw_deleted_at FROM assets WHERE id = ? AND dump_id = ?").bind(String(owners[i]), clip.dump_id).first<{ r2_key: string; raw_deleted_at: string | null }>();
    if (!a || a.raw_deleted_at) throw new Error("clip source cleared");
    out.push({ src: a.r2_key, start, end });
  }
  return out;
}

async function buildRerenderSpec(env: Env, jobId: string, dumpId: string, clipId: string): Promise<RerenderSpec> {
  const clip = await env.DB.prepare(`${CLIP_SOURCE_SQL} WHERE c.id = ? AND c.dump_id = ?`).bind(clipId, dumpId).first<ClipSourceDb & { muted: number }>();
  if (!clip || !clip.pending_look || !isLookId(clip.pending_look)) throw new Error("clip has no pending look");
  if (clip.raw_deleted_at) throw new Error("clip source cleared");
  const ctx = await renderContext(env);
  // Her captions editor failed on this clip: the built-in captions go back on (her own switch decides).
  const lastCaption = await env.DB.prepare("SELECT status FROM editor_jobs WHERE clip_id = ? AND capability = 'caption' ORDER BY created_at DESC LIMIT 1").bind(clipId).first<{ status: string }>();
  // Change music (Review): "none", one of her songs, else the song it had (or Settings' for a clip that had none).
  const tracks = await tracksOf(env);
  const musicChoice = clip.pending_music === "none" ? "none" : clip.pending_music ? `track:${clip.pending_music}` : null;
  // The song it had: one of hers, or a built-in track (a clip with its camera sound off).
  const kept = clip.music ? (libraryTrack(clip.music) ? [{ r2_key: clip.music }] : tracks.filter((t) => t.r2_key === clip.music).map((t) => ({ r2_key: t.r2_key }))) : [];
  const music = musicChoice ? steerMusic(cleanControls({ music: musicChoice }, tracks).controls, tracks, []) : kept.length ? kept : ctx.music;
  const look = steerLook(resolveLook(clip.pending_look, lastCaption?.status === "failed" ? ctx.own : ctx.editing, music.length > 0), musicChoice ? { music: musicChoice as SteerControls["music"] } : kept.length ? { music: "any" } : {});
  const parts = clipParts(clip);
  let cells: RerenderStretch[] | null = null;
  let voice = 0;
  if (isGridLook(clip.pending_look)) {
    const layout = parseJson<GridLayout | null>(clip.pending_layout, null) ?? defaultGridLayout(clip.pending_look, []);
    const length = clip.end_s - clip.start_s;
    const self: RerenderStretch = { src: clip.raw_key, start: clip.start_s, end: clip.end_s };
    cells = [];
    for (const cell of layout.cells) {
      if (cell.kind === "self") cells.push(self);
      else if (cell.kind === "zoom") cells.push({ ...self, zoom: cell.zoom });
      else {
        const other = await env.DB.prepare(`${CLIP_SOURCE_SQL} WHERE c.id = ? AND c.status != 'deleted'`).bind(cell.clip_id).first<ClipSourceDb>();
        const stretch = other ? clipSource(other, length) : { ...self, zoom: 1.35 };
        if (other && !other.raw_deleted_at && other.asset_duration) stretch.end = Math.min(stretch.end, other.asset_duration);
        cells.push(stretch);
      }
    }
    voice = layout.voice;
  }
  const keys = rerenderKeys(dumpId, clipId, clip.media_version + 1);
  return {
    job_id: jobId,
    type: "cut",
    mode: "rerender",
    dump_id: dumpId,
    clip_id: clipId,
    asset_id: clip.asset_id,
    recipe: clip.recipe,
    hook_text: clip.hook_text,
    look_id: clip.pending_look,
    look,
    parts: await partSources(env, clip, parts),
    cells,
    voice,
    branding: ctx.branding,
    music,
    muted: !!clip.muted,
    output_key: keys.mp4,
    output_cover_key: keys.jpg,
  };
}

// ---------------------------------------------------------------- result

/** One clip as jobs/cut.py reports it. */
export interface CutResultClip {
  id: string;
  asset_id: string;
  start_s: number;
  end_s: number;
  recipe: Recipe;
  hook_text: string;
  hook_alt: string | null;
  caption: string;
  hashtags: string | string[];
  platforms: Platform[];
  score: number;
  r2_key: string;
  cover_r2_key: string | null;
  /** The Look it was rendered in (jobs/looks.json). */
  look?: string | null;
  /** [[start_s, end_s], ...] in play order. */
  parts?: [number, number][] | null;
  /** Grid Looks: which moment is in each cell and whose sound plays. */
  layout?: unknown;
  /** The song under it (R2 key of her upload), null for none. */
  music?: string | null;
  /** How much of it has her talking (0..1); null = not measured. */
  speech?: number | null;
  /** Cut with the camera sound off (none of the video's own sound is in it). */
  muted?: boolean;
  /** Studio intelligence (jobs/see.py, jobs/plan.py): the story shape and the service it shows. */
  shape?: string | null;
  service?: string | null;
  /** What the shot sheet says is on screen (a voice over may describe only that). */
  on_screen?: string | null;
  /** The video each part comes from, when a clip joins several (before -> after). */
  part_assets?: string[] | null;
  /** Why the studio hid it (the critic, layer 6), in plain words. */
  hidden_reason?: string | null;
  // ---- studio fix (the clip engine's result fields, contract 23 Oct 2026) ----
  /** From the clip-type library ("payoff-first before→after", "photo slideshow" …). */
  clip_type?: string | null;
  /** Plain English: why it scored what it did ("ends on a blurry shot"). */
  score_reasons?: string[] | null;
  hero_asset_id?: string | null;
  /** Every file it uses (videos and photos). */
  files_used?: string[] | null;
  uses_ai_images?: boolean | null;
  event_group?: string | null;
  /** Its words (caption, voice) are still being written; Review shows it and holds Approve. */
  words_pending?: boolean | null;
  /** This is the same cut as another clip in a different look: shown as a style of that one. */
  style_of?: string | null;
}

export interface CutResult {
  clips: CutResultClip[];
  /** Which tools actually ran, so "clips look wrong" can be traced. */
  engine?: { transcript?: string; picker?: string; crop?: string; subtitles?: string };
  skipped?: { asset_id: string; reason: string }[];
  /** Measured source lengths; stored on assets.duration_s. */
  assets?: { id: string; duration_s: number }[];
  /** Platform watermarks and @handles the job read on sampled frames (worker/domain/sourceCheck.ts). */
  source_marks?: SourceMark[];
  /** The dump's plain line (shared/looksLike.ts) and each video's shot sheet (jobs/see.py). */
  looks_like?: unknown;
  shot_sheets?: Record<string, unknown>;
  /** Free-model calls this cut made, by kind (vision, critic, text, failed). */
  calls?: Record<string, number>;
  /** Studio fix: the stage the engine gave each file, and how many distinct clips (styles never count). */
  asset_roles?: Record<string, string>;
  clip_counts?: { distinct?: number; by_type?: Record<string, number> };
}

/**
 * Whose video each asset is, from the job's watermark reading and her Buffer channels' handles.
 * Only assets of this dump; an asset she already confirmed as hers stays confirmed.
 */
export function sourceUpdates(marks: unknown, assetIds: Set<string>, ownHandles: string[]): { asset_id: string; owner: SourceOwner; note: string | null }[] {
  if (!Array.isArray(marks)) return [];
  const out: { asset_id: string; owner: SourceOwner; note: string | null }[] = [];
  for (const raw of marks.slice(0, 200)) {
    const m = (raw ?? {}) as Partial<SourceMark>;
    const id = String(m.asset_id ?? "");
    if (!assetIds.has(id) || out.some((o) => o.asset_id === id)) continue;
    const platform = m.platform === "tiktok" || m.platform === "instagram" ? m.platform : null;
    const handles = Array.isArray(m.handles) ? m.handles.filter((h): h is string => typeof h === "string").map((h) => h.slice(0, 40)).slice(0, 10) : [];
    const v = sourceVerdict({ platform, handles }, ownHandles);
    if (v) out.push({ asset_id: id, owner: v.owner, note: v.owner === "other" ? heldSentence(v.foreign, platform) : null });
  }
  return out;
}

/** Her own handles: the channels in her connected Buffer. */
export async function ownHandles(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT meta FROM connections WHERE service = 'buffer'").first<{ meta: string }>();
  return parseJson<{ channels?: { handle?: string }[] }>(row?.meta, {}).channels?.map((c) => String(c.handle ?? "")).filter(Boolean) ?? [];
}

export interface CleanClip {
  id: string;
  asset_id: string;
  start_s: number;
  end_s: number;
  recipe: Recipe;
  hook_text: string;
  hook_alt: string | null;
  caption: string;
  hashtags: string;
  platforms: Platform[];
  score: number;
  hidden: boolean;
  r2_key: string;
  cover_r2_key: string | null;
  look: LookId | null;
  parts: [number, number][];
  layout: GridLayout | null;
  music: string | null;
  speech: number | null;
  muted: boolean;
  shape: Shape | null;
  service: string | null;
  on_screen: string | null;
  part_assets: string[] | null;
  hidden_reason: string | null;
  clip_type: string | null;
  score_reasons: string[];
  hero_asset_id: string | null;
  files_used: string[];
  uses_ai_images: boolean;
  event_group: string | null;
  words_pending: boolean;
  style_of: string | null;
}

export class CutResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutResultError";
  }
}

export const MAX_CLIPS_PER_DUMP = 60;
const MIN_CLIP_S = 3;
const LENGTH_SLACK_S = 1;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function normalizeHashtags(v: unknown): string {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const t = raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(`#${t}`);
    if (out.length >= 15) break;
  }
  return out.join(" ");
}

/**
 * The Worker never trusts the job: every clip is checked against the dump it belongs to.
 * Throws CutResultError (a content-free message) when the whole result is unusable; drops
 * single clips that break a rule and reports how many were dropped.
 */
export function parseCutResult(
  result: unknown,
  ctx: { dumpId: string; allowed: Map<string, Platform[]>; rawKeys: Set<string>; rules?: ContentRules; bar?: number },
): { clips: CleanClip[]; dropped: number } {
  if (!result || typeof result !== "object" || !Array.isArray((result as CutResult).clips)) throw new CutResultError("result has no clip list");
  const list = (result as CutResult).clips;
  if (list.length > MAX_CLIPS_PER_DUMP) throw new CutResultError("too many clips");
  const prefix = `clips/${ctx.dumpId}/`;
  const ids = new Set<string>();
  const clips: CleanClip[] = [];
  let dropped = 0;
  for (const raw of list as unknown[]) {
    const c = (raw ?? {}) as Partial<CutResultClip>;
    const recipe = c.recipe as Recipe;
    const bounds = RECIPES[recipe];
    const start = Number(c.start_s);
    const end = Number(c.end_s);
    const score = Number(c.score);
    const allowed = ctx.allowed.get(String(c.asset_id));
    const ok =
      typeof c.id === "string" &&
      /^clp_[a-z0-9]{8,32}$/.test(c.id) &&
      !ids.has(c.id) &&
      !!allowed &&
      !!bounds &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end - start >= MIN_CLIP_S &&
      end - start <= bounds.maxS + LENGTH_SLACK_S &&
      Number.isFinite(score) &&
      typeof c.r2_key === "string" &&
      c.r2_key.startsWith(prefix) &&
      c.r2_key.endsWith(".mp4") &&
      !ctx.rawKeys.has(c.r2_key) &&
      (c.cover_r2_key == null || (typeof c.cover_r2_key === "string" && c.cover_r2_key.startsWith(prefix) && c.cover_r2_key.endsWith(".jpg"))) &&
      str(c.hook_text, 200).length > 0;
    if (!ok) {
      dropped++;
      continue;
    }
    // Door B cooldown is re-applied here: a platform the spec did not allow is unticked.
    const wanted = Array.isArray(c.platforms) && c.platforms.length ? c.platforms : [...PLATFORMS];
    const platforms = PLATFORMS.filter((p) => wanted.includes(p) && allowed!.includes(p));
    if (!platforms.length) {
      dropped++;
      continue;
    }
    ids.add(c.id!);
    // The engine's 0..100 score (studio fix) or an older 0..1 one; stored 0..1, shown as 0..100.
    const hundred = isHundredScale(c, score);
    const s = Math.max(0, Math.min(1, hundred ? score / 100 : score));
    const bar = hundred ? (ctx.bar ?? QUALITY_BAR * 100) / 100 : QUALITY_BAR;
    const reasons = cleanReasons(c.score_reasons);
    const used = Array.isArray(c.files_used) ? [...new Set(c.files_used.map(String).filter((a) => ctx.allowed.has(a)))].slice(0, 60) : [];
    const alt = str(c.hook_alt, 200);
    const look = isLookId(c.look) ? c.look : null;
    const parts = cleanParts(c.parts, start, end);
    // Each part's video must be one of this dump's (the Worker never trusts the job).
    const partAssets = Array.isArray(c.part_assets) && c.part_assets.length === parts.length && c.part_assets.every((a) => typeof a === "string" && ctx.allowed.has(a)) ? (c.part_assets as string[]) : null;
    // Layer 5, checked again here (the Worker never trusts the job): words that break the studio's rules hide the clip.
    const broke = ctx.rules && [c.hook_text, c.hook_alt, c.caption].some((t) => typeof t === "string" && textProblems(t, ctx.rules!).length > 0);
    const under = s < bar;
    const hiddenReason = str(c.hidden_reason, 200) || (broke ? RULES_HIDDEN : null) || (under && hundred ? underBarReason(Math.round(s * 100), Math.round(bar * 100), reasons) : null);
    clips.push({
      id: c.id!,
      asset_id: String(c.asset_id),
      start_s: Math.round(start * 100) / 100,
      end_s: Math.round(end * 100) / 100,
      recipe,
      hook_text: str(c.hook_text, 200),
      hook_alt: alt || null,
      caption: str(c.caption, 2200),
      hashtags: normalizeHashtags(c.hashtags),
      platforms,
      score: Math.round(s * 1000) / 1000,
      hidden: under || !!hiddenReason,
      r2_key: c.r2_key!,
      cover_r2_key: c.cover_r2_key ?? null,
      look,
      parts,
      layout: look && isGridLook(look) ? (cleanGridLayout(look, c.layout) ?? defaultGridLayout(look, [])) : null,
      music: songKey(c.music),
      // A muted clip has no talking of its own (automatic voice over applies), whatever the job said.
      speech: c.muted === true ? 0 : typeof c.speech === "number" && Number.isFinite(c.speech) && c.speech >= 0 && c.speech <= 1 ? Math.round(c.speech * 1000) / 1000 : null,
      muted: c.muted === true,
      shape: isShape(c.shape) ? c.shape : null,
      service: str(c.service, 60) || null,
      on_screen: str(c.on_screen, 400) || null,
      part_assets: partAssets,
      hidden_reason: hiddenReason,
      clip_type: str(c.clip_type, 60) || null,
      score_reasons: reasons,
      hero_asset_id: typeof c.hero_asset_id === "string" && ctx.allowed.has(c.hero_asset_id) ? c.hero_asset_id : null,
      files_used: used.length ? used : [...new Set([String(c.asset_id), ...(partAssets ?? [])])],
      uses_ai_images: c.uses_ai_images === true,
      event_group: str(c.event_group, 80) || null,
      words_pending: c.words_pending === true,
      style_of: typeof c.style_of === "string" && /^clp_[a-z0-9]{8,32}$/.test(c.style_of) ? c.style_of : null,
    });
  }
  return { clips: groupStyles(clips), dropped };
}

/** A result from the studio-fix engine scores 0..100 (it also sends reasons or a clip type). */
function isHundredScale(c: Partial<CutResultClip>, score: number): boolean {
  return score > 1 || Array.isArray(c.score_reasons) || typeof c.clip_type === "string";
}

/** Up to five short plain reasons. */
export function cleanReasons(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => (typeof r === "string" ? r.replace(/\s+/g, " ").trim().slice(0, 120) : "")).filter(Boolean).slice(0, 5);
}

/** "it scored 48, under this studio's bar of 70: ends on a blurry shot" (Review says "Hidden because …"). */
export function underBarReason(score: number, bar: number, reasons: string[]): string {
  return `it scored ${score}, under this studio's bar of ${bar}${reasons.length ? `: ${reasons[0]}` : ""}`;
}

/**
 * Styles are options of one clip, never separate clips (owner, 23 Oct 2026): a clip that is the
 * same cut as a better-scored one (same video, same stretches, or the engine says style_of) is
 * kept as a style of it. A style_of that points at no clip of this result is dropped.
 */
export function groupStyles(clips: CleanClip[]): CleanClip[] {
  const ids = new Set(clips.map((c) => c.id));
  const sig = (c: CleanClip) => JSON.stringify([c.asset_id, c.parts, c.part_assets ?? []]);
  const first = new Map<string, string>();
  const order = [...clips].sort((a, b) => b.score - a.score);
  const main = new Map<string, string | null>();
  for (const c of order) {
    const named = c.style_of && ids.has(c.style_of) && c.style_of !== c.id ? c.style_of : null;
    const same = first.get(sig(c)) ?? null;
    main.set(c.id, named ?? same);
    if (!named && !same) first.set(sig(c), c.id);
  }
  // A style of a style points at the main clip; a main clip is never itself a style.
  return clips.map((c) => {
    let m = main.get(c.id) ?? null;
    for (let i = 0; m && main.get(m) && i < 5; i++) m = main.get(m) ?? null;
    return { ...c, style_of: m && m !== c.id ? m : null };
  });
}

/** A song key the job may report: one of her uploads, or a built-in library track that exists. */
export function songKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^music\/[A-Za-z0-9_]{4,60}$/.test(v)) return v;
  return libraryTrack(v) ? v : null;
}

/**
 * The parts a clip plays: at most MAX_PARTS (a before -> after joins up to 6 shots, jobs/plan.py
 * MAX_PARTS), each inside the source's 0 … end_s + 1 h, else [start, end].
 */
export const MAX_PARTS = 8;
export function cleanParts(v: unknown, start: number, end: number): [number, number][] {
  if (Array.isArray(v) && v.length >= 1 && v.length <= MAX_PARTS) {
    const out: [number, number][] = [];
    for (const p of v) {
      const a = Number(Array.isArray(p) ? p[0] : NaN);
      const b = Number(Array.isArray(p) ? p[1] : NaN);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > end + 3600) return [[start, end]];
      out.push([Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
    }
    return out;
  }
  return [[start, end]];
}

/** Plain sentences for the Dump screen when cutting fails. Never echoes the raw error. */
export function plainFailure(safeError: string): string {
  const e = safeError.toLowerCase();
  if (e.includes("no usable") || e.includes("no clips") || e.includes("nousable")) return "We couldn't find any usable moments in these videos. Try longer takes with talking or action, then dump again.";
  if (e.includes("download") || e.includes("nosuchkey") || e.includes("clienterror")) return "We couldn't open your videos. Try dumping them again.";
  if (e.includes("ffmpeg") || e.includes("calledprocesserror") || e.includes("decode")) return "One of the videos couldn't be read. It may be damaged or in an unusual format. Try exporting it again from your phone.";
  if (e.includes("timeout") || e.includes("cancel")) return "Cutting took too long and stopped. Try dumping fewer or shorter videos at a time.";
  if (e.includes("result") || e.includes("clip list") || e.includes("too many clips")) return "The cutter sent back something we couldn't use. Dump the videos again; if it happens twice, tell your helper.";
  return "Cutting stopped partway. Dump the videos again; if it happens twice, tell your helper.";
}

async function applyResult(env: Env, jobId: string, refId: string | null, result: unknown): Promise<void> {
  const ref = parseCutRef(refId);
  if (!ref) throw new CutResultError("cut job has no dump");
  if (ref.import) return applyImport(env, jobId, ref.dumpId, ref.clipId, result);
  if (ref.again && ref.clipId) return applyAgain(env, jobId, ref.dumpId, ref.clipId, result);
  if (ref.clipId) return applyRerender(env, jobId, ref.dumpId, ref.clipId, result);
  return applyDumpClips(env, jobId, ref.dumpId, result, {});
}

/**
 * A dump's clips, from the built-in cutter or imported from a connected editor (`editor`, with
 * the clip ids planned when its job finished): checked by parseCutResult, stored, the dump ready,
 * the "Clips ready" email. After a built-in cut, her captions / polish editor gets the new clips.
 */
export async function applyDumpClips(env: Env, jobId: string, dumpId: string, result: unknown, opts: { editor?: string; planned?: Set<string> }): Promise<void> {
  const dump = await env.DB.prepare("SELECT id, door FROM dumps WHERE id = ?").bind(dumpId).first<{ id: string; door: "new" | "recycle" }>();
  if (!dump) throw new CutResultError("dump missing");
  // The allowed platforms are recomputed from the database, not taken from the job.
  const spec = await buildDumpSpec(env, jobId, dumpId);
  const allowed = new Map(spec.assets.map((a) => [a.id, a.allowed_platforms]));
  const rawKeys = new Set(spec.assets.map((a) => a.r2_key));
  const parsed = parseCutResult(result, { dumpId, allowed, rawKeys, rules: contentRules(env), bar: spec.studio_rules.bar });
  // An editor's import may bring back only the clips planned for it, never extra ones.
  const clips = opts.planned ? parsed.clips.filter((c) => opts.planned!.has(c.id)) : parsed.clips;
  const dropped = parsed.dropped + (parsed.clips.length - clips.length);
  if (!clips.length) throw new CutResultError("no usable clips");

  // Clip numbers: the dump's own sequence, never reused (shared/clipNumber.ts). A style takes its clip's number.
  const seq = (await env.DB.prepare("SELECT clip_seq FROM dumps WHERE id = ?").bind(dumpId).first<{ clip_seq: number }>())?.clip_seq ?? 0;
  const numbers = numberClips(clips, seq);
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM clips WHERE dump_id = ? AND status = 'draft'").bind(dumpId)];
  for (const c of clips) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, hook_alt, caption, hashtags, platforms, score, r2_key, cover_r2_key, media_token, status, hidden, look, parts, layout, edited_with, music, speech, muted, shape, service, on_screen, part_assets, hidden_reason,
           number, version, clip_type, score_reasons, hero_asset_id, files_used, uses_ai_images, event_group, words_pending, style_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        c.id, c.asset_id, dumpId, c.start_s, c.end_s, c.recipe, c.hook_text, c.hook_alt, c.caption, c.hashtags, JSON.stringify(c.platforms), c.score, c.r2_key, c.cover_r2_key, mediaToken(), c.hidden ? 1 : 0,
        opts.editor ? null : c.look, JSON.stringify(c.parts), opts.editor ? null : c.layout ? JSON.stringify(c.layout) : null, opts.editor ?? null, c.music, c.speech, c.muted ? 1 : 0,
        c.shape, c.service, c.on_screen, c.part_assets ? JSON.stringify(c.part_assets) : null, c.hidden_reason,
        numbers.get(c.id) ?? null, c.clip_type, JSON.stringify(c.score_reasons), c.hero_asset_id, JSON.stringify(c.files_used), c.uses_ai_images ? 1 : 0, c.event_group, c.words_pending ? 1 : 0, c.style_of,
      ),
    );
  }
  stmts.push(env.DB.prepare("UPDATE dumps SET clip_seq = ? WHERE id = ?").bind(Math.max(seq, ...numbers.values()), dumpId));
  // What each file became (arrival, prep, team, process, finished, detail, hero), for What I dumped.
  for (const [assetId, role] of Object.entries((result as CutResult).asset_roles ?? {})) {
    const r = typeof role === "string" ? role.trim().slice(0, 40) : "";
    if (r && allowed.has(assetId)) stmts.push(env.DB.prepare("UPDATE assets SET role = ? WHERE id = ? AND dump_id = ?").bind(r, assetId, dumpId));
  }
  const distinct = clips.filter((c) => !c.style_of);
  const byType: Record<string, number> = {};
  for (const c of distinct) byType[c.clip_type ?? "other"] = (byType[c.clip_type ?? "other"] ?? 0) + 1;
  stmts.push(env.DB.prepare("UPDATE dumps SET clip_counts = ? WHERE id = ?").bind(JSON.stringify({ distinct: distinct.length, styles: clips.length - distinct.length, by_type: byType }), dumpId));
  const own = await ownHandles(env);
  const held = sourceUpdates((result as CutResult).source_marks, new Set(allowed.keys()), own);
  for (const h of held) {
    stmts.push(env.DB.prepare("UPDATE assets SET source_owner = ?, source_note = ? WHERE id = ? AND dump_id = ? AND (source_owner IS NULL OR source_owner != 'confirmed')").bind(h.owner, h.note, h.asset_id, dumpId));
  }
  for (const a of (result as CutResult).assets ?? []) {
    const d = Number(a?.duration_s);
    if (allowed.has(String(a?.id)) && Number.isFinite(d) && d > 0) stmts.push(env.DB.prepare("UPDATE assets SET duration_s = ? WHERE id = ? AND dump_id = ?").bind(d, String(a.id), dumpId));
  }
  // What the studio saw (kept, so "Change" re-plans without looking again) and its plain line.
  const sheets = (result as CutResult).shot_sheets;
  if (sheets && typeof sheets === "object") {
    for (const [assetId, sheet] of Object.entries(sheets)) {
      const json = JSON.stringify(sheet ?? null);
      if (allowed.has(assetId) && json.length <= 60_000) stmts.push(env.DB.prepare("UPDATE assets SET shot_sheet = ? WHERE id = ? AND dump_id = ?").bind(json, assetId, dumpId));
    }
  }
  const looksLike = cleanLooksLike((result as CutResult).looks_like);
  stmts.push(env.DB.prepare("UPDATE dumps SET looks_like = ? WHERE id = ?").bind(looksLike ? JSON.stringify(looksLike) : null, dumpId));
  const readyAt = nowIso();
  stmts.push(env.DB.prepare("UPDATE dumps SET status = 'ready', clips_made = ?, ready_at = ?, error_summary = NULL WHERE id = ?").bind(clips.length, readyAt, dumpId));
  // Never silently dropped: what her notes asked that could not be done, and what the job could not find.
  const told = await steerOutcome(env, dumpId, (result as CutResult & { steer_report?: unknown }).steer_report, clips);
  stmts.push(env.DB.prepare("UPDATE dumps SET not_followed = ?, tried = ? WHERE id = ?").bind(JSON.stringify(told.not_followed), told.tried, dumpId));
  await env.DB.batch(stmts);

  // Styles are options of one clip: they never count (owner, 23 Oct 2026).
  const visible = clips.filter((c) => !c.hidden && !c.style_of).length;
  const engine = (result as CutResult).engine ?? {};
  const looks = new Set(clips.map((c) => c.look).filter(Boolean)).size;
  const calls = (result as CutResult).calls ?? {};
  await recordEvent(env.DB, "dump.cut", dumpId, { clips: clips.length, visible, dropped, door: dump.door, engine, looks, editor: opts.editor ?? "built-in", held_videos: held.filter((h) => h.owner === "other").length, calls, hidden_by_critic: clips.filter((c) => c.hidden_reason).length });
  if (opts.editor) await env.DB.prepare("UPDATE editor_jobs SET status = 'done', updated_at = ? WHERE dump_id = ? AND capability = 'cut_from_source' AND status = 'importing'").bind(nowIso(), dumpId).run();
  else await queueClipEditors(env, clips.map((c) => c.id), env.PUBLIC_BASE_URL);
  // Automatic voice overs: every new clip with no talking, in one voice job run (worker/lib/autoVoice.ts).
  if (!opts.editor) await autoVoiceDump(env, dumpId);
  await clipCuttingLight(env, { status: "done", at: readyAt });
  log.info("cut.apply", { clips: clips.length, visible, dropped });

  const s = await readSettings(env);
  const tucked = distinct.length - visible;
  const hiddenNote = tucked > 0 ? ` ${tucked} more scored under your bar and are tucked away under "Show hidden", each with the reason.` : "";
  const shown = [...numbers.entries()].filter(([id]) => clips.some((c) => c.id === id && !c.hidden && !c.style_of)).map(([, n]) => n).sort((a, b) => a - b);
  const range = shown.length ? ` (${shown.length === 1 ? `Clip ${clipCode(shown[0])}` : `Clips ${clipCode(shown[0])} to ${clipCode(shown[shown.length - 1])}`})` : "";
  const { html, text } = emailFrame(
    "Your clips are ready",
    [`${visible} new clip${visible === 1 ? " is" : "s are"} waiting for you in Review${range}.${hiddenNote}`, "Nothing posts until you approve it. Approve the ones you like, reject the rest.", `What you dumped, and which clips used each file: ${env.PUBLIC_BASE_URL}/dump/${dumpId}/files`],
    { label: "Review clips", url: `${env.PUBLIC_BASE_URL}/review` },
  );
  await sendEmail(env, { kind: "clips_ready", to: s.notify_emails, subject: `${visible} clips ready to review`, html, text, refId: dumpId });
}

/** Each distinct clip gets the next number after `seq`, in the order the engine sent them; a style shares its clip's number. Pure. */
export function numberClips(clips: Pick<CleanClip, "id" | "style_of">[], seq: number): Map<string, number> {
  const out = new Map<string, number>();
  let n = seq;
  for (const c of clips) if (!c.style_of) out.set(c.id, ++n);
  for (const c of clips) if (c.style_of && out.has(c.style_of)) out.set(c.id, out.get(c.style_of)!);
  return out;
}

/** Everything her chips and notes asked that the dump could not do, and the one-line "What we tried". */
export async function steerOutcome(env: Env, dumpId: string, report: unknown, clips: { look: string | null; music: string | null }[]): Promise<{ not_followed: NotFollowed[]; tried: string }> {
  const dump = await env.DB.prepare("SELECT steer, steer_notes FROM dumps WHERE id = ?").bind(dumpId).first<{ steer: string | null; steer_notes: string | null }>();
  const tracks = await tracksOf(env);
  const chips = cleanControls(parseJson(dump?.steer ?? null, {}), tracks).controls;
  const note = readUnderstood(dump?.steer_notes ?? null);
  const nf: NotFollowed[] = [...(note?.not_followed ?? []), ...mergeControls(chips, note?.controls ?? {}).not_followed];
  const { results: assetNotes } = await env.DB.prepare("SELECT steer_notes FROM assets WHERE dump_id = ? AND steer_notes IS NOT NULL").bind(dumpId).all<{ steer_notes: string }>();
  for (const a of assetNotes) nf.push(...(readUnderstood(a.steer_notes)?.not_followed ?? []));
  // Voice over "on quiet clips" asked for (chip or note) while her voice isn't saved: said, never dropped.
  const askedVoice = [mergeControls(chips, note?.controls ?? {}).controls.voice, ...assetNotes.map((a) => readUnderstood(a.steer_notes)?.controls.voice)];
  if (askedVoice.includes("quiet") && !(await voiceReady(env)))
    nf.push({ what: "voice overs on the quiet clips", why: "your voice isn't saved yet (Voice overs, the steps at the top), so none were made; once it is, tap Add voice over on a clip in Review" });
  if (Array.isArray(report))
    for (const r of report.slice(0, 20)) if (r && typeof r.what === "string" && typeof r.why === "string") nf.push({ what: r.what.slice(0, 120), why: r.why.slice(0, 240) });
  const seen = new Set<string>();
  return {
    not_followed: nf.filter((x) => (seen.has(x.what) ? false : (seen.add(x.what), true))),
    tried: whatWeTried(clips, tracks.map((t) => ({ r2_key: t.r2_key, name: t.name }))),
  };
}

/** The re-render's answer, checked like every job result: its own clip, the file names it was given. */
export function parseRerender(result: unknown, expect: { clipId: string; look: string; mp4: string; jpg: string }): { duration_s: number | null; voice: number | null; music: string | null } {
  const r = (result as { rerender?: Record<string, unknown> } | null)?.rerender;
  if (!r || typeof r !== "object") throw new CutResultError("result has no re-render");
  if (r.clip_id !== expect.clipId || r.look !== expect.look || r.r2_key !== expect.mp4 || r.cover_r2_key !== expect.jpg) throw new CutResultError("re-render result does not match its clip");
  const d = Number(r.duration_s);
  const v = typeof r.voice === "number" ? r.voice : NaN;
  const music = songKey(r.music);
  return { duration_s: Number.isFinite(d) && d > 0 ? d : null, voice: Number.isInteger(v) && v >= 0 ? v : null, music };
}

/**
 * The clip's file was swapped (a new Look, or her own edit): a voice over mixed into the old file
 * is out of date. The link goes back to the new file at once and the voice job mixes her voice
 * into it again (the same steps as attaching it on Voice overs, worker/routes/voice.ts).
 */
export async function remixVoiceOver(env: Env, clipId: string): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, mixed_r2_key FROM narrations WHERE clip_id = ? AND status = 'ready' AND r2_key IS NOT NULL AND mix_status IS NOT NULL")
    .bind(clipId)
    .all<{ id: string; mixed_r2_key: string | null }>();
  for (const n of results) {
    if (n.mixed_r2_key) await env.FILES.delete(n.mixed_r2_key);
    await env.DB.prepare("UPDATE narrations SET mixed_r2_key = NULL, mix_status = 'mixing' WHERE id = ?").bind(n.id).run();
    const job = await dispatchJob(env, "voice", n.id);
    if (!job.dispatched) await env.DB.prepare("UPDATE narrations SET mix_status = 'failed' WHERE id = ?").bind(n.id).run();
  }
  if (results.length) log.info("cut.voice_remix", { narrations: results.length });
  return results.length;
}

/** The sentence on the clip when a re-render fails; the old version stays. */
/** Why a clip whose words broke the studio's rules is hidden (Review says "Hidden because …"). */
export const RULES_HIDDEN = "the words broke one of this studio's rules";

export const RERENDER_FAILED = "The new look didn't finish, so your clip is unchanged. Try Change look again.";

async function applyRerender(env: Env, _jobId: string, dumpId: string, clipId: string, result: unknown): Promise<void> {
  const clip = await env.DB.prepare("SELECT id, status, r2_key, cover_r2_key, pending_look, pending_layout, media_version FROM clips WHERE id = ? AND dump_id = ?").bind(clipId, dumpId).first<{
    id: string;
    status: string;
    r2_key: string;
    cover_r2_key: string | null;
    pending_look: string | null;
    pending_layout: string | null;
    media_version: number;
  }>();
  const keys = rerenderKeys(dumpId, clipId, (clip?.media_version ?? 0) + 1);
  if (!clip || clip.status === "deleted" || !clip.pending_look) {
    // Deleted (or already applied) while it rendered: the new files have nowhere to go.
    await env.FILES.delete([keys.mp4, keys.jpg]);
    log.info("cut.rerender.orphan", {});
    return;
  }
  const r = parseRerender(result, { clipId, look: clip.pending_look, mp4: keys.mp4, jpg: keys.jpg });
  let layout = parseJson<GridLayout | null>(clip.pending_layout, null);
  if (isLookId(clip.pending_look) && isGridLook(clip.pending_look)) {
    layout = layout ?? defaultGridLayout(clip.pending_look, []);
    if (r.voice !== null && r.voice < cellCount(clip.pending_look)) layout = { ...layout, voice: r.voice };
  } else layout = null;
  await env.DB.prepare(
    `UPDATE clips SET r2_key = ?, cover_r2_key = ?, look = pending_look, layout = ?, pending_look = NULL, pending_layout = NULL, pending_music = NULL, music = ?,
       rerender_job_id = NULL, rerender_error = NULL, media_version = media_version + 1, edited_with = NULL WHERE id = ?`,
  )
    .bind(keys.mp4, keys.jpg, layout ? JSON.stringify(layout) : null, r.music, clipId)
    .run();
  const old = [clip.r2_key, clip.cover_r2_key].filter((k): k is string => !!k && k !== keys.mp4 && k !== keys.jpg);
  if (old.length) await env.FILES.delete(old);
  await remixVoiceOver(env, clipId);
  await recordEvent(env.DB, "clip.look_changed", clipId, { look: clip.pending_look });
  await queueClipEditors(env, [clipId], env.PUBLIC_BASE_URL, "caption");
  log.info("cut.rerender.apply", {});
}

/** The sentence on the clip when Try another version (with notes) fails; the clip stays as it was. */
export const AGAIN_FAILED = "The new version didn't finish, so your clip is unchanged. Try another version again.";

/**
 * Try another version with notes: the new cut replaces this clip in place (same id, so its place
 * in Review, its platforms and its status stay); the old files go once the new ones are in.
 */
async function applyAgain(env: Env, jobId: string, dumpId: string, clipId: string, result: unknown): Promise<void> {
  const clip = await env.DB.prepare("SELECT id, status, r2_key, cover_r2_key, asset_id, rerender_job_id FROM clips WHERE id = ? AND dump_id = ?").bind(clipId, dumpId).first<{ id: string; status: string; r2_key: string; cover_r2_key: string | null; asset_id: string; rerender_job_id: string | null }>();
  const got = (result as { again?: unknown } | null)?.again;
  const { results: dumpAssets } = await env.DB.prepare("SELECT id FROM assets WHERE dump_id = ?").bind(dumpId).all<{ id: string }>();
  const rules = await readStudioRules(env);
  const parsed = parseCutResult({ clips: got ? [got] : [] }, { dumpId, allowed: new Map([[clip?.asset_id ?? "", [...PLATFORMS]], ...dumpAssets.map((a) => [a.id, [...PLATFORMS]] as [string, Platform[]])]), rawKeys: new Set(), rules: contentRules(env), bar: rules.bar });
  const fresh = parsed.clips[0];
  if (!clip || clip.status === "deleted" || clip.rerender_job_id !== jobId || !fresh) {
    if (fresh) await env.FILES.delete([fresh.r2_key, fresh.cover_r2_key].filter((k): k is string => !!k));
    if (!fresh) throw new CutResultError("no usable clips");
    log.info("cut.again.orphan", {});
    return;
  }
  // The version it replaces is kept (Compare versions in Review): 5 becomes 5b, and 5 stays playable.
  await keepVersion(env, clipId);
  await env.DB.prepare(
    `UPDATE clips SET asset_id = ?, start_s = ?, end_s = ?, recipe = ?, hook_text = ?, hook_alt = ?, caption = ?, hashtags = ?, score = ?, r2_key = ?, cover_r2_key = ?, look = ?, parts = ?, layout = ?,
       music = ?, speech = ?, muted = ?, shape = ?, service = ?, on_screen = ?, part_assets = ?, hidden_reason = ?, hidden = ?, pending_look = NULL, pending_layout = NULL, pending_music = NULL, rerender_job_id = NULL, rerender_error = NULL, media_version = media_version + 1, edited_with = NULL,
       version = (SELECT COALESCE(MAX(v.version), 0) FROM clip_versions v WHERE v.clip_id = clips.id) + 1,
       clip_type = ?, score_reasons = ?, hero_asset_id = ?, files_used = ?, uses_ai_images = ?, event_group = ?, words_pending = ? WHERE id = ?`,
  )
    .bind(fresh.asset_id, fresh.start_s, fresh.end_s, fresh.recipe, fresh.hook_text, fresh.hook_alt, fresh.caption, fresh.hashtags, fresh.score, fresh.r2_key, fresh.cover_r2_key, fresh.look, JSON.stringify(fresh.parts), fresh.layout ? JSON.stringify(fresh.layout) : null, fresh.music, fresh.speech, fresh.muted ? 1 : 0, fresh.shape, fresh.service, fresh.on_screen, fresh.part_assets ? JSON.stringify(fresh.part_assets) : null, fresh.hidden_reason, fresh.hidden ? 1 : 0,
      fresh.clip_type, JSON.stringify(fresh.score_reasons), fresh.hero_asset_id, JSON.stringify(fresh.files_used), fresh.uses_ai_images ? 1 : 0, fresh.event_group, fresh.words_pending ? 1 : 0, clipId)
    .run();
  // A voice over made for the old moment no longer fits: it goes; a new one is made for a clip with no talking.
  await removeVoiceOver(env, clipId);
  await autoVoiceDump(env, dumpId);
  await recordEvent(env.DB, "clip.again_applied", clipId, {});
  log.info("cut.again.apply", { muted: fresh.muted });
}

async function onFailure(env: Env, jobId: string, refId: string | null, safeError: string): Promise<void> {
  const ref = parseCutRef(refId);
  if (!ref) return;
  if (ref.import) return importFailed(env, ref.dumpId, ref.clipId, safeError);
  if (ref.clipId) {
    await env.DB.prepare("UPDATE clips SET pending_look = NULL, pending_layout = NULL, pending_music = NULL, rerender_job_id = NULL, rerender_error = ? WHERE id = ? AND rerender_job_id = ?")
      .bind(ref.again ? AGAIN_FAILED : RERENDER_FAILED, ref.clipId, jobId)
      .run();
    log.warn("cut.rerender.failed", { len: safeError.length });
    return;
  }
  const dumpId = ref.dumpId;
  await env.DB.prepare("UPDATE dumps SET status = 'failed', error_summary = ? WHERE id = ?").bind(plainFailure(safeError), dumpId).run();
  await clipCuttingLight(env, { status: "failed", at: nowIso() });
  log.warn("cut.failed", { len: safeError.length });
}

// ---------------------------------------------------------------- fake runner

// A 2-second 90×160 H.264/AAC MP4 (made once with ffmpeg; plays in every browser) and four
// 90×160 cover JPEGs in the brand colours. Bytes in code, so no fixture files to ship.
export const FAKE_MP4_B64 = "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";
export const FAKE_JPG_B64 = [
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAUGEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAoABaAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AtwGUVgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/9k=",
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABNAAEBAAAAAAAAAAAAAAAAAAAABQEBAQEAAAAAAAAAAAAAAAAAAAMGEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAoABaAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AgAJtCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//9k=",
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAMQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCACgAFoDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMgJqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/Z",
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABNAAEBAAAAAAAAAAAAAAAAAAAABQEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAoABaAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiAKjPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/9k=",
];

const FAKE_HOOKS: [string, string][] = [
  ["POV: the kitchen after", "Nobody warned me about this part"],
  ["3 things I'd never skip", "Stop scrolling if you do this"],
  ["The moment it clicked", "I almost didn't post this"],
  ["Watch till the end", "This changed my whole week"],
  ["Real talk: day in my life", "Come with me for 30 seconds"],
  ["You asked, here it is", "The honest answer"],
  ["Before vs after", "Wait for it"],
  ["My 5 a.m. routine, unfiltered", "What mornings really look like"],
  ["The mistake everyone makes", "Please don't do this"],
  ["This is your sign", "Save this for later"],
  ["Story time", "So this happened"],
  ["Small win, big deal", "Celebrate with me"],
];
const FAKE_TAGS = ["#dayinmylife #realtalk #creator", "#motivation #mindset #womeninbusiness", "#behindthescenes #vlog #storytime", "#tips #lifehacks #smallbusiness"];
const FAKE_RECIPES: Recipe[] = ["talking_head", "hook_first", "story", "montage"];
// Fixed spread so every fake dump has a clear best, a middle and at least two under the bar.
/** 0..100, as the studio-fix engine scores; two of every twelve under a bar of 70, with their reasons. */
const FAKE_SCORES = [92, 86, 81, 78, 75, 72, 71, 74, 48, 40, 79, 73];
const FAKE_REASONS: Record<number, string[]> = { 48: ["ends on a blurry shot"], 40: ["the hook is small and hard to read", "the same shot twice"] };
const FAKE_TYPES = ["payoff-first before→after", "POV walk-in reveal", "set up with me", "finished walk-through", "photo-moment details", "photo slideshow"];

/** The engine's final caption layout (shared/postText.ts): body, CTA + link, hashtags, then "—" and Made with AI where it applies. */
export function fakeFinalCaption(body: string, tags: string, rules: StudioRules, i: number, aiMade: boolean): string {
  const phrase = rules.cta_phrases[i % rules.cta_phrases.length] ?? "";
  const cta = [phrase, rules.cta_link].filter(Boolean).join(": ");
  return [body, cta, tags].filter(Boolean).join("\n\n") + (aiMade ? "\n\n—\nMade with AI" : "");
}

function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function fakeRun(env: Env, jobId: string, refId: string | null, options: Record<string, unknown>): Promise<unknown> {
  const ref = parseCutRef(refId);
  if (!ref) throw new Error("cut job has no dump");
  if (ref.import) return fakeImport(env, jobId, ref.dumpId, ref.clipId, options, unb64(FAKE_MP4_B64), unb64(FAKE_JPG_B64[0]));
  if (ref.again && ref.clipId) {
    // The fake "another version": a new file and a new hook for the same video, as the real job.
    const spec = await buildAgainSpec(env, jobId, ref.dumpId, ref.clipId);
    const id = newId("clp", 16);
    const key = `${spec.output_prefix}${id}.mp4`;
    const cover = `${spec.output_prefix}${id}.jpg`;
    await env.FILES.put(key, unb64(FAKE_MP4_B64), { httpMetadata: { contentType: "video/mp4" } });
    await env.FILES.put(cover, unb64(FAKE_JPG_B64[1]), { httpMetadata: { contentType: "image/jpeg" } });
    const muted = spec.camera === "off";
    const start = (spec.avoid_windows[0]?.end ?? 0) + 1;
    return {
      again: { id, asset_id: spec.assets[0]!.id, start_s: start, end_s: start + 20, recipe: "montage", hook_text: spec.change_request ? "A fresh take" : "Another take", hook_alt: null, caption: "Another version.", hashtags: "#creator", platforms: spec.assets[0]!.allowed_platforms, score: 76, score_reasons: spec.fixes.length ? spec.fixes.map((f) => `fixed: ${f.replace(/_/g, " ")}`) : ["a fresh moment"], clip_type: "finished walk-through", r2_key: key, cover_r2_key: cover, look: spec.rotation[0], parts: [[start, start + 20]], layout: null, music: muted ? "library/bright-morning" : null, speech: muted ? 0 : 0.6, muted },
    };
  }
  if (ref.clipId) {
    // The fake re-render copies the clip's file to the new name, as the real job uploads a new one.
    const spec = await buildRerenderSpec(env, jobId, ref.dumpId, ref.clipId);
    await env.FILES.put(spec.output_key, unb64(FAKE_MP4_B64), { httpMetadata: { contentType: "video/mp4" } });
    await env.FILES.put(spec.output_cover_key, unb64(FAKE_JPG_B64[hashNum(spec.look_id) % FAKE_JPG_B64.length]), { httpMetadata: { contentType: "image/jpeg" } });
    return { rerender: { clip_id: spec.clip_id, look: spec.look_id, r2_key: spec.output_key, cover_r2_key: spec.output_cover_key, duration_s: 2, voice: spec.cells ? spec.voice : null, music: spec.look.music && spec.music.length ? spec.music[0].r2_key : null } };
  }
  const spec = await buildDumpSpec(env, jobId, ref.dumpId);
  if (!spec.assets.length) return { clips: [], engine: { picker: "fake" }, skipped: spec.skipped_assets.map((s) => ({ asset_id: s.id, reason: s.reason })) };
  const wanted = Number(options.clips);
  // "How many" is honored like the real job: her count, else the test's, else 6–12.
  const count = spec.steer.count ?? (Number.isInteger(wanted) && wanted >= 1 && wanted <= 24 ? wanted : 6 + (hashNum(spec.dump_id) % 7));
  const mp4 = unb64(FAKE_MP4_B64);
  const clips: CutResultClip[] = [];
  for (let i = 0; i < count; i++) {
    const asset = spec.assets[i % spec.assets.length];
    const fakeRecipes = FAKE_RECIPES.filter((r) => spec.steer.allowed_recipes.includes(r));
    const recipe: Recipe = spec.door === "recycle" ? "recycle" : (fakeRecipes.length ? fakeRecipes : FAKE_RECIPES)[i % (fakeRecipes.length || FAKE_RECIPES.length)];
    const b = spec.recipes[recipe] ?? RECIPES[recipe]; // her clip length, as the real job
    const len = b.minS + ((i * 7) % (b.maxS - b.minS + 1));
    const start = (i * 37) % 240;
    const id = newId("clp", 16);
    const key = `${spec.output_prefix}${id}.mp4`;
    const cover = `${spec.output_prefix}${id}.jpg`;
    await env.FILES.put(key, mp4, { httpMetadata: { contentType: "video/mp4" } });
    await env.FILES.put(cover, unb64(FAKE_JPG_B64[i % FAKE_JPG_B64.length]), { httpMetadata: { contentType: "image/jpeg" } });
    const [hook, alt] = FAKE_HOOKS[(i + hashNum(spec.dump_id)) % FAKE_HOOKS.length];
    const look = lookForClip(spec.rotation, i);
    // Photos of the dump join clips as their ending (the hero), as the engine does.
    const photo = spec.assets.find((a) => a.mime_type.startsWith("image/"));
    const used = [...new Set([asset.id, ...(photo ? [photo.id] : [])])];
    const aiImages = used.some((id) => spec.assets.find((a) => a.id === id)?.exif_camera === false);
    const score = FAKE_SCORES[i % FAKE_SCORES.length];
    const tags = FAKE_TAGS[i % FAKE_TAGS.length];
    const body = `${hook}. ${spec.door === "recycle" ? "A favourite, back with a new opening." : "Straight from this week."}`;
    clips.push({
      id,
      asset_id: asset.id,
      start_s: start,
      end_s: start + len,
      recipe,
      hook_text: hook,
      hook_alt: alt,
      caption: fakeFinalCaption(body, tags, spec.studio_rules, i, spec.studio_rules.ai_note === "all" || aiImages),
      hashtags: tags,
      platforms: asset.allowed_platforms,
      score,
      score_reasons: FAKE_REASONS[score] ?? ["ends on the finished result, held 2 seconds"],
      clip_type: FAKE_TYPES[i % FAKE_TYPES.length],
      hero_asset_id: photo?.id ?? asset.id,
      files_used: used,
      uses_ai_images: aiImages,
      event_group: "event-1",
      r2_key: key,
      cover_r2_key: cover,
      look,
      parts: [[start, start + len]],
      layout: null,
      music: spec.looks[look]?.music && spec.music.length ? spec.music[i % spec.music.length].r2_key : null,
      // A montage is b-roll with no talking (the real job measures it from the transcript); camera sound off = no talking, music always.
      speech: spec.camera === "off" ? 0 : recipe === "montage" ? 0.04 : 0.72,
      ...(spec.camera === "off" ? { muted: true, music: spec.music[i % Math.max(1, spec.music.length)]?.r2_key ?? `library/${["bright-morning", "pop-up"][i % 2]}` } : {}),
    });
  }
  // Grid Looks: the other clips of this dump fill the cells, as the real job does.
  for (const c of clips) {
    if (c.look && isLookId(c.look) && isGridLook(c.look)) c.layout = defaultGridLayout(c.look, clips.filter((o) => o.id !== c.id).map((o) => o.id));
  }
  // A test can ask the fake to "see" a watermark on the first video (the real job reads it by OCR).
  const marks = Array.isArray(options.source_marks) ? (options.source_marks as Omit<SourceMark, "asset_id">[]).map((m) => ({ ...m, asset_id: spec.assets[0]!.id })) : undefined;
  const roles = Object.fromEntries(spec.assets.map((a, i) => [a.id, a.mime_type.startsWith("image/") ? "hero" : ["arrival", "prep", "process", "finished"][i % 4]]));
  return { clips, asset_roles: roles, clip_counts: { distinct: clips.length, by_type: {} }, engine: { transcript: "fake", picker: "fake", crop: "fake", subtitles: "fake" }, skipped: spec.skipped_assets.map((s) => ({ asset_id: s.id, reason: s.reason })), ...(marks ? { source_marks: marks } : {}) };
}

export const cutJob: JobHandler = { buildSpec, applyResult, onFailure, fakeRun };
