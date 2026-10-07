// Looks: named presets of the built-in editor's options (captions, layout, motion, branding).
// jobs/looks.json is the source of truth the cut job renders from; this file mirrors it for the
// Worker and the app, and tests/unit/looks.test.ts fails if the two disagree in any field.
// Everything here is pure and unit-tested: the rotation that gives a dump's clips different
// looks, the look → options resolution with her Settings → Editing switches, the grid cells
// and the voice cell.

export const LOOK_CAPTIONS = ["clean", "karaoke", "boxed", "none"] as const;
export const LOOK_LAYOUTS = ["fill", "blur_fill", "pip", "grid"] as const;
export type CaptionStyle = (typeof LOOK_CAPTIONS)[number];
export type LayoutKind = (typeof LOOK_LAYOUTS)[number];
export type GridId = "stack_2" | "side_2" | "grid_2x2" | "grid_2x3" | "grid_2x4" | "hero_strip";

export interface LookOptions {
  captions: CaptionStyle;
  caption_position: "bottom" | "center";
  hook: "top_bold" | "none";
  layout: LayoutKind;
  grid: GridId | null;
  punch_in: boolean;
  progress_bar: boolean;
  crossfade: boolean;
  grade: "none" | "warm";
  end_card: boolean;
}

export interface Look extends LookOptions {
  id: LookId;
  name: string;
  description: string;
}

export const FRAME = { w: 1080, h: 1920, gutter: 12 } as const;
export const DEFAULT_BRAND = { primary: "#d7b56d", ink: "#211713", paper: "#f7f1e7", accent: "#8f4b5b" } as const;
export const DEFAULT_FONT = "DejaVu Sans";

/** [x, y, w, h] in the 1080×1920 frame. */
export type Cell = readonly [number, number, number, number];

export const GRIDS: Record<GridId, { label: string; cells: readonly Cell[] }> = {
  stack_2: { label: "Two stacked", cells: [[0, 0, 1080, 954], [0, 966, 1080, 954]] },
  side_2: { label: "Two side by side", cells: [[0, 0, 534, 1920], [546, 0, 534, 1920]] },
  grid_2x2: { label: "2 x 2", cells: [[0, 0, 534, 954], [546, 0, 534, 954], [0, 966, 534, 954], [546, 966, 534, 954]] },
  grid_2x3: {
    label: "2 x 3",
    cells: [[0, 0, 534, 632], [546, 0, 534, 632], [0, 644, 534, 632], [546, 644, 534, 632], [0, 1288, 534, 632], [546, 1288, 534, 632]],
  },
  grid_2x4: {
    label: "2 x 4",
    cells: [
      [0, 2, 534, 470], [546, 2, 534, 470],
      [0, 484, 534, 470], [546, 484, 534, 470],
      [0, 966, 534, 470], [546, 966, 534, 470],
      [0, 1448, 534, 470], [546, 1448, 534, 470],
    ],
  },
  hero_strip: { label: "One big, three small", cells: [[0, 0, 1080, 1440], [0, 1452, 352, 468], [364, 1452, 352, 468], [728, 1452, 352, 468]] },
};

const base = { punch_in: false, progress_bar: false, crossfade: false, grade: "none", end_card: true, grid: null } as const;

