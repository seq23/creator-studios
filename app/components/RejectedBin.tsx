// The Rejected bin (owner's ruling, 13 Nov 2026): rejecting never deletes. Reels she rejected and
// photo posts she skipped wait here. "Bring back" returns one; "Delete for good" asks once, on the
// page (never a browser pop-up), and sits apart from Bring back; "Empty the whole bin" sits apart
// at the bottom and says how many. Her original photos and videos are never deleted from here.
import { useState } from "react";
import type { BinItem, BinList } from "@shared/posts";
import { del, get, post } from "../lib/api";
import { plural } from "../lib/format";
import { Empty, HelpButton, PageHead, Skeleton, useLoad, useToast } from "./ui";
import "../styles/calendar.css";

const day = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "") : "");

export function RejectedBin() {
  const toast = useToast();
  const bin = useLoad(() => get<BinList>("/api/bin"));
  const tz = bin.data?.tz ?? "UTC";
  const [asking, setAsking] = useState<string | null>(null); // the row asked "delete for good?"
  const [emptying, setEmptying] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = bin.data?.items ?? [];

  async function run(fn: () => Promise<unknown>, ok: (r: unknown) => string) {
    setBusy(true);
    try {
      toast.ok(ok(await fn()));
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
      setAsking(null);
      setEmptying(false);
      bin.reload();
    }
  }
  const bringBack = (it: BinItem) => run(() => post(`/api/bin/${it.source}/${it.id}/restore`), () => (it.source === "clip" ? "Brought back. It is waiting for your OK in Review." : "Brought back. It is on your Posts list again."));
  const remove = (it: BinItem) => run(() => del(`/api/bin/${it.source}/${it.id}`), () => "Deleted for good. Your original photos and videos are kept.");
  const empty = () =>
    run(
      () => post<{ deleted: number; kept: number }>("/api/bin/empty"),
      (r) => {
        const { deleted, kept } = r as { deleted: number; kept: number };
        return `Deleted ${plural(deleted, "post")} for good.${kept ? ` ${plural(kept, "post")} already went out, so ${kept === 1 ? "it is" : "they are"} kept.` : ""}`;
      },
    );

  return (
    <div className="page cal bin">
      <PageHead title={bin.data ? `Rejected bin · ${plural(items.length, "post")}` : "Rejected bin"} lede="Posts you said no to wait here. Nothing in the bin is ever posted." />
      {!bin.data ? <Skeleton blocks={2} /> : null}
      {bin.data && items.length === 0 ? <Empty title="The bin is empty">When you say no to a post it waits here, so you can bring it back if you change your mind.</Empty> : null}
      {items.some((it) => it.clears_on) ? <p className="hint">To save space, a reel is cleared by itself {bin.data!.keep_days} days after you say no to it. Bring it back before then to keep it.</p> : null}

      <div className="bin-list">
        {items.map((it) => {
          const key = `${it.source}:${it.id}`;
          return (
            <div key={key} className="bin-row" data-bin-row={it.source} data-bin-id={it.id}>
              <div className="post-row">
                {it.thumb_url ? <img className="post-thumb" src={it.thumb_url} alt="" loading="lazy" /> : <span className="post-thumb post-thumb-none" aria-hidden="true">{it.source === "clip" ? "▶" : "▣"}</span>}
                <div className="grow post-row-text">
                  <div className="post-row-top">
                    <span className="post-chip">{it.kind_label}</span>
                    <span className="hint">{it.rejected_at ? `Rejected ${day(it.rejected_at, tz)}` : "Rejected"}</span>
                  </div>
                  <div className="post-row-headline">{it.headline}</div>
                  {it.clears_on ? <div className="hint">Cleared by itself on {day(it.clears_on, tz)}</div> : null}
                </div>
              </div>
              {asking === key ? (
                <div className="bin-ask" role="group" aria-label="Delete this post for good?">
                  <strong>Delete this post for good?</strong>
                  <p className="hint">It cannot be brought back. Your original photos and videos are kept.</p>
                  <button type="button" className="btn quiet" disabled={busy} onClick={() => setAsking(null)}>
                    Keep it
                  </button>
                  <button type="button" className="link-btn danger-text" disabled={busy} onClick={() => remove(it)}>
                    Yes, delete for good
                  </button>
                </div>
              ) : (
                <div className="bin-actions">
                  <button type="button" className="btn quiet small" disabled={busy} onClick={() => bringBack(it)}>
                    Bring back ›
                  </button>
                  <button type="button" className="link-btn danger-text" disabled={busy} onClick={() => { setEmptying(false); setAsking(key); }}>
                    Delete for good
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {items.length ? (
        <div className="bin-empty">
          {emptying ? (
            <div className="bin-ask" role="group" aria-label="Empty the whole bin?">
              <strong>Delete all {plural(items.length, "post")} in the bin for good?</strong>
              <p className="hint">They cannot be brought back. Your original photos and videos are kept.</p>
              <button type="button" className="btn quiet" disabled={busy} onClick={() => setEmptying(false)}>
                Keep them
              </button>
              <button type="button" className="link-btn danger-text" disabled={busy} onClick={empty}>
                Yes, delete all {items.length} for good
              </button>
            </div>
          ) : (
            <button type="button" className="link-btn danger-text" disabled={busy} onClick={() => { setAsking(null); setEmptying(true); }}>
              Empty the whole bin
            </button>
          )}
        </div>
      ) : null}
      <HelpButton guide="review-and-approve-clips" />
    </div>
  );
}
