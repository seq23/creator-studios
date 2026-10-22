// Photos (shared/photoPosts.ts): add a photo, the studio makes a few posts from it (a slow-zoom
// video, a before/after when there is a before and an after photo, a photo set and three short
// captions), and they go out on their own. A heads-up email comes first; Skip stops any one of
// them. Calm by design (make-it-calm): summary first, one list, every button says what it does,
// ← Back at the top, and nothing jumps: after any tap you stay on the same card.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { get, patch, post, del } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { fmtDateTime } from "../lib/format";
import { HelpButton, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { PACK_MAX_PHOTOS, SOCIAL_LABEL, ITEM_LABEL, isPhoto, type PackView, type PhotosHome, type SocialPostView } from "@shared/photoPosts";
import "../styles/photos.css";

const CONNECT_LABEL: Record<string, string> = { facebook: "Connect Facebook", pinterest: "Connect Pinterest", buffer: "Connect Buffer (Instagram and TikTok)", github: "Connect the photo maker" };
const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png";

export function Photos() {
  const { data, reload } = useLoad(() => get<PhotosHome>("/api/photos"));
  return (
    <div className="page photos-page">
      <PageHead eyebrow="Photos" title="Turn a photo into posts" lede="Add a photo. The studio makes a few posts from it and they go out on their own. You get an email the day before, and you can skip any one.">
        <HelpButton guide="photo-posts" />
      </PageHead>
      {!data ? <Skeleton lines={6} /> : !data.on ? <Notice>{data.off_line}</Notice> : <PhotosBody home={data} reload={reload} />}
    </div>
  );
}

function PhotosBody({ home, reload }: { home: PhotosHome; reload: () => void | Promise<void> }) {
  const next = home.upcoming.find((p) => p.status === "scheduled");
  const ruleBits = [
    ...home.rules.banWords.map((w) => `never says “${w}”`),
    home.rules.blockAddresses ? "no addresses or house numbers" : "",
    home.rules.blockFaces ? "faces are blurred" : "",
    home.rules.prices ? `prices only: ${home.rules.prices}` : "",
  ].filter(Boolean);
  return (
    <>
      <section className="photos-summary" aria-live="polite">
        <p className="photos-summary-big">
          {home.upcoming.filter((p) => p.status === "scheduled").length} posts coming up
        </p>
        <p>{next ? `Next: ${SOCIAL_LABEL[next.platform]}, ${fmtDateTime(next.scheduled_at)}.` : "Nothing is planned yet. Add a photo below."}</p>
      </section>

      {home.stops.length > 0 && (
        <div className="photos-banner" role="status">
          <p>
            <strong>Not connected yet:</strong> {home.stops.map((s) => s.label.replace("Connect ", "")).join(", ")}. Those posts wait safely until then.
          </p>
          <div className="photos-banner-actions">
            {home.stops.map((s) => (
              <Link key={s.platform} className="btn small quiet" to={`/setup#setup-${s.setup}`}>
                {s.label} →
              </Link>
            ))}
          </div>
        </div>
      )}
      {home.maker_practice && (
        <div className="photos-banner" role="status">
          <p>
            <strong>The photo maker is not connected yet.</strong> Your photo sets are saved, but the videos and the face and house-number check wait until it is.
          </p>
          <div className="photos-banner-actions">
            <Link className="btn small quiet" to="/setup#setup-github">
              Connect the photo maker →
            </Link>
          </div>
        </div>
      )}

      <AddPhotos onMade={reload} />

      <section className="photos-section">
        <h2>Coming up</h2>
        {home.upcoming.length === 0 ? <p className="muted">Nothing is waiting to go out.</p> : (
          <ol className="photos-list">
            {home.upcoming.map((p) => (
              <li key={p.id} id={`post-${p.id}`}>
                <PostCard post={p} reload={reload} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="photos-section">
        <h2>Your photo sets</h2>
        {home.packs.length === 0 ? <p className="muted">No photo sets yet.</p> : (
          <ol className="photos-list">
            {home.packs.map((p) => (
              <li key={p.id}>
                <PackCard pack={p} reload={reload} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {ruleBits.length > 0 && <p className="photos-rules">This studio's rules, checked before anything posts: {ruleBits.join(" · ")}.</p>}
    </>
  );
}

type Local = { name: string; fraction: number; role: "main" | "before" | "after"; error?: string };

function AddPhotos({ onMade }: { onMade: () => void | Promise<void> }) {
  const toast = useToast();
  const [packId, setPackId] = useState<string | null>(null);
  const [files, setFiles] = useState<Local[]>([]);
  const [note, setNote] = useState("");
  const [aiEdited, setAiEdited] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const mainRef = useRef<HTMLInputElement>(null);
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!note.trim()) return setProblems([]);
      void post<{ problems: string[] }>("/api/photos/check", { text: note }).then((r) => setProblems(r.problems)).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [note]);

  async function ensurePack(): Promise<string> {
    if (packId) return packId;
    const r = await post<{ id: string }>("/api/photos/packs", { note, ai_edited: aiEdited });
    setPackId(r.id);
    return r.id;
  }

  async function add(list: FileList | null, role: Local["role"]) {
    if (!list?.length) return;
    const picked = [...list].filter((f) => isPhoto(f.type, f.name));
    if (picked.length < list.length) toast.bad(null, "Only photos can go here (JPG, PNG or iPhone photos).");
    if (files.length + picked.length > PACK_MAX_PHOTOS) {
      toast.bad(null, `A set holds up to ${PACK_MAX_PHOTOS} photos.`);
      return;
    }
    const id = await ensurePack();
    for (const f of picked) {
      const pos = files.length + picked.indexOf(f);
      setFiles((xs) => [...xs, { name: f.name, fraction: 0, role }]);
      try {
        await uploadFile(f, "photo", id, (fraction) => setFiles((xs) => xs.map((x, j) => (j === pos ? { ...x, fraction } : x))), { fileNote: role });
      } catch (e) {
        setFiles((xs) => xs.map((x, j) => (j === pos ? { ...x, error: e instanceof Error ? e.message : "Did not upload" } : x)));
      }
    }
  }

  async function make() {
    if (!packId) return;
    setBusy(true);
    try {
      await patch(`/api/photos/packs/${packId}`, { note, ai_edited: aiEdited });
      await post(`/api/photos/packs/${packId}/make`);
      toast.ok("Your posts are being made. They show up below in a few minutes.");
      setPackId(null);
      setFiles([]);
      setNote("");
      setAiEdited(false);
      await onMade();
    } catch (e) {
      toast.bad(e, "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const uploading = files.some((f) => f.fraction < 1 && !f.error);
  const ready = files.some((f) => f.fraction >= 1) && !uploading && problems.length === 0;
  return (
    <section className="photos-section photos-add">
      <h2>Add photos</h2>
      <button type="button" className="btn big block" data-primary onClick={() => mainRef.current?.click()}>
        Add photos from my phone
      </button>
      <input ref={mainRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => void add(e.target.files, "main")} />
      <p className="muted">Have a before and after? Add them here too (optional):</p>
      <div className="photos-ba">
        <button type="button" className="btn quiet" onClick={() => beforeRef.current?.click()}>
          Add the before photo
        </button>
        <button type="button" className="btn quiet" onClick={() => afterRef.current?.click()}>
          Add the after photo
        </button>
      </div>
      <input ref={beforeRef} type="file" accept={ACCEPT} hidden onChange={(e) => void add(e.target.files, "before")} />
      <input ref={afterRef} type="file" accept={ACCEPT} hidden onChange={(e) => void add(e.target.files, "after")} />
      {files.length > 0 && (
        <ul className="photos-uploads">
          {files.map((f, i) => (
            <li key={i}>
              <span>{f.role === "main" ? "Photo" : f.role === "before" ? "Before photo" : "After photo"} {i + 1}</span>
              <span className={f.error ? "bad" : f.fraction >= 1 ? "ok" : ""}>{f.error ? `Did not upload: ${f.error}` : f.fraction >= 1 ? "Uploaded ✓" : `Uploading ${Math.round(f.fraction * 100)}%`}</span>
            </li>
          ))}
        </ul>
      )}
      <label className="photos-note">
        <span>What does it show? (optional, helps the captions)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="Fall porch with mums and pumpkins" />
      </label>
      <label className="photos-ai-edited">
        <input type="checkbox" checked={aiEdited} onChange={(e) => setAiEdited(e.target.checked)} />
        <span>Some of these photos were edited with AI (every post from them is labelled “Made with AI”)</span>
      </label>
      {problems.map((p) => (
        <Notice key={p} tone="warn">
          {p}
        </Notice>
      ))}
      <button type="button" className="btn big block" data-primary disabled={!ready || busy} onClick={() => void make()}>
        {busy ? "Making your posts…" : uploading ? "Wait for the photos to finish uploading" : "Make my posts"}
      </button>
    </section>
  );
}

function PostCard({ post: p, reload }: { post: SocialPostView; reload: () => void | Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(p.caption);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function act(path: string, done: string) {
    setBusy(true);
    try {
      await post(`/api/photos/posts/${p.id}/${path}`);
      toast.ok(done);
      await reload();
    } catch (e) {
      toast.bad(e, "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const r = await fetch(`/api/photos/posts/${p.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ caption }) });
      const j = (await r.json()) as { ok: boolean; problems: string[] };
      if (!j.ok) return setProblems(j.problems);
      setProblems([]);
      setEditing(false);
      toast.ok("Caption saved.");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // Colour means one thing: red only when a post really did not go out; yellow when it waits on something.
  const tone = p.status === "failed" ? "bad" : p.status === "waiting" || p.status === "held" ? "warn" : p.status === "skipped" ? "muted" : "";
  return (
    <article className={`photos-card ${tone}`}>
      <div className="photos-card-head">
        {p.cover_url ? <img src={p.cover_url} alt="" className="photos-thumb" /> : <div className="photos-thumb empty" aria-hidden />}
        <div>
          <p className="photos-card-title">
            {SOCIAL_LABEL[p.platform]} · {ITEM_LABEL[p.item_kind]}
          </p>
          <p className="photos-card-line">{p.line}</p>
        </div>
      </div>
      {editing ? (
        <>
          <label className="photos-note">
            <span>Caption</span>
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} maxLength={2000} />
          </label>
          {problems.map((x) => (
            <Notice key={x} tone="warn">
              {x}
            </Notice>
          ))}
          <div className="photos-actions">
            <button type="button" className="btn" data-primary disabled={busy} onClick={() => void save()}>
              Save caption
            </button>
            <button type="button" className="btn quiet" onClick={() => (setEditing(false), setCaption(p.caption), setProblems([]))}>
              ✕ Cancel
            </button>
          </div>
        </>
      ) : (
        <p className="photos-caption">“{p.caption}”</p>
      )}
      {!editing && p.status === "skipped" && (
        <div className="photos-actions">
          <button type="button" className="btn quiet" disabled={busy} onClick={() => void act("unskip", "It is back on. You get a heads-up before it goes out.")}>
            Undo skip (let it go out)
          </button>
        </div>
      )}
      {!editing && p.status !== "skipped" && (
        <div className="photos-actions">
          {p.connect && (
            <Link className="btn" data-primary to={`/setup#setup-${p.connect}`}>
              {CONNECT_LABEL[p.connect] ?? "Open Setup"} →
            </Link>
          )}
          {p.status === "failed" && (
            <button type="button" className="btn" data-primary disabled={busy} onClick={() => void act("retry", "It will try again after a new heads-up.")}>
              Try again
            </button>
          )}
          <button type="button" className="btn quiet" disabled={busy} onClick={() => setEditing(true)}>
            Change the caption
          </button>
          <button type="button" className="btn quiet photos-skip" disabled={busy} onClick={() => void act("skip", "Skipped. That post will not go out.")}>
            Skip this post (it will not go out)
          </button>
        </div>
      )}
    </article>
  );
}

function PackCard({ pack, reload }: { pack: PackView; reload: () => void | Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const skipped = pack.posts.filter((p) => p.status === "skipped");
  const status =
    pack.status === "making" ? "Being made now. This takes a few minutes." : pack.status === "failed" ? `Not made: ${pack.error ?? "the photo maker stopped"}` : pack.status === "uploading" ? "Not sent yet." : `${pack.posts.length} posts planned`;
  return (
    <article className={`photos-card ${pack.status === "failed" || pack.privacy === "blocked" ? "bad" : ""}`}>
      <div className="photos-card-head">
        {pack.photos[0] ? <img src={pack.photos[0].url} alt="" className="photos-thumb" /> : <div className="photos-thumb empty" aria-hidden />}
        <div>
          <p className="photos-card-title">Photo set from {fmtDateTime(pack.created_at)}</p>
          <p className="photos-card-line">{status}</p>
          <p className="photos-card-line muted">{pack.privacy_line}</p>
        </div>
      </div>
      {(pack.status === "uploading" || pack.status === "failed") && pack.photos.length > 0 && (
        <button
          type="button"
          className="btn block"
          data-primary
          onClick={() =>
            void post(`/api/photos/packs/${pack.id}/make`)
              .then(() => (toast.ok("Your posts are being made. They show up here in a few minutes."), reload()))
              .catch((e: unknown) => toast.bad(e, "That did not work. Try again."))
          }
        >
          {pack.status === "failed" ? "Try making the posts again" : "Make my posts from these photos"}
        </button>
      )}
      <button type="button" className="btn quiet small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Show less ▴" : "Show the posts made from it ▾"}
      </button>
      {open && (
        <div className="photos-pack-more">
          {pack.items.map((it) => (
            <div key={it.id} className="photos-item">
              <p className="photos-card-title">
                {it.label}
                {it.ai_made ? " · labelled “Made with AI”" : ""}
              </p>
              {it.media_url ? (
                <video src={it.media_url} poster={it.cover_url ?? undefined} controls playsInline preload="none" className="photos-video" />
              ) : it.images.length ? (
                <div className="photos-strip">
                  {it.images.map((src) => (
                    <img key={src} src={src} alt="" />
                  ))}
                </div>
              ) : (
                <p className="muted">Made once the photo maker is connected.</p>
              )}
            </div>
          ))}
          {pack.captions.length > 0 && (
            <>
              <p className="photos-card-title">Captions</p>
              <ol className="photos-captions">
                {pack.captions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            </>
          )}
          {skipped.map((s) => (
            <p key={s.id} className="photos-card-line">
              Skipped: {SOCIAL_LABEL[s.platform]} · {ITEM_LABEL[s.item_kind]}{" "}
              <button
                type="button"
                className="btn quiet small"
                onClick={() =>
                  void post(`/api/photos/posts/${s.id}/unskip`)
                    .then(() => (toast.ok("It is back on. You get a heads-up before it goes out."), reload()))
                    .catch((e: unknown) => toast.bad(e, "That did not work."))
                }
              >
                Undo skip
              </button>
            </p>
          ))}
          {pack.status === "uploading" &&
            pack.photos.map((ph) => (
              <button key={ph.id} type="button" className="btn quiet small" onClick={() => void del(`/api/photos/packs/${pack.id}/photos/${ph.id}`).then(reload)}>
                Remove this photo
              </button>
            ))}
        </div>
      )}
    </article>
  );
}
