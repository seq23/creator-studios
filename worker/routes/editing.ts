// Settings > Editing: which Looks are in the rotation (all on by default), word captions, the end
// card, the music bed and her own songs (My music). The cut job reads the same row through
// renderContext() in worker/jobs/cut.ts, so what she switches here is what the next dump renders.
//
//   GET    /api/editing                 { editing, looks, music }
//   PATCH  /api/editing                 { looks?, captions?, end_card?, music?, editors? }   (owner)
//                                       editors: Who edits, per job: "built-in" or a connected editor
//   POST   /api/editing/music           { id, key }  after the upload finished (owner)
//   DELETE /api/editing/music/:id                                                    (owner)
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { getSetting, recordEvent, setSetting } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { log } from "../lib/log";
import { GRIDS, LOOKS, cleanEditing, editingFromStored, editingToStored, lookThumb, type EditingSettings, type LookId, type StoredEditing } from "../domain/looks";
import { MUSIC_MAX_BYTES } from "./uploads";
import { CAPABILITY_TEXT, CHOOSABLE, cleanEditorChoice, editorChoiceFromStored, editorsFor, effectiveEditor, type ChoosableCapability, type EditorChoice } from "../domain/editors";
import { connectedEditors } from "../lib/editorJobs";

export const editing = new Hono<{ Bindings: Env; Variables: Vars }>();
editing.use("*", requireUser);

export interface LookView {
  id: LookId;
  name: string;
  description: string;
  thumb: string;
  /** Grid Looks: the cells as [x, y, w, h] in the 1080×1920 frame; null otherwise. */
  cells: (readonly [number, number, number, number])[] | null;
}

export interface MusicTrack {
  id: string;
  file_name: string;
  size_bytes: number;
  created_at: string;
}

/** Who edits, per job: every editor that can do it is listed, connected or not (nothing hidden). */
export interface EditorRow {
  capability: ChoosableCapability;
  name: string;
  what: string;
  choice: EditorChoice[ChoosableCapability];
  /** Who actually does it now: her pick while connected, else the built-in editor. */
  effective: EditorChoice[ChoosableCapability];
  options: { id: string; name: string; connected: boolean }[];
}

export interface EditingView {
  editing: EditingSettings;
  looks: LookView[];
  music: MusicTrack[];
  editors: EditorRow[];
  templates: { name: string; what: string };
}

export const LOOK_VIEWS: LookView[] = LOOKS.map((l) => ({
  id: l.id,
  name: l.name,
  description: l.description,
  thumb: lookThumb(l.id),
  cells: l.layout === "grid" && l.grid ? [...GRIDS[l.grid].cells] : null,
}));

async function stored(env: Env): Promise<StoredEditing> {
  return (await getSetting<StoredEditing>(env.DB, "editing", {})) ?? {};
}

async function tracks(env: Env): Promise<MusicTrack[]> {
  const { results } = await env.DB.prepare("SELECT id, file_name, size_bytes, created_at FROM music_tracks ORDER BY created_at").all<MusicTrack>();
  return results;
}

async function editorRows(env: Env, raw: StoredEditing): Promise<EditorRow[]> {
  const choice = editorChoiceFromStored(raw.editors);
  const connected = await connectedEditors(env);
  return CHOOSABLE.map((cap) => ({
    capability: cap,
    name: CAPABILITY_TEXT[cap].name,
    what: CAPABILITY_TEXT[cap].what,
    choice: choice[cap],
    effective: effectiveEditor(choice, cap, connected),
    options: [{ id: "built-in", name: "Built-in (free)", connected: true }, ...editorsFor(cap).map((e) => ({ id: e.id, name: e.name, connected: connected.has(e.id) }))],
  }));
}

async function view(env: Env): Promise<EditingView> {
  const raw = await stored(env);
  return { editing: editingFromStored(raw), looks: LOOK_VIEWS, music: await tracks(env), editors: await editorRows(env, raw), templates: CAPABILITY_TEXT.templates };
}

editing.get("/", async (c) => c.json(await view(c.env)));

