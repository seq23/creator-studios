// The plain line (studio intelligence layer 7, owner's plan 22 Oct 2026), on Dump and in Review:
// "Looks like: <service> · <before and after / walk-through / …> · camera sound <off/on>", or
// "Not sure what this shows", with one-tap "Change". Tapping a choice re-plans the dump at once
// (POST /api/dumps/:id/looks-like); the services come from her Brand Profile, never from code.
// Under it, at most two one-tap questions (layer 7: "Is this <service>?", "Is one of these a
// before?"), answered with taps only, never typing (POST /api/dumps/:id/answer). An answer that
// changes the plan cuts the dump again; every answer is remembered (Studio Memory, layer 8).
// Calm rules (make-it-calm): yellow = a question with a one-tap answer, every button says what it
// does, ✕ Never mind closes, she stays where she was.
import { useEffect, useState } from "react";
import { SHAPES, SHAPE_LABELS, plainLine, type LooksLike, type Question, type QuestionVideo, type Shape } from "@shared/looksLike";
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
      {canChange ? <Questions dumpId={dumpId} looksLike={looksLike ?? null} onChanged={onChanged} /> : null}
    </p>
  );
}

function Questions({ dumpId, looksLike, onChanged }: { dumpId: string; looksLike: LooksLike | null; onChanged?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ questions: Question[]; services: string[]; videos: QuestionVideo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<"service" | "before" | null>(null);
  const [befores, setBefores] = useState<string[]>([]);
  useEffect(() => {
    get<{ questions: Question[]; services: string[]; videos: QuestionVideo[] }>(`/api/dumps/${dumpId}/questions`).then(setData).catch(() => setData(null));
  }, [dumpId, looksLike?.service, looksLike?.shape]);
  if (!data?.questions.length) return null;
  async function answer(body: { id: "service" | "before"; yes?: boolean; service?: string; before_assets?: string[] }, said: string) {
    setBusy(true);
    try {
      const r = await post<{ replan?: boolean; removed?: number }>(`/api/dumps/${dumpId}/answer`, body);
      toast.ok(r.replan === false ? `Thanks. ${said}` : `Got it. ${said} These videos are being cut again. We'll email you when the new clips are ready.`);
      setData((d) => (d ? { ...d, questions: d.questions.filter((q) => q.id !== body.id) } : d));
      setPicking(null);
      if (r.replan !== false) onChanged?.();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="looks-questions" data-looks-questions>
      {data.questions.map((q) => (
        <span key={q.id} className="looks-q" data-question={q.id} role="group" aria-label={q.text}>
          <strong className="looks-q-text">{q.text}</strong>
          <span className="hint">{q.hint}</span>
          {q.id === "service" && picking !== "service" ? (
            <span className="btn-row wrap">
              {looksLike?.sure && looksLike.service ? (
                <>
                  <button type="button" className="btn" disabled={busy} data-answer="yes" onClick={() => answer({ id: "service", yes: true }, "We'll remember that.")}>
                    ✓ Yes, that's right
                  </button>
                  <button type="button" className="btn quiet" disabled={busy} data-answer="no" onClick={() => setPicking("service")}>
                    ✗ No, it's something else
                  </button>
                </>
              ) : (
                <ServiceButtons services={data.services} busy={busy} onPick={(s) => answer({ id: "service", service: s }, `This is ${s}.`)} />
              )}
            </span>
          ) : null}
          {q.id === "service" && picking === "service" ? (
            <span className="btn-row wrap">
              <span className="looks-q-say">It's:</span>
              <ServiceButtons services={data.services.filter((s) => s !== looksLike?.service)} busy={busy} onPick={(s) => answer({ id: "service", service: s }, `This is ${s}.`)} />
              <button type="button" className="btn quiet" disabled={busy} onClick={() => setPicking(null)}>
                ✕ Never mind
              </button>
            </span>
          ) : null}
          {q.id === "before" && picking !== "before" ? (
            <span className="btn-row wrap">
              <button type="button" className="btn" disabled={busy} data-answer="yes" onClick={() => { setBefores(data.videos.filter((v) => v.before).map((v) => v.id)); setPicking("before"); }}>
                Yes, let me tap which
              </button>
              <button type="button" className="btn quiet" disabled={busy} data-answer="no" onClick={() => answer({ id: "before", yes: false }, "None of them is a before.")}>
                No, none of them
              </button>
            </span>
          ) : null}
          {q.id === "before" && picking === "before" ? (
            <span className="looks-q-videos">
              {data.videos.map((v) => {
                const on = befores.includes(v.id);
                return (
                  <button key={v.id} type="button" className={`looks-q-video${on ? " on" : ""}`} aria-pressed={on} disabled={busy} data-before-video={v.n} onClick={() => setBefores((b) => (on ? b.filter((x) => x !== v.id) : [...b, v.id]))}>
                    <span className="looks-q-check" aria-hidden="true">{on ? "☑" : "☐"}</span>
                    <span>
                      <strong>Video {v.n}</strong>: {v.what}
                      <span className="hint"> {on ? "This is a before (tap to undo)" : "Tap if this is a before"}</span>
                    </span>
                  </button>
                );
              })}
              <span className="btn-row wrap">
                <button type="button" className="btn" disabled={busy || !befores.length} data-before-done onClick={() => answer({ id: "before", before_assets: befores }, befores.length === 1 ? "1 video is a before." : `${befores.length} videos are befores.`)}>
                  {befores.length ? `Done: cut again with ${befores.length === 1 ? "this before" : "these befores"}` : "Tap a video above first"}
                </button>
                <button type="button" className="btn quiet" disabled={busy} onClick={() => setPicking(null)}>
                  ✕ Never mind
                </button>
              </span>
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function ServiceButtons({ services, busy, onPick }: { services: string[]; busy: boolean; onPick: (s: string) => void }) {
  return (
    <>
      {services.map((s) => (
        <button key={s} type="button" className="btn small" disabled={busy} data-service={s} onClick={() => onPick(s)}>
          {s[0]!.toUpperCase() + s.slice(1)}
        </button>
      ))}
    </>
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
