// One tap out of the way, one tap back (day 358, docs/reviews/2026-09-26-day-358.md). Archive is
// not delete: the thing waits under "Show archived". Home cards are dismissed (they still live on
// their own screen). Both show a toast with Undo.
import { post } from "./api";

type Toaster = { undo: (text: string, run: () => void) => void; bad: (e: unknown, fallback?: string) => void };
export type ArchiveKind = "dump" | "deal" | "brief" | "voice";

const NOUN: Record<ArchiveKind, string> = { dump: "Dump", deal: "Deal", brief: "Brief", voice: "Voice over" };

export async function archiveWithUndo(toast: Toaster, kind: ArchiveKind, id: string | number, onChange: () => void): Promise<void> {
  try {
    await post(`/api/archive/${kind}/${id}`);
    onChange();
    toast.undo(`${NOUN[kind]} archived. Find it under Show archived.`, () => {
      post(`/api/archive/${kind}/${id}/restore`).then(onChange, (e) => toast.bad(e));
    });
  } catch (e) {
    toast.bad(e);
  }
}

export async function restoreArchived(toast: Toaster & { ok: (t: string) => void }, kind: ArchiveKind, id: string | number, onChange: () => void): Promise<void> {
  try {
    await post(`/api/archive/${kind}/${id}/restore`);
    onChange();
    toast.ok(`${NOUN[kind]} is back.`);
  } catch (e) {
    toast.bad(e);
  }
}

export async function dismissWithUndo(toast: Toaster, key: string, onChange: () => void, text = "Hidden from Home."): Promise<void> {
  try {
    await post("/api/home/dismiss", { key });
    onChange();
    toast.undo(text, () => {
      post("/api/home/restore", { key }).then(onChange, (e) => toast.bad(e));
    });
  } catch (e) {
    toast.bad(e);
  }
}