export const LOOKS = [
  { ...base, id: "clean", name: "Clean", description: "Full frame that follows your face, simple white captions at the bottom, your end card.", captions: "clean", caption_position: "bottom", hook: "none", layout: "fill" },
  { ...base, id: "bold_hook", name: "Bold hook", description: "Big bold hook across the top for the first seconds, each word lights up as you say it, a little zoom on each new sentence.", captions: "karaoke", caption_position: "bottom", hook: "top_bold", layout: "fill", punch_in: true },
  { ...base, id: "karaoke", name: "Karaoke captions", description: "Captions in the middle of the screen, each word lights up as you say it, with a progress bar.", captions: "karaoke", caption_position: "center", hook: "top_bold", layout: "fill", punch_in: true, progress_bar: true },
  { ...base, id: "brand_card", name: "Brand card", description: "Captions on a box in your brand colour, a brand-coloured progress bar and your logo card at the end.", captions: "boxed", caption_position: "bottom", hook: "top_bold", layout: "fill", progress_bar: true },
  { ...base, id: "cinematic", name: "Cinematic", description: "The whole picture over a soft blurred copy, a warm film look, smooth fades between moments.", captions: "clean", caption_position: "bottom", hook: "none", layout: "blur_fill", crossfade: true, grade: "warm" },
  { ...base, id: "reaction", name: "Reaction inset", description: "Full frame with your strongest line replaying in a small window in the corner.", captions: "clean", caption_position: "bottom", hook: "top_bold", layout: "pip" },
  { ...base, id: "split", name: "Split moment", description: "Two moments stacked, top and bottom. You hear the top one; captions sit on the line between.", captions: "boxed", caption_position: "center", hook: "top_bold", layout: "grid", grid: "stack_2" },
  { ...base, id: "side_by_side", name: "Side by side", description: "Two moments next to each other, left and right, like a before and after.", captions: "boxed", caption_position: "center", hook: "top_bold", layout: "grid", grid: "side_2", progress_bar: true },
  { ...base, id: "grid_four", name: "Grid of four", description: "Four moments in a 2 by 2 grid. One plays its sound; you can change which one in Review.", captions: "boxed", caption_position: "center", hook: "top_bold", layout: "grid", grid: "grid_2x2" },
  { ...base, id: "grid_six", name: "Grid of six", description: "Six moments in a 2 by 3 grid, great for a recap of your week.", captions: "boxed", caption_position: "center", hook: "top_bold", layout: "grid", grid: "grid_2x3", progress_bar: true },
  { ...base, id: "grid_eight", name: "Grid of eight", description: "Eight moments in a 2 by 4 grid, a busy montage with one voice on top.", captions: "boxed", caption_position: "center", hook: "top_bold", layout: "grid", grid: "grid_2x4" },
  { ...base, id: "hero_strip", name: "Hero and strip", description: "One big moment on top and three small ones in a strip underneath.", captions: "clean", caption_position: "center", hook: "top_bold", layout: "grid", grid: "hero_strip", progress_bar: true, grade: "warm" },
] as const satisfies readonly (Omit<Look, "id"> & { id: string })[];

export type LookId = (typeof LOOKS)[number]["id"];
export const LOOK_IDS = LOOKS.map((l) => l.id) as LookId[];
const BY_ID = new Map<string, Look>(LOOKS.map((l) => [l.id, l as Look]));

export function isLookId(v: unknown): v is LookId {
  return typeof v === "string" && BY_ID.has(v);
}
export function lookById(id: string | null | undefined): Look | null {
  return (id && BY_ID.get(id)) || null;
}
export function isGridLook(id: string | null | undefined): boolean {
  return lookById(id)?.layout === "grid";
}
/** How many cells the look has: 1 for every non-grid look. */
export function cellCount(id: string | null | undefined): number {
  const l = lookById(id);
  return l?.layout === "grid" && l.grid ? GRIDS[l.grid].cells.length : 1;
}
/** The thumbnail every Look ships with (validator `looks` checks the file exists). */
export function lookThumb(id: LookId): string {
  return `/looks/${id}.webp`;
}

// ---------------------------------------------------------------- Settings → Editing

export interface EditingSettings {
  /** Looks in the rotation; all of them by default. At least one. */
  looks: LookId[];
  /** Word captions (the words she says, on screen). Hook text is separate. */
  captions: boolean;
  /** Her logo + handle for the last 1.5 s. */
  end_card: boolean;
  /** A bed from her own uploaded songs, under her voice. Off until she adds a song. */
  music: boolean;
}

export const DEFAULT_EDITING: EditingSettings = { looks: [...LOOK_IDS], captions: true, end_card: true, music: false };

/**
 * A saved or posted Editing value made safe: unknown looks dropped, order kept as LOOKS, an
 * empty rotation refused (null) because a dump must always get a Look.
 */
export function cleanEditing(input: unknown, current: EditingSettings = DEFAULT_EDITING): EditingSettings | null {
  const v = (input ?? {}) as Partial<Record<keyof EditingSettings, unknown>>;
  let looks = current.looks;
  if (v.looks !== undefined) {
    if (!Array.isArray(v.looks)) return null;
    looks = LOOK_IDS.filter((id) => (v.looks as unknown[]).includes(id));
    if (!looks.length) return null;
  }
  const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
  return { looks, captions: bool(v.captions, current.captions), end_card: bool(v.end_card, current.end_card), music: bool(v.music, current.music) };
}

