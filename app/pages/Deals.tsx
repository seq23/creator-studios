// Brand deals, as a talent manager runs them (docs/reviews/agency-pov.md). Money first: the
// money strip; then every open deal with the one thing to do next and when (overdue on top);
// then "Brands to pitch this week", ranked by expected money with the arithmetic and a source on
// every claim, one tap to Pitch; then the marketplaces worth joining. A deal opens full-width
// (DealView). The Media kit is the second tab. She sends every email herself from Gmail.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, patch, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { DismissButton, HelpButton, Modal, MoreRow, Notice, PageHead, SearchBox, Skeleton, useLoad, useToast } from "../components/ui";
import { archiveWithUndo, restoreArchived } from "../lib/archive";
import { Icon } from "../components/Icon";
import { MediaKitEditor } from "./MediaKit";
import { AddContact, DealView } from "../components/deals/DealView";
import type { NextAction, MoneyStrip } from "../../worker/domain/deals";
import type { BudgetSignal, Evidence } from "../../worker/domain/prospects";
import type { ListingStep } from "../../worker/domain/marketplaces";
import type { DealStage } from "@shared/constants";
import "../styles/deals.css";

interface Prospect {
  id: string;
  name: string;
  kind: "brand" | "agency" | "local";
  website: string | null;
  fit: number;
  fitReasons: string[];
  why: Evidence[];
  budget: BudgetSignal;
  budgetLabel: string;
  sources: string[];
  score: number;
  math: string;
  aboveLine: boolean;
  reach: string;
  bestContact: { id: string; kind: string; value: string; found_on_url: string } | null;
  origin: string;
}
interface DealCard {
  dealId: string;
  brandId: string;
  brand: string;
  kind: string;
  stage: DealStage;
  stageLabel: string;
  fee: number | null;
  next: NextAction;
  outcomeReason: string | null;
  closedAt: string | null;
  archivedAt?: string | null;
  archivedBy?: "her" | "tidy" | null;
}
interface DealsData {
  money: MoneyStrip;
  prospects: Prospect[];
  deals: DealCard[];
  /** Day 358: true counts; `deals` is capped unless all=1, `closed` is a page. */
  dealsTotal: number;
  closed: DealCard[];
  closedTotal: number;
  archived: DealCard[];
  archivedTotal: number;
  listings: ListingStep[];
  kit: { url: string; published: boolean };
  profileLocked: boolean;
  finder: { status: string; startedAt: string | null; finishedAt: string | null; running: boolean; error: string | null };
  hunter: { connected: boolean; creditsLeft: number | null };
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const KIND = { brand: "Brand", agency: "Agency", local: "Local" } as const;
function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export function Deals() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "kit" ? "kit" : "deals";
  const dealId = params.get("deal");
  // Day 358: Do this next capped (Show all), deals searchable, archived ones under Show archived.
  const [allNext, setAllNext] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [moreClosed, setMoreClosed] = useState<DealCard[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const dealsQuery = new URLSearchParams({ ...(allNext ? { all: "1" } : {}), ...(search ? { q: search } : {}), ...(showArchived ? { archived: "1" } : {}) }).toString();
  const { data, loading, error, reload } = useLoad(() => get<DealsData>(`/api/deals?${dealsQuery}`), [dealsQuery]);
  useEffect(() => setMoreClosed([]), [data]);
  async function loadMoreClosed() {
    if (!data) return;
    try {
      const next = await get<DealsData>(`/api/deals?${dealsQuery}&closedOffset=${data.closed.length + moreClosed.length}`);
      setMoreClosed((m) => [...m, ...next.closed]);
    } catch (e) {
      toast.bad(e);
    }
  }
  const [adding, setAdding] = useState(false);
  const [inbound, setInbound] = useState(false);
  const [contactFor, setContactFor] = useState<string | null>(null);
  const [showUnproven, setShowUnproven] = useState(false);
  const [pitching, setPitching] = useState<string | null>(null);
  const [joinedNow, setJoinedNow] = useState<Record<string, boolean>>({});
  const toast = useToast();

  useEffect(() => {
    if (!data?.finder.running) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [data?.finder.running, reload]);

  const openDeal = (id: string | null) => {
    const next = new URLSearchParams();
    if (id) next.set("deal", id);
    setParams(next);
  };

  async function runFinder() {
    try {
      await post("/api/deals/finder/run");
      toast.ok("Looking for brands with money for creators like you. New cards show up here in a few minutes.");
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  async function pitch(p: Prospect) {
    setPitching(p.id);
    try {
      const r = await post<{ dealId: string; note: string | null }>(`/api/deals/brands/${p.id}/pitch`);
      if (r.note) toast.ok(r.note);
      openDeal(r.dealId);
      reload();
    } catch (e) {
      toast.bad(e);
    } finally {
      setPitching(null);
    }
  }

  async function hide(p: Prospect) {
    try {
      await patch(`/api/deals/brands/${p.id}`, { status: "hidden" });
      toast.ok("Hidden. It won't be suggested again.");
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  async function joined(key: string, on: boolean) {
    setJoinedNow((j) => ({ ...j, [key]: on }));
    try {
      await patch("/api/deals/listings", { key, joined: on });
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  const above = data?.prospects.filter((p) => p.aboveLine) ?? [];
  const below = data?.prospects.filter((p) => !p.aboveLine) ?? [];

  return (
    <div className="page deals">
      <PageHead
        title="Brand deals"
        lede={tab === "kit" ? "The link in every pitch: your numbers, your best work and your rates, published when you say so." : "Brands with money for creators like you, the next email for every deal, written and ready."}
      >
        {tab === "deals" && !dealId ? (
          <>
            <button type="button" className="btn quiet small" onClick={() => setInbound(true)}>
              A brand wrote to me
            </button>
            <button type="button" className="btn quiet small" onClick={() => setAdding(true)}>
              <Icon name="plus" size="sm" />
              Add a brand I love
            </button>
          </>
        ) : null}
      </PageHead>

      <div className="deals-tabs" role="tablist" aria-label="Deals sections">
        <button type="button" role="tab" aria-selected={tab === "deals"} className={tab === "deals" ? "on" : ""} onClick={() => setParams({}, { replace: true })}>
          Deals
        </button>
        <button type="button" role="tab" aria-selected={tab === "kit"} className={tab === "kit" ? "on" : ""} onClick={() => setParams({ tab: "kit" }, { replace: true })}>
          Media kit
        </button>
      </div>

      {tab === "kit" ? (
        <MediaKitEditor />
      ) : dealId ? (
        <DealView dealId={dealId} onBack={() => openDeal(null)} onChanged={reload} />
      ) : (
        <>
          {loading && !data ? <Skeleton blocks={4} columns={2} /> : null}
          {error ? <Notice tone="bad">Brand deals did not load. Check your connection and try again.</Notice> : null}
          {data ? (
            <>
              <section className="money-strip" aria-label="Money">
                <div className="money">
                  <strong className="nums">{data.money.pitchedThisMonth}</strong>
                  <span>Pitched this month</span>
                </div>
                <div className="money">
                  <strong className="nums">{data.money.replies}</strong>
                  <span>Replies{data.money.replyRate != null ? ` (${data.money.replyRate}%)` : ""}</span>
                </div>
                <div className="money">
                  <strong className="nums">{data.money.won}</strong>
                  <span>Deals won</span>
                </div>
                <div className="money">
                  <strong className="nums">{usd(data.money.dollarsAgreed)}</strong>
                  <span>Agreed</span>
                </div>
                <div className="money">
                  <strong className="nums">{usd(data.money.dollarsPaid)}</strong>
                  <span>Paid</span>
                </div>
              </section>
              {data.money.averageFee != null ? <p className="hint money-note nums">Average fee {usd(data.money.averageFee)} across {data.money.won} won {data.money.won === 1 ? "deal" : "deals"}.</p> : null}

              {!data.profileLocked ? (
                <Notice tone="info">
                  <span>
                    <strong>Lock your Brand Profile first.</strong> The finder and your emails read it. <Link to="/brain">Open Client Brain</Link>
                  </span>
                </Notice>
              ) : null}
              {!data.kit.published ? (
                <Notice tone="warn">
                  <span>
                    <strong>Your media kit isn't published.</strong> Every pitch links to it. <Link to="/deals?tab=kit">Finish and publish it</Link>
                  </span>
                </Notice>
              ) : null}

              <section className="section" aria-label="Do this next">
                <div className="section-head">
                  <h2>Do this next</h2>
                  {data.dealsTotal > data.deals.length || allNext ? (
                    <button type="button" className="link-btn" onClick={() => setAllNext((v) => !v)} aria-expanded={allNext} data-see-all>
                      {allNext ? "Show fewer" : `Show all (${data.dealsTotal})`}
                    </button>
                  ) : null}
                </div>
                <div className="list-tools">
                  <SearchBox value={q} onChange={setQ} label="Search your deals by brand" />
                </div>
                {data.deals.length === 0 ? (
                  <p className="soft">{search ? "No deals match that." : "No deals in play yet. Pitch a brand below: the first email is written for you."}</p>
                ) : (
                  <div className="deal-cards">
                    {data.deals.map((d) => (
                      <div key={d.dealId} className="deal-card-wrap">
                      <button type="button" className={`deal-card${d.next.overdue ? " overdue" : ""}`} onClick={() => openDeal(d.dealId)}>
                        <span className="deal-card-top">
                          <span className="deal-card-name">{d.brand}</span>
                          <span className="pill">{d.stageLabel}</span>
                        </span>
                        <span className="deal-card-next">{d.next.label}</span>
                        <span className="deal-card-meta">
                          {d.next.dueAt ? <span className={`pill ${d.next.overdue ? "bad" : "warn"}`}>{d.next.overdue ? `Overdue ${fmtDate(d.next.dueAt)}` : `Due ${fmtDate(d.next.dueAt)}`}</span> : null}
                          {d.fee != null ? <span className="nums">{usd(d.fee)}</span> : null}
                        </span>
                      </button>
                      <DismissButton label={`Archive the ${d.brand} deal`} onClick={() => archiveWithUndo(toast, "deal", d.dealId, reload)} />
                      </div>
                    ))}
                  </div>
                )}
                <p className="hint">Finished deals move to Archived on their own 60 days after they close; an open deal with nothing happening for 90 days does too (never an unpaid invoice).</p>
              </section>

              <section className="section" aria-label="Brands to pitch this week">
                <div className="section-head">
                  <h2>Brands to pitch this week</h2>
                  <button type="button" className="btn small" data-primary={data.prospects.length === 0 || undefined} onClick={runFinder} disabled={data.finder.running || !data.profileLocked}>
                    {data.finder.running ? "Looking…" : "Find brands now"}
                  </button>
                </div>
                <p className="hint">
                  Ranked by expected money: how sure we are they pay creators × how well they fit you × how reachable they are.{" "}
                  {data.finder.finishedAt ? `Last search ${fmtDate(data.finder.finishedAt)}; it refreshes every day on its own.` : "It refreshes every day on its own."}
                  {data.hunter.connected ? ` Hunter: ${data.hunter.creditsLeft ?? "?"} lookups left.` : ""}
                </p>
                {data.finder.status === "failed" ? (
                  <Notice tone="bad">
                    <span>
                      The last brand search did not finish. It tries again tomorrow on its own. <Link to="/help/pitch-a-brand">More</Link>
                    </span>
                  </Notice>
                ) : null}
                {above.length === 0 && below.length === 0 ? (
                  <div className="empty">
                    <h3>No brands yet</h3>
                    <p className="soft">Tap Find brands now, or add a brand you already use and love. Those make the strongest pitches.</p>
                  </div>
                ) : null}
                <div className="prospects">
                  {above.map((p) => (
                    <ProspectCard key={p.id} p={p} busy={pitching === p.id} onPitch={() => pitch(p)} onHide={() => hide(p)} onContact={() => setContactFor(p.id)} />
                  ))}
                </div>
                {below.length ? (
                  <div className="below-line">
                    <button type="button" className="link-btn" onClick={() => setShowUnproven((v) => !v)} aria-expanded={showUnproven}>
                      {showUnproven ? "Hide" : "Show"} {below.length} {below.length === 1 ? "brand" : "brands"} with no sign yet that they pay
                    </button>
                    {showUnproven ? (
                      <div className="prospects unproven">
                        {below.map((p) => (
                          <ProspectCard key={p.id} p={p} busy={pitching === p.id} onPitch={() => pitch(p)} onHide={() => hide(p)} onContact={() => setContactFor(p.id)} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="section" aria-label="Get listed here">
                <div className="section-head">
                  <h2>Get listed here</h2>
                </div>
                <p className="hint">
                  Places where brands with budgets look for creators. Checked 25 Sep 2026; each links to its source. <Link to="/help/pitch-a-brand">More</Link>
                </p>
                <div className="listings">
                  {data.listings.map((l) => (
                    <details key={l.key} className={`listing ${l.status}${l.joined ? " joined" : ""}`}>
                      <summary>
                        <span className="grow">
                          <strong>{l.name}</strong>
                          <span className="hint"> · {l.payoff}</span>
                        </span>
                        <span className={`pill ${l.joined ? "ok" : l.status === "ready" ? "ok" : l.status === "not_yet" ? "" : "warn"}`}>{l.joined ? "Joined" : l.status === "ready" ? "You can join" : l.status === "not_yet" ? "Not yet" : "Check"}</span>
                      </summary>
                      <p>
                        <strong>Pays:</strong> {l.pays}
                      </p>
                      <p>
                        <strong>Who:</strong> {l.why}
                      </p>
                      <p>
                        <strong>How:</strong> {l.apply}
                      </p>
                      <div className="btn-row">
                        {l.applyUrl ? (
                          <a className="btn quiet small" href={l.applyUrl} target="_blank" rel="noreferrer">
                            Open it
                          </a>
                        ) : null}
                        <label className="check">
                          <input type="checkbox" checked={joinedNow[l.key] ?? l.joined} onChange={(e) => joined(l.key, e.target.checked)} />
                          I'm on it
                        </label>
                        <a className="hint" href={l.sourceUrl} target="_blank" rel="noreferrer">
                          Source
                        </a>
                      </div>
                    </details>
                  ))}
                </div>
              </section>

              {data.closedTotal ? (
                <section className="section" aria-label="Closed deals">
                  <div className="section-head">
                    <h2>Closed</h2>
                  </div>
                  {data.money.lostReasons.length ? <p className="hint">Why deals closed: {data.money.lostReasons.map((r) => `${r.reason} (${r.n})`).join(", ")}.</p> : null}
                  <div className="list">
                    {[...data.closed, ...moreClosed].map((d) => (
                      <div key={d.dealId} className="list-row closed-row">
                        <button type="button" className="grow link-row" onClick={() => openDeal(d.dealId)}>
                          <span className="title">{d.brand}</span>
                          <span className="meta">
                            {d.stageLabel}
                            {d.outcomeReason ? `: ${d.outcomeReason}` : ""}
                            {d.closedAt ? ` · ${fmtDate(d.closedAt)}` : ""}
                          </span>
                        </button>
                        <DismissButton label={`Archive the ${d.brand} deal`} onClick={() => archiveWithUndo(toast, "deal", d.dealId, reload)} />
                      </div>
                    ))}
                  </div>
                  <MoreRow shown={data.closed.length + moreClosed.length} total={data.closedTotal} onMore={loadMoreClosed} noun="closed deals" />
                </section>
              ) : null}

              <section className="section" aria-label="Archived deals">
                <div className="section-head">
                  <h2>Archived</h2>
                  <button type="button" className="link-btn" onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived} data-show-archived>
                    {showArchived ? "Hide archived" : `Show archived (${data.archivedTotal})`}
                  </button>
                </div>
                {showArchived ? (
                  data.archived.length ? (
                    <div className="list">
                      {data.archived.map((d) => (
                        <div key={d.dealId} className="list-row closed-row">
                          <span className="grow">
                            <span className="title">{d.brand}</span>
                            <span className="meta">
                              {d.stageLabel}
                              {d.archivedAt ? ` · archived ${fmtDate(d.archivedAt)}${d.archivedBy === "tidy" ? " by Tidy up" : ""}` : ""}
                            </span>
                          </span>
                          <button type="button" className="btn quiet small" onClick={() => restoreArchived(toast, "deal", d.dealId, reload)}>
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="soft">Nothing archived.</p>
                  )
                ) : null}
              </section>
            </>
          ) : null}
        </>
      )}

      {adding ? (
        <AddBrand
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : null}
      {inbound ? (
        <Inbound
          onClose={() => setInbound(false)}
          onDone={(id) => {
            setInbound(false);
            openDeal(id);
            reload();
          }}
        />
      ) : null}
      {contactFor ? <AddContact brandId={contactFor} onClose={() => setContactFor(null)} onAdded={() => { setContactFor(null); reload(); }} /> : null}
      <HelpButton guide={tab === "kit" ? "media-kit" : dealId ? "reply-to-a-brand-offer" : "pitch-a-brand"} />
    </div>
  );
}

function ProspectCard({ p, busy, onPitch, onHide, onContact }: { p: Prospect; busy: boolean; onPitch: () => void; onHide: () => void; onContact: () => void }) {
  return (
    <article className={`prospect${p.aboveLine ? "" : " unproven"}`} aria-label={p.name}>
      <div className="prospect-top">
        <span className="brand-logo" aria-hidden="true">
          {p.name.slice(0, 1)}
        </span>
        <div className="grow">
          <h3>{p.name}</h3>
          <div className="row wrap prospect-tags">
            <span className="pill">{KIND[p.kind]}</span>
            <span className={`pill ${p.budget.level === "paying" ? "ok" : p.budget.level === "likely" ? "warn" : ""}`}>{p.budgetLabel}</span>
            {p.origin === "her_list" ? <span className="pill">You love it</span> : null}
          </div>
        </div>
      </div>
      {p.budget.evidence[0] ? (
        <p className="prospect-line">
          <strong>Money:</strong> {p.budget.evidence[0].text}{" "}
          <a className="src" href={p.budget.evidence[0].url} target="_blank" rel="noreferrer">
            ({host(p.budget.evidence[0].url)})
          </a>
        </p>
      ) : null}
      {p.why[0] ? (
        <p className="prospect-line">
          <strong>Why now:</strong> {p.why[0].text}{" "}
          <a className="src" href={p.why[0].url} target="_blank" rel="noreferrer">
            ({host(p.why[0].url)})
          </a>
        </p>
      ) : p.fitReasons.length ? (
        <p className="prospect-line">
          <strong>Fit:</strong> {p.fitReasons.slice(0, 2).join("; ")}
          {p.sources[0] ? (
            <>
              {" "}
              <a className="src" href={p.sources[0]} target="_blank" rel="noreferrer">
                ({host(p.sources[0])})
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="prospect-line">
        <strong>Contact:</strong>{" "}
        {p.bestContact ? (
          <>
            <span className="mono">{p.bestContact.kind === "form" ? "their creator form" : p.bestContact.value}</span>{" "}
            <a className="src" href={p.bestContact.found_on_url} target="_blank" rel="noreferrer">
              (found on {host(p.bestContact.found_on_url)})
            </a>
          </>
        ) : (
          <>
            none yet.{" "}
            <button type="button" className="link-btn" onClick={onContact}>
              Add one you found
            </button>
          </>
        )}
      </p>
      <details className="math">
        <summary>How it ranked</summary>
        <span className="nums">{p.math}</span>
      </details>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onPitch} disabled={busy}>
          {busy ? "Writing…" : p.kind === "agency" ? "Pitch to be on their list" : "Pitch"}
        </button>
        <button type="button" className="link-btn" onClick={onHide}>
          Not a fit
        </button>
      </div>
    </article>
  );
}

function AddBrand({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  async function save() {
    try {
      const r = await post<{ id: string; existed?: boolean }>("/api/deals/brands", { name, website: website || undefined, note: note || undefined });
      toast.ok(r.existed ? "Already in your list. Saved it to the top." : "Added. The finder looks up their public contact on its next run.");
      onAdded();
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <Modal title="Add a brand you use and love" onClose={onClose}>
      <p className="soft">These make the strongest pitches.</p>
      <label className="field">
        <span className="label">Brand name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="label">Website (optional)</span>
        <input className="input" inputMode="url" placeholder="brand.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">What you love about it (optional)</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn" onClick={save} disabled={!name.trim()}>
          Add brand
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function Inbound({ onClose, onDone }: { onClose: () => void; onDone: (dealId: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await post<{ dealId: string }>("/api/deals/inbound", { name, website: website || undefined, text });
      toast.ok("Read. Your reply is one tap away on the deal.");
      onDone(r.dealId);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="A brand wrote to me" onClose={onClose}>
      <p className="soft">Paste their email. We read the terms, flag anything risky, and write your reply.</p>
      <label className="field">
        <span className="label">Brand name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="label">Their website (optional)</span>
        <input className="input" inputMode="url" placeholder="brand.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">Paste what the brand sent</span>
        <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn" data-primary onClick={save} disabled={busy || !name.trim() || text.trim().length < 20}>
          {busy ? "Reading…" : "Read it"}
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
