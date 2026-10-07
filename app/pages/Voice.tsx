// Voice narration (section 12). Always in the menu and always usable (nothing hidden, owner
// 26 Sep 2026). The switch "Automatic voice overs" (features.voice, also in Settings) sits right
// under the steps: on = clips with no talking get a voice over automatically (Review can remove
// it); off = only the voice overs she makes here herself. Her voice can be saved either way.
// Top: five numbered setup steps, phone first: find a quiet spot, record (or Voice Memos) while
// reading the ~3-minute script shown right here, listen back / upload, consent + Save my voice,
// re-record any time. Recording works on iPhone Safari (MediaRecorder audio/mp4, else webm),
// with a live timer, a level meter, Stop and play-back before anything is uploaded. At least a
// minute is required; about 3 minutes is recommended. Once her voice is saved the steps fold
// into one "Your voice" card with Record again.
// Then: which voice is in use (built-in free, or ElevenLabs premium) and why, the "Use premium
// voice when connected" switch, Make a narration, and Recent narrations tagged Premium/Built-in.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, patch, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { uploadFile } from "../lib/upload";
import { Card, DismissButton, Dot, Empty, HelpButton, Modal, MoreRow, Notice, PageHead, SearchBox, Skeleton, useLoad, useToast } from "../components/ui";
import { archiveWithUndo, restoreArchived } from "../lib/archive";
import SCRIPT from "../content/voice-script.md?raw";
import "../styles/voice.css";
import { AUTO_VOICE_HINT } from "@shared/autoVoice";

type Engine = "built-in" | "elevenlabs";

interface VoiceState {
  enabled: boolean;
  hasSample: boolean;
  consent_at: string | null;
  consent_line: string;
  hasModel: boolean;
  owner: boolean;
  min_sample_seconds: number;
  engine: {
    active: Engine;
    reason: string;
    why: string;
    preference: "premium_when_available" | "built_in_only";
    connected: boolean;
    connection: string;
    can_clone: boolean;
    premium_voice: boolean;
    tier: string | null;
    characters_left: number | null;
    characters_limit: number | null;
  };
  narrations: { id: string; script: string; status: "queued" | "generating" | "ready" | "failed"; clip_id: string | null; engine: Engine; duration_s: number | null; mix_status: "mixing" | "ready" | "failed" | null; created_at: string; audio_url: string | null }[];
  /** Day 358: the true count for this list, how many are archived, and the page. */
  narrations_page: { total: number; limit: number; offset: number; archived: number; q: string };
}

export const ENGINE_COPY: Record<Engine, { name: string; line: string; tag: string }> = {
  "built-in": { name: "Built-in voice (free)", line: "Built-in voice (free): good quality, takes a few minutes per voice over.", tag: "Built-in" },
  elevenlabs: { name: "ElevenLabs premium voice", line: "ElevenLabs premium voice: best quality, seconds per voice over, uses your ElevenLabs credits.", tag: "Premium" },
};

export function Voice() {
  const { data, loading, reload } = useLoad(() => get<VoiceState>("/api/voice"));
  const busy = data?.narrations.some((n) => n.status === "queued" || n.status === "generating" || n.mix_status === "mixing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [busy, reload]);

  return (
    <div className="page voice">
      <PageHead title="Voice overs" lede="Spoken voice overs in your own voice. Your clips stay real footage either way." />
      {loading && !data ? <Skeleton blocks={2} /> : null}
      {data ? (
        <>
          <SetupSteps v={data} onChange={reload} />
          <ClipsSwitch v={data} onChange={reload} />
          <EngineCard v={data} onChange={reload} />
          <NarrateCard v={data} onChange={reload} />
          <Narrations v={data} onChange={reload} />
        </>
      ) : null}
      <HelpButton guide="record-your-voice" />
    </div>
  );
}

// ---------------------------------------------------------------- recording helpers

/** The best format this browser records: iPhone Safari → audio/mp4, Chrome/Firefox → webm. */
function recorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
}

const EXT_TYPES: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", caf: "audio/x-caf", webm: "audio/webm", ogg: "audio/ogg" };
export const ACCEPT_AUDIO = "audio/*,video/*,.m4a,.mp3,.wav,.aac,.caf,.webm";

