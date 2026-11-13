// Open a post (owner's rulings, 13 Nov 2026): a sheet from the bottom of the phone, over the Posts
// list, so closing it lands her exactly where she was. She can watch the video or see the photos,
// read the whole caption as it will post, change the words, move it, swap it (reels) and take it
// off or skip it. One sheet for every kind of post, opened from the list, the week and the month;
// each change goes through that kind's own route.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { PostItem } from "@shared/posts";
import { plainDay, plainWhen } from "@shared/posts";
import { ApiFailure, get, patch, post } from "../lib/api";
import { Modal, Skeleton, useLoad, useToast } from "./ui";

function ymdIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
function nextDays(today: string, n: number): string[] {
  const [y, m, d] = today.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

export function PostSheet({ id, tz, today, others, onClose, onChanged }: { id: string; tz: string; today: string; /** other reels it can swap places with */ others: PostItem[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const item = useLoad(() => get<PostItem>(`/api/posts/item/${id}`), [id]);
  const p = item.data;
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState("");
  const [tags, setTags] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [swapWith, setSwapWith] = useState("");
  const [busy, setBusy] = useState(false);
  const [taste, setTaste] = useState<boolean | null>(null);

  async function tell(more: boolean) {
    setBusy(true);
    try {
      await post(`/api/posts/item/${id}/taste`, { more });
      setTaste(more);
      toast.ok(more ? "Got it. The next batch makes more posts like this one." : "Got it. The next batch makes fewer posts like this one.");
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  if (item.error && !p)
    return (
      <Modal title="Post" onClose={onClose}>
        <p className="soft">That post is not here any more. Close this and look at the list again.</p>
      </Modal>
    );
  if (!p)
    return (
      <Modal title="Post" onClose={onClose}>
        <Skeleton lines={4} />
      </Modal>
    );

  const current = ymdIn(p.scheduled_at, tz);
  const picked = day || (current >= today ? current : today);

  /** Run one change; `stay` keeps the sheet open on the fresh post (a caption, a move). */
  async function run(fn: () => Promise<unknown>, ok: string, stay = false) {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
      onChanged();
      if (stay) item.reload();
      else onClose();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveWords() {
    if (!p?.edit) return;
    setBusy(true);
    setProblems([]);
    try {
      if (p.source === "clip") await patch(`/api/clips/${p.ref_id}`, p.edit.tags === null ? { caption: words } : { caption: words, hashtags: tags });
      else await patch(`/api/photos/posts/${p.id}`, { caption: words });
      toast.ok("Saved. This is what will post.");
      setEditing(false);
      onChanged();
      item.reload();
    } catch (e) {
      // A caption that breaks a studio rule comes back with the reasons, in plain words.
      const list = e instanceof ApiFailure ? (e.body as { problems?: string[] }).problems : undefined;
      if (list?.length) setProblems(list);
      else toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  const out = p.state === "posted";
  const off = p.state === "off";
  return (
    <Modal title={`${p.kind_label} · ${p.platform_label}`} onClose={onClose}>
      <div className="post-sheet" data-post-sheet={p.source}>
        {p.video_url ? (
          <video className="post-media" src={p.video_url} poster={p.thumb_url ?? undefined} controls playsInline preload="metadata" aria-label="Play this post" />
        ) : p.images.length ? (
          <div className={`post-photos${p.images.length === 1 ? " one" : ""}`}>
            {p.images.map((src, i) => (
              <img key={src} src={src} alt={`Photo ${i + 1} of ${p.images.length}`} loading="lazy" />
            ))}
          </div>
        ) : p.thumb_url ? (
          <img className="post-media" src={p.thumb_url} alt="" />
        ) : (
          <div className="post-media post-media-none">The picture is not ready to show yet.</div>
        )}

        <div className="post-when">
          <span className="post-chip">{p.kind_label}</span>
          <span className="hint">
            {plainWhen(p.scheduled_at, tz)} · {p.platform_label}
          </span>
        </div>
        {p.source === "clip" ? <h3 className="post-headline">{p.headline}</h3> : null}
        {p.reason ? <div className={`notice ${p.state === "failed" ? "bad" : "warn"}`}>{p.reason}</div> : null}

        {/* "More like this" / "Less like this" (owner, 13 Nov 2026): what she says here shapes the next batch. */}
        <div className="taste-row" data-taste>
          <button type="button" className={`btn quiet small${taste === true ? " on" : ""}`} aria-pressed={taste === true} disabled={busy} onClick={() => void tell(true)}>
            👍 More like this
          </button>
          <button type="button" className={`btn quiet small${taste === false ? " on" : ""}`} aria-pressed={taste === false} disabled={busy} onClick={() => void tell(false)}>
            👎 Less like this
          </button>
        </div>

        {editing && p.edit ? (
          <div className="field">
            <label htmlFor="post-words">The words that post</label>
            <textarea id="post-words" className="input post-words" rows={7} value={words} onChange={(e) => setWords(e.target.value)} />
            {p.edit.tags !== null ? (
              <>
                <label htmlFor="post-tags">Tags</label>
                <input id="post-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
              </>
            ) : null}
            {p.source === "clip" ? <div className="hint">This changes the words everywhere this one posts.</div> : null}
            {problems.length ? (
              <div className="notice bad" role="alert">
                {problems.map((x) => (
                  <div key={x}>{x}</div>
                ))}
              </div>
            ) : null}
            <div className="btn-row">
              <button type="button" className="btn dark" disabled={busy} onClick={saveWords}>
                Save the words
              </button>
              <button type="button" className="btn quiet" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="post-caption" data-post-caption>
              {p.caption || "No caption yet."}
            </p>
            {p.edit ? (
              <button
                type="button"
                className="btn quiet"
                onClick={() => {
                  setWords(p.edit!.caption);
                  setTags(p.edit!.tags ?? "");
                  setProblems([]);
                  setEditing(true);
                }}
              >
                Change the words
              </button>
            ) : p.edit_note ? (
              <p className="hint">{p.edit_note}</p>
            ) : null}
          </>
        )}

        {out ? (
          <p className="hint">
            This one already went out, so it stays where it is.{" "}
            {p.url ? (
              <a href={p.url} target="_blank" rel="noreferrer">
                See it ›
              </a>
            ) : null}
          </p>
        ) : null}
        {off ? (
          <p className="hint">
            {p.source === "photo" ? (
              <>
                You skipped this one, so it will not go out. It waits in the <Link to="/calendar/bin">Rejected bin ›</Link>
              </>
            ) : (
              "This one was taken off the calendar."
            )}
          </p>
        ) : null}

        {p.can.retry ? (
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => post(p.source === "clip" ? `/api/posts/${p.id}/retry` : `/api/photos/posts/${p.id}/retry`), p.source === "clip" ? "We’ll try that post again within the hour." : "Planned again. You get a heads-up before it goes out.")}>
            Try again
          </button>
        ) : null}

        {p.can.move ? (
          <div className="field">
            <label htmlFor="move-day">Move to another day</label>
            <div className="row wrap">
              <select id="move-day" className="select cal-select" value={picked} onChange={(e) => setDay(e.target.value)}>
                {nextDays(today, 35).map((d) => (
                  <option key={d} value={d}>
                    {plainDay(`${d}T12:00:00Z`, "UTC")}
                    {d === current ? " (now)" : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="btn dark" disabled={busy || picked === current} onClick={() => run(() => (p.source === "clip" ? patch(`/api/posts/${p.id}`, { date: picked }) : patch(`/api/photos/posts/${p.id}/move`, { date: picked })), `Moved to ${plainDay(`${picked}T12:00:00Z`, "UTC")}.`, true)}>
                Move
              </button>
            </div>
            <div className="hint">Keeps the same time of day.</div>
          </div>
        ) : null}

        {p.can.swap && others.length ? (
          <div className="field">
            <label htmlFor="swap-with">Swap for a different post</label>
            <div className="row wrap">
              <select id="swap-with" className="select cal-select" value={swapWith} onChange={(e) => setSwapWith(e.target.value)}>
                <option value="">Pick another post</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {plainWhen(o.scheduled_at, tz)} · {o.platform_label} · {o.headline.slice(0, 40)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn dark" disabled={busy || !swapWith} onClick={() => run(() => post("/api/posts/swap", { a: p.id, b: swapWith }), "Swapped. The two posts traded places.")}>
                Swap
              </button>
            </div>
            <div className="hint">The two posts trade days and times.</div>
          </div>
        ) : null}

        {p.can.remove ? (
          p.source === "clip" ? (
            <button type="button" className="btn danger" disabled={busy} onClick={() => run(() => post(`/api/posts/${p.id}/unschedule`), "Taken off. It is back with your approved posts.")}>
              Take it off the calendar
            </button>
          ) : (
            <button type="button" className="btn danger" disabled={busy} onClick={() => run(() => post(`/api/photos/posts/${p.id}/skip`), "Skipped. That post will not go out. It waits in the Rejected bin.")}>
              Skip this post (it will not go out)
            </button>
          )
        ) : null}

        <button type="button" className="btn quiet" onClick={onClose}>
          ✕ Close
        </button>
      </div>
    </Modal>
  );
}
