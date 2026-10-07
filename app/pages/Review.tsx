// Review (section 9). OWNED BY: phase 5. Clips grouped by dump, best score first. Per clip: play,
// approve, reject (with a reason), delete (confirm), edit caption / hashtags / hook (one-tap swap
// to the other hook), untick platforms, Paid partnership (#ad). Bulk: Approve all, Reject all,
// select several. Tabs: New / Approved / Rejected (kept 7 days). Phone first: one column, big
// Approve / Reject buttons; desktop: a grid.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ClipRow } from "@shared/types";
import { PLATFORMS, PLATFORM_LABEL, RECIPES, REJECT_REASONS, type Platform, type Recipe } from "@shared/constants";
import { del, get, patch, post } from "../lib/api";
import { fmtDate, fmtSeconds, plural } from "../lib/format";
import { Empty, HelpButton, Modal, MoreRow, PageHead, SearchBox, Skeleton, Switch, useLoad, useToast } from "../components/ui";
import { useApp } from "../state";
import { HeldNotice } from "../components/HeldNotice";
import { LookModal } from "../components/LookPicker";
import { HandoffModal } from "../components/HandoffModal";
import { maxWords } from "@shared/autoVoice";
import { FullVideoBody, type FullVideo } from "../components/FullVideoCard";
import "../styles/review.css";

type Tab = "new" | "approved" | "rejected";

export interface ReviewClip extends ClipRow {
  reviewed_at: string | null;
  purge_at: string | null;
  look: string | null;
  look_name: string | null;
  layout: { cells: ({ kind: "self" } | { kind: "clip"; clip_id: string } | { kind: "zoom"; zoom: number })[]; voice: number } | null;
  pending_look: string | null;
  pending_look_name: string | null;
  rerender_error: string | null;
  source_available: boolean;
  edited_with: string | null;
  edited_with_name: string | null;
  editing_note: string | null;
  music_id: string | null;
  pending_music: string | null;
  /** Her voice over on this clip: being added, in it (the video plays with it), or it did not work. */
  voice_over: "mixing" | "ready" | "failed" | null;
  /** The words of that voice over (Redo opens them to edit), and whether it was made automatically. */
  voice_script: string | null;
  voice_auto: boolean;
  /** A full video for YouTube (the third door): never cut; its own card body. */
  full_video: FullVideo | null;
  /** Day 358: the video file was cleared 30 days after posting (cover, numbers and post link stay). */
  file_cleared: boolean;
  /** An unapproved draft cleared on this date unless she approves it or taps Keep. */
  clears_on: string | null;
}
interface ReviewGroup {
  /** held_note: "Looks like someone else's video" (worker/domain/sourceCheck.ts), or null. */
  dump: { id: string; door: "new" | "recycle" | "youtube"; created_at: string; ready_at: string | null; status: string; held_note: string | null };
  clips: ReviewClip[];
}
interface ReviewList {
  tab: Tab;
  groups: ReviewGroup[];
  counts: { new: number; approved: number; rejected: number; hidden: number };
  /** Day 358: one page at a time; `total` is the true count for this tab, filters and search. */
  total: number;
  limit: number;
  offset: number;
}

/** Page two onwards joins the groups already shown (a dump can straddle two pages). */
function mergePages(a: ReviewList, b: ReviewList): ReviewList {
  const groups = a.groups.map((g) => ({ ...g, clips: [...g.clips] }));
  for (const g of b.groups) {
    const same = groups.find((x) => x.dump.id === g.dump.id);
    if (same) same.clips.push(...g.clips);
    else groups.push(g);
  }
  return { ...b, groups, offset: 0 };
}

const SHORT: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };
const TAB_LABEL: Record<Tab, string> = { new: "New", approved: "Approved", rejected: "Rejected" };

