// Client Brain (BUILD_PLAN.md section 5): upload brand docs (many at once, any time), see each
// doc's reading status (unreadable files are flagged, never skipped), draft the Brand Profile,
// edit its nine sections, lock it, roll back to an earlier version.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BRAND_PROFILE_SECTIONS, type BrandProfileKey } from "@shared/constants";
import type { BrandDocRow, BrandProfileSections, BrandProfileView } from "@shared/types";
import { del, get, patch, post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { fmtBytes, fmtDate, plural } from "../lib/format";
import { Card, Empty, HelpButton, Modal, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import "../styles/brain.css";

interface Version {
  version: number;
  locked: boolean;
  locked_at: string | null;
  source: BrandProfileView["source"];
  created_at: string;
}
interface BrainData {
  docs: (BrandDocRow & { char_count: number | null })[];
  profile: BrandProfileView | null;
  versions: Version[];
  job: { id: string; status: string; ref_id: string | null; safe_error: string | null } | null;
  totalChars: number;
}

const TYPE_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};
const LABEL_BY_TYPE: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/markdown": "MD",
  "text/plain": "TXT",
};

/** Phones often hand over .md/.txt with no type; name the type from the extension. */
function withType(f: File): File | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  const type = TYPE_BY_EXT[ext] ?? (f.type in LABEL_BY_TYPE ? f.type : "");
  if (!type) return null;
  return f.type === type ? f : new File([f], f.name, { type, lastModified: f.lastModified });
}

const SOURCE_WORD: Record<BrandProfileView["source"], string> = { draft: "drafted", edited: "edited", rollback: "rolled back" };

