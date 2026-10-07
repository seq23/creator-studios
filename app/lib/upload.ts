// Chunked, resumable uploads (section 7). Parts go straight through the Worker into R2
// multipart. Progress per file; a dropped connection resumes from the finished parts,
// which are remembered in localStorage keyed by a file fingerprint.
import { post } from "./api";
import { UPLOAD_PART_SIZE } from "@shared/constants";

export type UploadKind = "video" | "brand_doc" | "research_upload" | "voice_sample" | "kit_photo" | "music" | "edit";

export interface UploadHandle {
  id: string;
  key: string;
  uploadId: string;
}

interface Saved {
  id: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}

function fingerprint(file: File, kind: UploadKind, parentId: string | null): string {
  return `ss-upload:${kind}:${parentId ?? "-"}:${file.name}:${file.size}:${file.lastModified}`;
}

function loadSaved(fp: string): Saved | null {
  try {
    const raw = localStorage.getItem(fp);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(fp: string, s: Saved) {
  try {
    localStorage.setItem(fp, JSON.stringify(s));
  } catch {
    /* private mode: resume just won't work */
  }
}
function clear(fp: string) {
  try {
    localStorage.removeItem(fp);
  } catch {
    /* ignore */
  }
}

async function hashHead(file: File): Promise<string> {
  // Cheap content fingerprint: first 1 MB + size. Enough to catch "same file again".
  const head = await file.slice(0, 1024 * 1024).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", head);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}:${file.size}`;
}

export async function uploadFile(
  file: File,
  kind: UploadKind,
  parentId: string | null,
  onProgress: (fraction: number) => void,
  options: { fileNote?: string; signal?: AbortSignal } = {},
): Promise<UploadHandle> {
  const fp = fingerprint(file, kind, parentId);
  let saved = loadSaved(fp);
  if (!saved) {
    const contentHash = kind === "video" ? await hashHead(file) : undefined;
    const started = await post<{ id: string; key: string; uploadId: string; partSize: number }>("/api/uploads/start", {
      kind,
      parentId: parentId ?? undefined,
      fileName: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      fileNote: options.fileNote,
      contentHash,
    });
    saved = { id: started.id, key: started.key, uploadId: started.uploadId, parts: [] };
    save(fp, saved);
  }
  const total = Math.ceil(file.size / UPLOAD_PART_SIZE);
  const done = new Set(saved.parts.map((p) => p.partNumber));
  onProgress(done.size / total);

  for (let n = 1; n <= total; n++) {
    if (done.has(n)) continue;
    if (options.signal?.aborted) throw new Error("aborted");
    const blob = file.slice((n - 1) * UPLOAD_PART_SIZE, Math.min(n * UPLOAD_PART_SIZE, file.size));
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(`/api/uploads/${saved.id}/parts/${n}?key=${encodeURIComponent(saved.key)}&uploadId=${encodeURIComponent(saved.uploadId)}`, {
          method: "PUT",
          body: blob,
          credentials: "same-origin",
          signal: options.signal,
        });
        if (!res.ok) throw new Error(`part ${n} failed (${res.status})`);
        const part = (await res.json()) as { partNumber: number; etag: string };
        saved.parts.push(part);
        save(fp, saved);
        done.add(n);
        onProgress(done.size / total);
        break;
      } catch (e) {
        if (options.signal?.aborted) throw e;
        attempt++;
        if (attempt > 5) throw e;
        await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** attempt)));
      }
    }
  }
  await post(`/api/uploads/${saved.id}/complete`, { key: saved.key, uploadId: saved.uploadId, parts: saved.parts });
  clear(fp);
  onProgress(1);
  return { id: saved.id, key: saved.key, uploadId: saved.uploadId };
}

export async function abortUpload(h: UploadHandle) {
  await post(`/api/uploads/${h.id}/abort`, { key: h.key, uploadId: h.uploadId }).catch(() => undefined);
}
