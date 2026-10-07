// Review: a full video for YouTube (the third door on Dump). The whole video, never cut: she picks
// one of three thumbnails, checks the title, description (with chapters) and tags, picks who can
// see it (Public / Unlisted / Private), and approves. After it posts: "Finish in YouTube Studio"
// (the thumbnail and tags, which Buffer can't set). If Buffer won't take it: "Upload it yourself".
import { useState } from "react";
import { patch, post } from "../lib/api";
import { fmtDate, fmtSeconds } from "../lib/format";
import { Modal, Notice, useToast } from "./ui";

export type Privacy = "public" | "unlisted" | "private";
const PRIVACY: { id: Privacy; label: string; hint: string }[] = [
  { id: "public", label: "Public", hint: "Anyone can find it." },
  { id: "unlisted", label: "Unlisted", hint: "Only people with the link." },
  { id: "private", label: "Private", hint: "Only you." },
];

export interface FullVideo {
  title: string;
  description: string;
  chapters: { t: number; title: string }[];
  tags: string[];
  thumbnails: { url: string; t: number }[];
  thumb_pick: number;
  privacy: Privacy;
  width: number;
  height: number;
  duration_s: number;
  size_bytes: number;
  studio_done_at: string | null;
  handoff: boolean;
  file_deleted: boolean;
  post: { status: string; url: string | null; scheduled_at: string } | null;
  studio_url: string;
  /** Connect YouTube (full videos): on = straight to her channel; broken = needs Reconnect YouTube; off = the older path. */
  direct: { mode: "on" | "broken" | "off"; upload: { status: string; video_id: string | null; note: string | null; thumbnail: string | null; publish_at: string | null; privacy: string | null; url: string | null } | null };
}

interface Clip {
  id: string;
  status: string;
  media_url: string;
  full_video: FullVideo | null;
}