/** What the cut job actually renders for a Look, after her Settings → Editing switches. */
export interface ResolvedLook extends LookOptions {
  id: LookId;
  music: boolean;
}

export function resolveLook(id: LookId, editing: EditingSettings, hasMusic: boolean): ResolvedLook {
  const l = lookById(id) ?? lookById("clean")!;
  return {
    id: l.id,
    captions: editing.captions ? l.captions : "none",
    caption_position: l.caption_position,
    hook: l.hook,
    layout: l.layout,
    grid: l.grid,
    punch_in: l.punch_in,
    progress_bar: l.progress_bar,
    crossfade: l.crossfade,
    grade: l.grade,
    end_card: editing.end_card && l.end_card,
    music: editing.music && hasMusic,
  };
}

// ---------------------------------------------------------------- rotation

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** Deterministic shuffle (seeded by the dump id), so a re-run gives the same order. */
function shuffled<T>(xs: readonly T[], seed: string): T[] {
  const out = [...xs];
  let h = hash(seed) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The order a dump's clips take their Looks in: the enabled Looks shuffled per dump, singles and
 * grids interleaved two to one (a dump is never mostly grids), every enabled Look used before any
 * repeats, and never the same Look twice in a row. Clip k gets rotation[k % length].
 */
export function rotationFor(enabled: readonly LookId[], seed: string): LookId[] {
  const on = LOOK_IDS.filter((id) => enabled.includes(id));
  if (!on.length) return ["clean"];
  const singles = shuffled(on.filter((id) => !isGridLook(id)), `${seed}:s`);
  const grids = shuffled(on.filter((id) => isGridLook(id)), `${seed}:g`);
  const out: LookId[] = [];
  let s = 0;
  let g = 0;
  while (s < singles.length || g < grids.length) {
    for (let k = 0; k < 2 && s < singles.length; k++) out.push(singles[s++]);
    if (g < grids.length) out.push(grids[g++]);
  }
  return out;
}

export function lookForClip(rotation: readonly LookId[], k: number): LookId {
  return rotation.length ? rotation[((k % rotation.length) + rotation.length) % rotation.length] : "clean";
}

/** How many clips of a dump got each Look (the staging report and the Dump screen use it). */
export function lookDistribution(looks: readonly (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of looks) out[l ?? "none"] = (out[l ?? "none"] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------- grid cells

/** One cell's source. `moment` = another clip's moment (by clip id), `zoom` = the voice clip's own moment, closer. */
export type CellSource = { kind: "clip"; clip_id: string } | { kind: "zoom"; zoom: number } | { kind: "self" };

export interface GridLayout {
  cells: CellSource[];
  /** Which cell's sound plays; its words are the captions. */
  voice: number;
}

/** The cell with the clearest speech (highest score) is the voice; ties go to the first. */
export function pickVoiceCell(speech: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < speech.length; i++) if ((speech[i] ?? 0) > (speech[best] ?? 0)) best = i;
  return best;
}

export const ZOOMS = [1.35, 1.7, 2.1] as const;

/**
 * Her cell picks from Review, made safe for a grid Look: exactly the grid's number of cells,
 * each a known kind (a clip id shape, a zoom from ZOOMS), the voice inside the grid. The clip's
 * own moment ("self") must stay in at least one cell. null = refuse with a plain sentence.
 */
export function cleanGridLayout(lookId: LookId, input: unknown): GridLayout | null {
  const n = cellCount(lookId);
  if (!isGridLook(lookId)) return null;
  const v = (input ?? {}) as { cells?: unknown; voice?: unknown };
  if (!Array.isArray(v.cells) || v.cells.length !== n) return null;
  const cells: CellSource[] = [];
  for (const raw of v.cells as unknown[]) {
    const c = (raw ?? {}) as { kind?: unknown; clip_id?: unknown; zoom?: unknown };
    if (c.kind === "self") cells.push({ kind: "self" });
    else if (c.kind === "clip" && typeof c.clip_id === "string" && /^clp_[a-z0-9]{8,32}$/.test(c.clip_id)) cells.push({ kind: "clip", clip_id: c.clip_id });
    else if (c.kind === "zoom" && typeof c.zoom === "number" && (ZOOMS as readonly number[]).includes(c.zoom)) cells.push({ kind: "zoom", zoom: c.zoom });
    else return null;
  }
  if (!cells.some((c) => c.kind === "self")) return null;
  const voice = Number(v.voice);
  if (!Number.isInteger(voice) || voice < 0 || voice >= n) return null;
  return { cells, voice };
}

/** A default grid for a clip: itself first, then the other clips given, then closer zooms. */
export function defaultGridLayout(lookId: LookId, otherClipIds: readonly string[]): GridLayout {
  const n = cellCount(lookId);
  const cells: CellSource[] = [{ kind: "self" }];
  for (const id of otherClipIds) {
    if (cells.length >= n) break;
    cells.push({ kind: "clip", clip_id: id });
  }
  let z = 0;
  while (cells.length < n) cells.push({ kind: "zoom", zoom: ZOOMS[z++ % ZOOMS.length] });
  return { cells, voice: 0 };
}

// ---------------------------------------------------------------- stored shape

/** What the `editing` settings row holds: the Looks she switched OFF, so a new Look is on. */
export interface StoredEditing {
  looks_off?: unknown;
  captions?: unknown;
  end_card?: unknown;
  music?: unknown;
  editors?: unknown;
}

export function editingFromStored(v: StoredEditing | null | undefined): EditingSettings {
  const off = Array.isArray(v?.looks_off) ? (v!.looks_off as unknown[]) : [];
  const looks = LOOK_IDS.filter((id) => !off.includes(id));
  const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
  return {
    looks: looks.length ? looks : [...LOOK_IDS],
    captions: bool(v?.captions, DEFAULT_EDITING.captions),
    end_card: bool(v?.end_card, DEFAULT_EDITING.end_card),
    music: bool(v?.music, DEFAULT_EDITING.music),
  };
}

export function editingToStored(e: EditingSettings, rest: StoredEditing = {}): StoredEditing {
  return { ...rest, looks_off: LOOK_IDS.filter((id) => !e.looks.includes(id)), captions: e.captions, end_card: e.end_card, music: e.music };
}

// ---------------------------------------------------------------- branding for the end card

export interface Branding {
  colors: { primary: string; ink: string; paper: string; accent: string };
  font: string | null;
  handle: string | null;
  cta: string | null;
}

/** Fonts the cut job can fetch for captions (jobs/looks.py FONT_URLS). */
export const BRAND_FONTS = ["Montserrat", "Playfair Display", "Poppins", "Inter", "Lato", "Open Sans"] as const;

/**
 * Her branding for a render: the handle of her TikTok channel in Buffer (else any channel, else
 * the first @handle in her Brand Profile); colours and font when her Brand Profile names them
 * (the first two #rrggbb codes are her primary and accent colours), defaults otherwise; her first
 * call to action for the end card.
 */
export function brandingFor(profile: Record<string, string> | null, channels: { platform?: string; handle?: string }[]): Branding {
  const text = profile ? Object.values(profile).join("\n") : "";
  const hexes = [...text.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => `#${m[1].toLowerCase()}`);
  const font = BRAND_FONTS.find((f) => new RegExp(`\\b${f.replace(" ", "\\s+")}\\b`, "i").test(text)) ?? null;
  const tiktok = channels.find((c) => c.platform === "tiktok" && c.handle)?.handle ?? channels.find((c) => c.handle)?.handle ?? null;
  const fromProfile = /(^|\s)@([A-Za-z0-9._]{2,30})/.exec(profile?.who ?? text)?.[2] ?? null;
  const raw = (tiktok ?? fromProfile ?? "").replace(/^@+/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30);
  const cta = (profile?.ctas ?? "")
    .split("\n")
    .map((l) => l.replace(/^[\s\-•\t]+|[\s\-•\t]+$/g, ""))
    .find(Boolean);
  return {
    colors: { primary: hexes[0] ?? DEFAULT_BRAND.primary, ink: DEFAULT_BRAND.ink, paper: DEFAULT_BRAND.paper, accent: hexes[1] ?? DEFAULT_BRAND.accent },
    font,
    handle: raw ? `@${raw}` : null,
    cta: cta ? cta.slice(0, 60) : null,
  };
}