editing.patch("/", requireOwner, async (c) => {
  const body = await readJson<Partial<EditingSettings> & { editors?: unknown }>(c);
  if (!body) return fail(c, 400, "Nothing to save.");
  const raw = await stored(c.env);
  if (body.editors !== undefined) {
    const picked = cleanEditorChoice(body.editors, editorChoiceFromStored(raw.editors), await connectedEditors(c.env));
    if ("error" in picked) return fail(c, 422, picked.error, "connect-an-editor");
    raw.editors = picked.choice;
  }
  const next = cleanEditing(body, editingFromStored(raw));
  if (!next) return fail(c, 422, "Keep at least one look switched on, so every dump gets one.", "looks-and-styles");
  if (next.music && !(await tracks(c.env)).length) return fail(c, 409, "Add a song under My music first. The music bed only ever uses songs you upload.", "looks-and-styles");
  await setSetting(c.env.DB, "editing", editingToStored(next, raw));
  await recordEvent(c.env.DB, "settings.editing", null, { looks: next.looks.length, captions: next.captions, end_card: next.end_card, music: next.music, editors: raw.editors ?? null }, c.get("user").email);
  return c.json(await view(c.env));
});

/** After the chunked upload of a song finished: check it is really there, keep it, switch music on the first time. */
editing.post("/music", requireOwner, async (c) => {
  const body = await readJson<{ id?: string; key?: string; fileName?: string; mimeType?: string }>(c);
  const id = String(body?.id ?? "");
  const key = String(body?.key ?? "");
  if (!/^upl_[a-z0-9]{8,40}$/.test(id) || key !== `music/${id}`) return fail(c, 400, "That upload is not a song.", "looks-and-styles");
  const head = await c.env.FILES.head(key);
  if (!head) return fail(c, 404, "The song did not finish uploading. Try again.", "looks-and-styles");
  if (head.size > MUSIC_MAX_BYTES) {
    await c.env.FILES.delete(key);
    return fail(c, 413, "That song is over 25 MB. Export it as an MP3 or M4A and try again.", "looks-and-styles");
  }
  const mime = head.httpMetadata?.contentType ?? String(body?.mimeType ?? "audio/mpeg");
  if (!mime.startsWith("audio/")) {
    await c.env.FILES.delete(key);
    return fail(c, 422, "That file is not a song. Pick an MP3, M4A or WAV.", "looks-and-styles");
  }
  const first = !(await tracks(c.env)).length;
  await c.env.DB.prepare("INSERT OR REPLACE INTO music_tracks (id, file_name, r2_key, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, String(body?.fileName ?? "Song").slice(0, 120), key, mime, head.size)
    .run();
  let note = "Song added. New clips can use it as a quiet music bed under your voice.";
  if (first) {
    // She added a song: she wants music. The bed turns on (she can switch it off right here).
    const raw = await stored(c.env);
    await setSetting(c.env.DB, "editing", editingToStored({ ...editingFromStored(raw), music: true }, raw));
    note = "Song added and the music bed is on: new clips play it quietly under your voice.";
  }
  await recordEvent(c.env.DB, "music.added", id, {}, c.get("user").email);
  log.info("music.added", { first });
  return c.json({ ...(await view(c.env)), note });
});

editing.delete("/music/:id", requireOwner, async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM music_tracks WHERE id = ?").bind(c.req.param("id")).first<{ r2_key: string }>();
  if (!row) return fail(c, 404, "That song is already gone.");
  await c.env.FILES.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM music_tracks WHERE id = ?").bind(c.req.param("id")).run();
  if (!(await tracks(c.env)).length) {
    // No songs left: the bed has nothing to play, so it switches off (and says so on the card).
    const raw = await stored(c.env);
    await setSetting(c.env.DB, "editing", editingToStored({ ...editingFromStored(raw), music: false }, raw));
  }
  await recordEvent(c.env.DB, "music.removed", c.req.param("id") ?? null, {}, c.get("user").email);
  return c.json(await view(c.env));
});