export function stampOf(s: number): string {
  const x = Math.max(0, Math.floor(s));
  const h = Math.floor(x / 3600);
  const m = Math.floor((x % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}` : `${m}:${String(x % 60).padStart(2, "0")}`;
}

function sizeOf(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function FullVideoBody({ clip, tab, busy, onChanged }: { clip: Clip; tab: string; busy: boolean; onChanged: (updated: unknown) => void }) {
  const toast = useToast();
  const v = clip.full_video!;
  const [editing, setEditing] = useState(false);
  const locked = v.post?.status === "in_buffer" || v.post?.status === "posted";
  async function save(body: Record<string, unknown>, ok?: string) {
    try {
      const updated = await patch(`/api/clips/${clip.id}/youtube`, body);
      onChanged(updated);
      if (ok) toast.ok(ok);
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <div className="full-video" data-full-video>
      <div className="clip-meta">
        <span className="pill ok">Full video for YouTube</span>
        <span className="nums">{fmtSeconds(v.duration_s)}</span>
        {v.size_bytes ? <span className="nums">· {sizeOf(v.size_bytes)}</span> : null}
        {v.width && v.height ? <span className="nums">· {v.width}×{v.height}</span> : null}
      </div>
      {v.file_deleted ? <p className="hint">The video file was removed to save space (7 days after it posted). Its thumbnail, words and numbers are kept.</p> : null}

      <div className="fv-title">{v.title}</div>

      <fieldset className="fv-thumbs" disabled={busy || locked || tab === "rejected"}>
        <legend className="label">Thumbnail</legend>
        <div className="fv-thumb-row" role="radiogroup" aria-label="Pick a thumbnail">
          {v.thumbnails.map((t, i) => (
            <button key={t.url || i} type="button" role="radio" aria-checked={v.thumb_pick === i} aria-label={`Thumbnail ${i + 1}, from ${stampOf(t.t)}`} className={`fv-thumb${v.thumb_pick === i ? " on" : ""}`} onClick={() => save({ thumb_pick: i })}>
              {t.url ? <img src={t.url} alt="" loading="lazy" /> : null}
              <span className="fv-thumb-at nums">{stampOf(t.t)}</span>
            </button>
          ))}
        </div>
        <span className="hint">{v.direct.mode === "on" ? "The one you pick goes up to YouTube with the video." : "You set the one you pick in YouTube Studio after it posts: YouTube only takes a thumbnail from you there."}</span>
      </fieldset>

      <fieldset className="fv-privacy" disabled={busy || locked || tab === "rejected"}>
        <legend className="label">Who can see it</legend>
        <div className="fv-privacy-row" role="radiogroup" aria-label="Who can see it">
          {PRIVACY.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={v.privacy === p.id} className={`steer-chip${v.privacy === p.id ? " on" : ""}`} onClick={() => save({ privacy: p.id }, `${p.label}: ${p.hint}`)}>
              {p.label}
            </button>
          ))}
        </div>
      </fieldset>

      <details className="fv-desc">
        <summary>Description{v.chapters.length ? `, ${v.chapters.length} chapters` : ""} and {v.tags.length} tags</summary>
        <p className="clip-caption">{v.description}</p>
        {v.chapters.length ? (
          <ol className="fv-chapters" data-chapters>
            {v.chapters.map((c) => (
              <li key={c.t}>
                <span className="nums">{stampOf(c.t)}</span> {c.title}
              </li>
            ))}
          </ol>
        ) : (
          <p className="hint">No chapters: the video is short, or we couldn't hear enough words. You can add them.</p>
        )}
        <p className="clip-tags hint">{v.tags.join(", ")}</p>
      </details>
      {tab !== "rejected" ? (
        <button className="link-btn" onClick={() => setEditing(true)} disabled={locked}>
          Edit title, description, chapters & tags
        </button>
      ) : null}

      {v.direct.mode !== "off" ? <DirectLine v={v} /> : v.post ? <PostLine clip={clip} v={v} /> : null}
      {v.direct.mode === "off" ? (
        v.handoff && v.post?.status !== "posted" ? clip.status === "approved" ? <Handoff clip={clip} v={v} onChanged={onChanged} /> : <p className="hint" data-handoff-note>You upload this one yourself after you approve it (two taps): YouTube lets apps post only Shorts, vertical and 3 minutes or less.</p> : null
      ) : directFellBack(v) && clip.status === "approved" && v.post?.status !== "posted" ? (
        <Handoff clip={clip} v={v} onChanged={onChanged} />
      ) : null}
      {editing ? <EditFull clip={clip} v={v} onClose={() => setEditing(false)} onSaved={(u) => { onChanged(u); setEditing(false); }} /> : null}
    </div>
  );
}

/** Connected, but this one has to go up by hand: the sign-in needs Reconnect YouTube, or the upload failed twice. */
function directFellBack(v: FullVideo): boolean {
  const u = v.direct.upload;
  return (v.direct.mode === "broken" && !u?.video_id) || u?.status === "failed";
}

/** Connect YouTube: where this video stands on her channel, in one line. */
function DirectLine({ v }: { v: FullVideo }) {
  const u = v.direct.upload;
  const when = v.post?.scheduled_at ? fmtDate(v.post.scheduled_at) : null;
  const watch = u?.url ? (
    <a href={u.url} target="_blank" rel="noreferrer">
      See it on YouTube
    </a>
  ) : null;
  let line: React.ReactNode;
  if (v.direct.mode === "broken" && !u?.video_id) line = <>YouTube needs you to reconnect (Settings → Connections → Reconnect YouTube). Meanwhile you can upload it yourself below.</>;
  else if (!u) line = v.post ? <>On the Calendar for {when}. It uploads to your channel up to a week before, with this thumbnail, title, description, chapters and tags.</> : <>Approve it and put it on the Calendar: it uploads straight to your YouTube channel.</>;
  else if (u.status === "queued") line = <>{u.note ?? "Waiting to upload to your channel."}</>;
  else if (u.status === "uploading") line = <>Uploading to your YouTube channel now.</>;
  else if (u.status === "scheduled") line = <>On your channel as private; it goes public {u.publish_at ? fmtDate(u.publish_at) : when}. {watch}</>;
  else if (u.status === "live") line = <>On your channel ({u.privacy === "public" ? "Public" : u.privacy === "unlisted" ? "Unlisted" : "Private"}). {watch}</>;
  else if (u.status === "removed") line = <>Taken off the Calendar: private on your channel and kept. Put it back on the Calendar to schedule it again. {watch}</>;
  else line = <>{u.note} {watch}</>;
  return (
    <div className="fv-direct" data-direct={u?.status ?? v.direct.mode}>
      <p className="hint">{line}</p>
      {u?.thumbnail === "needs_verify" ? (
        <p className="hint" data-thumb-verify>
          Verify your channel's phone number in YouTube to use custom thumbnails.{" "}
          <a href="https://www.youtube.com/verify" target="_blank" rel="noreferrer">
            Verify my channel
          </a>
        </p>
      ) : null}
    </div>
  );
}

function PostLine({ clip, v }: { clip: Clip; v: FullVideo }) {
  const toast = useToast();
  const p = v.post!;
  if (p.status !== "posted") return <p className="hint">{p.status === "in_buffer" ? `In Buffer, posts ${fmtDate(p.scheduled_at)}.` : p.status === "planned" ? `On the Calendar for ${fmtDate(p.scheduled_at)}.` : p.status === "failed" ? "Buffer couldn't post it." : ""}</p>;
  return (
    <div className="fv-studio" data-finish-studio>
      <p>
        <strong>Posted.</strong> {p.url ? <a href={p.url} target="_blank" rel="noreferrer">Watch it on YouTube</a> : null}
      </p>
      {!v.studio_done_at ? (
        <>
          <p className="hint">Finish in YouTube Studio: set the thumbnail you picked and add the tags (Buffer can't send those two).</p>
          <div className="btn-row">
            {v.thumbnails[v.thumb_pick]?.url ? (
              <a className="btn quiet small" href={`${v.thumbnails[v.thumb_pick].url}&download=1`} download>
                Download thumbnail
              </a>
            ) : null}
            <button className="btn quiet small" onClick={() => navigator.clipboard?.writeText(v.tags.join(", ")).then(() => toast.ok("Tags copied. Paste them in YouTube Studio → Tags."), () => toast.bad(new Error("Copy didn't work here. Select the tags above and copy them.")))}>
              Copy tags
            </button>
            <a className="btn small" href={v.studio_url} target="_blank" rel="noreferrer">
              Open YouTube Studio
            </a>
            <button className="btn quiet small" onClick={() => post(`/api/clips/${clip.id}/youtube/studio-done`).then(() => toast.ok("Done. Nice."), (e) => toast.bad(e))}>
              I did it
            </button>
          </div>
        </>
      ) : (
        <p className="hint">Thumbnail and tags set in YouTube Studio.</p>
      )}
    </div>
  );
}

function Handoff({ clip, v, onChanged }: { clip: Clip; v: FullVideo; onChanged: (u: unknown) => void }) {
  const toast = useToast();
  const [link, setLink] = useState("");
  return (
    <Notice tone="warn">
      <div data-handoff>
        <strong>Upload this one yourself{v.post ? `, on ${fmtDate(v.post.scheduled_at)}` : ""}.</strong> {v.direct.mode === "off" ? "YouTube lets apps post only Shorts (vertical, 3 minutes or less), so a full video goes up from your account:" : `${v.direct.upload?.note ?? "YouTube needs you to reconnect first."} Or do it by hand:`} download it, upload it on YouTube with the title and description below, set it to {v.privacy === "public" ? "Public" : v.privacy === "unlisted" ? "Unlisted" : "Private"}, and pick your thumbnail. We mark it posted when it shows on your channel.
        <div className="btn-row">
          {clip.media_url && !v.file_deleted ? (
            <a className="btn small" href={`${clip.media_url}${clip.media_url.includes("?") ? "&" : "?"}download=1`} download>
              Download for YouTube
            </a>
          ) : null}
          <a className="btn quiet small" href="https://www.youtube.com/upload" target="_blank" rel="noreferrer">
            Open YouTube upload
          </a>
        </div>
        <div className="field">
          <label htmlFor={`yt-link-${clip.id}`}>Already uploaded? Paste its link</label>
          <input id={`yt-link-${clip.id}`} className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/…" />
          <button className="btn quiet small" disabled={!link.trim()} onClick={() => post(`/api/clips/${clip.id}/youtube/posted`, { url: link }).then(() => { toast.ok("Marked posted."); onChanged(null); }, (e) => toast.bad(e))}>
            Mark posted
          </button>
        </div>
      </div>
    </Notice>
  );
}

function EditFull({ clip, v, onClose, onSaved }: { clip: Clip; v: FullVideo; onClose: () => void; onSaved: (u: unknown) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(v.title);
  const [description, setDescription] = useState(v.description);
  const [tags, setTags] = useState(v.tags.join(", "));
  const [chapters, setChapters] = useState(v.chapters.map((c) => ({ at: stampOf(c.t), title: c.title })));
  const [saving, setSaving] = useState(false);
  const toSeconds = (s: string) => s.split(":").map(Number).reduce((a, b) => a * 60 + (Number.isFinite(b) ? b : 0), 0);
  async function save() {
    if (!title.trim()) return toast.bad(new Error("The title can't be empty."));
    setSaving(true);
    try {
      const updated = await patch(`/api/clips/${clip.id}/youtube`, { title, description, tags, chapters: chapters.filter((c) => c.title.trim()).map((c) => ({ t: toSeconds(c.at), title: c.title })) });
      onSaved(updated);
    } catch (e) {
      toast.bad(e);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Edit your YouTube video" onClose={onClose}>
      <div className="field">
        <label htmlFor="fv-title">Title</label>
        <input id="fv-title" className="input" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        <span className="hint nums">{title.length} of 100</span>
      </div>
      <div className="field">
        <label htmlFor="fv-desc">Description</label>
        <textarea id="fv-desc" className="textarea" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
        <span className="hint">The chapters and three hashtags from your tags are added under it for you.</span>
      </div>
      <fieldset className="field">
        <legend className="label">Chapters</legend>
        {chapters.map((c, i) => (
          <div key={i} className="row fv-chapter-edit">
            <input className="input nums fv-at" aria-label={`Chapter ${i + 1} time`} value={c.at} onChange={(e) => setChapters((xs) => xs.map((x, j) => (j === i ? { ...x, at: e.target.value } : x)))} />
            <input className="input" aria-label={`Chapter ${i + 1} name`} value={c.title} onChange={(e) => setChapters((xs) => xs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
          </div>
        ))}
        <button type="button" className="btn quiet small" onClick={() => setChapters((xs) => [...xs, { at: xs.length ? "" : "0:00", title: "" }])}>
          Add a chapter
        </button>
        <span className="hint">YouTube shows chapters when the first is at 0:00 and there are at least three, each 10 seconds or longer.</span>
      </fieldset>
      <div className="field">
        <label htmlFor="fv-tags">Tags</label>
        <input id="fv-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="brunch, tablescape, hosting" />
        <span className="hint">Separated by commas. {v.direct.mode === "on" ? "They go up to YouTube with the video." : "You paste these in YouTube Studio after it posts."}</span>
      </div>
      <div className="btn-row">
        <button className="btn" data-primary disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
