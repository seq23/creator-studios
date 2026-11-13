// Calendar (section 10; owner's rulings, 13 Nov 2026). The default view is ONE list of every
// upcoming post of every kind (reels AND photo posts), soonest first, each with its picture, its
// words, its day and where it goes; then what cannot go out yet (the plain reason and one button),
// what already went out (History, folded) and the Rejected bin. Week and month views are a tap
// away: drag to move on desktop, the sheet's "Move to another day" on phone. "Fill the calendar"
// plans the next weeks from approved clips right now (the hourly run keeps 4 weeks filled on its
// own) and answers with one of three true things (shared/posts.ts fillLine). The weekly limits are
// words, not a score. Times are the audience's local time.
import { useMemo, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import type { ClipRow, PostRow, SettingsShape } from "@shared/types";
import { get, patch, post } from "../lib/api";
import { plural } from "../lib/format";
import { Empty, HelpButton, Modal, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { comingLine, fillLine, limitLine, plainDay, plainTime, runsOutSoon, type FillResult, type PostItem, type PostsList } from "@shared/posts";
import { PostSheet } from "../components/PostSheet";
import { PLATFORMS, PLATFORM_LABEL, RECIPES, type Platform } from "@shared/constants";
import { Icon } from "../components/Icon";
import { CalendarHistory } from "../components/CalendarHistory";
import { ToFilm } from "../components/ToFilm";
import "../styles/calendar.css";

type PoolClip = Pick<ClipRow, "id" | "hook_text" | "cover_url" | "recipe" | "door" | "platforms" | "score"> & { clip_label?: string };
type View = "list" | "week" | "month";

const SHORT: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };
const STATUS_TEXT: Record<PostRow["status"], string> = { planned: "Planned", in_buffer: "Lined up", posted: "Posted", failed: "Failed", unscheduled: "Off" };
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

/** The list opens on this many days of posts; "Show the rest" brings the others (four weeks is 80 rows on a phone). */
const LIST_DAYS = 7;

/** The approved-not-scheduled list shows this many, then "Show all (N)" (day 358: 92 clips was 10 phone screens). */
const POOL_SHOWN = 8;

export function Calendar() {
  const [poolAll, setPoolAll] = useState(false);
  const toast = useToast();
  const settings = useLoad(() => get<SettingsShape>("/api/settings"));
  const tz = settings.data?.audience_timezone ?? "America/New_York";
  const today = ymdIn(new Date(), tz);
  const [view, setView] = useState<View>("list");
  const [anchor, setAnchor] = useState<string | null>(null); // a day inside the shown week/month
  const at = anchor ?? today;

  // Visible days
  const days = useMemo(() => {
    if (view !== "month") {
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
  const list = useLoad(() => get<PostsList>("/api/posts/upcoming"));
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState<FillResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [allDays, setAllDays] = useState(false);
  const [shownGroups, setShownGroups] = useState<Record<string, boolean>>({});
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
    list.reload();
  }

  async function fill() {
    setBusy(true);
    try {
      // One of three true answers, said on the page (never "full" when it is only out of approved posts).
      setFilled(await post<FillResult>("/api/posts/plan", {}));
      reload();
    } catch (e) {
      setFilled(null);
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  async function move(p: PostRow, date: string) {
    try {
      await patch(`/api/posts/${p.id}`, { date });
      toast.ok(`Moved to ${dayLabel(date)}.`);
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
    <PageHead title="Calendar" lede="Every post that is coming, soonest first. Open one to watch it, read it, move it or take it off.">
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

  // Limits for the week being shown (week view) or the week containing the anchor (month view); the list shows this week's.
  const weekDays = new Set(Array.from({ length: 7 }, (_, i) => addDays(mondayOf(at), i)));
  const weekCount = (p: Platform) => (posts.data ?? []).filter((x) => x.platform === p && weekDays.has(ymdIn(new Date(x.scheduled_at), tz))).length;
  const thisWeek = weekDays.has(today);
  const limits = view === "list" ? (list.data?.limits ?? []) : PLATFORMS.map((p) => ({ platform: p, label: SHORT[p], used: weekCount(p), cap: caps[p] }));
  const inView = (posts.data ?? []).filter((p) => days.includes(ymdIn(new Date(p.scheduled_at), tz)));
  const nothingAnywhere = !!list.data && list.data.posts.length === 0 && list.data.blocked.length === 0;
  const noClips = posts.data && pool.data && posts.data.length === 0 && pool.data.length === 0 && (view !== "list" || nothingAnywhere);

  const title = view === "month" ? dayLabel(at, { month: "long", year: "numeric" }) : `${dayLabel(days[0], { day: "numeric", month: "short" })} – ${dayLabel(days[6], { day: "numeric", month: "short" })}`;
  const step = (dir: number) => setAnchor(view === "week" ? addDays(at, 7 * dir) : (() => { const d = toUtcDate(`${at.slice(0, 8)}01`); d.setUTCMonth(d.getUTCMonth() + dir); return d.toISOString().slice(0, 10); })());

  // The list: every post that will go out, grouped by its day.
  const coming = list.data?.posts ?? [];
  const listDays: { day: string; posts: PostItem[] }[] = [];
  for (const p of coming) {
    const d = ymdIn(new Date(p.scheduled_at), tz);
    const last = listDays[listDays.length - 1];
    if (last?.day === d) last.posts.push(p);
    else listDays.push({ day: d, posts: [p] });
  }
  const shownDays = allDays ? listDays : listDays.slice(0, LIST_DAYS);
  const hiddenPosts = listDays.slice(shownDays.length).reduce((n, g) => n + g.posts.length, 0);
  // What a reel can trade places with: every other reel that has not gone out.
  const swappable = [...coming, ...(list.data?.blocked ?? []).flatMap((g) => g.posts)].filter((x) => x.source === "clip" && x.can.swap && x.id !== open);

  return (
    <div className="page cal">
      {head}

      {list.data ? (
        <p className="posts-line" data-posts-line>
          <strong>{comingLine(list.data.summary, tz)}</strong>
          {runsOutSoon(list.data.summary) ? (
            <Link className="posts-add" to="/dump">
              Add photos and videos ›
            </Link>
          ) : null}
        </p>
      ) : (
        <Skeleton lines={1} />
      )}

      {filled ? (
        <div className="notice ok" role="status" data-fill-state={filled.state}>
          {fillLine(filled, tz)}{" "}
          {filled.state === "nothing_left" ? <Link to="/dump">Add photos and videos to fill the rest ›</Link> : null}
        </div>
      ) : null}

      <div className="cal-bar">
        {view === "list" ? (
          <span className="hint">Times are in your audience’s time zone.</span>
        ) : (
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
        )}
        <div className="cal-toggle" role="group" aria-label="View">
          {(["list", "week", "month"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "list" ? "List" : v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>

      {/* Get it sponsored → "Add to my Calendar": the days she plans to film a video idea. Never a post. */}
      <ToFilm from={days[0]} to={days[days.length - 1]} />

      {noClips ? (
        <Empty title="No approved clips yet" cta={{ to: "/review", label: "Go to Review" }}>
          Approve some clips in Review and they fill the calendar at the best times, at most 10 per channel a week.
        </Empty>
      ) : null}

      <div className="cal-layout">
        {view === "list" ? (
          <div className="posts-list" aria-label="Posts coming" data-posts-list>
            {!list.data ? <Skeleton blocks={3} /> : null}
            {list.data && coming.length === 0 && !noClips ? <p className="soft">Nothing is planned to go out. Tap Fill the calendar, or add photos and videos.</p> : null}
            {shownDays.map((g) => (
              <section key={g.day} className="posts-day" data-day={g.day} aria-label={plainDay(`${g.day}T12:00:00Z`, "UTC")}>
                <h3 className="posts-day-name">{g.day === today ? `Today, ${plainDay(`${g.day}T12:00:00Z`, "UTC")}` : plainDay(`${g.day}T12:00:00Z`, "UTC")}</h3>
                {g.posts.map((p) => (
                  <PostListRow key={p.id} p={p} tz={tz} onOpen={() => setOpen(p.id)} />
                ))}
              </section>
            ))}
            {hiddenPosts > 0 || (allDays && listDays.length > LIST_DAYS) ? (
              <button type="button" className="link-btn" aria-expanded={allDays} onClick={() => setAllDays((v) => !v)}>
                {allDays ? "Show fewer ▴" : `+ ${plural(hiddenPosts, "more post")} after that ▾`}
              </button>
            ) : null}

            {(list.data?.blocked ?? []).map((g) => {
              // A few posts show at once; a long group folds behind its count. A post that did not go out always shows.
              const shown = shownGroups[g.key] ?? (g.key === "failed" || g.posts.length <= 3);
              return (
                <section key={g.key} className="posts-group" data-blocked={g.key} aria-label={g.label}>
                  <div className="posts-group-head">
                    <strong>
                      {g.label} ({g.posts.length})
                    </strong>
                    {g.action ? (
                      <Link className="btn small quiet" to={g.action.to}>
                        {g.action.label}
                      </Link>
                    ) : null}
                  </div>
                  <p className="hint">{g.posts[0].reason}</p>
                  {g.key !== "failed" && g.posts.length > 3 ? (
                    <button type="button" className="link-btn" aria-expanded={shown} onClick={() => setShownGroups((m) => ({ ...m, [g.key]: !shown }))}>
                      {shown ? "Hide them ▴" : "Show them ▾"}
                    </button>
                  ) : null}
                  {shown ? g.posts.map((p) => <PostListRow key={p.id} p={p} tz={tz} withDay onOpen={() => setOpen(p.id)} />) : null}
                </section>
              );
            })}
          </div>
        ) : view === "week" ? (
          <div className="cal-week">
            {days.map((d) => {
              const dayPosts = byDay.get(d) ?? [];
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
                  {!posts.data ? <div className="skeleton cal-post-skel" aria-hidden="true" /> : dayPosts.length === 0 ? <div className="cal-none">Nothing planned</div> : null}
                  {dayPosts.map((p) => (
                    <PostCard key={p.id} p={p} tz={tz} onOpen={() => setOpen(p.id)} />
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
              const dayPosts = byDay.get(d) ?? [];
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
                  aria-label={`${dayLabel(d, { weekday: "long", day: "numeric", month: "long" })}: ${plural(dayPosts.length, "post")}. Open this week.`}
                >
                  <span className="num">{Number(d.slice(8))}</span>
                  {dayPosts.slice(0, 3).map((p) => (
                    <span key={p.id} className={`cal-mini ${p.status}`}>
                      <span className={`cal-dot ${p.platform}`} aria-hidden="true" />
                      <span className="truncate">
                        {timeIn(p.scheduled_at, tz)} {SHORT[p.platform]}
                      </span>
                    </span>
                  ))}
                  {dayPosts.length > 3 ? <span className="cal-more">+{dayPosts.length - 3} more</span> : null}
                </button>
              );
            })}
          </div>
        )}

        <aside className="cal-pool card flat" aria-label="Approved, not scheduled">
          <h2>Approved, not scheduled</h2>
          <div className="hint">{view === "week" ? "Drag onto a day, tap Add, or let Fill the calendar do it." : "Tap Add, or let Fill the calendar do it."}</div>
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
                  {c.clip_label ? <span data-clip-label>{c.clip_label} · </span> : null}
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

      {/* The weekly limits, in words (13 Nov 2026: "10 / 10" at the top read as a score). */}
      <ul className="cal-caps" aria-label={thisWeek || view === "list" ? "This week’s limits" : "That week’s limits"}>
        {limits.map((l) => (
          <li key={l.platform} className={`cal-cap${l.used > l.cap ? " over" : ""}`}>
            <span className={`cal-dot ${l.platform}`} aria-hidden="true" />
            {limitLine(l, thisWeek || view === "list" ? "this" : "that")}
          </li>
        ))}
        <li className="hint">
          A limit is the most that goes out in a week, never a target. Change it in <Link to="/settings">Settings</Link>.
        </li>
      </ul>

      <details className="posts-fold" data-history-fold>
        <summary>Already posted{list.data ? ` (${list.data.summary.postedThisWeek} this week)` : ""} ▾</summary>
        <CalendarHistory onChanged={reload} />
      </details>

      <p className="posts-bin-link">
        <Link className="btn quiet" to="/calendar/bin" data-bin-link>
          Rejected bin ({list.data?.bin ?? 0}) ›
        </Link>
      </p>

      {inView.some((p) => p.status === "failed") && view !== "list" ? (
        <div className="notice bad">
          A post did not go out. Tap it to try again, or <Link to="/help/a-post-failed">see how to fix it</Link>.
        </div>
      ) : null}

      {open ? <PostSheet id={open} tz={tz} today={today} others={swappable} onClose={() => setOpen(null)} onChanged={reload} /> : null}
      {adding ? <AddClip clip={adding.clip} day={adding.day} today={today} tz={tz} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} /> : null}
      <HelpButton guide="move-or-remove-a-post" />
    </div>
  );
}

/** One post in the list: its picture, what it is in plain words, when and where, its words, and Open. */
function PostListRow({ p, tz, withDay, onOpen }: { p: PostItem; tz: string; withDay?: boolean; onOpen: () => void }) {
  return (
    <div className={`post-row ${p.state}`} data-post={p.id} data-kind={p.kind}>
      {p.thumb_url ? <img className="post-thumb" src={p.thumb_url} alt="" loading="lazy" /> : <span className="post-thumb post-thumb-none" aria-hidden="true">{p.video_url || p.source === "clip" ? "▶" : "▣"}</span>}
      <div className="grow post-row-text">
        <div className="post-row-top">
          <span className="post-chip">{p.kind_label}</span>
          <span className="hint">
            {withDay ? `${plainDay(p.scheduled_at, tz)}, ` : ""}
            {plainTime(p.scheduled_at, tz)} · {p.platform_label}
          </span>
        </div>
        <div className="post-row-headline">{p.headline}</div>
        {p.caption_line && p.caption_line !== p.headline ? <div className="hint post-row-caption">{p.caption_line}</div> : null}
      </div>
      <button type="button" className="btn quiet small post-open" onClick={onOpen} aria-label={`Open the ${p.kind_label} for ${p.platform_label}: ${p.headline}`}>
        Open ›
      </button>
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
        aria-label={`${SHORT[p.platform]} at ${timeIn(p.scheduled_at, tz)}: ${p.hook_text || "clip"}. ${STATUS_TEXT[p.status]}. Open it.`}
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
          <span className="cal-hook">
            {p.clip_label ? <span className="cal-num" data-clip-label>{p.clip_label.replace(/^.* · /, "")} · </span> : null}
            {p.hook_text || "Untitled clip"}
          </span>
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
