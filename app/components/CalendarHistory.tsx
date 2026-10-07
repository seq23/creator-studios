// Calendar → History (day 358, docs/reviews/2026-09-26-day-358.md): everything that already
// happened, newest first, a page at a time with true counts. Filter by what happened and by
// platform, search the hook. A failed post: Try again (goes out within the hour) or Let go.
import { useEffect, useState } from "react";
import type { PostRow } from "@shared/types";
import { PLATFORMS, type Platform } from "@shared/constants";
import { get, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { MoreRow, SearchBox, useToast } from "./ui";

type HistoryRow = PostRow & { posted_at: string | null; file_cleared: boolean };
interface History {
  items: HistoryRow[];
  total: number;
  counts: { posted: number; failed: number; unscheduled: number };
}

const SHORT: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };
const STATUS_WORDS: Record<string, string> = { posted: "Posted", failed: "Didn't go out", unscheduled: "Taken off" };

export function CalendarHistory({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<"all" | "posted" | "failed" | "unscheduled">("all");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = (offset: number) => new URLSearchParams({ status, offset: String(offset), ...(platform ? { platform } : {}), ...(search ? { q: search } : {}) }).toString();
  useEffect(() => {
    let live = true;
    get<History>(`/api/posts/history?${params(0)}`).then((d) => live && setData(d), (e) => toast.bad(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, platform, search, tick]);

  async function more() {
    if (!data) return;
    setBusy(true);
    try {
      const next = await get<History>(`/api/posts/history?${params(data.items.length)}`);
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  async function act(p: HistoryRow, what: "retry" | "unschedule") {
    try {
      await post(`/api/posts/${p.id}/${what}`);
      toast.ok(what === "retry" ? "We’ll try that post again within the hour." : "Let go. The clip is back in your approved clips.");
      setTick((n) => n + 1);
      onChanged();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <section className="section cal-history" aria-label="History">
      <div className="section-head">
        <h2>History</h2>
        {data ? (
          <span className="hint nums">
            {data.counts.posted} posted · {data.counts.failed} didn’t go out · {data.counts.unscheduled} taken off
          </span>
        ) : null}
      </div>
      <div className="list-tools">
        <SearchBox value={q} onChange={setQ} label="Search your posts" />
        {(["all", "posted", "failed", "unscheduled"] as const).map((s) => (
          <button key={s} type="button" className="chip-filter" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "all" ? "All" : STATUS_WORDS[s]}
            {s === "failed" && data?.counts.failed ? ` (${data.counts.failed})` : ""}
          </button>
        ))}
        <label className="sr-only" htmlFor="h-platform">
          Platform
        </label>
        <select id="h-platform" className="select" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "")}>
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {SHORT[p]}
            </option>
          ))}
        </select>
      </div>
      {data && data.items.length === 0 ? <p className="soft">Nothing here yet.</p> : null}
      {data && data.items.length ? (
        <div className="list card flat">
          {data.items.map((p) => (
            <div key={p.id} className="list-row" data-history-row={p.status}>
              {p.cover_url ? <img className="cal-history-cover" src={p.cover_url} alt="" loading="lazy" /> : null}
              <div className="grow">
                <div className="title">{p.hook_text || "Untitled clip"}</div>
                <div className="meta">
                  {SHORT[p.platform]} · {fmtDate(p.posted_at ?? p.scheduled_at)} · <span className={`pill ${p.status === "posted" ? "ok" : p.status === "failed" ? "bad" : ""}`}>{STATUS_WORDS[p.status] ?? p.status}</span>
                  {p.status === "failed" && p.error ? ` ${p.error}` : ""}
                </div>
              </div>
              {p.status === "posted" && p.url ? (
                <a className="btn quiet small" href={p.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : null}
              {p.status === "failed" ? (
                <span className="btn-row">
                  {!p.file_cleared ? (
                    <button type="button" className="btn small" onClick={() => act(p, "retry")}>
                      Try again
                    </button>
                  ) : null}
                  <button type="button" className="btn quiet small" onClick={() => act(p, "unschedule")}>
                    Let go
                  </button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {data && data.total > 0 ? <MoreRow shown={data.items.length} total={data.total} onMore={more} busy={busy} noun="posts" /> : null}
    </section>
  );
}
