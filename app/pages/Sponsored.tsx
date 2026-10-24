// Get it sponsored (owner-approved mock-up, 23 Oct 2026). Not a menu item: a page inside Brand
// deals, opened from the card at the top of it; ← Back always returns there. She types an
// experience (a business studio: an event); the $0 research job finds brands with public proof
// they sponsor creators, videos to make and a dated to-do list. A medical or cosmetic experience
// shows "Read before you book" FIRST. "Pitch this brand" saves the brand and a written first
// email to Deals; she sends every pitch herself. make-it-calm: phone first, one gold button per
// card, every way out written, she lands back on the same card after any action.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, post } from "../lib/api";
import { ago, fmtDate, plural } from "../lib/format";
import { HelpButton, Modal, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { EXAMPLE_CHIPS, WHO_OPTIONS, monthOptions, sponsorWords, type SponsorAskView, type SponsorBrand, type SponsorKind, type SponsorResult, type SponsorTodo, type SponsorVideo } from "@shared/sponsored";
import "../styles/sponsored.css";

interface ListData {
  kind: SponsorKind;
  today: string;
  asks: SponsorAskView[];
  total: number;
  archivedTotal: number;
  profileLocked: boolean;
}

interface OneData {
  kind: SponsorKind;
  ask: SponsorAskView;
  rules: string[];
  result: SponsorResult | null;
  plan: SponsorTodo[];
  ticks: Record<string, string>;
  hidden: string[];
  pitched: Record<string, string>;
  film: { id: string; day: string; title: string }[];
  job: { status: string; progress: { step: string; done: number; total: number } | null; startedAt: string } | null;
  profileLocked: boolean;
}

const day = (ymd: string | null) => (ymd ? fmtDate(`${ymd}T12:00:00Z`, { day: "numeric", month: "short" }) : "");

export function Sponsored() {
  const { id } = useParams();
  return id ? <OneExperience id={id} /> : <StartScreen />;
}

// ---------- A · Start one + the saved list

function StartScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { data, loading, error, reload } = useLoad(() => get<ListData>(`/api/sponsored${showArchived ? "?archived=1" : ""}`), [showArchived]);
  const kind: SponsorKind = data?.kind ?? "experience";
  const w = sponsorWords(kind);
  const months = useMemo(() => monthOptions(data?.today ?? new Date().toISOString().slice(0, 10)), [data?.today]);
  const [title, setTitle] = useState("");
  const [whenMonth, setWhenMonth] = useState("");
  const [who, setWho] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data?.asks.some((a) => a.status === "researching")) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [data, reload]);

  async function start() {
    if (title.trim().length < 3) {
      toast.bad(new Error(`Type the ${w.noun} first, in a few words.`));
      return;
    }
    setBusy(true);
    try {
      const r = await post<{ id: string }>("/api/sponsored", { title, whenMonth, who, notes });
      navigate(`/deals/sponsored/${r.id}`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  const asks = data?.asks ?? [];
  const shown = showAll ? asks : asks.slice(0, 3);
  return (
    <div className="page sponsored">
      <PageHead crumb={<Link to="/deals">← Back to Brand deals</Link>} title="Get it sponsored" lede={`Tell us ${kind === "event" ? "an event you want to run" : "an experience you want"}. We find the brands that pay for it, the videos to make, and what to do first.`} />

      <section className="card sp-start" aria-label={w.ask}>
        <div className="field">
          <label htmlFor="sp-title">{w.ask}</label>
          <textarea id="sp-title" className="input" rows={2} maxLength={160} placeholder={w.placeholder} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="sp-chips" aria-label="Examples: tap one to use it">
          {EXAMPLE_CHIPS[kind].map((c) => (
            <button key={c} type="button" className="chip-filter" onClick={() => setTitle(c)}>
              + {c}
            </button>
          ))}
        </div>
        <div className="sp-two">
          <div className="field">
            <label htmlFor="sp-when">When</label>
            <select id="sp-when" className="input" value={whenMonth} onChange={(e) => setWhenMonth(e.target.value)}>
              <option value="">Not sure yet</option>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sp-who">{kind === "event" ? "Who it's for" : "Who's coming"}</label>
            <select id="sp-who" className="input" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Tap to choose</option>
              {WHO_OPTIONS[kind].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="sp-notes">Anything else? (optional)</label>
          <input id="sp-notes" className="input" maxLength={300} placeholder={kind === "event" ? "e.g. We can host 60 people" : "e.g. Somewhere I can film a get-ready video"} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="button" className="btn big block" data-primary disabled={busy} onClick={start}>
          {busy ? "Starting…" : "Find brands for this"}
        </button>
        <p className="hint">Free. Takes 3–6 minutes. You can leave this page; it keeps going and shows here when it's ready.</p>
        {data && !data.profileLocked ? (
          <Notice tone="info">
            <span>
              <strong>Lock your Brand Profile</strong> before you pitch, so the emails sound like you. <Link to="/brain">Open Client Brain</Link>
            </span>
          </Notice>
        ) : null}
      </section>

      <section className="section" aria-label={w.list}>
        <div className="section-head">
          <h2>{showArchived ? "Archived" : w.list}</h2>
          {data && data.total > 3 ? (
            <button type="button" className="link-btn" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer ▴" : `Show all ${data.total} ▾`}
            </button>
          ) : null}
        </div>
        {loading && !data ? <Skeleton lines={2} /> : null}
        {error ? <Notice tone="bad">This list did not load. Check your connection and try again.</Notice> : null}
        {data && !asks.length ? <p className="hint">{showArchived ? "Nothing archived." : `Nothing yet. Type one above and tap Find brands for this.`}</p> : null}
        <ul className="sp-list">
          {shown.map((a) => (
            <li key={a.id}>
              <Link className="sp-row" to={`/deals/sponsored/${a.id}`}>
                <span className="grow">
                  <strong>{a.title}</strong>
                  <span className="hint">{rowLine(a)}</span>
                </span>
                <StatusPill a={a} />
                <span className="sp-open">Tap to open</span>
              </Link>
            </li>
          ))}
        </ul>
        {data && data.total > shown.length && !showAll ? <p className="hint">Showing {shown.length} of {data.total}.</p> : null}
        {data && (data.archivedTotal > 0 || showArchived) ? (
          <button type="button" className="link-btn" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? `← Back to ${w.list.toLowerCase()}` : `Show archived (${data.archivedTotal})`}
          </button>
        ) : null}
      </section>
      <HelpButton guide="get-it-sponsored" />
    </div>
  );
}

function rowLine(a: SponsorAskView): string {
  if (a.status === "researching") return `Started ${ago(a.createdAt)}`;
  if (a.status === "failed") return "Didn't finish. Tap to try again.";
  const parts = [plural(a.counts.brands, "brand"), plural(a.counts.videos, "video")];
  if (a.pitchBy) parts.push(`pitch by ${day(a.pitchBy)}`);
  return parts.join(" · ");
}

function StatusPill({ a }: { a: SponsorAskView }) {
  if (a.status === "ready") return <span className="pill ok">Ready</span>;
  if (a.status === "failed") return <span className="pill warn">Try again</span>;
  return <span className="pill">Researching</span>;
}

// ---------- B–G · one experience

type Tab = "brands" | "videos" | "todo";

function OneExperience({ id }: { id: string }) {
  const toast = useToast();
  const { data, error, reload, setData } = useLoad(() => get<OneData>(`/api/sponsored/${id}`), [id]);
  const [tab, setTab] = useState<Tab>("brands");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [justPitched, setJustPitched] = useState<Record<string, { dealId: string; needsWayIn: boolean }>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [filmFor, setFilmFor] = useState<SponsorVideo | null>(null);
  const [archiving, setArchiving] = useState(false);
  const navigate = useNavigate();

  const researching = data?.ask.status === "researching";
  useEffect(() => {
    if (!researching) return;
    const t = setInterval(reload, 8_000);
    return () => clearInterval(t);
  }, [researching, reload]);

  if (error && !data) {
    return (
      <div className="page sponsored">
        <PageHead crumb={<Link to="/deals/sponsored">← Back to Get it sponsored</Link>} title="Get it sponsored" />
        <Notice tone="bad">This did not load. Check your connection, then tap Try again.</Notice>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
        <HelpButton guide="get-it-sponsored" />
      </div>
    );
  }
  if (!data) return <Skeleton blocks={3} />;

  const { ask, result } = data;
  const w = sponsorWords(data.kind);
  const hidden = new Set(data.hidden);
  const brands = result?.brands.filter((b) => !hidden.has(b.key)) ?? [];
  const hiddenBrands = result?.brands.filter((b) => hidden.has(b.key)) ?? [];
  const sub = [ask.who, ask.whenLabel, ask.readyAt && ask.status === "ready" ? `ready ${fmtDate(ask.readyAt)}` : null].filter(Boolean).join(" · ");

  async function run() {
    try {
      await post(`/api/sponsored/${id}/run`);
      toast.ok("Looking again. Your ticks and pitches are kept.");
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  async function pitch(b: SponsorBrand) {
    setBusyKey(b.key);
    try {
      const r = await post<{ dealId: string; note: string | null; needsWayIn: boolean }>(`/api/sponsored/${id}/brands/${encodeURIComponent(b.key)}/pitch`);
      setJustPitched((m) => ({ ...m, [b.key]: { dealId: r.dealId, needsWayIn: r.needsWayIn } }));
      setData((d) => (d ? { ...d, pitched: { ...d.pitched, [b.key]: r.dealId } } : d));
      if (r.note) toast.ok(r.note);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusyKey(null);
    }
  }

  async function hide(b: SponsorBrand, on: boolean) {
    try {
      const r = await post<{ hidden: string[] }>(`/api/sponsored/${id}/brands/${encodeURIComponent(b.key)}/hide`, { hidden: on });
      setData((d) => (d ? { ...d, hidden: r.hidden } : d));
      toast.ok(on ? `${b.name} is hidden. Bring it back under “Show hidden”.` : `${b.name} is back.`);
    } catch (e) {
      toast.bad(e);
    }
  }

  async function tick(t: SponsorTodo, done: boolean) {
    setData((d) => (d ? { ...d, ticks: done ? { ...d.ticks, [t.id]: "now" } : Object.fromEntries(Object.entries(d.ticks).filter(([k]) => k !== t.id)) } : d));
    try {
      await post(`/api/sponsored/${id}/ticks`, { id: t.id, done });
    } catch (e) {
      toast.bad(e);
      reload();
    }
  }

  async function archive() {
    try {
      await post(`/api/sponsored/${id}/archive`, { archived: true });
      toast.ok("Archived. Nothing was deleted; find it under Show archived.");
      navigate("/deals/sponsored");
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <div className="page sponsored">
      <PageHead crumb={<Link to="/deals/sponsored">← Back to Get it sponsored</Link>} title={ask.title} lede={sub || undefined} />

      {ask.status === "researching" ? <Researching data={data} noun={w.noun} /> : null}

      {ask.status === "failed" ? (
        <section className="card sp-failed" aria-label="It didn't finish">
          <h2>It didn't finish</h2>
          <p>{ask.error}</p>
          <button type="button" className="btn big" data-primary onClick={run}>
            Try again
          </button>
        </section>
      ) : null}

      {/* A medical or cosmetic experience: the rules come FIRST, above the brands, never behind a tab. */}
      {data.rules.length && ask.status !== "researching" ? (
        <section className="card sp-rules" aria-label="Read before you book">
          <h2>Read before you book</h2>
          <ul>
            {data.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <details>
            <summary>Why these rules ▾</summary>
            <p className="hint">
              A free or paid treatment is a deal, so the FTC's disclosure rules apply (ftc.gov, “Disclosures 101 for Social Media Influencers”). Prescription drugs carry FDA advertising rules. Who may inject or treat you is set by your state. Each platform has its own rules for paid posts about cosmetic
              treatments. This is not legal or medical advice: see a doctor before any treatment, and have a lawyer read a medical deal.
            </p>
          </details>
        </section>
      ) : null}

      {result && ask.status !== "researching" ? (
        <>
          <section className="card accent sp-first" aria-label="Do this first">
            <h2>Do this first</h2>
            {ask.pitchBy ? (
              <p>
                <strong>Pitch by {day(ask.pitchBy)}.</strong> {data.kind === "event" ? "Sponsors plan their budgets ahead." : "Brands plan this kind of content months ahead."}
              </p>
            ) : null}
            <p>{result.firstMove?.text ?? (brands[0] ? `Start with ${brands[0].name}: ${brands[0].why || brands[0].what}` : "Start with the first brand below.")}</p>
          </section>

          <div className="deals-tabs sp-tabs" role="tablist" aria-label="Results">
            {(
              [
                ["brands", `Brands ${brands.length}`],
                ["videos", `Videos ${result.videos.length}`],
                ["todo", `To do ${data.plan.length}`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "brands" ? (
            <section className="section" aria-label="Brands">
              {!brands.length ? <p className="hint">Every brand is hidden. Tap “Show hidden” to bring one back.</p> : null}
              <div className="sp-cards">
                {brands.map((b) => (
                  <BrandCard key={b.key} b={b} busy={busyKey === b.key} dealId={data.pitched[b.key] ?? null} fresh={justPitched[b.key] ?? null} onPitch={() => pitch(b)} onHide={() => hide(b, true)} />
                ))}
              </div>
              {hiddenBrands.length ? (
                <div className="sp-hidden">
                  <button type="button" className="link-btn" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
                    {showHidden ? "Hide the hidden ones ▴" : `Show hidden (${hiddenBrands.length}) ▾`}
                  </button>
                  {showHidden ? (
                    <ul className="sp-list">
                      {hiddenBrands.map((b) => (
                        <li key={b.key} className="sp-row">
                          <span className="grow">{b.name}</span>
                          <button type="button" className="btn small quiet" onClick={() => hide(b, false)}>
                            Bring back
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "videos" ? (
            <section className="section" aria-label="Videos">
              <div className="sp-cards">
                {result.videos.map((v) => (
                  <VideoCard key={v.id} v={v} filmed={data.film.find((f) => f.title === v.title) ?? null} onCalendar={() => setFilmFor(v)} />
                ))}
              </div>
            </section>
          ) : null}

          {tab === "todo" ? (
            <section className="section" aria-label="To do">
              <ul className="sp-todo">
                {data.plan.map((t) => {
                  const done = !!data.ticks[t.id];
                  return (
                    <li key={t.id} className={done ? "done" : ""}>
                      <label>
                        <input type="checkbox" checked={done} onChange={(e) => tick(t, e.target.checked)} />
                        <span className="grow">{t.text}</span>
                        <span className={`sp-when${done ? " ok" : ""}`}>{done ? "Done" : t.by ? `By ${day(t.by)}` : t.label ?? ""}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="hint">Ticks are saved. Dates work back from {ask.whenMonth ? ask.whenLabel : "about 3 months from when you started"}.</p>
            </section>
          ) : null}

          <section className="section sp-again" aria-label="More">
            <button type="button" className="btn quiet" onClick={run}>
              Run it again (keeps your ticks and pitches)
            </button>
            <p className="hint">Found from {plural(result.sources, "public page")}{result.madeBy === "rules" ? ", without the AI writer this time" : ""}. Every brand links the page we read; nothing is guessed.</p>
          </section>
          <div className="sp-danger">
            <button type="button" className="btn danger small" onClick={() => setArchiving(true)}>
              {w.archive} (asks first; nothing is deleted)
            </button>
          </div>
        </>
      ) : null}

      {filmFor ? (
        <FilmModal
          video={filmFor}
          whenMonth={ask.whenMonth}
          onClose={() => setFilmFor(null)}
          onSave={async (d) => {
            try {
              await post(`/api/sponsored/${id}/calendar`, { videoId: filmFor.id, day: d });
              toast.ok(`On your Calendar for ${day(d)} under “To film”.`);
              setFilmFor(null);
              reload();
            } catch (e) {
              toast.bad(e);
            }
          }}
        />
      ) : null}
      {archiving ? (
        <Modal title={`${w.archive}?`} onClose={() => setArchiving(false)}>
          <p>It moves to Archived. Nothing is deleted, and your deals stay in Brand deals.</p>
          <div className="btn-row">
            <button type="button" className="btn danger" onClick={archive}>
              Yes, archive it
            </button>
            <button type="button" className="btn quiet" onClick={() => setArchiving(false)}>
              No, keep it
            </button>
          </div>
        </Modal>
      ) : null}
      <HelpButton guide="get-it-sponsored" />
    </div>
  );
}

const STEPS: { step: string; label: string }[] = [
  { step: "start", label: "Read your Brand Profile and numbers" },
  { step: "searching", label: "Search public pages for brands that sponsor this" },
  { step: "thinking", label: "Check which ones work with creators" },
  { step: "contacts", label: "Find each brand's public way in" },
];

function Researching({ data, noun }: { data: OneData; noun: string }) {
  const p = data.job?.progress ?? null;
  const at = p ? Math.max(1, STEPS.findIndex((s) => s.step === p.step)) : 0;
  return (
    <section className="card sp-progress" aria-label="Finding brands for this" aria-live="polite">
      <h2>Finding brands for this</h2>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.step} className={i < at ? "done" : i === at ? "now" : ""}>
            <span className="sp-mark" aria-hidden="true">
              {i < at ? "✓" : i === at ? "…" : "·"}
            </span>
            {s.label}
            {i === at && p && p.total > 1 ? <span className="hint"> ({Math.min(p.done + 1, p.total)} of {p.total})</span> : null}
          </li>
        ))}
      </ol>
      <p className="hint">Takes 3–6 minutes. You can leave this page; your {noun} keeps going and shows here when it's ready.</p>
    </section>
  );
}

function wayInText(b: SponsorBrand): string {
  if (b.wayIn.kind === "none") return "Needs a way in";
  return `Way in: ${b.wayIn.label}`;
}

function BrandCard({ b, busy, dealId, fresh, onPitch, onHide }: { b: SponsorBrand; busy: boolean; dealId: string | null; fresh: { dealId: string; needsWayIn: boolean } | null; onPitch: () => void; onHide: () => void }) {
  const fit = b.fit === "best" ? ["ok", "Best fit"] : b.fit === "good" ? ["", "Good fit"] : ["", "Worth a try"];
  return (
    <article className="card tight sp-brand" aria-label={b.name}>
      <div className="sp-brand-top">
        <div className="grow">
          <h3>{b.name}</h3>
          {b.what ? <p className="hint">{b.what}</p> : null}
        </div>
        <span className={`pill ${fit[0]}`}>{fit[1]}</span>
      </div>
      {b.why ? <p>{b.why}</p> : null}
      <p className="sp-proof">
        Proof: {b.proof[0].text}{" "}
        <a href={b.proof[0].url} target="_blank" rel="noreferrer">
          See the page
        </a>
      </p>
      <p className={`sp-wayin${b.wayIn.kind === "none" ? " none" : ""}`}>{wayInText(b)}</p>
      {fresh || dealId ? (
        <Notice tone="ok">
          <span>
            <strong>In your Deals.</strong> {fresh ? "The first email is written. " : ""}You send every pitch yourself.{fresh?.needsWayIn ? " Add their public contact in the deal first." : ""}{" "}
            <Link to={`/deals?deal=${fresh?.dealId ?? dealId}`}>Open the email in Deals</Link>
          </span>
        </Notice>
      ) : (
        <div className="btn-row">
          <button type="button" className="btn" disabled={busy} onClick={onPitch}>
            {busy ? "Writing the email…" : "Pitch this brand"}
          </button>
          <button type="button" className="btn quiet" onClick={onHide}>
            Not for me
          </button>
        </div>
      )}
      <details>
        <summary>More about {b.name} ▾</summary>
        <ul className="sp-more">
          {b.proof.map((p) => (
            <li key={p.url + p.text}>
              {p.text}{" "}
              <a href={p.url} target="_blank" rel="noreferrer">
                See the page
              </a>
            </li>
          ))}
          {b.wayIn.kind !== "none" && b.wayIn.value ? (
            <li>
              Way in: {b.wayIn.kind === "email" ? b.wayIn.value : <a href={b.wayIn.value} target="_blank" rel="noreferrer">{b.wayIn.label}</a>}
              {b.wayIn.foundOn && b.wayIn.kind === "email" ? (
                <>
                  {" "}
                  (printed on{" "}
                  <a href={b.wayIn.foundOn} target="_blank" rel="noreferrer">
                    this public page
                  </a>
                  )
                </>
              ) : null}
            </li>
          ) : (
            <li>No public address found yet. In the deal, tap Add a contact when you find one on their site.</li>
          )}
          {b.firstStep ? <li>First step: {b.firstStep}</li> : null}
          {b.website ? (
            <li>
              <a href={b.website} target="_blank" rel="noreferrer">
                Their website
              </a>
            </li>
          ) : null}
        </ul>
      </details>
    </article>
  );
}

function VideoCard({ v, filmed, onCalendar }: { v: SponsorVideo; filmed: { day: string } | null; onCalendar: () => void }) {
  return (
    <article className="card tight sp-video" aria-label={v.title}>
      <div className="sp-brand-top">
        <div className="grow">
          <h3>{v.title}</h3>
          <p className="hint">{[v.format, v.forBrand ? `for ${v.forBrand}` : null].filter(Boolean).join(" · ")}</p>
        </div>
        <span className="pill">{v.deal}</span>
      </div>
      <p>
        <strong>Hook:</strong> “{v.hook}”
      </p>
      {v.shots.length ? (
        <p className="hint">
          <strong>Shots:</strong> {v.shots.join(" · ")}
        </p>
      ) : null}
      {filmed ? (
        <p className="sp-wayin">
          On your Calendar for {day(filmed.day)}. <Link to="/calendar">Open Calendar</Link>
        </p>
      ) : (
        <div className="btn-row">
          <button type="button" className="btn quiet" onClick={onCalendar}>
            Add to my Calendar
          </button>
        </div>
      )}
    </article>
  );
}

function FilmModal({ video, whenMonth, onClose, onSave }: { video: SponsorVideo; whenMonth: string; onClose: () => void; onSave: (day: string) => void }) {
  const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const [d, setD] = useState(whenMonth && `${whenMonth}-01` > soon ? `${whenMonth}-01` : soon);
  return (
    <Modal title="Add to my Calendar" onClose={onClose}>
      <p>
        <strong>{video.title}</strong> goes on your Calendar under “To film”, with the hook and the shots. Nothing posts.
      </p>
      <div className="field">
        <label htmlFor="sp-day">Which day will you film it?</label>
        <input id="sp-day" className="input" type="date" value={d} onChange={(e) => setD(e.target.value)} />
      </div>
      <button type="button" className="btn block" disabled={!d} onClick={() => onSave(d)}>
        Add to my Calendar
      </button>
    </Modal>
  );
}
