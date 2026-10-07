// Dump → Your dumps (day 358, docs/reviews/2026-09-26-day-358.md): a year is 50+ dumps. A page at
// a time with its true count, search, a filter, one-tap archive with Undo, Show archived + Restore.
// Held notices ("someone else's video") sit on top only for the last 30 days; older ones are the
// Held pill on their row, so they stop pushing the form down.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DumpList, DumpSummary } from "@shared/types";
import { get } from "../lib/api";
import { fmtDate, plural } from "../lib/format";
import { archiveWithUndo, restoreArchived } from "../lib/archive";
import { Card, DismissButton, Empty, MoreRow, SearchBox, Skeleton, useToast } from "./ui";
import { HeldNotice } from "./HeldNotice";

const FILTERS = [
  ["", "All"],
  ["ready", "Ready for review"],
  ["failed", "Needs a look"],
  ["held", "Held"],
] as const;

const HELD_NOTICE_DAYS = 30;

function statusWords(d: DumpSummary): { text: string; tone: string } {
  if (d.status === "ready") return { text: "Ready for review", tone: "ok" };
  if (d.status === "reviewed") return { text: "Reviewed", tone: "ok" };
  if (d.status === "failed") return { text: "Needs a look", tone: "bad" };
  if (d.status === "uploading") return { text: "Not sent", tone: "warn" };
  return { text: "Cutting", tone: "" };
}

export function DumpHistory({ refreshKey }: { refreshKey: unknown }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState<DumpList | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = (offset: number, limit = 20) => new URLSearchParams({ offset: String(offset), limit: String(limit), ...(query ? { q: query } : {}), ...(status ? { status } : {}), ...(archived ? { archived: "1" } : {}) }).toString();

  useEffect(() => {
    let live = true;
    setBusy(true);
    const keep = shownRef.current;
    shownRef.current = 0;
    get<DumpList>(`/api/dumps?${params(0, Math.min(50, Math.max(20, keep)))}`)
      .then((d) => live && setData(d), (e) => toast.bad(e))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, archived, refreshKey, tick]);

  async function more() {
    if (!data) return;
    setBusy(true);
    try {
      const next = await get<DumpList>(`/api/dumps?${params(data.items.length)}`);
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  const reload = () => {
    // an archive or restore keeps what she already scrolled through loaded
    shownRef.current = data?.items.length ?? 0;
    setTick((n) => n + 1);
  };
  const recentHeld = archived ? [] : (data?.items ?? []).filter((d) => d.held_note && Date.parse(d.created_at) > Date.now() - HELD_NOTICE_DAYS * 86400_000);

  return (
    <aside className="section dump-history" aria-label="Your dumps">
      <div className="section-head">
        <h2>{archived ? "Archived dumps" : "Your dumps"}</h2>
        <button type="button" className="link-btn" onClick={() => setArchived((v) => !v)} aria-pressed={archived} data-show-archived>
          {archived ? "Back to your dumps" : `Show archived${data?.archived ? ` (${data.archived})` : ""}`}
        </button>
      </div>
      <div className="list-tools">
        <SearchBox value={q} onChange={setQ} label="Search your notes and file names" />
        {!archived
          ? FILTERS.map(([key, label]) => (
              <button key={key} type="button" className="chip-filter" aria-pressed={status === key} onClick={() => setStatus(key)}>
                {label}
              </button>
            ))
          : null}
      </div>
      {!data && busy ? <Skeleton lines={4} /> : null}
      {recentHeld.map((d) => (
        <HeldNotice key={d.id} dumpId={d.id} note={`${fmtDate(d.created_at)}: ${d.held_note}`} onDone={reload} />
      ))}
      {data && data.items.length === 0 ? (
        archived ? (
          <p className="soft">Nothing archived. Finished dumps move here on their own 30 days after you review them.</p>
        ) : query || status ? (
          <p className="soft">No dumps match that.</p>
        ) : (
          <Empty title="Nothing dumped yet">Choose videos, add a note and press Dump. Each dump shows up here with how its clips are coming along.</Empty>
        )
      ) : null}
      {data && data.items.length > 0 ? (
        <Card className="flat">
          <div className="list">
            {data.items.map((d) => {
              const s = statusWords(d);
              return (
                <Link key={d.id} to={d.status === "ready" ? "/review" : `/dump/${d.id}`} className="list-row" data-dump-row={d.id}>
                  <div className="grow">
                    <div className="title">
                      {fmtDate(d.created_at)} · {d.door === "new" ? "New videos" : d.door === "youtube" ? "Full video for YouTube" : "Old posts"} · {plural(d.files, "video")}
                    </div>
                    <div className="meta">
                      {d.held_note ? <span className="pill warn">Held</span> : null} <span className={`pill ${s.tone}`}>{s.text}</span> {d.clips_made ? `${plural(d.clips_made, "clip")} made` : d.status === "cutting" && d.progress ? `${d.progress.step}…` : ""}
                    </div>
                  </div>
                  {archived ? (
                    <button
                      type="button"
                      className="btn quiet small"
                      onClick={(e) => {
                        e.preventDefault();
                        restoreArchived(toast, "dump", d.id, reload);
                      }}
                    >
                      Restore
                    </button>
                  ) : ["queued", "cutting"].includes(d.status) ? null : (
                    <DismissButton label={`Archive the dump from ${fmtDate(d.created_at)}`} onClick={() => archiveWithUndo(toast, "dump", d.id, reload)} />
                  )}
                </Link>
              );
            })}
          </div>
        </Card>
      ) : null}
      {data && data.total > 0 ? <MoreRow shown={data.items.length} total={data.total} onMore={more} busy={busy} noun={archived ? "archived dumps" : "dumps"} /> : null}
    </aside>
  );
}
