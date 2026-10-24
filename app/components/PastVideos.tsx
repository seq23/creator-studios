// Client Brain → "My past videos" (owner's plan, 23 Oct 2026). She adds 3 to 10 of her old FINISHED
// videos; the studio watches them (never cuts them: they live apart from footage) and writes "How my
// videos feel" into her Brand Profile, which she can edit before locking. Phone first: one column,
// 44 px targets, one next step at a time, a way to remove each video (with a confirm).
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { fmtBytes, fmtDate, plural } from "../lib/format";
import { Card, Modal, Notice, useToast } from "./ui";

export interface PastVideosData {
  files: { id: string; file_name: string; size_bytes: number; upload_status: string; read_at: string | null; created_at: string }[];
  job: { id: string; status: string; progress: { step: string; done: number; total: number } | null; safe_error: string | null; created_at: string } | null;
  read: { at: string; videos?: number; by?: "ai" | "rules"; version?: number; lockedInUse?: boolean; failed?: string } | null;
  min: number;
  max: number;
}

const RUNNING = ["queued", "dispatched", "running"];

export function PastVideos({ data, reload }: { data: PastVideosData; reload: () => void }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<{ name: string; fraction: number; failed?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const uploaded = data.files.filter((f) => f.upload_status === "uploaded");
  const running = !!data.job && RUNNING.includes(data.job.status);
  const room = Math.max(0, data.max - data.files.length);
  const enough = uploaded.length >= data.min;

  // While the studio watches her videos, look again every 10 seconds.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [running, reload]);

  async function addFiles(files: FileList) {
    const list = Array.from(files).filter((f) => f.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name));
    if (list.length < files.length) toast.bad(new Error("Only videos go here. Photos and docs belong in other places."));
    const take = list.slice(0, room);
    if (list.length > take.length) toast.bad(new Error(`Up to ${data.max} past videos. The first ${take.length} were added.`));
    if (!take.length) return;
    setUploads(take.map((f) => ({ name: f.name, fraction: 0 })));
    await Promise.all(
      take.map((f, i) =>
        uploadFile(f, "past_video", null, (fraction) => setUploads((xs) => xs.map((x, j) => (j === i ? { ...x, fraction } : x)))).catch((e) => {
          setUploads((xs) => xs.map((x, j) => (j === i ? { ...x, failed: true } : x)));
          toast.bad(e);
        }),
      ),
    );
    setUploads([]);
    reload();
  }

  async function watch() {
    setBusy(true);
    try {
      await post("/api/brain/past-videos/read");
      toast.ok("Watching your videos now. Usually 10 to 20 minutes; you can leave this page.");
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function remove(id: string) {
    setConfirm(null);
    try {
      await del(`/api/brain/past-videos/${id}`);
      toast.ok("Removed.");
    } catch (e) {
      toast.bad(e);
    }
    reload();
  }

  return (
    <section className="section past-videos" aria-labelledby="past-h" data-past-videos>
      <h2 id="past-h">My past videos</h2>
      <p className="soft">
        Add {data.min} to {data.max} of your finished videos that did well. We watch them and write down how your videos feel: your hooks, pace, length, captions, music and how you talk to camera. They are never cut into clips.
      </p>

      {running ? (
        <Notice tone="info">
          <span data-past-status="running">
            <strong>Watching your videos…</strong> {data.job?.progress ? `${data.job.progress.step} (${data.job.progress.done}/${data.job.progress.total})` : "usually 10 to 20 minutes"}. You can leave this page.
          </span>
        </Notice>
      ) : data.job?.status === "failed" ? (
        <Notice tone="warn">
          <span data-past-status="failed">
            Watching your videos did not finish. Press <strong>Watch my videos</strong> to try again. <Link to="/help/learn-from-past-videos">What to do</Link>
          </span>
        </Notice>
      ) : data.read?.version && !data.read.failed ? (
        <p className="hint" data-past-status="done">
          Watched {plural(data.read.videos ?? uploaded.length, "video")} on {fmtDate(data.read.at)}. “How my videos feel” is in your Brand Profile below.
        </p>
      ) : null}

      {data.files.length || uploads.length ? (
        <Card className="flat">
          <div className="list" aria-label="My past videos">
            {data.files.map((f) => (
              <div key={f.id} className="list-row" data-past-video={f.id}>
                <div className="grow">
                  <div className="title brain-ellipsis">{f.file_name}</div>
                  <div className="meta">
                    {f.upload_status === "uploaded" ? `${fmtBytes(f.size_bytes)}${f.read_at ? " · watched" : ""}` : "Still uploading; keep this page open"}
                  </div>
                </div>
                <button type="button" className="btn quiet small" disabled={running} onClick={() => setConfirm(f.id)} aria-label={`Remove ${f.file_name}`}>
                  Remove
                </button>
              </div>
            ))}
            {uploads.map((u) => (
              <div key={`u-${u.name}`} className="list-row">
                <div className="grow">
                  <div className="title brain-ellipsis">{u.name}</div>
                  <div className="meter">
                    <span style={{ width: `${u.fraction * 100}%` }} />
                  </div>
                </div>
                <span className="meta nums">{u.failed ? "Failed" : `${Math.round(u.fraction * 100)}%`}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="past-actions">
        {room > 0 ? (
          <button type="button" className={enough ? "btn quiet block" : "btn block"} data-primary={!enough || undefined} disabled={running || uploads.length > 0} onClick={() => inputRef.current?.click()}>
            {data.files.length ? `Add more past videos (${data.files.length} of ${data.max})` : "Choose past videos"}
          </button>
        ) : null}
        {enough ? (
          <button type="button" className="btn block" data-primary disabled={running || busy || uploads.length > 0} onClick={watch}>
            {running ? "Watching…" : data.read?.version ? "Watch my videos again" : "Watch my videos"}
          </button>
        ) : (
          <span className="hint">{uploaded.length ? `Add ${data.min - uploaded.length} more, then press Watch my videos.` : `Pick at least ${data.min}.`}</span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        hidden
        aria-label="Choose past videos"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {confirm ? (
        <Modal title="Remove this past video?" onClose={() => setConfirm(null)}>
          <p>The studio stops learning from it. “How my videos feel” keeps what it already says until you watch again.</p>
          <div className="btn-row">
            <button type="button" className="btn quiet" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            <button type="button" className="btn danger" onClick={() => remove(confirm)}>
              Remove
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
