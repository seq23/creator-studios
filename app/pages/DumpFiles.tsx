// What I dumped (studio fix, 23 Oct 2026): every photo and video of one dump, each with a picture
// to tap and view, what the studio saw in it (its stage), which clips used it (by number), and the
// day the original is cleared to save space. Linked from the dump and from Review.
// Calm: ← Back on top, the summary first, then one list; ✕ Close on the viewer; plain words.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get } from "../lib/api";
import { fmtBytes, fmtDate, plural } from "../lib/format";
import { Empty, HelpButton, Modal, PageHead, Skeleton, useLoad } from "../components/ui";
import "../styles/dumpfiles.css";

interface FileUse {
  clip_id: string;
  code: string;
  label: string;
  status: string;
  hero: boolean;
}
interface DumpFile {
  id: string;
  file_name: string;
  kind: "photo" | "video";
  size_bytes: number;
  view_url: string | null;
  poster_url: string | null;
  role: string | null;
  role_label: string | null;
  camera: boolean | null;
  taken_at: string | null;
  used_by: FileUse[];
  clears_on: string | null;
  cleared: boolean;
}
interface View {
  dump: { id: string; created_at: string; status: string; ready_at: string | null; clip_counts: { distinct?: number; styles?: number } | null };
  files: DumpFile[];
  unused: number;
}

const STATUS_WORD: Record<string, string> = { draft: "new", approved: "approved", rejected: "rejected" };

export function DumpFiles() {
  const { id = "" } = useParams();
  const v = useLoad(() => get<View>(`/api/dumps/${id}/files`), [id]);
  const [open, setOpen] = useState<DumpFile | null>(null);
  const files = v.data?.files ?? [];
  const videos = files.filter((f) => f.kind === "video").length;
  const photos = files.length - videos;
  const clearOn = files.find((f) => !f.cleared)?.clears_on ?? null;

  return (
    <div className="page dump-files-page">
      <PageHead
        crumb={
          <Link to={`/dump/${id}`} data-back>
            ← Back to this dump
          </Link>
        }
        title={v.data ? `What you dumped on ${fmtDate(v.data.dump.created_at)}` : "What you dumped"}
        lede="Every photo and video, what the studio saw in it, and which clips used it."
      >
        <Link to="/review" className="btn quiet">
          Go to Review
        </Link>
      </PageHead>

      {v.loading && !v.data ? <Skeleton blocks={3} /> : null}
      {v.error ? <Empty title="This didn’t load">Check your connection, then reload the page to try again.</Empty> : null}

      {v.data ? (
        <>
          <p className="files-summary" data-files-summary>
            <strong>{plural(files.length, "file")}</strong>: {plural(videos, "video")}, {plural(photos, "photo")}.{" "}
            {v.data.dump.clip_counts?.distinct ? `${plural(v.data.dump.clip_counts.distinct, "clip")} made from them. ` : ""}
            {v.data.unused ? `${plural(v.data.unused, "file")} not used in any clip yet. ` : "Every file is in at least one clip. "}
            {clearOn ? `The originals are cleared on ${fmtDate(clearOn)} to save space; your clips stay.` : ""}
          </p>
          <ol className="files-list" aria-label="Your files">
            {files.map((f, i) => (
              <li key={f.id} className="file-row" data-file-id={f.id}>
                <button type="button" className="file-thumb" disabled={!f.view_url} onClick={() => setOpen(f)} aria-label={f.view_url ? `Tap to view ${f.kind} ${i + 1}` : `${f.kind} ${i + 1}, original cleared`}>
                  {!f.view_url ? (
                    <span className="file-gone">Cleared</span>
                  ) : f.kind === "photo" ? (
                    <img src={f.view_url} alt="" loading="lazy" />
                  ) : f.poster_url ? (
                    <img src={f.poster_url} alt="" loading="lazy" />
                  ) : (
                    <video src={`${f.view_url}#t=0.5`} preload="metadata" muted playsInline />
                  )}
                  {f.view_url ? <span className="file-tap">{f.kind === "photo" ? "Tap to view" : "▶ Tap to play"}</span> : null}
                </button>
                <div className="file-body">
                  <div className="file-name">
                    {i + 1}. {f.file_name}
                  </div>
                  <div className="hint">
                    {f.kind === "photo" ? "Photo" : "Video"} · {fmtBytes(f.size_bytes)}
                    {f.kind === "photo" && f.camera === false ? " · No camera details: treated as an AI picture (its clips say Made with AI)" : ""}
                  </div>
                  <div className="file-role" data-role>
                    {f.role_label ? <>The studio saw: <strong>{f.role_label}</strong></> : "Not sorted yet"}
                  </div>
                  <div className="file-used" data-used-by>
                    {f.used_by.length ? (
                      <>
                        Used in{" "}
                        {f.used_by.map((u, j) => (
                          <span key={u.clip_id}>
                            {j ? ", " : ""}
                            <Link to={`/review?q=${encodeURIComponent(u.code)}&tab=${u.status === "draft" ? "new" : u.status}`}>Clip {u.code}</Link>
                            {u.hero ? " (ends on it)" : ""}
                            {STATUS_WORD[u.status] && u.status !== "draft" ? ` · ${STATUS_WORD[u.status]}` : ""}
                          </span>
                        ))}
                      </>
                    ) : (
                      "Not in any clip yet"
                    )}
                  </div>
                  <div className="hint">{f.cleared ? `Original cleared on ${fmtDate(f.clears_on)}.` : f.clears_on ? `Original kept until ${fmtDate(f.clears_on)}.` : "Original kept while the clips are made."}</div>
                </div>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {open && open.view_url ? (
        <Modal title={open.file_name} onClose={() => setOpen(null)}>
          {open.kind === "photo" ? <img className="file-full" src={open.view_url} alt={open.file_name} /> : <video className="file-full" src={open.view_url} controls playsInline autoPlay />}
          <div className="btn-row">
            <button type="button" className="btn quiet" onClick={() => setOpen(null)}>
              ✕ Close
            </button>
          </div>
        </Modal>
      ) : null}
      <HelpButton guide="what-i-dumped" />
    </div>
  );
}