export function ClientBrain() {
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => get<BrainData>("/api/brain"));
  const [uploads, setUploads] = useState<{ name: string; fraction: number; failed?: boolean }[]>([]);
  const [draft, setDraft] = useState<BrandProfileSections | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = data?.profile ?? null;
  const locked = !!profile?.locked;
  const reading = (data?.docs ?? []).some((d) => d.extract_status === "extracting") || (data?.job && ["queued", "dispatched", "running"].includes(data.job.status) && data.job.ref_id === "draft_profile");

  // A fresh profile from the server replaces the editor's copy (unless she is mid-edit).
  const version = profile?.version ?? 0;
  useEffect(() => {
    setDraft(profile ? { ...profile.sections } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, locked]);

  // While docs are being read, check back every 5 seconds.
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reading, reload]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const ok = list.map(withType).filter((f): f is File => !!f);
    if (ok.length < list.length) toast.bad(new Error("Some files were skipped: upload PDF, Word (.docx), Markdown or plain text."));
    if (!ok.length) return;
    setUploads(ok.map((f) => ({ name: f.name, fraction: 0 })));
    await Promise.all(
      ok.map((f, i) =>
        uploadFile(f, "brand_doc", null, (fraction) => setUploads((xs) => xs.map((x, j) => (j === i ? { ...x, fraction } : x)))).catch((e) => {
          setUploads((xs) => xs.map((x, j) => (j === i ? { ...x, failed: true } : x)));
          toast.bad(e);
        }),
      ),
    );
    try {
      const r = await post<{ docs: number }>("/api/brain/extract");
      if (r.docs) toast.ok(`Reading ${plural(r.docs, "doc")}. This takes a minute or two.`);
    } catch (e) {
      toast.bad(e);
    }
    setUploads([]);
    reload();
  }

  async function act(name: string, fn: () => Promise<unknown>, okText?: string) {
    setBusy(name);
    try {
      await fn();
      if (okText) toast.ok(okText);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
      reload();
    }
  }

  const dirty = !!profile && !!draft && BRAND_PROFILE_SECTIONS.some((s) => draft[s.key] !== profile.sections[s.key]);
  const readDocs = (data?.docs ?? []).filter((d) => d.extract_status === "done").length;
  // The screen's one next step, by state: lock an unlocked draft; draft a profile once docs are
  // read; otherwise add docs.
  const next: "lock" | "draft" | "choose" | null = !data ? null : profile && !locked ? "lock" : !profile && readDocs > 0 ? "draft" : "choose";
  const draftProfile = () => act("draft", () => post("/api/brain/profile/draft"), "New draft ready. Read it, edit anything, then lock it.");

  return (
    <div className="page">
      <PageHead title="Client Brain" lede="Everything the AI knows about you. Add docs any time.">
        {next === "lock" ? (
          <button className="btn" data-primary disabled={dirty || busy === "lock"} title={dirty ? "Save your changes first" : undefined} onClick={() => act("lock", () => post("/api/brain/profile/lock"), "Locked. Research, clips and captions now use this profile.")}>
            Lock profile
          </button>
        ) : next === "draft" ? (
          <button className="btn" data-primary disabled={busy === "draft"} onClick={draftProfile}>
            {busy === "draft" ? "Drafting…" : "Draft my profile"}
          </button>
        ) : next === "choose" ? (
          <button className="btn" data-primary onClick={() => inputRef.current?.click()}>
            Choose docs
          </button>
        ) : null}
      </PageHead>

      {loading && !data ? <Skeleton blocks={2} columns={2} /> : null}

      {data ? (
        <div className="brain-split">
          <section className="section" aria-labelledby="docs-h">
            <h2 id="docs-h">Your brand docs</h2>
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" ? inputRef.current?.click() : undefined)}
            >
              <div className="brain-drop-title">{data.docs.length ? "Drop more brand docs" : "Start with your brand docs"}</div>
              {data.docs.length ? null : <p className="soft brain-drop-copy">Anything that says who you are and what you want: a brand guide, your media kit, notes, a saved ChatGPT conversation.</p>}
              <div className="hint">PDF · Word · Markdown · Text — many at once, including exports of past AI chats. Drop them here or tap to pick.</div>
              {next !== "choose" ? <span className="btn quiet">Choose docs</span> : null}
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                aria-label="Choose brand docs"
                accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {uploads.length ? (
              <Card className="flat">
                {uploads.map((u) => (
                  <div key={u.name} className="list-row">
                    <div className="grow">
                      <div className="title brain-ellipsis">{u.name}</div>
                      <div className="meter">
                        <span style={{ width: `${u.fraction * 100}%` }} />
                      </div>
                    </div>
                    <span className="meta nums">{u.failed ? "Failed" : `${Math.round(u.fraction * 100)}%`}</span>
                  </div>
                ))}
              </Card>
            ) : null}

            {data.docs.length === 0 ? null : (
              <Card className="flat">
                <div className="list" aria-label="Brand docs">
                  {data.docs.map((d) => (
                    <DocLine key={d.id} doc={d} busy={busy === d.id} onRetry={() => act(d.id, () => post(`/api/brain/docs/${d.id}/extract`), "Reading it again.")} onRemove={() => setConfirmRemove(d.id)} />
                  ))}
                </div>
              </Card>
            )}

            {data.docs.length && next !== "draft" ? (
              <button className="btn quiet block" disabled={locked || busy === "draft" || readDocs === 0} onClick={draftProfile}>
                {busy === "draft" ? "Drafting…" : profile ? "Redraft profile from all docs" : "Draft my profile"}
              </button>
            ) : null}
            {data.job?.status === "failed" ? (
              <Notice tone="bad">
                <span>
                  Reading your docs stopped: {data.job.safe_error ?? "unknown reason"}. Press Try again on a doc. <Link to="/help/upload-brand-docs">What to do</Link>
                </span>
              </Notice>
            ) : null}
          </section>

          <section className="section" aria-labelledby="profile-h">
            <div className="section-head">
              <h2 id="profile-h">
                Brand Profile
                {profile ? (
                  <span className="brain-sub">
                    {" "}
                    · v{profile.version} · {SOURCE_WORD[profile.source]} {fmtDate(profile.created_at)}
                  </span>
                ) : null}
              </h2>
              {profile ? <span className={`pill ${locked ? "ok" : "warn"}`}>{locked ? "Locked" : "Not locked"}</span> : null}
            </div>

            {!profile ? (
              <Empty title="No profile yet" secondary={{ to: "/help/upload-brand-docs", label: "How it works" }}>
                {reading ? "Reading your docs… Draft my profile unlocks when they’re read." : readDocs > 0 ? "Your docs are read. Press Draft my profile at the top; you’ll edit and lock it here." : "Add your docs, then press Draft my profile. You’ll edit and lock it here."}
              </Empty>
            ) : (
              <>
                <div className="btn-row">
                  {locked ? (
                    <button className="btn quiet" disabled={busy === "unlock"} onClick={() => act("unlock", () => post("/api/brain/profile/unlock"), "Unlocked. The AI waits for you to lock it again.")}>
                      Unlock to edit
                    </button>
                  ) : (
                    <button className="btn dark" disabled={!dirty || busy === "save"} onClick={() => act("save", () => patch("/api/brain/profile", { sections: draft }), "Saved as a new version.")}>
                      {busy === "save" ? "Saving…" : "Save changes"}
                    </button>
                  )}
                  <button className="btn quiet" aria-expanded={showVersions} onClick={() => setShowVersions((v) => !v)}>
                    Versions (<span className="nums">{data.versions.length}</span>)
                  </button>
                </div>

                {showVersions ? (
                  <Card className="flat">
                    <div className="list" aria-label="Profile versions">
                      {data.versions.map((v) => (
                        <div key={v.version} className="list-row">
                          <div className="grow">
                            <div className="title">
                              v{v.version} · {SOURCE_WORD[v.source]}
                              {v.locked ? " · locked" : ""}
                            </div>
                            <div className="meta">{fmtDate(v.created_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                          </div>
                          {v.version !== profile.version ? (
                            <button className="btn quiet small" disabled={locked || busy === `rb${v.version}`} onClick={() => act(`rb${v.version}`, () => post(`/api/brain/profile/rollback/${v.version}`), `Rolled back to v${v.version} as a new version.`)}>
                              Roll back
                            </button>
                          ) : (
                            <span className="meta">Current</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {locked ? <div className="hint">Unlock to roll back.</div> : null}
                  </Card>
                ) : null}

                <div className="brain-sections">
                  {BRAND_PROFILE_SECTIONS.map((s) => (
                    <Section key={s.key} k={s.key} label={s.label} value={draft?.[s.key] ?? ""} disabled={locked} onChange={(v) => setDraft((d) => (d ? { ...d, [s.key]: v } : d))} />
                  ))}
                </div>
                <Notice tone={locked ? "ok" : "info"}>
                  <span>{locked ? "The locked profile is used by research, clip picking, captions and voice over scripts." : "Save your changes, then press Lock profile at the top when it sounds like you. Until it’s locked, no clips are cut."}</span>
                </Notice>
              </>
            )}
          </section>
        </div>
      ) : null}

      {confirmRemove ? (
        <Modal title="Remove this doc?" onClose={() => setConfirmRemove(null)}>
          <p>The file and what we read from it are deleted. Your profile keeps what it already says.</p>
          <div className="btn-row">
            <button
              className="btn danger"
              onClick={() => {
                const id = confirmRemove;
                setConfirmRemove(null);
                act(id, () => del(`/api/brain/docs/${id}`), "Removed.");
              }}
            >
              Yes, remove it
            </button>
            <button className="btn quiet" onClick={() => setConfirmRemove(null)}>
              Keep it
            </button>
          </div>
        </Modal>
      ) : null}
      <HelpButton guide="upload-brand-docs" />
    </div>
  );
}

function DocLine({ doc, busy, onRetry, onRemove }: { doc: BrainData["docs"][number]; busy: boolean; onRetry: () => void; onRemove: () => void }) {
  const flagged = doc.extract_status === "unreadable" || doc.extract_status === "failed";
  const status =
    doc.extract_status === "done"
      ? { text: `Read · ${plural(Math.max(1, Math.round((doc.char_count ?? 0) / 6)), "word")}`, tone: "ok" }
      : doc.extract_status === "extracting"
        ? { text: "Reading text…", tone: "" }
        : doc.extract_status === "pending"
          ? { text: "Waiting to be read", tone: "" }
          : { text: "Couldn’t read · flagged", tone: "bad" };
  return (
    <div className="brain-doc">
      <div className="list-row">
        <span className="badge soft brain-type">{LABEL_BY_TYPE[doc.mime_type] ?? "DOC"}</span>
        <div className="grow">
          <div className="title brain-ellipsis">{doc.file_name}</div>
          <div className="meta">
            {fmtBytes(doc.size_bytes)} · {fmtDate(doc.uploaded_at)}
          </div>
        </div>
        <span className={`pill ${status.tone}`}>{status.text}</span>
        {!flagged ? (
          <button className="icon-btn" aria-label={`Remove ${doc.file_name}`} onClick={onRemove} disabled={busy}>
            <Icon name="close" size="sm" />
          </button>
        ) : null}
      </div>
      {flagged ? (
        <div className="brain-flag">
          <span>{doc.extract_error ?? "This file could not be read."}</span>
          <div className="btn-row">
            <button className="btn quiet small" onClick={onRetry} disabled={busy}>
              Try again
            </button>
            <button className="btn danger small" onClick={onRemove} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({ k, label, value, disabled, onChange }: { k: BrandProfileKey; label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={`sec-${k}`}>{label}</label>
      <textarea id={`sec-${k}`} className="textarea" rows={Math.min(10, Math.max(3, Math.ceil(value.length / 70) + value.split("\n").length - 1))} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
