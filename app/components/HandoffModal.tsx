// "Edit in CapCut" on a clip in Review (docs/EDITORS.md): how the owner uses CapCut (or InShot, or
// any editing app) instead of the built-in editor. CapCut has no API and no published app link, so:
//   1. Save the clip: on the phone the share sheet (pick CapCut there), else a download
//   2. Edit it in the app, export 9:16
//   3. Replace with my edit: upload it back; it is checked (tall 9:16, long enough, within each
//      ticked platform's limit), its loudness and cover are made again, and it swaps in
// The current version keeps playing until her edit is in place.
import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { Modal, Notice, useToast } from "./ui";
import type { ReviewClip } from "../pages/Review";
import { HANDOFF, type HandoffApp } from "@shared/editors";

function downloadUrl(clip: ReviewClip): string {
  return `${clip.media_url}${clip.media_url.includes("?") ? "&" : "?"}download=1`;
}

export function HandoffModal({ clip, onClose, onReplaced }: { clip: ReviewClip; onClose: () => void; onReplaced: (updated: ReviewClip | null) => void }) {
  const toast = useToast();
  const [app, setApp] = useState<HandoffApp>("capcut");
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = HANDOFF[app].name;
  const canShareFiles = typeof navigator !== "undefined" && "canShare" in navigator;

  async function share() {
    // On a phone the share sheet lists CapCut / InShot: she taps it and the clip opens there.
    setSharing(true);
    try {
      const res = await fetch(clip.media_url);
      const file = new File([await res.blob()], "studio-clip.mp4", { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: clip.hook_text });
      else window.location.href = downloadUrl(clip);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) window.location.href = downloadUrl(clip);
    } finally {
      setSharing(false);
    }
  }

  async function replace(f: File) {
    setError(null);
    setUploading(0);
    try {
      const up = await uploadFile(f, "edit", clip.id, (x) => setUploading(x));
      const r = await post<{ clip: ReviewClip | null }>(`/api/clips/${clip.id}/replace`, { id: up.id, key: up.key, app });
      toast.ok(`Finishing your edit from ${app === "other" ? "your app" : name}, about a minute. The current version stays until it’s ready.`);
      onReplaced(r.clip);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't upload. Try again.");
    } finally {
      setUploading(null);
    }
  }

  return (
    <Modal title={`Edit in ${app === "other" ? "another app" : name}`} onClose={onClose}>
      <div className="handoff-apps" role="group" aria-label="Which app">
        {(["capcut", "inshot", "other"] as const).map((a) => (
          <button key={a} type="button" className="btn small quiet" aria-pressed={app === a} onClick={() => setApp(a)}>
            {a === "other" ? "Another app" : HANDOFF[a].name}
          </button>
        ))}
      </div>
      <ol className="handoff-steps">
        <li>
          <div className="label">1. Send the clip to {app === "other" ? "your app" : name}</div>
          <div className="btn-row">
            {canShareFiles ? (
              <button type="button" className="btn small" onClick={share} disabled={sharing}>
                {sharing ? "Opening…" : `Share to ${app === "other" ? "an app" : name}`}
              </button>
            ) : null}
            <a className="btn small quiet" href={downloadUrl(clip)} download="studio-clip.mp4">
              Save the clip
            </a>
          </div>
          <p className="hint">On your phone, tap Share and pick {app === "other" ? "your app" : name}. On a computer, save it{HANDOFF[app].web ? <> and open it in <a href={HANDOFF[app].web} target="_blank" rel="noreferrer">{name} on the web</a></> : null}.</p>
        </li>
        <li>
          <div className="label">2. Edit it there</div>
          <p className="hint">Keep the ratio 9:16 (tall). Export it as a video.</p>
        </li>
        <li>
          <div className="label">3. Replace with my edit</div>
          <input id="edit-file" className="sr-only" type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && replace(e.target.files[0])} />
          <label htmlFor="edit-file" className="btn small" aria-disabled={uploading !== null}>
            {uploading !== null ? `Uploading… ${Math.round(uploading * 100)}%` : "Replace with my edit"}
          </label>
          <p className="hint">We check it’s tall and not too long for the platforms this clip goes to, then level the sound and make a new cover. The clip is marked Edited in {app === "other" ? "your app" : name}.</p>
        </li>
      </ol>
      {error ? (
        <Notice tone="bad">
          <span data-handoff-error>{error}</span>
        </Notice>
      ) : null}
      <div className="btn-row">
        <button className="btn quiet" onClick={onClose}>
          Done
        </button>
        <Link to="/help/edit-in-capcut" className="link-btn">
          Picture-by-picture guide
        </Link>
      </div>
    </Modal>
  );
}
