// "Change look" on a clip in Review: every Look with its one-line description and a tiny preview
// (public/looks/<id>.webp, made from the selftest footage). Picking one queues a re-render of just
// that clip; the current version keeps playing until the new one is ready (about a minute).
// A grid Look opens the cell picker first: a live mosaic of the cells, tap a cell to choose what
// it shows (this clip, this clip closer, another clip from this dump, an approved clip from her
// library) and which cell's sound plays. The rules are the Worker's (worker/domain/looks.ts
// cleanGridLayout); this screen only makes them easy to follow.
import { useMemo, useState } from "react";
import { get, post } from "../lib/api";
import { Modal, Notice, Skeleton, useLoad, useToast } from "./ui";
import type { ReviewClip } from "../pages/Review";
import "../styles/looks.css";

export interface LookView {
  id: string;
  name: string;
  description: string;
  thumb: string;
  cells: [number, number, number, number][] | null;
}

interface EditingView {
  looks: LookView[];
}

interface CellOption {
  id: string;
  hook_text: string;
  seconds: number;
  look_name: string | null;
  cover_url: string | null;
}

interface CellOptions {
  self: CellOption;
  dump: CellOption[];
  library: CellOption[];
  zooms: number[];
}

type CellSource = { kind: "self" } | { kind: "clip"; clip_id: string } | { kind: "zoom"; zoom: number };
interface GridLayout {
  cells: CellSource[];
  voice: number;
}

const FRAME_W = 1080;
const FRAME_H = 1920;

