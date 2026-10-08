// Extract text from brand docs, OCR scanned PDFs (BUILD_PLAN.md section 5). The Python job
// (jobs/extract.py) reads each file from R2, writes the text to R2 at brain/text/<doc_id>.txt
// and reports back only a status and a character count per doc: the text itself never travels
// through the callback, D1 or any log.
//
// ref_id says what to do:
//   "doc_…"          read that one doc (Try again)
//   "pending"        read every doc not read yet
//   "draft_profile"  read every doc not read yet, then draft the Brand Profile from all of them
//                    (used when there is too much text for one model call in the Worker)
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { getConnectionSecret } from "../lib/connections";
import { recordEvent } from "../lib/db";
import { log } from "../lib/log";
import { BRAND_PROFILE_SECTIONS } from "@shared/constants";
import { cleanSections, FAKE_PROFILE, filledCount, PROFILE_SYSTEM } from "../domain/profile";
import { FREE_MODEL } from "../services/openrouter";

export const textKey = (docId: string) => `brain/text/${docId}.txt`;

export type UnreadableReason = "no_text" | "locked" | "corrupt" | "unsupported" | "missing";

/** Plain sentences for a doc that could not be read (flagged, never silently skipped). */
export const UNREADABLE_SENTENCE: Record<UnreadableReason, string> = {
  no_text: "We couldn't find any words in this file, even after reading the pictures. Try a clearer copy, or a Word or PDF version.",
  locked: "This PDF has a password. Save a copy without the password and upload that.",
  corrupt: "This file seems damaged and couldn't be opened. Try saving or exporting it again.",
  unsupported: "This kind of file can't be read. Upload PDF, Word (.docx), Markdown or plain text.",
  missing: "The upload didn't finish. Remove this file and upload it again.",
};

export interface ExtractDocResult {
  id: string;
  status: "done" | "unreadable" | "failed";
  char_count: number;
  reason?: UnreadableReason;
  ocr?: boolean;
}

interface DocRow {
  id: string;
  r2_key: string;
  mime_type: string;
  file_name: string;
  extract_status: string;
}

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/markdown": "md",
  "text/plain": "txt",
};

async function docsFor(env: Env, refId: string | null): Promise<DocRow[]> {
  if (refId && refId.startsWith("doc_")) {
    const r = await env.DB.prepare("SELECT id, r2_key, mime_type, file_name, extract_status FROM brand_docs WHERE id = ?").bind(refId).all<DocRow>();
    return r.results;
  }
  const r = await env.DB.prepare("SELECT id, r2_key, mime_type, file_name, extract_status FROM brand_docs WHERE extract_status IN ('pending', 'extracting') ORDER BY uploaded_at").all<DocRow>();
  return r.results;
}

/** Only docs whose upload finished (the R2 object exists) are handed to the job. */
async function readyDocs(env: Env, refId: string | null): Promise<DocRow[]> {
  const out: DocRow[] = [];
  for (const d of await docsFor(env, refId)) if (await env.FILES.head(d.r2_key)) out.push(d);
  return out;
}

/** Flip the docs a job is about to read to "extracting" (the screen shows "Reading text…"). */
export async function markExtracting(env: Env, refId: string | null): Promise<number> {
  const docs = await readyDocs(env, refId);
  for (const d of docs) await env.DB.prepare("UPDATE brand_docs SET extract_status = 'extracting', extract_error = NULL WHERE id = ?").bind(d.id).run();
  return docs.length;
}

async function buildSpec(env: Env, jobId: string, refId: string | null) {
  const docs = await readyDocs(env, refId);
  const draft = refId === "draft_profile";
  const { results: done } = draft ? await env.DB.prepare("SELECT id FROM brand_docs WHERE extract_status = 'done'").all<{ id: string }>() : { results: [] as { id: string }[] };
  return {
    job_id: jobId,
    type: "extract",
    docs: docs.map((d) => ({ id: d.id, r2_key: d.r2_key, mime_type: d.mime_type, ext: EXT[d.mime_type] ?? (d.file_name.split(".").pop() ?? "").toLowerCase().slice(0, 5), text_key: textKey(d.id) })),
    draft_profile: draft,
    done_text_keys: done.map((d) => textKey(d.id)),
    ocr_min_chars_per_page: 50,
    llm: draft ? { key: await getConnectionSecret(env, "openrouter"), model: FREE_MODEL, system: PROFILE_SYSTEM, sections: BRAND_PROFILE_SECTIONS.map((s) => s.key) } : null,
  };
}

