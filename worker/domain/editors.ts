// Editors: who does each editing job. The built-in editor (Looks, jobs/looks.py) is free, always
// works and is the default and the fallback for everything. On top of it (docs/EDITORS.md, the
// research behind this list, 25 Sep 2026):
//   - hand-off / hand-back apps with no API (CapCut, InShot): she takes a clip out from Review,
//     edits it there, and uploads her edit back; it replaces the rendered file after the same checks
//   - connected editors with a verified self-serve API (Opus Clip, Vizard, Klap, Submagic, Descript):
//     each declares what it can do; Settings > Editing > "Who edits" picks one per job.
// Everything here is pure and unit-tested (tests/unit/editors.test.ts).
import type { Platform, Recipe } from "@shared/constants";

export * from "@shared/editors";
import { API_EDITORS, CAPABILITY_TEXT, CHOOSABLE, EDITORS, HANDOFF, HANDOFF_APPS, type ApiEditorDef, type ApiEditorId, type ChoosableCapability, type HandoffApp } from "@shared/editors";

export function isApiEditor(v: unknown): v is ApiEditorId {
  return typeof v === "string" && (API_EDITORS as readonly string[]).includes(v);
}
export function isHandoffApp(v: unknown): v is HandoffApp {
  return typeof v === "string" && (HANDOFF_APPS as readonly string[]).includes(v);
}
export function editorDef(id: string | null | undefined): ApiEditorDef | null {
  return EDITORS.find((e) => e.id === id) ?? null;
}
/** The name shown on a clip ("Edited in CapCut", "Cut by Opus Clip"). */
export function editorName(id: string | null | undefined): string | null {
  if (!id) return null;
  if (isHandoffApp(id)) return HANDOFF[id].name;
  return editorDef(id)?.name ?? null;
}
export function editorsFor(cap: ChoosableCapability): ApiEditorDef[] {
  return EDITORS.filter((e) => e.capabilities.includes(cap));
}

// ---------------------------------------------------------------- Who edits

export type EditorChoice = Record<ChoosableCapability, "built-in" | ApiEditorId>;
export const DEFAULT_EDITOR_CHOICE: EditorChoice = { cut_from_source: "built-in", caption: "built-in", enhance: "built-in" };

export function editorChoiceFromStored(v: unknown): EditorChoice {
  const raw = (v ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_EDITOR_CHOICE };
  for (const cap of CHOOSABLE) {
    const x = raw[cap];
    if (isApiEditor(x) && editorDef(x)!.capabilities.includes(cap)) out[cap] = x;
  }
  return out;
}

/**
 * Her pick from Settings, made safe: each job goes to "built-in" or to an editor that does that
 * job AND is connected now. null = refuse with a plain sentence (the route says which).
 */
export function cleanEditorChoice(input: unknown, current: EditorChoice, connected: ReadonlySet<ApiEditorId>): { choice: EditorChoice } | { error: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  const out = { ...current };
  for (const cap of CHOOSABLE) {
    if (v[cap] === undefined) continue;
    const x = v[cap];
    if (x === "built-in") {
      out[cap] = "built-in";
      continue;
    }
    if (!isApiEditor(x) || !editorDef(x)!.capabilities.includes(cap)) return { error: `That editor can't do ${CAPABILITY_TEXT[cap].name.toLowerCase()}.` };
    if (!connected.has(x)) return { error: `Connect ${editorDef(x)!.name} on the Connect screen first.` };
    out[cap] = x;
  }
  return { choice: out };
}

/** Who actually does the job now: her pick while it is connected and answering, else the built-in editor. */
export function effectiveEditor(choice: EditorChoice, cap: ChoosableCapability, connected: ReadonlySet<ApiEditorId>): "built-in" | ApiEditorId {
  const x = choice[cap];
  return x !== "built-in" && connected.has(x) ? x : "built-in";
}

// ---------------------------------------------------------------- her edit, back from another app

/** Longest video each platform takes for these posts (TikTok 10 min, Instagram Reels 90 s, YouTube Shorts 3 min). */
export const PLATFORM_MAX_S: Record<Platform, number> = { tiktok: 600, instagram: 90, youtube: 180 };
export const MIN_EDIT_S = 3;
export const MAX_EDIT_BYTES = 1024 * 1024 * 1024;
const PLATFORM_NAME: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube Shorts" };

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min${r ? ` ${r} s` : ""}` : `${r} s`;
}

/**
 * Is her edit usable for this clip? A tall 9:16 video (within 3%), at least 3 s, and no longer
 * than every platform the clip is ticked for allows. Each refusal says what to do in the app.
 */
export function checkEdit(probe: { width: number; height: number; duration_s: number } | null, platforms: readonly Platform[], app: string): { ok: true } | { ok: false; error: string } {
  if (!probe || !probe.width || !probe.height || !(probe.duration_s > 0)) return { ok: false, error: `We couldn't read that video. Export it again from ${app} as an MP4 and upload it.` };
  const ratio = probe.width / probe.height;
  if (Math.abs(ratio - 9 / 16) > 0.03 * (9 / 16))
    return { ok: false, error: `Your edit is ${probe.width}×${probe.height}, not a tall 9:16 video. In ${app} set the ratio to 9:16, export again and upload it.` };
  if (probe.duration_s < MIN_EDIT_S) return { ok: false, error: `Your edit is only ${mmss(probe.duration_s)}. Clips need at least ${MIN_EDIT_S} seconds.` };
  for (const p of platforms) {
    if (probe.duration_s > PLATFORM_MAX_S[p] + 0.5)
      return { ok: false, error: `${PLATFORM_NAME[p]} takes up to ${mmss(PLATFORM_MAX_S[p])}; your edit is ${mmss(probe.duration_s)}. Trim it in ${app}, or untick ${PLATFORM_NAME[p]} on this clip first.` };
  }
  return { ok: true };
}

/** A clip from another editor gets the recipe its length fits (for Review's filter and the checks). */
export function recipeForLength(seconds: number): Recipe {
  if (seconds <= 45) return "talking_head";
  if (seconds <= 60) return "hook_first";
  return "story";
}