export function LookModal({ clip, onClose, onQueued }: { clip: ReviewClip; onClose: () => void; onQueued: (updated: ReviewClip | null) => void }) {
  const toast = useToast();
  const data = useLoad(() => get<EditingView>("/api/editing"));
  const [grid, setGrid] = useState<LookView | null>(null);
  const [busy, setBusy] = useState(false);

  async function queue(look: LookView, layout?: GridLayout) {
    setBusy(true);
    try {
      const r = await post<{ jobId: string; clip: ReviewClip | null }>(`/api/clips/${clip.id}/look`, layout ? { look: look.id, layout } : { look: look.id });
      onQueued(r.clip);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  if (grid) return <CellPicker clip={clip} look={grid} busy={busy} onBack={() => setGrid(null)} onClose={onClose} onConfirm={(layout) => queue(grid, layout)} />;

  return (
    <Modal title="Change look" onClose={onClose}>
      <p className="hint">Pick a look and just this clip is made again in it, in about a minute. The current version stays until the new one is ready.</p>
      {!clip.source_available ? (
        <Notice tone="warn">The original video for this clip was cleared after 7 days, so its look can’t change. Dump that video again to get new looks.</Notice>
      ) : null}
      {data.loading && !data.data ? <Skeleton lines={4} /> : null}
      <ul className="look-list" aria-label="Looks">
        {(data.data?.looks ?? []).map((l) => {
          const current = l.id === clip.look;
          return (
            <li key={l.id}>
              <button
                type="button"
                className={`look-option${current ? " current" : ""}`}
                data-look-option={l.id}
                disabled={busy || !clip.source_available || (current && !l.cells)}
                onClick={() => (l.cells ? setGrid(l) : queue(l))}
              >
                <img src={l.thumb} alt="" width={222} height={128} loading="lazy" />
                <span className="look-text">
                  <span className="look-name">
                    {l.name}
                    {current ? <span className="pill soft">Now</span> : null}
                    {l.cells ? <span className="pill soft">{l.cells.length} cells</span> : null}
                  </span>
                  <span className="hint">{l.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="btn-row">
        <button className="btn quiet" onClick={onClose}>
          Keep this look
        </button>
      </div>
    </Modal>
  );
}

/** The starting grid: the saved one when the clip already has this Look, else this clip, this dump's other clips, then closer shots. */
function startLayout(clip: ReviewClip, look: LookView, options: CellOptions | null): GridLayout {
  const n = look.cells?.length ?? 1;
  if (clip.look === look.id && clip.layout && clip.layout.cells.length === n) return clip.layout;
  const cells: CellSource[] = [{ kind: "self" }];
  for (const o of options?.dump ?? []) {
    if (cells.length >= n) break;
    cells.push({ kind: "clip", clip_id: o.id });
  }
  const zooms = options?.zooms ?? [1.35, 1.7, 2.1];
  let z = 0;
  while (cells.length < n) cells.push({ kind: "zoom", zoom: zooms[z++ % zooms.length] });
  return { cells, voice: 0 };
}

function CellPicker({ clip, look, busy, onBack, onClose, onConfirm }: { clip: ReviewClip; look: LookView; busy: boolean; onBack: () => void; onClose: () => void; onConfirm: (layout: GridLayout) => void }) {
  const options = useLoad(() => get<CellOptions>(`/api/clips/${clip.id}/cells`));
  const [layout, setLayout] = useState<GridLayout | null>(null);
  const [active, setActive] = useState(0);
  const current = layout ?? (options.data ? startLayout(clip, look, options.data) : null);
  const byId = useMemo(() => {
    const m = new Map<string, CellOption>();
    for (const o of [...(options.data?.dump ?? []), ...(options.data?.library ?? [])]) m.set(o.id, o);
    return m;
  }, [options.data]);
  const cells = look.cells ?? [];
  const hasSelf = current?.cells.some((c) => c.kind === "self") ?? false;

  function describe(src: CellSource): { label: string; cover: string | null; zoom: number } {
    if (src.kind === "self") return { label: "This clip", cover: clip.cover_url, zoom: 1 };
    if (src.kind === "zoom") return { label: `This clip, closer (${src.zoom}×)`, cover: clip.cover_url, zoom: src.zoom };
    const o = byId.get(src.clip_id);
    return { label: o ? `“${o.hook_text}”` : "Another clip", cover: o?.cover_url ?? null, zoom: 1 };
  }

  function set(src: CellSource) {
    if (!current) return;
    const next = { ...current, cells: current.cells.map((c, i) => (i === active ? src : c)) };
    setLayout(next);
  }

  return (
    <Modal title={`${look.name}: pick what each cell shows`} onClose={onClose}>
      <p className="hint">Tap a cell, then choose what it shows. The cell marked Sound plays its sound, and its words become the captions.</p>
      {!current ? <Skeleton lines={4} /> : null}
      {current ? (
        <div className="cell-picker">
          <div className="mosaic" role="group" aria-label="Preview of the grid" data-testid="mosaic">
            {cells.map(([x, y, w, h], i) => {
              const d = describe(current.cells[i]);
              return (
                <button
                  key={i}
                  type="button"
                  className={`mosaic-cell${i === active ? " active" : ""}`}
                  style={{ left: `${(x / FRAME_W) * 100}%`, top: `${(y / FRAME_H) * 100}%`, width: `${(w / FRAME_W) * 100}%`, height: `${(h / FRAME_H) * 100}%` }}
                  aria-label={`Cell ${i + 1}: ${d.label}${current.voice === i ? ", plays its sound" : ""}`}
                  aria-pressed={i === active}
                  data-cell={i}
                  onClick={() => setActive(i)}
                >
                  {d.cover ? <img src={d.cover} alt="" style={{ transform: `scale(${d.zoom})` }} /> : <span className="mosaic-empty">{i + 1}</span>}
                  {current.voice === i ? <span className="mosaic-voice">Sound</span> : null}
                </button>
              );
            })}
          </div>
          <div className="cell-options">
            <div className="label">Cell {active + 1} shows</div>
            <div className="cell-choice-row">
              <button type="button" className="btn small quiet" aria-pressed={current.cells[active]?.kind === "self"} onClick={() => set({ kind: "self" })}>
                This clip
              </button>
              {(options.data?.zooms ?? []).map((z) => (
                <button key={z} type="button" className="btn small quiet" aria-pressed={current.cells[active]?.kind === "zoom" && (current.cells[active] as { zoom: number }).zoom === z} onClick={() => set({ kind: "zoom", zoom: z })}>
                  Closer {z}×
                </button>
              ))}
            </div>
            <CellList title="From this dump" items={options.data?.dump ?? []} activeId={current.cells[active]?.kind === "clip" ? (current.cells[active] as { clip_id: string }).clip_id : null} onPick={(id) => set({ kind: "clip", clip_id: id })} empty="No other clips in this dump." />
            <CellList title="From your approved clips" items={options.data?.library ?? []} activeId={current.cells[active]?.kind === "clip" ? (current.cells[active] as { clip_id: string }).clip_id : null} onPick={(id) => set({ kind: "clip", clip_id: id })} empty="Approve clips in Review and they can be picked here." />
            <button type="button" className="btn small" disabled={current.voice === active} onClick={() => setLayout({ ...current, voice: active })}>
              {current.voice === active ? "This cell plays its sound" : "Play sound from this cell"}
            </button>
          </div>
        </div>
      ) : null}
      {current && !hasSelf ? <Notice tone="warn">Keep this clip in at least one cell.</Notice> : null}
      <div className="btn-row">
        <button className="btn" data-primary disabled={busy || !current || !hasSelf} onClick={() => current && onConfirm(current)}>
          {busy ? "Starting…" : "Make it in this look"}
        </button>
        <button className="btn quiet" onClick={onBack}>
          Back to looks
        </button>
      </div>
    </Modal>
  );
}

function CellList({ title, items, activeId, onPick, empty }: { title: string; items: CellOption[]; activeId: string | null; onPick: (id: string) => void; empty: string }) {
  return (
    <div className="cell-list">
      <div className="label">{title}</div>
      {items.length ? (
        <ul>
          {items.map((o) => (
            <li key={o.id}>
              <button type="button" className={`cell-source${activeId === o.id ? " on" : ""}`} aria-pressed={activeId === o.id} onClick={() => onPick(o.id)}>
                {o.cover_url ? <img src={o.cover_url} alt="" width={36} height={64} loading="lazy" /> : null}
                <span className="grow">{o.hook_text}</span>
                <span className="hint nums">{Math.round(o.seconds)} s</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">{empty}</p>
      )}
    </div>
  );
}