function isResult(x: unknown): x is { docs: ExtractDocResult[]; profile?: unknown } {
  return !!x && typeof x === "object" && Array.isArray((x as { docs?: unknown }).docs);
}

export const extractJob: JobHandler = {
  buildSpec,

  async applyResult(env, jobId, refId, result) {
    if (!isResult(result)) throw new Error("extract result has no docs list");
    let done = 0;
    let flagged = 0;
    for (const d of result.docs) {
      if (typeof d?.id !== "string") continue;
      if (d.status === "done") {
        done++;
        await env.DB.prepare("UPDATE brand_docs SET extract_status = 'done', extract_error = NULL, char_count = ? WHERE id = ?").bind(Math.max(0, Math.floor(Number(d.char_count) || 0)), d.id).run();
      } else {
        flagged++;
        const reason: UnreadableReason = d.reason && d.reason in UNREADABLE_SENTENCE ? d.reason : "corrupt";
        await env.DB.prepare("UPDATE brand_docs SET extract_status = ?, extract_error = ?, char_count = 0 WHERE id = ?")
          .bind(d.status === "failed" ? "failed" : "unreadable", UNREADABLE_SENTENCE[reason], d.id)
          .run();
      }
    }
    if (refId === "draft_profile" && result.profile) {
      const sections = cleanSections(result.profile);
      const latest = await env.DB.prepare("SELECT locked FROM brand_profile ORDER BY version DESC LIMIT 1").first<{ locked: number }>();
      if (latest?.locked) log.warn("extract.profile.skipped_locked");
      else if (filledCount(sections) >= 5) {
        await env.DB.prepare("INSERT INTO brand_profile (sections, locked, source) VALUES (?, 0, 'draft')").bind(JSON.stringify(sections)).run();
        await recordEvent(env.DB, "profile.drafted", jobId, { via: "job" });
      }
    }
    log.info("extract.apply", { done, flagged });
  },

  async onFailure(env, jobId, refId) {
    void jobId;
    const q = refId && refId.startsWith("doc_") ? env.DB.prepare("UPDATE brand_docs SET extract_status = 'failed', extract_error = ? WHERE id = ? AND extract_status = 'extracting'").bind("Reading this file stopped partway. Press Try again.", refId) : env.DB.prepare("UPDATE brand_docs SET extract_status = 'failed', extract_error = ? WHERE extract_status = 'extracting'").bind("Reading your docs stopped partway. Press Try again.");
    await q.run();
    log.warn("extract.failed");
  },

  /** Fake runner: real text for Markdown/plain files (read from R2), plausible text otherwise. */
  async fakeRun(env, jobId, refId) {
    const spec = await buildSpec(env, jobId, refId);
    const rows = await docsFor(env, refId);
    const docs: ExtractDocResult[] = [];
    for (const d of spec.docs) {
      const row = rows.find((r) => r.id === d.id);
      if (row && /unreadable|scan-blank/i.test(row.file_name)) {
        docs.push({ id: d.id, status: "unreadable", char_count: 0, reason: "no_text", ocr: true });
        continue;
      }
      let text: string;
      if (d.ext === "md" || d.ext === "txt" || d.mime_type.startsWith("text/")) {
        const obj = await env.FILES.get(d.r2_key);
        text = obj ? await obj.text() : "";
      } else {
        text = FAKE_DOC_TEXT;
      }
      if (text.trim().length < 20) {
        docs.push({ id: d.id, status: "unreadable", char_count: 0, reason: "no_text" });
        continue;
      }
      await env.FILES.put(d.text_key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      docs.push({ id: d.id, status: "done", char_count: text.length, ocr: d.ext === "pdf" && /scan/i.test(row?.file_name ?? "") });
    }
    return { docs, profile: spec.draft_profile ? FAKE_PROFILE : undefined };
  },
};

const FAKE_DOC_TEXT = `Sample Creator — brand notes (demo text)
A creator brand: short how-tos, behind the scenes, tips and quick wins, stories from the week.
Who watches: beginners, returning fans, friends who share what they learn.
Origin: a few how-to clips for friends that grew into a weekly channel.
Goals: grow a following that comes back; partner with brands that fit.`;
