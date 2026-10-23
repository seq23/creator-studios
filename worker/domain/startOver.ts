// Start over (owner, 22 Oct 2026): a dump's New clips go, and the same videos are cut again with the
// current settings (and any notes she adds). Approved, posted and rejected clips stay, and her
// uploaded videos are never touched. Pure and unit-tested (tests/unit/start-over.test.ts).

export interface StartOverClip {
  id: string;
  status: string;
  /** Already loaded into Buffer (it can't be removed from here). */
  in_buffer: boolean;
}

export interface StartOverPlan {
  /** The plain refusal, when it can't start now. */
  refusal: { status: 404 | 409; error: string } | null;
  /** The New clips that go. */
  remove: string[];
  /** The clips that stay (approved, rejected, or in Buffer). */
  keep: number;
}

export function startOverPlan(dump: { status: string; kind: string } | null, clips: readonly StartOverClip[], sources: number): StartOverPlan {
  const no = (status: 404 | 409, error: string): StartOverPlan => ({ refusal: { status, error }, remove: [], keep: 0 });
  if (!dump) return no(404, "That dump no longer exists.");
  if (dump.kind === "full_video") return no(409, "A full video for YouTube isn't cut, so there is nothing to start over.");
  if (["uploading", "queued", "cutting"].includes(dump.status)) return no(409, "This dump is still being cut. Start over once its clips are ready.");
  if (!sources) return no(409, "The original videos for this dump were cleared after 7 days, so they can't be cut again. Dump them again instead.");
  const live = clips.filter((c) => c.status !== "deleted");
  const remove = live.filter((c) => c.status === "draft" && !c.in_buffer).map((c) => c.id);
  return { refusal: null, remove, keep: live.length - remove.length };
}

/** The dump's notes with what she added on Start over, as one note the cut reads. Pure. */
export function notesWithStartOver(notes: string, added: string): string {
  const a = added.replace(/\s+/g, " ").trim();
  if (!a) return notes;
  return `${notes.trim()}${notes.trim() ? "\n" : ""}${a}`.slice(0, 4000);
}
