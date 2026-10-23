// The plain line (studio intelligence layer 7, owner's plan 22 Oct 2026), on Dump and in Review:
// "Looks like: <service> · <before and after / walk-through / …> · camera sound <off/on>", or
// "Not sure what this shows", with one-tap "Change". Tapping a choice re-plans the dump at once
// (POST /api/dumps/:id/looks-like); the services come from her Brand Profile, never from code.
import { useEffect, useState } from "react";
import { SHAPES, SHAPE_LABELS, plainLine, type LooksLike, type Shape } from "@shared/looksLike";
import { get, post } from "../lib/api";
import { Modal, useToast } from "./ui";

export function LooksLikeLine({ dumpId, looksLike, canChange, onChanged }: { dumpId: string; looksLike: LooksLike | null | undefined; canChange: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <p className="looks-like" data-looks-like>
      <span data-looks-like-text>{plainLine(looksLike ?? null)}</span>
      {canChange ? (
        <>
          {" "}
          <button type="button" className="btn quiet small" data-looks-like-change onClick={() => setOpen(true)}>
            Change
          </button>
        </>
      ) : null}
      {open ? <ChangeModal dumpId={dumpId} current={looksLike ?? null} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onChanged?.(); }} /> : null}
    </p>
  );
}

function ChangeModal({ dumpId, current, onClose, onDone }: { dumpId: string; current: LooksLike | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ services: string[] }>(`/api/dumps/${dumpId}/services`).then((r) => setServices(r.services)).catch(() => setServices([]));
  }, [dumpId]);
  async function pick(body: { service?: string; shape?: Shape }) {
    setBusy(true);
    try {
      await post(`/api/dumps/${dumpId}/looks-like`, body);
      toast.ok("Got it. These videos are being cut again with your pick. We'll email you when the new clips are ready.");
      onDone();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="What do these videos show?" onClose={onClose}>
      <p className="hint">Tap one. The new clips from this dump are made again to match (clips you approved or posted stay).</p>
      <div className="btn-row wrap" role="group" aria-label="What these videos show">
        {(services ?? []).map((s) => (
          <button key={s} type="button" className={`btn small${current?.service === s ? " primary" : ""}`} disabled={busy} onClick={() => pick({ service: s })}>
            {s}
          </button>
        ))}
        <button type="button" className="btn small quiet" disabled={busy} onClick={() => pick({ service: "unsure" })}>
          Not sure
        </button>
      </div>
      <h3>What kind of video?</h3>
      <div className="btn-row wrap" role="group" aria-label="What kind of video">
        {SHAPES.map((sh) => (
          <button key={sh} type="button" className={`btn small${current?.shape === sh ? " primary" : ""}`} disabled={busy} onClick={() => pick({ shape: sh })}>
            {SHAPE_LABELS[sh][0]!.toUpperCase() + SHAPE_LABELS[sh].slice(1)}
          </button>
        ))}
      </div>
    </Modal>
  );
}
