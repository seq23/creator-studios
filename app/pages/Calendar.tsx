// Calendar (section 10): week view (default) and month view of every planned, queued, posted
// and failed post; drag to move on desktop, "Move to…" on phone; take a post off; swap two;
// "Fill the calendar" plans the next weeks from approved clips right now (the hourly run
// keeps 4 weeks filled on its own). Times are the audience's local time.
import { useMemo, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import type { ClipRow, PostRow, SettingsShape } from "@shared/types";
import { get, patch, post } from "../lib/api";
import { plural } from "../lib/format";
import { Empty, HelpButton, Modal, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { PLATFORMS, PLATFORM_LABEL, RECIPES, type Platform } from "@shared/constants";
import { Icon } from "../components/Icon";
import { CalendarHistory } from "../components/CalendarHistory";
import "../styles/calendar.css";

type PoolClip = Pick<ClipRow, "id" | "hook_text" | "cover_url" | "recipe" | "door" | "platforms" | "score">;
type View = "week" | "month";

const SHORT: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };
const STATUS_TEXT: Record<PostRow["status"], string> = { planned: "Planned", in_buffer: "In Buffer", posted: "Posted", failed: "Failed", unscheduled: "Off" };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- dates as YYYY-MM-DD strings in the audience time zone
function ymdIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function toUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(ymd: string, n: number): string {
  const d = toUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(ymd: string): string {
  return addDays(ymd, -((toUtcDate(ymd).getUTCDay() + 6) % 7));
}
function dayLabel(ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
  return toUtcDate(ymd).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}
function timeIn(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
}

/** The approved-not-scheduled list shows this many, then "Show all (N)" (day 358: 92 clips was 10 phone screens). */
const POOL_SHOWN = 8;

export function Calendar() {
  const [poolAll, setPoolAll] = useState(false);
  const toast = useToast();
  const settings = useLoad(() => get<SettingsShape>("/api/settings"));
  const tz = settings.data?.audience_timezone ?? "America/New_York";
  const today = ymdIn(new Date(), tz);
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<string | null>(null); // a day inside the shown week/month
  const at = anchor ?? today;

  // Visible days
  const days = useMemo(() => {
    if (view === "week") {
      const mon = mondayOf(at);
      return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    }
    const first = `${at.slice(0, 8)}01`;
    const start = mondayOf(first);
    const nextMonth = toUtcDate(first);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const last = addDays(nextMonth.toISOString().slice(0, 10), -1);
    const end = addDays(mondayOf(last), 6);
    const out: string[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [view, at]);

  // Fetch a little wider than the local days (time-zone edges), then group by local date.
  const from = `${addDays(days[0], -1)}T00:00:00.000Z`;
  const to = `${addDays(days[days.length - 1], 2)}T00:00:00.000Z`;
  const posts = useLoad(() => get<PostRow[]>(`/api/posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), [from, to]);
  const pool = useLoad(() => get<PoolClip[]>("/api/posts/pool"));
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<PostRow | null>(null);
  const [adding, setAdding] = useState<{ clip: PoolClip; day: string } | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, PostRow[]>();
    for (const p of posts.data ?? []) {
      const d = ymdIn(new Date(p.scheduled_at), tz);
      m.set(d, [...(m.get(d) ?? []), p]);
    }
    return m;
  }, [posts.data, tz]);

  function reload() {
    posts.reload();
    pool.reload();
  }

  async function fill() {
    setBusy(true);
    try {
      const r = await post<{ added: number; perPlatform: Record<Platform, number> }>("/api/posts/plan", {});
      toast.ok(r.added ? `Added ${plural(r.added, "post")} to the calendar.` : "The calendar is already full for the next 4 weeks.");
      reload();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  async function move(p: PostRow, date: string) {
    try {
      await patch(`/api/posts/${p.id}`, { date });
      toast.ok(`Moved to ${dayLabel(date)}.`);
      setActing(null);
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  function onDrop(e: DragEvent, day: string) {
    e.preventDefault();
    e.currentTarget.classList.remove("over");
    const postId = e.dataTransfer.getData("text/x-post");
    const clipId = e.dataTransfer.getData("text/x-clip");
    if (postId) {
      const p = posts.data?.find((x) => x.id === postId);
      if (p && ymdIn(new Date(p.scheduled_at), tz) !== day) void move(p, day);
    } else if (clipId) {
      const c = pool.data?.find((x) => x.id === clipId);
      if (c) setAdding({ clip: c, day });
    }
  }

  const head = (
    <PageHead title="Calendar" lede="Approved clips go out at the best times. Tap a post to move it, swap it or take it off.">
      <button className="btn" data-primary onClick={fill} disabled={busy}>
        {busy ? "Filling…" : "Fill the calendar"}
      </button>
    </PageHead>
  );

  // The page head shows at once; the week holds its shape until the settings arrive.
  if (!settings.data)
    return (
      <div className="page cal">
        {head}
        <Skeleton lines={2} />
        <div className="cal-week" aria-busy="true" aria-label="Loading">
          {DAY_NAMES.map((n) => (
            <div key={n} className="skeleton skeleton-block cal-day-skel" />
          ))}
        </div>
        <HelpButton guide="move-or-remove-a-post" />
      </div>
    );
  const caps = settings.data.weekly_caps;

  // Caps line for the week being shown (week view) or the week containing the anchor (month view).
  const weekDays = new Set(Array.from({ length: 7 }, (_, i) => addDays(mondayOf(at), i)));
  const weekCount = (p: Platform) => (posts.data ?? []).filter((x) => x.platform === p && weekDays.has(ymdIn(new Date(x.scheduled_at), tz))).length;
  const inView = (posts.data ?? []).filter((p) => days.includes(ymdIn(new Date(p.scheduled_at), tz)));
  const noClips = posts.data && pool.data && posts.data.length === 0 && pool.data.length === 0;

  const title = view === "week" ? `${dayLabel(days[0], { day: "numeric", month: "short" })} – ${dayLabel(days[6], { day: "numeric", month: "short" })}` : dayLabel(at, { month: "long", year: "numeric" });
  const step = (dir: number) => setAnchor(view === "week" ? addDays(at, 7 * dir) : (() => { const d = toUtcDate(`${at.slice(0, 8)}01`); d.setUTCMonth(d.getUTCMonth() + dir); return d.toISOString().slice(0, 10); })());

  return (
    <div className="page cal">
      {head}

      <div className="cal-bar">
        <div className="row">
          <button className="icon-btn" aria-label={view === "week" ? "Previous week" : "Previous month"} onClick={() => step(-1)}>
            <Icon name="left" />
          </button>
          <strong className="cal-title">{title}</strong>
          <button className="icon-btn" aria-label={view === "week" ? "Next week" : "Next month"} onClick={() => step(1)}>
            <Icon name="right" />
          </button>
          {anchor && anchor !== today ? (
            <button className="btn quiet small" onClick={() => setAnchor(null)}>
              Today
            </button>
          ) : null}
        </div>
        <div className="cal-toggle" role="group" aria-label="View">
          <button className={view === "week" ? "on" : ""} aria-pressed={view === "week"} onClick={() => setView("week")}>
            Week
          </button>
          <button className={view === "month" ? "on" : ""} aria-pressed={view === "month"} onClick={() => setView("month")}>
            Month
          </button>
        </div>
      </div>

      <div className="cal-caps" aria-label="Posts this week per platform">
        {PLATFORMS.map((p) => {
          const n = weekCount(p);
          return (
            <span key={p} className={`cal-cap${n > caps[p] ? " over" : ""}`}>
              <span className={`cal-dot ${p}`} aria-hidden="true" />
              {SHORT[p]} <span className="nums">{n} / {caps[p]}</span>
            </span>
          );
        })}
        <span className="hint">
          cap {settings.data.hard_cap_per_channel} per channel · times in your audience’s time zone ({tz})
        </span>
      </div>

      {noClips ? (
        <Empty title="No approved clips yet" cta={{ to: "/review", label: "Go to Review" }}>
          Approve some clips in Review and they fill the calendar at the best times, at most 10 per channel a week.
        </Empty>
      ) : null}

      <div className="cal-layout">
        {view === "week" ? (
          <div className="cal-week">
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              return (
                <section
                  key={d}
                  className={`cal-day${d === today ? " today" : ""}`}
                  aria-label={dayLabel(d, { weekday: "long", day: "numeric", month: "long" })}
                  data-day={d}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add("over");
                  }}
                  onDragLeave={(e) => e.currentTarget.classList.remove("over")}
                  onDrop={(e) => onDrop(e, d)}
                >
                  <h3 className="cal-day-name">{dayLabel(d)}</h3>
                  {!posts.data ? <div className="skeleton cal-post-skel" aria-hidden="true" /> : list.length === 0 ? <div className="cal-none">Nothing planned</div> : null}
                  {list.map((p) => (
                    <PostCard key={p.id} p={p} tz={tz} onOpen={() => setActing(p)} />
                  ))}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="cal-month" role="grid" aria-label={title}>
            {DAY_NAMES.map((n) => (
              <div key={n} className="cal-month-head" role="columnheader">
                {n}
              </div>
            ))}
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const outside = d.slice(0, 7) !== at.slice(0, 7);
              return (
                <button
                  key={d}
                  role="gridcell"
                  className={`cal-month-day${outside ? " outside" : ""}${d === today ? " today" : ""}`}
                  onClick={() => {
                    setAnchor(d);
                    setView("week");
                  }}
                  aria-label={`${dayLabel(d, { weekday: "long", day: "numeric", month: "long" })}: ${plural(list.length, "post")}. Open this week.`}
                >
                  <span className="num">{Number(d.slice(8))}</span>
                  {list.slice(0, 3).map((p) => (
                    <span key={p.id} className={`cal-mini ${p.status}`}>
                      <span className={`cal-dot ${p.platform}`} aria-hidden="true" />
                      <span className="truncate">
                        {timeIn(p.scheduled_at, tz)} {SHORT[p.platform]}
                      </span>
                    </span>
                  ))}
                  {list.length > 3 ? <span className="cal-more">+{list.length - 3} more</span> : null}
                </button>
              );
            })}
          </div>
        )}

        <aside className="cal-pool card flat" aria-label="Approved, not scheduled">
          <h2>Approved, not scheduled</h2>
          <div className="hint">Drag onto a day, tap Add, or let Fill the calendar do it.</div>
          {pool.data && pool.data.length === 0 ? (
            <div className="hint">
              Every approved clip is on the calendar. <Link to="/review">Review new clips</Link>
            </div>
          ) : null}
          {(pool.data ?? []).slice(0, poolAll ? undefined : POOL_SHOWN).map((c) => (
            <div
              key={c.id}
              className="cal-pool-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/x-clip", c.id);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <div className="grow">
                <div className="title">{c.hook_text || "Untitled clip"}</div>
                <div className="meta">
                  {c.door === "recycle" ? "Recycled" : "New"} · {RECIPES[c.recipe]?.label ?? c.recipe}
                </div>
              </div>
              <button className="btn quiet small" onClick={() => setAdding({ clip: c, day: addDays(today, 1) })}>
                Add
              </button>
            </div>
          ))}
          {(pool.data?.length ?? 0) > POOL_SHOWN ? (
            <button type="button" className="link-btn" onClick={() => setPoolAll((v) => !v)} aria-expanded={poolAll}>
              {poolAll ? "Show fewer" : `Show all (${pool.data!.length})`}
            </button>
          ) : null}
        </aside>
      </div>

      <CalendarHistory onChanged={reload} />

      {inView.some((p) => p.status === "failed") ? (
        <div className="notice bad">
          A post did not go out. Tap it to try again, or <Link to="/help/a-post-failed">see how to fix it</Link>.
        </div>
      ) : null}

      {acting ? <PostActions p={acting} tz={tz} today={today} others={(posts.data ?? []).filter((x) => x.id !== acting.id && x.status !== "posted")} onClose={() => setActing(null)} onMove={move} onDone={() => { setActing(null); reload(); }} /> : null}
      {adding ? <AddClip clip={adding.clip} day={adding.day} today={today} tz={tz} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} /> : null}
      <HelpButton guide="move-or-remove-a-post" />
    </div>
  );
}

function PostCard({ p, tz, onOpen }: { p: PostRow; tz: string; onOpen: () => void }) {
  const movable = p.status !== "posted";
  return (
    <div
      className={`cal-post ${p.platform} ${p.status}`}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-post", p.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      data-post={p.id}
    >
      {/* a div, not a <button>: Firefox will not start a drag from inside a button */}
      <div
        className="cal-post-main"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " " ? (e.preventDefault(), onOpen()) : undefined)}
        aria-label={`${SHORT[p.platform]} at ${timeIn(p.scheduled_at, tz)}: ${p.hook_text || "clip"}. ${STATUS_TEXT[p.status]}. Open actions.`}
      >
        {p.cover_url ? <img src={p.cover_url} alt="" loading="lazy" /> : <span className="cal-cover" aria-hidden="true" />}
        <span className="cal-post-text">
          <span className="cal-post-top">
            <span className="cal-time">{timeIn(p.scheduled_at, tz)}</span>
            <span className="cal-plat">
              <span className={`cal-dot ${p.platform}`} aria-hidden="true" />
              {SHORT[p.platform]}
            </span>
          </span>
          <span className="cal-hook">{p.hook_text || "Untitled clip"}</span>
          <span className={`cal-status ${p.status}`}>
            {p.status === "posted" ? <Icon name="check" size="sm" /> : null}
            {STATUS_TEXT[p.status]}
          </span>
        </span>
      </div>
      {p.status === "failed" ? (
        <Link className="cal-fix" to="/help/a-post-failed">
          How to fix
        </Link>
      ) : null}
      {p.status === "posted" && p.url ? (
        <a className="cal-fix" href={p.url} target="_blank" rel="noreferrer">
          See it
        </a>
      ) : null}
    </div>
  );
}

function nextDays(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}

function PostActions({ p, tz, today, others, onClose, onMove, onDone }: { p: PostRow; tz: string; today: string; others: PostRow[]; onClose: () => void; onMove: (p: PostRow, d: string) => Promise<void>; onDone: () => void }) {
  const toast = useToast();
  const current = ymdIn(new Date(p.scheduled_at), tz);
  const [day, setDay] = useState(current >= today ? current : today);
  const [swapWith, setSwapWith] = useState("");
  const posted = p.status === "posted";

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.ok(ok);
      onDone();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <Modal title={`${PLATFORM_LABEL[p.platform]} · ${dayLabel(current)} ${timeIn(p.scheduled_at, tz)}`} onClose={onClose}>
      <p className="soft">“{p.hook_text || "Untitled clip"}” · {STATUS_TEXT[p.status]}</p>
      {p.error && p.status === "failed" ? <div className="notice bad">{p.error}</div> : null}
      {posted ? (
        <p className="hint">This one already went out, so it stays where it is.</p>
      ) : (
        <>
          {p.status === "failed" ? (
            <button className="btn" onClick={() => run(() => post(`/api/posts/${p.id}/retry`), "We’ll try that post again within the hour.")}>
              Try again
            </button>
          ) : null}
          <div className="field">
            <label htmlFor="move-day">Move to…</label>
            <div className="row wrap">
              <select id="move-day" className="select cal-select" value={day} onChange={(e) => setDay(e.target.value)}>
                {nextDays(today, 35).map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(d, { weekday: "long", day: "numeric", month: "short" })}
                    {d === current ? " (now)" : ""}
                  </option>
                ))}
              </select>
              <button className="btn dark" disabled={day === current} onClick={() => onMove(p, day)}>
                Move
              </button>
            </div>
            <div className="hint">Keeps the same time of day.</div>
          </div>
          {others.length ? (
            <div className="field">
              <label htmlFor="swap-with">Swap with…</label>
              <div className="row wrap">
                <select id="swap-with" className="select cal-select" value={swapWith} onChange={(e) => setSwapWith(e.target.value)}>
                  <option value="">Pick another post</option>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {dayLabel(ymdIn(new Date(o.scheduled_at), tz))} {timeIn(o.scheduled_at, tz)} · {SHORT[o.platform]} · {(o.hook_text || "clip").slice(0, 40)}
                    </option>
                  ))}
                </select>
                <button className="btn dark" disabled={!swapWith} onClick={() => run(() => post("/api/posts/swap", { a: p.id, b: swapWith }), "Swapped.")}>
                  Swap
                </button>
              </div>
            </div>
          ) : null}
          <button className="btn danger" onClick={() => run(() => post(`/api/posts/${p.id}/unschedule`), "Taken off. The clip is back in your approved pool.")}>
            Take off the calendar
          </button>
        </>
      )}
      <button className="btn quiet" onClick={onClose}>
        Close
      </button>
    </Modal>
  );
}

function AddClip({ clip, day, today, tz, onClose, onDone }: { clip: PoolClip; day: string; today: string; tz: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [platform, setPlatform] = useState<Platform>(clip.platforms[0] ?? "tiktok");
  const [d, setD] = useState(day < today ? today : day);
  const [time, setTime] = useState("18:00");

  async function add() {
    try {
      // Local wall-clock in the audience zone → UTC: find the offset for that day.
      const guess = new Date(`${d}T${time}:00Z`);
      const shown = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
      const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
      const at = new Date(guess.getTime() - (shown.getTime() - asUtc.getTime()));
      await post("/api/posts", { clip_id: clip.id, platform, scheduled_at: at.toISOString() });
      toast.ok(`Added for ${dayLabel(d)}.`);
      onDone();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <Modal title="Add to the calendar" onClose={onClose}>
      <p className="soft">“{clip.hook_text || "Untitled clip"}”</p>
      <div className="field">
        <label htmlFor="add-platform">Where</label>
        <select id="add-platform" className="select" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
          {clip.platforms.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="add-day">Day</label>
        <select id="add-day" className="select" value={d} onChange={(e) => setD(e.target.value)}>
          {nextDays(today, 35).map((x) => (
            <option key={x} value={x}>
              {dayLabel(x, { weekday: "long", day: "numeric", month: "short" })}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="add-time">Time</label>
        <input id="add-time" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={add}>
          Add
        </button>
        <button className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