function sentence(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Review() {
  const toast = useToast();
  const { refreshCounts } = useApp();
  // ?tab= opens a tab (Home's "Copy the tags in Review" goes to Approved; day 358 found it ignored).
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (["new", "approved", "rejected"].includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "new"));
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [moreBusy, setMoreBusy] = useState(false);
  const [door, setDoor] = useState("");
  const [recipe, setRecipe] = useState("");
  const [platform, setPlatform] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ReviewClip | null>(null);
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<ReviewClip | null>(null);
  const [restyling, setRestyling] = useState<ReviewClip | null>(null);
  const [handoff, setHandoff] = useState<ReviewClip | null>(null);
  const [musicFor, setMusicFor] = useState<ReviewClip | null>(null);
  const [voiceFor, setVoiceFor] = useState<ReviewClip | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ tab });
    if (door) q.set("door", door);
    if (recipe) q.set("recipe", recipe);
    if (platform) q.set("platform", platform);
    if (showHidden) q.set("hidden", "1");
    if (search) q.set("q", search);
    return q.toString();
  }, [tab, door, recipe, platform, showHidden, search]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useLoad(() => get<ReviewList>(`/api/clips?${query}`), [query]);
  const shownCount = useMemo(() => (list.data?.groups ?? []).reduce((n, g) => n + g.clips.length, 0), [list.data]);
  async function showMore() {
    if (!list.data) return;
    setMoreBusy(true);
    try {
      const next = await get<ReviewList>(`/api/clips?${query}&offset=${shownCount}`);
      list.setData((d) => (d ? mergePages(d, next) : next));
    } catch (e) {
      toast.bad(e);
    } finally {
      setMoreBusy(false);
    }
  }
  async function keep(ids: string[]) {
    try {
      const r = await post<{ kept: number; until: string }>("/api/clips/keep", { ids });
      toast.ok(`Kept until ${fmtDate(r.until)}.`);
      list.reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  useEffect(() => setSelected(new Set()), [query]);

  // A clip getting a new look re-renders on the runner (about a minute): check back every 15 s
  // until none is pending, so the new version appears without a manual refresh.
  const pending = (list.data?.groups ?? []).some((g) => g.clips.some((c) => c.pending_look || c.editing_note || c.voice_over === "mixing"));
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => list.reload(), 15_000);
    return () => window.clearInterval(t);
  }, [pending, list.reload]);

  /** Put one clip's fresh copy (a PATCH or Change look answer) into the list right away. */
  function replaceClip(updated: ReviewClip) {
    list.setData((d) => (d ? { ...d, groups: d.groups.map((g) => ({ ...g, clips: g.clips.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)) })) } : d));
  }

  const visible = useMemo(() => (list.data?.groups ?? []).flatMap((g) => g.clips), [list.data]);
  const counts = list.data?.counts ?? { new: 0, approved: 0, rejected: 0, hidden: 0 };

  function after(message: string) {
    toast.ok(message);
    setSelected(new Set());
    list.reload();
    refreshCounts();
  }

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      after(message);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  const approve = (ids: string[]) =>
    run(() => (ids.length === 1 ? post(`/api/clips/${ids[0]}/approve`) : post("/api/clips/bulk", { action: "approve", ids })), ids.length === 1 ? "Approved. It will go on the Calendar." : `${plural(ids.length, "clip")} approved.`);
  const reject = (ids: string[], reason: string | null) =>
    run(() => (ids.length === 1 ? post(`/api/clips/${ids[0]}/reject`, { reason }) : post("/api/clips/bulk", { action: "reject", ids, reason })), ids.length === 1 ? "Rejected. It stays in Rejected for 7 days." : `${plural(ids.length, "clip")} rejected.`);
  const restore = (id: string) => run(() => post(`/api/clips/${id}/restore`), "Moved back to New.");
  const remove = (id: string) => run(() => del(`/api/clips/${id}`), "Deleted for good.");

  async function togglePlatform(c: ReviewClip, p: Platform) {
    const next = c.platforms.includes(p) ? c.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || c.platforms.includes(x));
    if (!next.length) {
      toast.bad(new Error("Leave at least one platform ticked, or reject the clip instead."));
      return;
    }
    try {
      const updated = await patch<ReviewClip>(`/api/clips/${c.id}`, { platforms: next });
      list.setData((d) => (d ? { ...d, groups: d.groups.map((g) => ({ ...g, clips: g.clips.map((x) => (x.id === c.id ? { ...x, platforms: updated.platforms } : x)) })) } : d));
    } catch (e) {
      toast.bad(e);
    }
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const newIds = tab === "new" ? visible.map((c) => c.id) : [];
  const nothingAtAll = !list.loading && counts.new + counts.approved + counts.rejected + counts.hidden === 0;

  return (
    <div className="page review-page">
      <PageHead title="Review clips" lede="Approve the clips you’d post and reject the rest. Nothing posts until you approve it.">
        {tab === "new" && newIds.length > 0 ? (
          <>
            <button className="btn quiet" disabled={busy} onClick={() => setRejecting(newIds)}>
              Reject all
            </button>
            <button className="btn" data-primary disabled={busy} onClick={() => approve(newIds)}>
              {list.data && list.data.total > newIds.length ? `Approve these ${newIds.length}` : `Approve all ${newIds.length}`}
            </button>
          </>
        ) : null}
      </PageHead>

      <div className="review-tabs" role="tablist" aria-label="Which clips">
        {(["new", "approved", "rejected"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`review-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]} <span className="badge soft">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="review-filters">
        <label className="sr-only" htmlFor="f-door">Door</label>
        <select id="f-door" className="select" value={door} onChange={(e) => setDoor(e.target.value)}>
          <option value="">All footage</option>
          <option value="new">New videos</option>
          <option value="recycle">Old posts</option>
        </select>
        <label className="sr-only" htmlFor="f-recipe">Style</label>
        <select id="f-recipe" className="select" value={recipe} onChange={(e) => setRecipe(e.target.value)}>
          <option value="">All styles</option>
          {(Object.keys(RECIPES) as Recipe[]).map((r) => (
            <option key={r} value={r}>
              {RECIPES[r].label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-platform">Platform</label>
        <select id="f-platform" className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p]}
            </option>
          ))}
        </select>
        {tab === "new" ? <Switch checked={showHidden} onChange={setShowHidden} label={`Show hidden (under the quality bar)${counts.hidden ? ` · ${counts.hidden}` : ""}`} /> : null}
      </div>
      <div className="list-tools">
        <SearchBox value={q} onChange={setQ} label="Search hooks, captions and hashtags" />
      </div>

      {tab === "rejected" && visible.length > 0 ? <p className="hint">Rejected clips are removed for good 7 days after you reject them. Changed your mind? Approve or move one back.</p> : null}

      {list.loading && !list.data ? <Skeleton blocks={3} columns={3} /> : null}
      {list.error ? <Empty title="Review didn’t load">Check your connection, then pull down or reload the page to try again.</Empty> : null}

      {list.data && visible.length === 0 ? (
        nothingAtAll ? (
          <Empty title="Nothing to review yet" cta={{ to: "/dump", label: "Dump videos" }} primary>
            Dump some footage and the clips land here, usually 10 to 30 minutes later. We’ll email you.
          </Empty>
        ) : tab === "new" ? (
          <Empty title="All caught up" cta={{ to: "/calendar", label: "See the Calendar" }} primary>
            {counts.hidden && !showHidden ? `Every new clip is reviewed. ${plural(counts.hidden, "clip")} scored lower and are hidden; switch on “Show hidden” to see them.` : "Every new clip is reviewed. Approved clips fill the Calendar."}
          </Empty>
        ) : tab === "approved" ? (
          <Empty title="No approved clips here" cta={{ to: "/calendar", label: "See the Calendar" }}>
            Approve clips in New and they wait here until they post. Posts already planned are on the Calendar.
          </Empty>
        ) : (
          <Empty title="Nothing rejected">Clips you reject stay here for 7 days in case you change your mind.</Empty>
        )
      ) : null}

      {list.data?.groups.map((g) => (
        <section key={g.dump.id} className="review-group" data-dump-id={g.dump.id} aria-label={`Dump from ${fmtDate(g.dump.created_at)}`}>
          <h2 className="review-group-head">
            Dump: {fmtDate(g.dump.created_at)} · {g.dump.door === "new" ? "New videos" : g.dump.door === "youtube" ? "Full video for YouTube" : "Old posts"} <span className="hint">· {plural(g.clips.length, "clip")} · best first</span>
          </h2>
          {g.dump.held_note ? <HeldNotice dumpId={g.dump.id} note={g.dump.held_note} onDone={list.reload} /> : null}
          <div className="review-grid">
            {g.clips.map((c) => (
              <ClipCard
                key={c.id}
                clip={c}
                tab={tab}
                busy={busy}
                selected={selected.has(c.id)}
                onSelect={() => toggleSelect(c.id)}
                onApprove={() => approve([c.id])}
                onReject={() => setRejecting([c.id])}
                onRestore={() => restore(c.id)}
                onEdit={() => setEditing(c)}
                onRestyle={() => setRestyling(c)}
                onHandoff={() => setHandoff(c)}
                onMusic={() => setMusicFor(c)}
                onAnother={() =>
                  run(async () => {
                    const r = await post<{ clip: ReviewClip | null }>(`/api/clips/${c.id}/another`);
                    if (r.clip) replaceClip(r.clip);
                  }, "Trying another version, about a minute. The current one stays until it's ready.")
                }
                onVoiceRedo={() => setVoiceFor(c)}
                onVoiceAdd={() => setVoiceFor(c)}
                onKeep={() => keep([c.id])}
                onVoiceRemove={() =>
                  run(async () => {
                    const r = await post<{ clip: ReviewClip | null }>(`/api/clips/${c.id}/voice-over/remove`);
                    if (r.clip) replaceClip(r.clip);
                  }, "Voice over removed. The clip plays with its own sound.")
                }
                onDelete={() => setDeleting(c)}
                onPlatform={(p) => togglePlatform(c, p)}
                onFullChanged={(u) => (u && typeof u === "object" && "id" in u ? replaceClip(u as ReviewClip) : list.reload())}
              />
            ))}
          </div>
        </section>
      ))}

      {selected.size > 0 ? (
        <div className="select-bar" role="region" aria-label="Selected clips">
          <strong>{selected.size} selected</strong>
          <div className="btn-row">
            {tab !== "approved" ? (
              <button className="btn small" disabled={busy} onClick={() => approve([...selected])}>
                Approve
              </button>
            ) : null}
            {tab !== "rejected" ? (
              <button className="btn small quiet" disabled={busy} onClick={() => setRejecting([...selected])}>
                Reject
              </button>
            ) : null}
            <button className="btn small quiet" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {rejecting ? (
        <RejectModal
          count={rejecting.length}
          onClose={() => setRejecting(null)}
          onPick={(reason) => {
            const ids = rejecting;
            setRejecting(null);
            reject(ids, reason);
          }}
        />
      ) : null}
      {deleting ? (
        <Modal title="Delete this clip for good?" onClose={() => setDeleting(null)}>
          <p>This removes the video file permanently. You can’t undo it. To keep it around for a week instead, reject it.</p>
          <div className="btn-row">
            <button
              className="btn danger"
              onClick={() => {
                const id = deleting.id;
                setDeleting(null);
                remove(id);
              }}
            >
              Delete for good
            </button>
            <button className="btn quiet" onClick={() => setDeleting(null)}>
              Keep it
            </button>
          </div>
        </Modal>
      ) : null}
      {list.data && list.data.total > 0 ? <MoreRow shown={shownCount} total={list.data.total} onMore={showMore} busy={moreBusy} noun="clips" /> : null}

      {editing ? (
        <EditModal
          clip={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            // The card shows the saved values before the sheet closes: reopening it at once (live
            // test, 25 Sep 2026) showed the old values while the list reloaded, and a second Save
            // undid the first.
            if (updated) replaceClip(updated);
            setEditing(null);
            after("Saved.");
          }}
        />
      ) : null}
      {musicFor ? (
        <MusicModal
          clip={musicFor}
          onClose={() => setMusicFor(null)}
          onQueued={(updated) => {
            if (updated) replaceClip(updated);
            setMusicFor(null);
            toast.ok("Changing the music, about a minute. The current version stays until it's ready.");
            list.reload();
          }}
        />
      ) : null}
      {voiceFor ? (
        <VoiceOverModal
          clip={voiceFor}
          onClose={() => setVoiceFor(null)}
          onQueued={(updated) => {
            if (updated) replaceClip(updated);
            setVoiceFor(null);
            toast.ok("Making the voice over in your voice, a few minutes. It plays here when it's in.");
            list.reload();
          }}
        />
      ) : null}
      {handoff ? (
        <HandoffModal
          clip={handoff}
          onClose={() => setHandoff(null)}
          onReplaced={(updated) => {
            if (updated) replaceClip(updated);
            setHandoff(null);
            list.reload();
          }}
        />
      ) : null}
      {restyling ? (
        <LookModal
          clip={restyling}
          onClose={() => setRestyling(null)}
          onQueued={(updated) => {
            if (updated) replaceClip(updated);
            setRestyling(null);
            toast.ok("Re-rendering, about a minute. The current version stays until the new one is ready.");
            list.reload();
          }}
        />
      ) : null}
      <HelpButton guide="review-and-approve-clips" />
    </div>
  );
}

function ClipCard(props: {
  clip: ReviewClip;
  tab: Tab;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRestore: () => void;
  onEdit: () => void;
  onRestyle: () => void;
  onHandoff: () => void;
  onMusic: () => void;
  onAnother: () => void;
  onVoiceRedo: () => void;
  onVoiceAdd: () => void;
  onVoiceRemove: () => void;
  onDelete: () => void;
  onPlatform: (p: Platform) => void;
  onFullChanged: (u: unknown) => void;
  onKeep?: () => void;
}) {
  const { clip: c, tab, busy } = props;
  const seconds = c.end_s - c.start_s;
  if (c.full_video) return <FullVideoCardShell {...props} />;
  return (
    <article className={`clip-card${props.selected ? " selected" : ""}${c.hidden ? " is-hidden" : ""}`} data-clip-id={c.id} aria-label={`Clip: ${c.hook_text}`}>
      <div className="clip-media">
        {c.media_url ? (
          <video src={c.media_url} poster={c.cover_url ?? undefined} controls playsInline preload="none" aria-label="Play this clip" />
        ) : c.file_cleared && c.cover_url ? (
          <div className="clip-cleared">
            <img src={c.cover_url} alt="" loading="lazy" />
            <span className="clip-cleared-note">Posted. The video file was cleared 30 days after posting to save space; its numbers stay on Stats.</span>
          </div>
        ) : (
          <div className="clip-gone">{c.file_cleared ? "Posted. The video file was cleared 30 days after posting to save space." : "File removed"}</div>
        )}
        <label className="clip-select">
          <input type="checkbox" checked={props.selected} onChange={props.onSelect} aria-label="Select this clip" />
        </label>
      </div>
      <div className="clip-body">
        <div className="clip-meta">
          <span className="nums">{fmtSeconds(seconds)}</span>
          <span>· Score {Math.round(c.score * 100)}</span>
          <span className="pill">{RECIPES[c.recipe]?.label ?? c.recipe}</span>
          {c.door === "recycle" ? <span className="pill">Recycled</span> : null}
          {c.hidden ? <span className="pill warn">Under the quality bar</span> : null}
          {c.clears_on ? (
            <span className="pill warn" data-clears-on>
              Cleared {fmtDate(c.clears_on)} unless you approve or keep it
            </span>
          ) : null}
          {c.clears_on && props.onKeep ? (
            <button type="button" className="btn quiet small" disabled={busy} onClick={props.onKeep}>
              Keep
            </button>
          ) : null}
          {c.paid_partnership ? <span className="pill ok">Paid partnership</span> : null}
          {c.voice_over === "ready" ? (
            <span className="pill ok" data-voice-over="ready">
              With your voice over{c.voice_auto ? " · added automatically" : ""} · AI-labelled when it posts
            </span>
          ) : null}
          {c.voice_over === "mixing" ? <span className="pill" data-voice-over="mixing">Adding your voice over…</span> : null}
          {c.voice_over === "failed" ? <span className="pill warn" data-voice-over="failed">Voice over not added · tap Redo to try again</span> : null}
        </div>
        {tab !== "rejected" ? (
          <div className="clip-voice" role="group" aria-label="Voice over">
            {c.voice_over ? (
              <>
                <button className="btn quiet small" disabled={busy || c.voice_over === "mixing"} onClick={props.onVoiceRemove}>
                  Remove voice over
                </button>
                <button className="btn quiet small" disabled={busy || c.voice_over === "mixing"} onClick={props.onVoiceRedo}>
                  Redo voice over
                </button>
              </>
            ) : (
              <button className="btn quiet small" disabled={busy || !!c.pending_look || !!c.editing_note} onClick={props.onVoiceAdd}>
                Add voice over
              </button>
            )}
          </div>
        ) : null}
        <div className="clip-look">
          {c.look_name ? (
            <span className="pill look-chip" data-look={c.look ?? undefined}>
              Look: {c.look_name}
            </span>
          ) : null}
          {c.edited_with_name ? (
            <span className="pill look-chip" data-edited-with={c.edited_with ?? undefined}>
              Edited in {c.edited_with_name}
            </span>
          ) : null}
          {c.editing_note ? (
            <span className="pill warn look-pending" role="status">
              {c.editing_note}
            </span>
          ) : null}
          {c.pending_look ? (
            <span className="pill warn look-pending" role="status">
              Re-rendering as {c.pending_look_name ?? "a new look"}, about a minute
            </span>
          ) : null}
        </div>
        {c.rerender_error ? <p className="hint look-error">{c.rerender_error}</p> : null}
        <div className="clip-hook">{c.hook_text}</div>
        {c.caption ? <p className="clip-caption">{c.caption}</p> : null}
        {c.hashtags ? <p className="clip-tags hint">{c.hashtags}</p> : null}
        <div className="clip-platforms" role="group" aria-label="Goes to">
          {PLATFORMS.map((p) => (
            <button key={p} type="button" className={`plat${c.platforms.includes(p) ? " on" : ""}`} aria-pressed={c.platforms.includes(p)} aria-label={`Post to ${SHORT[p]}`} disabled={tab === "rejected"} onClick={() => props.onPlatform(p)}>
              {SHORT[p]}
            </button>
          ))}
        </div>
        {tab === "rejected" ? (
          <p className="hint">
            {c.reject_reason ? `Reason: ${c.reject_reason}. ` : ""}
            {c.purge_at ? `Removed for good on ${fmtDate(c.purge_at)}.` : ""}
          </p>
        ) : null}
        <div className="clip-actions">
          {tab === "new" ? (
            <>
              <button className="btn quiet" disabled={busy} onClick={props.onReject}>
                Reject
              </button>
              <button className="btn" disabled={busy} onClick={props.onApprove}>
                Approve
              </button>
            </>
          ) : tab === "approved" ? (
            <>
              <button className="btn quiet" disabled={busy} onClick={props.onRestore}>
                Back to New
              </button>
              <button className="btn quiet" disabled={busy} onClick={props.onReject}>
                Reject
              </button>
            </>
          ) : (
            <>
              <button className="btn quiet" disabled={busy} onClick={props.onRestore}>
                Back to New
              </button>
              <button className="btn" disabled={busy} onClick={props.onApprove}>
                Approve
              </button>
            </>
          )}
        </div>
        <div className="clip-links">
          {tab !== "rejected" ? (
            <button className="link-btn" onClick={props.onEdit}>
              Edit caption & hook
            </button>
          ) : null}
          {tab !== "rejected" ? (
            <button className="link-btn" onClick={props.onRestyle} disabled={!!c.pending_look || !!c.editing_note}>
              Change look
            </button>
          ) : null}
          {tab !== "rejected" ? (
            <button className="link-btn" onClick={props.onAnother} disabled={busy || !!c.pending_look || !!c.editing_note || !c.source_available}>
              Try another version
            </button>
          ) : null}
          {tab !== "rejected" ? (
            <button className="link-btn" onClick={props.onMusic} disabled={!!c.pending_look || !!c.editing_note || !c.source_available}>
              Change music
            </button>
          ) : null}
          {tab !== "rejected" ? (
            <button className="link-btn" onClick={props.onHandoff} disabled={!!c.pending_look || !!c.editing_note}>
              Edit in CapCut
            </button>
          ) : null}
          <button className="link-btn danger-text" onClick={props.onDelete}>
            Delete this clip
          </button>
        </div>
      </div>
    </article>
  );
}

/** A full video for YouTube: 16:9 player, its YouTube details, Approve / Reject / Delete. */
function FullVideoCardShell(props: Parameters<typeof ClipCard>[0]) {
  const { clip: c, tab, busy } = props;
  const v = c.full_video!;
  return (
    <article className={`clip-card full${props.selected ? " selected" : ""}`} data-clip-id={c.id} aria-label={`Full video: ${v.title}`}>
      <div className="clip-media wide" style={v.width && v.height ? { aspectRatio: `${v.width} / ${v.height}` } : undefined}>
        {c.media_url && !v.file_deleted ? <video src={c.media_url} poster={v.thumbnails[v.thumb_pick]?.url || undefined} controls playsInline preload="none" aria-label="Play this video" /> : <div className="clip-gone">File removed</div>}
        <label className="clip-select">
          <input type="checkbox" checked={props.selected} onChange={props.onSelect} aria-label="Select this video" />
        </label>
      </div>
      <div className="clip-body">
        <FullVideoBody clip={c} tab={tab} busy={busy} onChanged={props.onFullChanged} />
        <div className="clip-actions">
          {tab === "new" ? (
            <>
              <button className="btn quiet" disabled={busy} onClick={props.onReject}>
                Reject
              </button>
              <button className="btn" disabled={busy} onClick={props.onApprove}>
                Approve
              </button>
            </>
          ) : (
            <>
              <button className="btn quiet" disabled={busy || v.post?.status === "posted"} onClick={props.onRestore}>
                Back to New
              </button>
              {tab === "approved" ? (
                <button className="btn quiet" disabled={busy || v.post?.status === "posted"} onClick={props.onReject}>
                  Reject
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={props.onApprove}>
                  Approve
                </button>
              )}
            </>
          )}
        </div>
        <div className="clip-links">
          <button className="link-btn danger-text" onClick={props.onDelete}>
            Delete this video
          </button>
        </div>
      </div>
    </article>
  );
}

function RejectModal({ count, onPick, onClose }: { count: number; onPick: (reason: string | null) => void; onClose: () => void }) {
  return (
    <Modal title={count === 1 ? "Why reject this one?" : `Why reject these ${count}?`} onClose={onClose}>
      <p className="hint">Tap a reason. It teaches the cutter what you don’t like.</p>
      <div className="reason-list">
        {REJECT_REASONS.map((r) => (
          <button key={r} className="btn quiet block" onClick={() => onPick(r)}>
            {sentence(r)}
          </button>
        ))}
      </div>
      <div className="btn-row">
        <button className="btn quiet small" onClick={() => onPick(null)}>
          Reject without a reason
        </button>
        <button className="btn quiet small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function EditModal({ clip, onSaved, onClose }: { clip: ReviewClip; onSaved: (updated: ReviewClip | null) => void; onClose: () => void }) {
  const toast = useToast();
  const [hook, setHook] = useState(clip.hook_text);
  const [hookAlt, setHookAlt] = useState(clip.hook_alt);
  const [caption, setCaption] = useState(clip.caption.replace(/(\s*#ad\b)+\s*$/i, ""));
  const [hashtags, setHashtags] = useState(clip.hashtags);
  const [platforms, setPlatforms] = useState<Platform[]>(clip.platforms);
  const [paid, setPaid] = useState(clip.paid_partnership);
  const [saving, setSaving] = useState(false);

  function swap() {
    if (!hookAlt) return;
    const old = hook;
    setHook(hookAlt);
    setHookAlt(old);
  }

  async function save() {
    if (!hook.trim()) {
      toast.bad(new Error("The on-screen hook can’t be empty."));
      return;
    }
    if (!platforms.length) {
      toast.bad(new Error("Leave at least one platform ticked, or reject the clip instead."));
      return;
    }
    setSaving(true);
    try {
      const swapped = hookAlt !== clip.hook_alt && hook === clip.hook_alt;
      const updated = await patch<ReviewClip | { ok: true }>(`/api/clips/${clip.id}`, swapped ? { swap_hook: true, caption, hashtags, platforms, paid_partnership: paid } : { hook_text: hook, caption, hashtags, platforms, paid_partnership: paid });
      onSaved("id" in updated ? updated : null);
    } catch (e) {
      toast.bad(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit this clip" onClose={onClose}>
      <div className="field">
        <label htmlFor="e-hook">On-screen hook</label>
        <input id="e-hook" className="input" value={hook} maxLength={200} onChange={(e) => setHook(e.target.value)} />
        {hookAlt ? (
          <div className="hook-alt">
            <span className="hint">Other hook: “{hookAlt}”</span>
            <button type="button" className="btn quiet small" onClick={swap} aria-label={`Use the other hook: “${hookAlt}”`}>
              Use the other hook
            </button>
          </div>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="e-caption">Caption</label>
        <textarea id="e-caption" className="textarea" rows={4} maxLength={2190} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="e-tags">Hashtags</label>
        <input id="e-tags" className="input" value={hashtags} maxLength={500} onChange={(e) => setHashtags(e.target.value)} placeholder="#morning #realtalk" />
      </div>
      <fieldset className="field edit-platforms">
        <legend className="label">Goes to</legend>
        {PLATFORMS.map((p) => (
          <label key={p} className="check">
            <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms((xs) => (e.target.checked ? PLATFORMS.filter((x) => x === p || xs.includes(x)) : xs.filter((x) => x !== p)))} />
            {PLATFORM_LABEL[p]}
          </label>
        ))}
      </fieldset>
      <Switch checked={paid} onChange={setPaid} label="Paid partnership" hint="Adds #ad to the end of the caption. When it posts, also switch on the app’s own paid-partnership label." />
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

/** Change music: no music, or one of her songs; the clip keeps its look. */
function MusicModal({ clip, onClose, onQueued }: { clip: ReviewClip; onClose: () => void; onQueued: (updated: ReviewClip | null) => void }) {
  const toast = useToast();
  const songs = useLoad(() => get<{ music: { id: string; file_name: string }[] }>("/api/editing"));
  const [busy, setBusy] = useState(false);
  async function pick(music: string) {
    setBusy(true);
    try {
      const r = await post<{ clip: ReviewClip | null }>(`/api/clips/${clip.id}/music`, { music });
      onQueued(r.clip);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  const list = songs.data?.music ?? [];
  return (
    <Modal title="Change music" onClose={onClose}>
      <p className="hint">Just this clip is made again with the music you pick, in about a minute. Only songs you added under Settings → Editing → My music are used.</p>
      <div className="reason-list">
        <button className="btn quiet block" disabled={busy} aria-pressed={!clip.music_id} onClick={() => pick("none")}>
          No music{!clip.music_id ? " (now)" : ""}
        </button>
        {list.map((t) => (
          <button key={t.id} className="btn quiet block" disabled={busy} aria-pressed={clip.music_id === t.id} onClick={() => pick(t.id)}>
            {t.file_name}
            {clip.music_id === t.id ? " (now)" : ""}
          </button>
        ))}
      </div>
      {!songs.loading && !list.length ? <p className="hint">No songs yet. Add one under Settings → Editing → My music.</p> : null}
      <div className="btn-row">
        <button className="btn quiet" onClick={onClose}>
          Keep it as it is
        </button>
      </div>
    </Modal>
  );
}

/** Redo a voice over: her words in a box (the script we wrote, or the one she wrote last), voiced and mixed again. */
function VoiceOverModal({ clip, onClose, onQueued }: { clip: ReviewClip; onClose: () => void; onQueued: (updated: ReviewClip | null) => void }) {
  const toast = useToast();
  const adding = !clip.voice_over;
  const [script, setScript] = useState(clip.voice_script ?? "");
  const [busy, setBusy] = useState(false);
  // Add voice over: a script to start from (the free AI, fitted to the clip), and whether her voice is saved.
  const draft = useLoad(() => (adding ? post<{ script: string; has_voice: boolean }>(`/api/clips/${clip.id}/voice-over/draft`) : Promise.resolve(null)), [clip.id]);
  useEffect(() => {
    if (draft.data?.script) setScript((s) => s || draft.data!.script);
  }, [draft.data]);
  const seconds = clip.end_s - clip.start_s;
  const most = maxWords(seconds);
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  async function save() {
    setBusy(true);
    try {
      const r = await post<{ clip: ReviewClip | null }>(`/api/clips/${clip.id}/voice-over`, { script });
      onQueued(r.clip);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Edit the script" onClose={onClose}>
      {draft.data && !draft.data.has_voice ? (
        <p className="hint" data-auto-voice="needs_voice">
          <a href="/voice#voice-steps">Record your voice first</a>, then come back: the script below is kept only while this box is open.
        </p>
      ) : null}
      <p className="hint">
        {adding ? "A voice over in your voice, mixed into just this clip. Change the words as you like." : "Change the words and we make the voice over again in your voice, then put it back on this clip."} The clip is {Math.round(seconds)} seconds, room for about {most} words. It is labelled as AI audio when it posts.
      </p>
      <div className="field">
        <label htmlFor="v-script">Voice over script</label>
        <textarea id="v-script" className="textarea" rows={5} maxLength={1200} value={script} onChange={(e) => setScript(e.target.value)} />
        <span className={`hint${words > most ? " look-error" : ""}`} data-word-count>
          {words} of about {most} words
        </span>
      </div>
      <div className="btn-row">
        <button className="btn" data-primary disabled={busy || words === 0} onClick={save}>
          {busy ? "Starting…" : adding ? "Voice it and mix it in" : "Re-voice and re-mix"}
        </button>
        <button className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