/** Voice Memos and Files sometimes hand over a file with no type; name it from its extension. */
function withType(f: File): File {
  if (f.type) return f;
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  const type = EXT_TYPES[ext];
  return type ? new File([f], f.name, { type, lastModified: f.lastModified }) : f;
}

/** Seconds of audio in a picked file, read by the browser; null when it cannot tell. */
function measureSeconds(f: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const a = document.createElement("audio");
    a.preload = "metadata";
    let done = false;
    const finish = () => {
      if (done) return;
      const d = a.duration;
      if (d === Infinity) {
        // webm from some recorders reports no length until it is sought to the end
        a.currentTime = 1e7;
        a.ontimeupdate = a.ondurationchange = () => {
          if (Number.isFinite(a.duration)) end(a.duration);
        };
        setTimeout(() => end(Number.isFinite(a.duration) ? a.duration : null), 3000);
        return;
      }
      end(Number.isFinite(d) && d > 0 ? d : null);
    };
    const end = (d: number | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onloadedmetadata = finish;
    a.onerror = () => end(null);
    setTimeout(() => end(null), 8000);
    a.src = url;
  });
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

interface Clip {
  file: File;
  seconds: number | null;
}

// ---------------------------------------------------------------- the five steps

function SetupSteps({ v, onChange }: { v: VoiceState; onChange: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(!v.hasSample);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [consent, setConsent] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setOpen(!v.hasSample), [v.hasSample]);

  const min = v.min_sample_seconds;
  const tooShort = !!clip && (clip.seconds === null || clip.seconds < min);

  async function pick(f: File | null) {
    if (!f) return;
    const file = withType(f);
    setClip({ file, seconds: await measureSeconds(file) });
  }

  async function save() {
    if (!clip || tooShort) return;
    setSaving(true);
    try {
      const h = await uploadFile(clip.file, "voice_sample", null, () => undefined);
      const r = await post<{ engine: Engine; premium_voice: boolean }>("/api/voice/sample", { upload_id: h.id, consent: true, consent_text: v.consent_line, duration_s: clip.seconds });
      toast.ok(r.premium_voice ? "Voice saved. Your premium voice is ready too." : "Voice saved. The built-in voice is ready for your first voice over.");
      setClip(null);
      setConsent(false);
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await del("/api/voice/sample");
      toast.ok("Your voice sample and voice model are deleted.");
      setConfirmDelete(false);
      onChange();
    } catch (e) {
      toast.bad(e);
    }
  }

  if (!v.owner) {
    return (
      <Card>
        <h2>Your voice</h2>
        {v.hasSample ? (
          <div className="row">
            <Dot light="green" /> Voice ready · saved {fmtDate(v.consent_at)}
          </div>
        ) : null}
        <Notice tone="info">Only the owner’s own login can record or replace the voice.</Notice>
      </Card>
    );
  }

  return (
    <section className="section voice-setup" aria-label="Set up your voice">
      {v.hasSample ? (
        <Card>
          <div className="row between wrap">
            <div className="row">
              <Dot light="green" /> Voice ready · saved {fmtDate(v.consent_at)}
            </div>
            <div className="btn-row">
              <button type="button" className="btn quiet small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? "Hide the steps" : "Record again"}
              </button>
              <button type="button" className="btn danger small" onClick={() => setConfirmDelete(true)}>
                Delete my voice
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="section-head">
          <h2>Set up your voice in 5 steps</h2>
        </div>
      )}

      {open ? (
        <ol className="voice-steps" id="voice-steps">
          <Step n={1} title="Find a quiet spot">
            <p>Find a quiet spot. Hold your phone like a call, about a hand’s width from your mouth.</p>
          </Step>

          <Step n={2} title="Record while you read">
            <p>Tap Record below (or open your phone’s Voice Memos app) and read the script out loud. Take your time, it’s about 3 minutes. Mistakes are fine, keep going.</p>
            <p className="soft">Start with this line:</p>
            <blockquote className="consent-line">“{v.consent_line}”</blockquote>
            <ScriptPanel />
            <Recorder onDone={(c) => setClip(c)} />
          </Step>

          <Step n={3} title="Listen back">
            <p>Tap Stop, listen back for a few seconds to check it’s clear. Used Voice Memos instead? In Voice Memos tap ••• then Save to Files, then tap Upload a recording here.</p>
            <ClipPreview clip={clip} />
            <label className="btn quiet upload-btn">
              Upload a recording
              <input type="file" accept={ACCEPT_AUDIO} className="sr-only" aria-label="Upload a voice clip" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </label>
          </Step>

          <Step n={4} title="Say yes and save">
            <p>Tick the consent box and tap Save my voice. The built-in voice is ready in a few minutes; with ElevenLabs connected the premium voice is ready in about a minute.</p>
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>This is my own voice and I consent to it being cloned for my narrations.</span>
            </label>
            {clip ? (
              <p className={tooShort ? "hint warn-text" : "hint"} data-testid="sample-length">
                {clip.seconds === null
                  ? "We could not tell how long that recording is. Record here instead, or pick another file."
                  : clip.seconds < min
                    ? `Your recording is ${mmss(clip.seconds)}. Record at least 1 minute; about 3 minutes (the whole script) gives the best voice.`
                    : `Your recording is ${mmss(clip.seconds)}.${clip.seconds < 150 ? " That works; about 3 minutes gives the best voice." : " Perfect."}`}
              </p>
            ) : (
              <p className="hint">At least 1 minute; about 3 minutes (the whole script) is best.</p>
            )}
            <div className="btn-row">
              <button type="button" className="btn" data-primary={!v.hasSample || undefined} onClick={save} disabled={!clip || tooShort || !consent || saving}>
                {saving ? "Saving…" : "Save my voice"}
              </button>
            </div>
          </Step>

          <Step n={5} title="Re-record any time">
            <p>Come back any time to re-record; the newest recording replaces the old one.</p>
          </Step>
        </ol>
      ) : null}

      {confirmDelete ? (
        <Modal title="Delete your voice?" onClose={() => setConfirmDelete(false)}>
          <p>Your voice sample and the voice model are deleted for good, and your premium voice is deleted from ElevenLabs too. Voice overs you already made stay until you delete them.</p>
          <div className="btn-row">
            <button type="button" className="btn danger" onClick={remove}>
              Yes, delete my voice
            </button>
            <button type="button" className="btn quiet" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="card voice-step" data-step={n}>
      <div className="row voice-step-head">
        <span className="voice-step-num" aria-hidden="true">
          {n}
        </span>
        <h3>
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
      </div>
      {children}
    </li>
  );
}

function ScriptPanel() {
  const [shown, setShown] = useState(true);
  const [big, setBig] = useState(false);
  const paras = SCRIPT.trim().split(/\n\s*\n/);
  return (
    <div className="voice-script-box">
      <div className="btn-row">
        <button type="button" className="btn quiet small" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
          {shown ? "Hide script" : "Show script"}
        </button>
        {shown ? (
          <button type="button" className="btn quiet small" aria-pressed={big} onClick={() => setBig((b) => !b)}>
            {big ? "Smaller text" : "Bigger text"}
          </button>
        ) : null}
      </div>
      {shown ? (
        <div className={`voice-script${big ? " big" : ""}`} aria-label="Script to read aloud">
          {paras.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Recorder({ onDone }: { onDone: (c: Clip) => void }) {
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(0);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (meter.current) {
      cancelAnimationFrame(meter.current.raf);
      meter.current.ctx.close().catch(() => undefined);
      meter.current = null;
    }
    setLevel(0);
  }

  function startMeter(stream: MediaStream) {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += ((b - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        if (meter.current) meter.current.raf = requestAnimationFrame(tick);
      };
      meter.current = { ctx, raf: requestAnimationFrame(tick) };
    } catch {
      /* the meter is a nicety; recording works without it */
    }
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.bad(new Error("This browser can’t record here. Use Voice Memos, then Upload a recording."));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const want = recorderType();
      const r = want ? new MediaRecorder(stream, { mimeType: want }) : new MediaRecorder(stream);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = (r.mimeType || want || "audio/webm").split(";")[0];
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const secs = (Date.now() - started.current) / 1000;
        onDone({ file: new File([new Blob(chunks, { type })], `voice-sample.${ext}`, { type }), seconds: secs });
      };
      rec.current = r;
      r.start(1000);
      started.current = Date.now();
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 500);
      startMeter(stream);
    } catch {
      toast.bad(new Error("The microphone is blocked. Allow it in your browser, or use Voice Memos and Upload a recording."));
    }
  }

  function stop() {
    rec.current?.stop();
    setRecording(false);
    cleanup();
  }

  return (
    <div className="recorder">
      <div className="row wrap rec-row">
        <button type="button" className={`rec-btn${recording ? " on" : ""}`} aria-label={recording ? "Stop recording" : "Record sample"} onClick={recording ? stop : start}>
          <span />
        </button>
        <div className="grow">
          <div className="nums rec-time" aria-live="polite">
            {recording ? `Recording… ${mmss(seconds)}` : "Tap to record"}
          </div>
          {recording ? (
            <div className="level-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          ) : null}
        </div>
        {recording ? (
          <button type="button" className="btn" onClick={stop}>
            Stop
          </button>
        ) : null}
      </div>
      {recording && seconds < 60 ? <p className="hint">Keep going: at least 1 minute, about 3 is best.</p> : null}
    </div>
  );
}

function ClipPreview({ clip }: { clip: Clip | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!clip) return setUrl(null);
    const u = URL.createObjectURL(clip.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [clip]);
  if (!url) return <p className="hint">Your recording shows up here to play back.</p>;
  return <audio controls src={url} className="voice-audio" aria-label="Play back your recording" />;
}

// ---------------------------------------------------------------- use my voice on clips

function ClipsSwitch({ v, onChange }: { v: VoiceState; onChange: () => void }) {
  const toast = useToast();
  const [on, setOn] = useState(v.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(v.enabled), [v.enabled]);
  async function toggle(next: boolean) {
    setOn(next);
    setBusy(true);
    try {
      await patch("/api/voice/clips", { on: next });
      toast.ok(next ? "On: clips with no talking get a voice over in your voice." : "Off: only the voice overs you add yourself.");
      onChange();
    } catch (e) {
      setOn(!next);
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="clips-switch">
      <label className="switch">
        <input type="checkbox" checked={on} disabled={busy || !v.owner} onChange={(e) => toggle(e.target.checked)} />
        <span>
          <span className="switch-label">Automatic voice overs</span>
          <span className="switch-hint hint">{AUTO_VOICE_HINT}</span>
        </span>
      </label>
      {on && !v.hasSample ? (
        <p className="hint" data-auto-voice="needs_voice">
          <a href="#voice-steps">Record your voice first</a>: follow the steps, and clips with no talking get a voice over from then on. Until then nothing is made and nothing is wrong.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- which voice

function EngineCard({ v, onChange }: { v: VoiceState; onChange: () => void }) {
  const toast = useToast();
  const e = v.engine;
  const [busy, setBusy] = useState(false);
  // The switch moves the moment she taps it; the server answer then redraws the card.
  const [premiumOn, setPremiumOn] = useState(e.preference === "premium_when_available");
  useEffect(() => setPremiumOn(e.preference === "premium_when_available"), [e.preference]);
  async function toggle(on: boolean) {
    setPremiumOn(on);
    setBusy(true);
    try {
      await patch("/api/voice/engine", { preference: on ? "premium_when_available" : "built_in_only" });
      toast.ok(on ? "Premium voice on: used whenever ElevenLabs is connected." : "Built-in voice only. ElevenLabs is not used.");
      onChange();
    } catch (err) {
      setPremiumOn(!on);
      toast.bad(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="engine-card">
      <div className="row between wrap">
        <h2>Which voice</h2>
        <span className={`pill engine-tag${e.active === "elevenlabs" ? " ok" : ""}`} data-engine={e.active}>
          In use: {ENGINE_COPY[e.active].tag}
        </span>
      </div>
      <ul className="engine-list">
        {(["built-in", "elevenlabs"] as Engine[]).map((k) => (
          <li key={k} className={e.active === k ? "on" : undefined}>
            <Dot light={e.active === k ? "green" : "grey"} />
            <span>{ENGINE_COPY[k].line}</span>
          </li>
        ))}
      </ul>
      <p className="soft engine-why">{e.why}</p>
      {e.connected && e.tier ? (
        <div className="hint nums">
          ElevenLabs plan: {e.tier}
          {e.characters_limit ? ` · ${(e.characters_left ?? 0).toLocaleString("en-US")} of ${e.characters_limit.toLocaleString("en-US")} characters left` : ""}
        </div>
      ) : null}
      {!e.connected ? (
        <div>
          <Link to="/settings/connections" className="link-btn">
            {e.connection === "error" ? "Reconnect ElevenLabs on Connect" : "Connect ElevenLabs for the premium voice"}
          </Link>
        </div>
      ) : null}
      {v.owner ? (
        <label className="switch">
          <input type="checkbox" checked={premiumOn} disabled={busy} onChange={(ev) => toggle(ev.target.checked)} />
          <span>
            <span className="switch-label">Use premium voice when connected</span>
            <span className="switch-hint hint">Off: always the built-in voice, even with ElevenLabs connected.</span>
          </span>
        </label>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- narrate

function NarrateCard({ v, onChange }: { v: VoiceState; onChange: () => void }) {
  const toast = useToast();
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState<"draft" | "gen" | null>(null);

  async function draft() {
    setBusy("draft");
    try {
      const r = await post<{ script: string; note: string | null }>("/api/voice/draft", {});
      setScript(r.script);
      if (r.note) toast.ok(r.note);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }
  async function generate() {
    setBusy("gen");
    try {
      const r = await post<{ engine: Engine; notice: string | null }>("/api/voice/narrations", { script });
      toast.ok(r.notice ?? (r.engine === "elevenlabs" ? "Done. Your premium voice over is ready below." : "Generating. It shows up below when it’s ready; short scripts take a few minutes."));
      setScript("");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <h2>Make a voice over</h2>
      {!v.hasSample ? <Notice tone="info">Save your voice in the steps above first.</Notice> : null}
      <label className="field">
        <span className="label">Script</span>
        <textarea className="textarea" rows={5} maxLength={1500} value={script} onChange={(e) => setScript(e.target.value)} placeholder="What should the voice-over say?" />
        <span className="hint nums">
          {script.length}/1500 · about {Math.max(1, Math.round(script.split(/\s+/).filter(Boolean).length / 2.5))} seconds · {ENGINE_COPY[v.engine.active].name}
        </span>
      </label>
      <div className="btn-row">
        <button type="button" className="btn quiet" onClick={draft} disabled={!!busy}>
          {busy === "draft" ? "Drafting…" : "Draft with AI"}
        </button>
        <button type="button" className={v.hasSample ? "btn" : "btn quiet"} data-primary={v.hasSample || undefined} onClick={generate} disabled={!!busy || !v.hasSample || script.trim().length < 10}>
          {busy === "gen" ? "Starting…" : "Generate"}
        </button>
      </div>
    </Card>
  );
}

type NarrationRow = VoiceState["narrations"][number];

/**
 * Your voice overs (day 358): a page at a time with the true count, search the script, archive with
 * Undo, Show archived + Restore. Failed ones archive on their own after 14 days, unused ones after 60.
 */
function Narrations({ v, onChange }: { v: VoiceState; onChange: () => void }) {
  const toast = useToast();
  const [attach, setAttach] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<NarrationRow[]>(v.narrations);
  const [page, setPage] = useState(v.narrations_page);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = (offset: number) => new URLSearchParams({ offset: String(offset), ...(archived ? { archived: "1" } : {}), ...(search ? { q: search } : {}) }).toString();
  useEffect(() => {
    if (!archived && !search && tick === 0) {
      setRows(v.narrations);
      setPage(v.narrations_page);
      return;
    }
    get<VoiceState>(`/api/voice?${params(0)}`).then(
      (d) => {
        setRows(d.narrations);
        setPage(d.narrations_page);
      },
      (e) => toast.bad(e),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived, search, tick, v]);
  async function more() {
    setBusy(true);
    try {
      const d = await get<VoiceState>(`/api/voice?${params(rows.length)}`);
      setRows((r) => [...r, ...d.narrations]);
      setPage(d.narrations_page);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  const changed = () => {
    setTick((n) => n + 1);
    onChange();
  };
  return (
    <section className="section" aria-label="Your voice overs">
      <div className="section-head">
        <h2>{archived ? "Archived voice overs" : "Your voice overs"}</h2>
        <button type="button" className="link-btn" onClick={() => setArchived((a) => !a)} aria-pressed={archived} data-show-archived>
          {archived ? "Back to your voice overs" : `Show archived${page?.archived ? ` (${page.archived})` : ""}`}
        </button>
      </div>
      <div className="list-tools">
        <SearchBox value={q} onChange={setQ} label="Search your voice overs" />
      </div>
      {rows.length === 0 ? (
        archived ? (
          <p className="soft">Nothing archived. Voice overs that failed move here after 14 days, unused ones after 60.</p>
        ) : search ? (
          <p className="soft">No voice overs match that.</p>
        ) : (
          <Empty title="No voice overs yet">Write a script above and press Generate. Each voice over shows up here to listen to, download or attach to a clip.</Empty>
        )
      ) : (
        <Card className="flat">
          <div className="list">
            {rows.map((n) => (
              <div key={n.id} className="list-row narration" data-narration={n.id}>
                <div className="grow">
                  <div className="title">
                    {n.script.slice(0, 80)}
                    {n.script.length > 80 ? "…" : ""}
                  </div>
                  <div className="meta row wrap">
                    <span className={`pill engine-tag${n.engine === "elevenlabs" ? " ok" : ""}`} data-engine={n.engine}>
                      {ENGINE_COPY[n.engine].tag}
                    </span>
                    <span>
                      {fmtDate(n.created_at)} · {n.status === "ready" ? (n.clip_id ? (n.mix_status === "ready" ? "In your clip · plays in Review" : n.mix_status === "failed" ? "Not added to the clip · attach it again" : "Adding to your clip…") : "Ready") : n.status === "failed" ? "Did not finish" : "Generating…"}
                      {n.duration_s ? ` · ${mmss(n.duration_s)}` : ""}
                    </span>
                  </div>
                  {n.audio_url ? <audio controls preload="none" src={n.audio_url} className="voice-audio" aria-label="Play voice over" /> : null}
                </div>
                <div className="btn-row">
                  {n.audio_url ? (
                    <a className="btn quiet small" href={`${n.audio_url}?download=1`}>
                      Download
                    </a>
                  ) : null}
                  {n.audio_url ? (
                    <button type="button" className="btn quiet small" onClick={() => setAttach(n.id)}>
                      Attach to clip
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn quiet small"
                    onClick={() =>
                      del(`/api/voice/narrations/${n.id}`).then(
                        () => {
                          toast.ok("Deleted.");
                          changed();
                        },
                        (e) => toast.bad(e),
                      )
                    }
                  >
                    Delete
                  </button>
                  {archived ? (
                    <button type="button" className="btn quiet small" onClick={() => restoreArchived(toast, "voice", n.id, changed)}>
                      Restore
                    </button>
                  ) : (
                    <DismissButton label="Archive this voice over" onClick={() => archiveWithUndo(toast, "voice", n.id, changed)} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {page ? <MoreRow shown={rows.length} total={page.total} onMore={more} busy={busy} noun="voice overs" /> : null}
      {attach ? <AttachModal narrationId={attach} onClose={() => setAttach(null)} onDone={onChange} /> : null}
    </section>
  );
}

function AttachModal({ narrationId, onClose, onDone }: { narrationId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data } = useLoad(() => get<{ clips: { id: string; hook_text: string }[] }>("/api/mediakit"));
  async function pick(clipId: string) {
    try {
      await patch(`/api/voice/narrations/${narrationId}`, { clip_id: clipId });
      toast.ok("Adding it to the clip. In a minute or two the clip plays with your voice over in Review.");
      onClose();
      onDone();
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <Modal title="Attach to a clip" onClose={onClose}>
      {!data ? (
        <Skeleton />
      ) : data.clips.length === 0 ? (
        <Empty title="No approved clips yet" cta={{ to: "/review", label: "Open Review" }}>
          Approve a clip in Review, then attach this voice over to it.
        </Empty>
      ) : (
        <div className="list">
          {data.clips.map((c) => (
            <button key={c.id} type="button" className="list-row attach-row" onClick={() => pick(c.id)}>
              {c.hook_text || "Clip"}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
