// One deal, the way a talent manager keeps it: the one next step at the top, the email for it
// already written, the deal memo (who, what, money, dates, rights), what the brand sent with its
// red flags, the negotiation helper, delivery, invoice, and the timeline. Rules live in
// worker/domain/ (deals, emails, offers, ratecard, memo, delivery); this only shows them.
import { archiveWithUndo, restoreArchived } from "../../lib/archive";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PLATFORMS, PLATFORM_LABEL, type DealStage, type Platform } from "@shared/constants";
import { del, get, patch, post } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { Card, Modal, Notice, Skeleton, useLoad, useToast } from "../ui";
import { Icon } from "../Icon";
import { EmailPanel, SentModal, type EmailView } from "./EmailPanel";
import { counterOffer, quote, type AddOnTerms, type LeverScript, type PackageItem } from "../../../worker/domain/ratecard";
import type { NextAction } from "../../../worker/domain/deals";
import type { DealTerms, Memo } from "../../../worker/domain/memo";
import type { DeliveryState, DeliveryStep } from "../../../worker/domain/delivery";
import type { OfferTerms, OfferVerdict, RedFlag } from "../../../worker/domain/offers";
import type { BudgetSignal, Evidence } from "../../../worker/domain/prospects";

interface Contact {
  id: string;
  kind: "form" | "role_email" | "agency";
  value: string;
  found_on_url: string;
}
interface Offer {
  id: string;
  pasted: string;
  terms: OfferTerms;
  flags: RedFlag[];
  verdict: OfferVerdict;
  source: "ai" | "rules";
  createdAt: string;
}
interface Pkg {
  id: string;
  name: string;
  what: string;
  items: PackageItem[];
  startingAt: number | null;
  onRequest: boolean;
  floor: number | null;
  target: number | null;
}
interface Deliverable {
  id: string;
  clip_id: string | null;
  platform: Platform;
  due_at: string;
  note: string;
  done: boolean;
}
export interface DealDetail {
  deal: { id: string; stage: DealStage; stageLabel: string; outcomeReason: string | null; invoiceNumber: string | null; invoiceDueAt: string | null; paidAt: string | null; paidPartnership: boolean; pitchedAt: string | null; followupsSent: number; followupsTotal: number; nextFollowupAt: string | null; archivedAt?: string | null };
  brand: { id: string; name: string; kind: "brand" | "agency" | "local"; website: string | null; programUrl: string | null; socials: Record<string, string>; fitReasons: string[]; why: Evidence[]; budget: BudgetSignal; sources: string[]; contacts: Contact[] };
  next: NextAction;
  suggested: string;
  scenarios: { key: string; label: string; when: string }[];
  emails: EmailView[];
  offers: Offer[];
  terms: DealTerms;
  effective: { netDays: number; upfrontPct: number; killFeePct: number; revisionRounds: number };
  memo: Memo;
  delivery: { state: DeliveryState; steps: DeliveryStep[] };
  deliverables: Deliverable[];
  packages: Pkg[];
  addons: AddOnTerms;
  levers: LeverScript[];
  results: { posts: number; views: number; likes: number; comments: number; shares: number; saves: number; asOf: string } | null;
  kit: { url: string; published: boolean };
  timeline: { at: string; what: string; emailId: string | null }[];
  reasons: { declined: string[]; lost: string[] };
  stages: { key: DealStage; label: string; allowed: boolean }[];
}

const KIND = { brand: "Brand", agency: "Agency (books creators)", local: "Local business" } as const;
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US")}`);
function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export function DealView({ dealId, onBack, onChanged }: { dealId: string; onBack: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => get<DealDetail>(`/api/deals/deals/${dealId}`), [dealId]);
  const [closing, setClosing] = useState<"declined" | "lost" | null>(null);
  const [addContact, setAddContact] = useState(false);
  const [markSent, setMarkSent] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLDivElement>(null);
  const offerRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<HTMLDivElement>(null);
  const deliveryRef = useRef<HTMLDivElement>(null);
  useEffect(() => top.current?.scrollIntoView({ block: "start" }), [dealId]);
  const refresh = () => {
    reload();
    onChanged();
  };

  if (loading && !data) return <Skeleton blocks={3} />;
  if (error || !data) return <Notice tone="bad">This deal did not load. Go back and try again.</Notice>;
  const d = data;
  const contact = d.brand.contacts[0] ?? null;

  async function act(path: string, body: unknown, ok: string) {
    try {
      await post(path, body);
      toast.ok(ok);
      refresh();
    } catch (e) {
      toast.bad(e);
    }
  }
  const move = (to: DealStage, ok: string, reason?: string) => act(`/api/deals/deals/${d.deal.id}/stage`, { stage: to, reason }, ok);

  function doNext() {
    const s = d.next.step;
    if (d.next.scenario) return emailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (s === "add_contact") return setAddContact(true);
    if (s === "close_no_reply") return setClosing("lost");
    if (s === "paste_offer") return offerRef.current?.scrollIntoView({ behavior: "smooth" });
    if (s === "set_terms") return termsRef.current?.scrollIntoView({ behavior: "smooth" });
    if (s === "delivery") return deliveryRef.current?.scrollIntoView({ behavior: "smooth" });
    if (s === "make_invoice") return act(`/api/deals/deals/${d.deal.id}/invoice`, {}, "Invoice made. Open it, save it as a PDF, then send the invoice email.");
    if (s === "mark_paid") return act(`/api/deals/deals/${d.deal.id}/paid`, {}, "Paid! It's in your media kit's collaborations too.");
  }
  const nextBtn = d.next.scenario ? "Open the email" : d.next.step === "add_contact" ? "Add their contact" : d.next.step === "close_no_reply" ? "Close as no reply" : d.next.step === "make_invoice" ? "Make the invoice" : d.next.step === "mark_paid" ? "Mark paid" : d.next.step === "delivery" ? "Open the checklist" : d.next.step === "set_terms" ? "Fill in the terms" : null;

  return (
    <div className="deal-view">
      <div ref={top} />
      <button type="button" className="btn quiet small back-btn" onClick={onBack}>
        <Icon name="left" size="sm" />
        All deals
      </button>
      <header className="deal-head">
        <div>
          <h2>{d.brand.name}</h2>
          <div className="row wrap deal-tags">
            <span className="pill">{d.deal.stageLabel}</span>
            <span className="pill">{KIND[d.brand.kind]}</span>
            {d.brand.website ? (
              <a className="link-btn" href={d.brand.website} target="_blank" rel="noreferrer">
                Website
              </a>
            ) : null}
            {d.brand.programUrl ? (
              <a className="link-btn" href={d.brand.programUrl} target="_blank" rel="noreferrer">
                Creator program
              </a>
            ) : null}
            {d.deal.archivedAt ? <span className="pill">Archived {fmtDate(d.deal.archivedAt)}</span> : null}
          </div>
        </div>
        {d.deal.archivedAt ? (
          <button type="button" className="btn quiet small" onClick={() => restoreArchived(toast, "deal", d.deal.id, refresh)}>
            Restore
          </button>
        ) : (
          <button type="button" className="btn quiet small" data-archive-deal onClick={() => archiveWithUndo(toast, "deal", d.deal.id, refresh)}>
            <Icon name="archive" size="sm" /> Archive
          </button>
        )}
      </header>

      <Card accent className={`next-card${d.next.overdue ? " overdue" : ""}`}>
        <div className="card-label">Next step</div>
        <div className="next-label">{d.next.label}</div>
        <p className="soft">{d.next.detail}</p>
        {d.next.dueAt ? <div className={`pill ${d.next.overdue ? "bad" : "warn"}`}>{d.next.overdue ? `Overdue since ${fmtDate(d.next.dueAt)}` : `Due ${fmtDate(d.next.dueAt)}`}</div> : null}
        <div className="btn-row">
          {nextBtn ? (
            <button type="button" className="btn" data-primary onClick={doNext}>
              {nextBtn}
            </button>
          ) : null}
          {d.deal.stage === "follow_up" ? (
            <button type="button" className="btn quiet" onClick={() => move("negotiating", "They replied! Follow-ups stop. Paste what they sent to read the terms.")}>
              They replied
            </button>
          ) : null}
          {d.deal.stage === "pitch" && contact ? (
            <button type="button" className="btn quiet" onClick={() => setMarkSent(true)}>
              I sent my own pitch
            </button>
          ) : null}
          {d.deal.stage === "negotiating" ? (
            <button type="button" className="btn quiet" onClick={() => move("agreed", "Agreed! Confirm it in writing next.")}>
              We agreed a deal
            </button>
          ) : null}
        </div>
      </Card>

      <Card className="why-card">
        <div className="why-grid">
          <div>
            <div className="card-label">Why this {d.brand.kind === "agency" ? "agency" : "brand"}</div>
            {d.brand.why.length ? (
              d.brand.why.map((w) => (
                <p key={w.url}>
                  {w.text}{" "}
                  <a href={w.url} target="_blank" rel="noreferrer" className="src">
                    ({host(w.url)})
                  </a>
                </p>
              ))
            ) : (
              <p>{d.brand.fitReasons.join("; ") || "You added it."}</p>
            )}
          </div>
          <div>
            <div className="card-label">Money signal</div>
            <p>
              <strong>{d.brand.budget.level === "paying" ? "Pays creators" : d.brand.budget.level === "likely" ? "Has a creator program" : "No sign yet that they pay"}</strong>
            </p>
            {d.brand.budget.evidence.map((e) => (
              <p key={e.url} className="soft">
                {e.text}{" "}
                <a href={e.url} target="_blank" rel="noreferrer" className="src">
                  ({host(e.url)})
                </a>
              </p>
            ))}
          </div>
          <div>
            <div className="card-label">Contact</div>
            {contact ? (
              <p>
                <span className="mono">{contact.value}</span>
                <br />
                <span className="hint">
                  Found on{" "}
                  <a href={contact.found_on_url} target="_blank" rel="noreferrer">
                    {host(contact.found_on_url)}
                  </a>
                </span>
              </p>
            ) : (
              <p className="soft">None yet. Public business contacts only.</p>
            )}
            <button type="button" className="link-btn" onClick={() => setAddContact(true)}>
              Add a contact you found
            </button>
          </div>
        </div>
      </Card>

      <div ref={emailRef}>
        <EmailPanel dealId={d.deal.id} scenarios={d.scenarios} suggested={d.suggested} emails={d.emails} contact={contact} kitUrl={d.kit.url} kitPublished={d.kit.published} onChanged={refresh} />
      </div>

      <div ref={offerRef}>
        <OfferPanel d={d} onChanged={refresh} />
      </div>

      <div ref={termsRef}>
        <MemoPanel d={d} onChanged={refresh} />
      </div>

      <Negotiation d={d} />

      {["agreed", "delivering", "invoiced", "paid", "done"].includes(d.deal.stage) ? (
        <div ref={deliveryRef}>
          <DeliveryPanel d={d} onChanged={refresh} />
        </div>
      ) : null}

      <Card className="stage-card">
        <h3>Move this deal</h3>
        <div className="btn-row">
          {d.stages
            .filter((s) => s.allowed && s.key !== "declined" && s.key !== "lost")
            .map((s) => (
              <button key={s.key} type="button" className="btn quiet small" onClick={() => move(s.key, `Moved to ${s.label}.`)}>
                {s.label}
              </button>
            ))}
          {d.stages.find((s) => s.key === "declined")?.allowed ? (
            <button type="button" className="link-btn" onClick={() => setClosing("declined")}>
              I'm saying no
            </button>
          ) : null}
          {d.stages.find((s) => s.key === "lost")?.allowed ? (
            <button type="button" className="link-btn" onClick={() => setClosing("lost")}>
              It didn't happen
            </button>
          ) : null}
        </div>
        {d.deal.outcomeReason ? <p className="hint">Reason: {d.deal.outcomeReason}</p> : null}
      </Card>

      <Card className="timeline-card">
        <h3>Timeline</h3>
        {d.timeline.length ? (
          <ul className="timeline">
            {d.timeline.map((t, i) => (
              <li key={i}>
                <span className="hint nums">{fmtDate(t.at)}</span> {t.what}
              </li>
            ))}
          </ul>
        ) : (
          <p className="soft">Nothing yet.</p>
        )}
      </Card>

      {closing ? <CloseModal kind={closing} reasons={closing === "declined" ? d.reasons.declined : d.reasons.lost} preset={d.next.step === "close_no_reply" ? "No reply after 3 follow-ups" : undefined} onClose={() => setClosing(null)} onDone={(r) => move(closing, closing === "declined" ? "Closed. It won't be suggested again." : "Closed. You can re-pitch next season.", r).then(() => setClosing(null))} /> : null}
      {addContact ? <AddContact brandId={d.brand.id} onClose={() => setAddContact(false)} onAdded={() => { setAddContact(false); refresh(); }} /> : null}
      {markSent ? (
        <SentModal
          label="Your pitch"
          onClose={() => setMarkSent(false)}
          onSent={async (sentAt) => {
            try {
              await post(`/api/deals/deals/${d.deal.id}/stage`, { stage: "follow_up", sent_at: sentAt });
              toast.ok("Marked as sent. Follow-up 1 is due on day 5.");
              setMarkSent(false);
              refresh();
            } catch (e) {
              toast.bad(e);
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ---------- what they sent

function OfferPanel({ d, onChanged }: { d: DealDetail; onChanged: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const last = d.offers[0] ?? null;
  async function read() {
    setBusy(true);
    try {
      await post(`/api/deals/deals/${d.deal.id}/offer`, { text });
      setText("");
      toast.ok("Read. The terms, red flags and a suggested reply are below.");
      onChanged();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  const T = last?.terms;
  return (
    <Card className="offer-card">
      <h3>Paste what the brand sent</h3>
      <label className="field">
        <span className="label">Their email</span>
        <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste their whole email here. We read the fee, deliverables, usage, exclusivity, timing and payment terms." />
      </label>
      <button type="button" className="btn" onClick={read} disabled={busy || text.trim().length < 20}>
        {busy ? "Reading…" : "Read it"}
      </button>
      {last && T ? (
        <div className="offer-read" aria-label="What their email says">
          <div className={`verdict ${last.verdict.verdict}`}>
            <strong>{last.verdict.headline}.</strong> {last.verdict.reason}
            <div className="hint nums">
              Fit {last.verdict.scores.fit}/3 · Budget {last.verdict.scores.budget}/3 · Brief {last.verdict.scores.brief}/3 · Risk {last.verdict.scores.risk}/3 (3 = safest)
            </div>
          </div>
          <dl className="offer-terms">
            {(
              [
                ["Fee", T.fee != null ? usd(T.fee) : null],
                ["Deliverables", T.deliverables],
                ["Usage", T.usage],
                ["Exclusivity", T.exclusivity],
                ["Timing", T.timeline],
                ["Payment", T.payment],
                ["Who's buying", T.buyer === "unknown" ? null : T.buyer === "gifting" ? "Free product (gifting)" : T.buyer],
              ] as [string, string | null][]
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v ? <>{v} <span className="from">from their email</span></> : <span className="soft">Not in their email: ask</span>}</dd>
              </div>
            ))}
          </dl>
          {last.flags.length ? (
            <div className="flags">
              <div className="label">Red flags</div>
              <ul>
                {last.flags.map((f) => (
                  <li key={f.key}>
                    <strong>{f.text}</strong>
                    {f.quote ? <span className="quote">“{f.quote}”</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hint">No red flags found in their wording.</p>
          )}
          <p className="hint">Read by {last.source === "ai" ? "the AI, checked against their words" : "the rules"}. Check each line against their email before you rely on it.</p>
        </div>
      ) : null}
    </Card>
  );
}

// ---------- the deal memo + terms

function MemoPanel({ d, onChanged }: { d: DealDetail; onChanged: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<DealTerms>(d.terms);
  useEffect(() => setT(d.terms), [d.terms]);
  const m = d.memo;
  async function save(p: Partial<DealTerms>) {
    const next = { ...t, ...p };
    setT(next);
    try {
      await patch(`/api/deals/deals/${d.deal.id}`, { terms: p });
      onChanged();
    } catch (e) {
      toast.bad(e);
    }
  }
  const pkg = d.packages.find((x) => x.id === t.packageId);
  return (
    <Card className="memo-card">
      <h3>Deal memo</h3>
      <dl className="memo">
        <div>
          <dt>Who</dt>
          <dd>
            {m.who.brand}
            {m.who.contact ? ` · ${m.who.contact}` : ""} · {m.who.buyer}
          </dd>
        </div>
        <div>
          <dt>What</dt>
          <dd>{m.what}</dd>
        </div>
        <div>
          <dt>Money</dt>
          <dd>
            {m.money.total != null ? (
              <>
                <strong className="nums">{usd(m.money.total)}</strong>
                {m.money.lines.length > 1 ? <span className="hint"> ({m.money.lines.map((l) => `${l.label} ${usd(l.amount)}`).join(" + ")})</span> : null}
                {m.money.upfront ? <div className="hint">{usd(m.money.upfront)} up front</div> : null}
              </>
            ) : (
              "No fee yet"
            )}
            <div className="hint">Kill fee: {m.money.killFee}</div>
          </dd>
        </div>
        <div>
          <dt>Rights</dt>
          <dd>
            Usage: {m.rights.usage}
            <br />
            Exclusivity: {m.rights.exclusivity}
          </dd>
        </div>
        <div>
          <dt>Dates</dt>
          <dd>{m.dates.filter((x) => x.value).map((x) => `${x.label} ${fmtDate(x.value)}`).join(" · ") || "None yet"}</dd>
        </div>
      </dl>
      <details className="terms-edit" open={["negotiating", "agreed"].includes(d.deal.stage)}>
        <summary>Edit the terms</summary>
        <div className="grid cols-2">
          <label className="field">
            <span className="label">Package from your rate card</span>
            <select className="select" value={t.packageId ?? ""} onChange={(e) => save({ packageId: e.target.value || null, deliverables: t.deliverables ?? d.packages.find((x) => x.id === e.target.value)?.what ?? null })}>
              <option value="">None</option>
              {d.packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {!d.packages.length ? (
              <span className="hint">
                <Link to="/deals?tab=kit">Add packages to your rate card</Link>
              </span>
            ) : null}
          </label>
          <label className="field">
            <span className="label">Agreed fee ($)</span>
            <input className="input nums" inputMode="numeric" defaultValue={t.fee ?? ""} key={`fee-${t.fee}`} onBlur={(e) => save({ fee: e.target.value.trim() === "" ? null : Number(e.target.value.replace(/[$,]/g, "")) })} placeholder={pkg?.target ? String(pkg.target) : ""} />
          </label>
          <label className="field">
            <span className="label">Deliverables</span>
            <input className="input" defaultValue={t.deliverables ?? ""} key={`dl-${t.deliverables}`} onBlur={(e) => save({ deliverables: e.target.value })} placeholder="2 TikTok videos + 1 Instagram Reel" />
          </label>
          <label className="field">
            <span className="label">Their contact's name</span>
            <input className="input" defaultValue={t.contactName ?? ""} key={`cn-${t.contactName}`} onBlur={(e) => save({ contactName: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Your idea for them (goes in the pitch)</span>
            <input className="input" defaultValue={t.idea ?? ""} key={`idea-${t.idea}`} onBlur={(e) => save({ idea: e.target.value })} placeholder="a 30-second Sunday brunch reset with your stoneware" />
          </label>
          <label className="field">
            <span className="label">Usage on their channels (days)</span>
            <input className="input nums" inputMode="numeric" defaultValue={t.usageDays} key={`u-${t.usageDays}`} onBlur={(e) => save({ usageDays: Number(e.target.value) || 30 })} />
          </label>
          <label className="field">
            <span className="label">Paid ads from your handle (days)</span>
            <input className="input nums" inputMode="numeric" defaultValue={t.paidUsageDays} key={`pu-${t.paidUsageDays}`} onBlur={(e) => save({ paidUsageDays: Number(e.target.value) || 0 })} />
          </label>
          <label className="field">
            <span className="label">Exclusivity (months)</span>
            <input className="input nums" inputMode="numeric" defaultValue={t.exclusivityMonths} key={`ex-${t.exclusivityMonths}`} onBlur={(e) => save({ exclusivityMonths: Number(e.target.value) || 0 })} />
          </label>
          <label className="field">
            <span className="label">Exclusivity category</span>
            <input className="input" defaultValue={t.exclusivityCategory ?? ""} key={`exc-${t.exclusivityCategory}`} onBlur={(e) => save({ exclusivityCategory: e.target.value })} placeholder="candles" />
          </label>
          <label className="field">
            <span className="label">Draft to them by</span>
            <input className="input" type="date" value={t.draftBy ?? ""} onChange={(e) => save({ draftBy: e.target.value || null })} />
          </label>
          <label className="field">
            <span className="label">Post by</span>
            <input className="input" type="date" value={t.postBy ?? ""} onChange={(e) => save({ postBy: e.target.value || null })} />
          </label>
          <label className="field">
            <span className="label">Payment due (days after invoice)</span>
            <input className="input nums" inputMode="numeric" defaultValue={t.netDays ?? ""} key={`nd-${t.netDays}`} placeholder={String(d.effective.netDays)} onBlur={(e) => save({ netDays: e.target.value.trim() === "" ? null : Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={t.rush} onChange={(e) => save({ rush: e.target.checked })} />
            Rush (under 7 days)
          </label>
        </div>
      </details>
      <details className="contract">
        <summary>Checklist to copy into a contract</summary>
        <ContractChecklist d={d} t={t} />
      </details>
    </Card>
  );
}

function ContractChecklist({ d, t }: { d: DealDetail; t: DealTerms }) {
  const toast = useToast();
  const lines = [
    `Parties: ${d.brand.name} and you (the creator)`,
    `Deliverables: ${t.deliverables ?? "(fill in)"}`,
    `Fee: ${d.memo.money.total != null ? usd(d.memo.money.total) : "(fill in)"}${d.memo.money.lines.length > 1 ? ` (${d.memo.money.lines.map((l) => `${l.label} ${usd(l.amount)}`).join(", ")})` : ""}`,
    `Payment: net-${d.effective.netDays} from invoice${d.memo.money.upfront ? `; ${usd(d.memo.money.upfront)} (${d.effective.upfrontPct}%) up front` : ""}`,
    `Dates: draft by ${t.draftBy ?? "(date)"}; post by ${t.postBy ?? "(date)"}`,
    `Approvals: ${d.effective.revisionRounds} rounds of changes included; more are quoted separately`,
    `Usage: ${d.memo.rights.usage}; ends on the stated date; no perpetual rights`,
    `Exclusivity: ${d.memo.rights.exclusivity}`,
    "Likeness: the creator's name, image and voice are licensed for this campaign's content only",
    "Disclosure: posted with #ad and the platform's paid-partnership label (FTC)",
    `Kill fee: ${d.effective.killFeePct}% if cancelled after the brief is approved; 100% after the content is delivered`,
    "Ownership: the creator keeps ownership of the content; the brand receives the license above",
  ];
  return (
    <div className="contract-list">
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <button type="button" className="btn quiet small" onClick={() => navigator.clipboard.writeText(lines.map((l) => `• ${l}`).join("\n")).then(() => toast.ok("Copied."), () => toast.bad(new Error("Copy it by hand.")))}>
        Copy the checklist
      </button>
    </div>
  );
}

// ---------- negotiation helper (the math lives in worker/domain/ratecard.ts)

function Negotiation({ d }: { d: DealDetail }) {
  const [pkgId, setPkgId] = useState(d.terms.packageId ?? d.packages.find((p) => p.floor != null)?.id ?? d.packages[0]?.id ?? "");
  const theirFromEmail = d.offers[0]?.terms.fee ?? null;
  const [their, setTheir] = useState(theirFromEmail != null ? String(theirFromEmail) : "");
  const [usage, setUsage] = useState(String(d.terms.usageDays || 30));
  const [paid, setPaid] = useState(String(d.terms.paidUsageDays || 0));
  const [excl, setExcl] = useState(String(d.terms.exclusivityMonths || 0));
  const pkg = d.packages.find((p) => p.id === pkgId) ?? null;
  const n = Number(their.replace(/[$,]/g, ""));
  const counter = pkg && their && Number.isFinite(n) && n > 0 ? counterOffer(n, pkg) : null;
  const base = pkg?.target ?? pkg?.startingAt ?? null;
  const q = base ? quote(base, { usageDays: Number(usage) || 30, paidUsageDays: Number(paid) || 0, exclusivityMonths: Number(excl) || 0 }, d.addons) : null;
  return (
    <Card className="nego-card">
      <h3>Negotiation helper</h3>
      {!d.packages.length ? (
        <p className="soft">
          Add packages with a private floor and target to your <Link to="/deals?tab=kit">rate card</Link>, and this works out your counters.
        </p>
      ) : (
        <>
          <div className="grid cols-2">
            <label className="field">
              <span className="label">Package</span>
              <select className="select" value={pkgId} onChange={(e) => setPkgId(e.target.value)}>
                {d.packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {pkg ? <span className="hint nums">Your floor {usd(pkg.floor)} · target {usd(pkg.target)} (private)</span> : null}
            </label>
            <label className="field">
              <span className="label">Their number ($){theirFromEmail != null ? " · from their email" : ""}</span>
              <input className="input nums" inputMode="numeric" value={their} onChange={(e) => setTheir(e.target.value)} placeholder="400" />
            </label>
          </div>
          {counter ? (
            <div className={`counter ${counter.verdict}`} aria-label="Counter-offer">
              <strong>{counter.verdict === "accept" ? "Say yes" : counter.verdict === "counter" ? `Counter at ${usd(counter.counter)}` : counter.verdict === "trim" ? `Trim the scope: ${usd(counter.counter)}` : counter.verdict === "walk" ? "Walk away politely" : "Set your floor and target first"}</strong>
              {counter.math.map((m) => (
                <p key={m} className="hint nums">
                  {m}
                </p>
              ))}
              <p className="say">“{counter.line}”</p>
            </div>
          ) : null}
          <h4>Price the add-ons</h4>
          <div className="grid cols-3">
            <label className="field">
              <span className="label">Usage (days)</span>
              <input className="input nums" inputMode="numeric" value={usage} onChange={(e) => setUsage(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Paid ads (days)</span>
              <input className="input nums" inputMode="numeric" value={paid} onChange={(e) => setPaid(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Exclusivity (months)</span>
              <input className="input nums" inputMode="numeric" value={excl} onChange={(e) => setExcl(e.target.value)} />
            </label>
          </div>
          {q ? (
            <ul className="quote-lines" aria-label="Quote">
              {q.lines.map((l) => (
                <li key={l.label} className="nums">
                  {l.label}: {l.math}
                </li>
              ))}
              <li className="nums total">Total: {usd(q.total)}</li>
            </ul>
          ) : null}
        </>
      )}
      <details className="levers">
        <summary>What to say when they push</summary>
        {d.levers.map((l) => (
          <div key={l.key} className="lever">
            <strong>{l.when}</strong>
            <p className="say">“{l.say}”</p>
            <p className="hint">{l.why}</p>
          </div>
        ))}
      </details>
    </Card>
  );
}

// ---------- delivery

function DeliveryPanel({ d, onChanged }: { d: DealDetail; onChanged: () => void }) {
  const toast = useToast();
  const s = d.delivery.state;
  const [url, setUrl] = useState(s.postUrls[0] ?? "");
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  async function set(p: Partial<DeliveryState>): Promise<boolean> {
    try {
      await patch(`/api/deals/deals/${d.deal.id}`, { delivery: p });
      onChanged();
      return true;
    } catch (e) {
      toast.bad(e);
      return false;
    }
  }
  const stamp = (on: boolean) => (on ? new Date().toISOString() : null);
  // Ticks show at once; the saved state comes back with the reload. A reload only clears the ticks
  // it confirms: clearing them all let the reload from one tick's save undo the next tick while its
  // own save was still on the way (e2e mediakit-deals, 26 Sep 2026: "Clicking the checkbox did not
  // change its state"). A save that fails puts the box back.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  useEffect(
    () =>
      setTicked((t) => {
        const next = { ...t };
        for (const st of d.delivery.steps) if (next[st.key] === st.done) delete next[st.key];
        return next;
      }),
    [d.delivery.steps],
  );
  return (
    <Card className="delivery-card">
      <h3>Delivery</h3>
      <Notice tone="info">
        <span>
          Sponsored clips are flagged <strong>Paid partnership</strong> in Review: the caption gets #ad. Turn on the platform's paid-partnership label when it posts. <Link to="/help/mark-a-paid-partnership">How</Link>
        </span>
      </Notice>
      <ul className="steps">
        {d.delivery.steps.map((st) => (
          <li key={st.key} className={st.done ? "done" : ""}>
            <label className="check">
              <input
                type="checkbox"
                checked={ticked[st.key] ?? st.done}
                onChange={(e) => {
                  const on = e.target.checked;
                  setTicked((t) => ({ ...t, [st.key]: on }));
                  const patchFor: Record<string, Partial<DeliveryState>> = {
                    brief: { briefReceivedAt: stamp(on) },
                    concept: { conceptOkAt: stamp(on) },
                    draft: { draftSentAt: stamp(on) },
                    approved: { approvedAt: stamp(on) },
                    posted: { postedAt: stamp(on), adLabelOn: on },
                    report: { reportSentAt: stamp(on) },
                  };
                  const p = patchFor[st.key];
                  if (p)
                    void set(p).then((ok) => {
                      if (!ok)
                        setTicked((t) => {
                          const next = { ...t };
                          delete next[st.key];
                          return next;
                        });
                    });
                }}
              />
              <span>
                {st.label}
                {st.dueAt && !st.done ? <span className="hint"> · due {fmtDate(st.dueAt)}</span> : null}
                {st.done && st.doneAt ? <span className="hint"> · {fmtDate(st.doneAt)}</span> : null}
                <span className="hint step-hint">{st.hint}</span>
              </span>
            </label>
            {st.key === "approved" && s.draftSentAt && !s.approvedAt ? (
              <button type="button" className="btn quiet small" onClick={() => set({ roundsUsed: s.roundsUsed + 1 })}>
                They asked for changes
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <label className="field">
        <span className="label">Link to the post (for the results report)</span>
        <input className="input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url && url !== s.postUrls[0] && set({ postUrls: [url] })} placeholder="https://www.tiktok.com/@you/video/…" />
      </label>
      {d.results ? (
        <p className="nums">
          From Stats (as of {fmtDate(d.results.asOf)}): {d.results.views.toLocaleString("en-US")} views, {d.results.likes.toLocaleString("en-US")} likes, {d.results.saves.toLocaleString("en-US")} saves, {d.results.shares.toLocaleString("en-US")} shares.
        </p>
      ) : (
        <p className="hint">Results appear here once Stats has the post (connect stats, or upload your TikTok export).</p>
      )}

      <h4>What you owe them</h4>
      {d.deliverables.length ? (
        <div className="list">
          {d.deliverables.map((x) => (
            <div key={x.id} className="list-row deliverable">
              <label className="check">
                <input type="checkbox" aria-label={`Done: ${PLATFORM_LABEL[x.platform]} due ${fmtDate(x.due_at)}`} checked={x.done} onChange={() => patch(`/api/deals/deals/${d.deal.id}/deliverables/${x.id}`, { done: !x.done }).then(onChanged, (e) => toast.bad(e))} />
              </label>
              <div className="grow">
                <div className="title">
                  {PLATFORM_LABEL[x.platform]} · due {fmtDate(x.due_at)}
                </div>
                {x.note ? <div className="meta">{x.note}</div> : null}
              </div>
              <button type="button" className="link-btn" onClick={() => del(`/api/deals/deals/${d.deal.id}/deliverables/${x.id}`).then(onChanged, (e) => toast.bad(e))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {["agreed", "delivering", "invoiced"].includes(d.deal.stage) ? (
        <div className="row wrap deliverable-add">
          <select className="select" aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
          <input className="input" type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
          <input className="input" aria-label="Note" placeholder="What they asked for" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!due}
            onClick={async () => {
              try {
                await post(`/api/deals/deals/${d.deal.id}/deliverables`, { platform, due_at: `${due}T17:00:00`, note });
                toast.ok("Added.");
                setDue("");
                setNote("");
                onChanged();
              } catch (e) {
                toast.bad(e);
              }
            }}
          >
            Add
          </button>
        </div>
      ) : null}

      <h4>Invoice</h4>
      {d.deal.invoiceNumber ? (
        <div className="btn-row">
          <a className="btn quiet" href={`/api/deals/deals/${d.deal.id}/invoice`} target="_blank" rel="noreferrer">
            Open invoice {d.deal.invoiceNumber}
          </a>
          <span className="hint">Due {fmtDate(d.deal.invoiceDueAt)}</span>
          {d.deal.stage === "invoiced" ? (
            <button type="button" className="btn" onClick={() => post(`/api/deals/deals/${d.deal.id}/paid`).then(() => { toast.ok("Paid! It's in your media kit's collaborations too."); onChanged(); }, (e) => toast.bad(e))}>
              Mark paid
            </button>
          ) : null}
        </div>
      ) : d.deal.stage === "delivering" ? (
        <button type="button" className="btn quiet" onClick={() => post(`/api/deals/deals/${d.deal.id}/invoice`).then(() => { toast.ok("Invoice made."); onChanged(); }, (e) => toast.bad(e))}>
          Make the invoice
        </button>
      ) : (
        <p className="hint">Once the content is made, make the invoice here.</p>
      )}
    </Card>
  );
}

// ---------- modals

function CloseModal({ kind, reasons, preset, onClose, onDone }: { kind: "declined" | "lost"; reasons: string[]; preset?: string; onClose: () => void; onDone: (reason: string) => void }) {
  const [reason, setReason] = useState(preset ?? reasons[0] ?? "");
  const [other, setOther] = useState("");
  const final = reason === "other" ? other.trim() : reason;
  return (
    <Modal title={kind === "declined" ? "Say no to this one" : "It didn't happen"} onClose={onClose}>
      <p className="soft">Pick why. The dashboard learns from it, and a brand you said no to isn't suggested again.</p>
      <fieldset className="reasons">
        {reasons.map((r) => (
          <label key={r} className="check">
            <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />
            {r}
          </label>
        ))}
        <label className="check">
          <input type="radio" name="reason" checked={reason === "other"} onChange={() => setReason("other")} />
          Something else
        </label>
        {reason === "other" ? <input className="input" aria-label="Reason" value={other} onChange={(e) => setOther(e.target.value)} /> : null}
      </fieldset>
      <div className="btn-row">
        <button type="button" className="btn" disabled={!final} onClick={() => onDone(final)}>
          Close the deal
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export function AddContact({ brandId, onClose, onAdded }: { brandId: string; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<"role_email" | "form" | "agency">("role_email");
  const [value, setValue] = useState("");
  const [page, setPage] = useState("");
  async function save() {
    try {
      await post(`/api/deals/brands/${brandId}/contacts`, { kind, value, found_on_url: page });
      toast.ok("Contact added.");
      onAdded();
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <Modal title="Add a public contact" onClose={onClose}>
      <p className="soft">Only business contacts the brand publishes, like partnerships@ or an application form. Never a personal address.</p>
      <label className="field">
        <span className="label">Type</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="role_email">Business email (partnerships@, pr@ …)</option>
          <option value="form">Application form link</option>
          <option value="agency">Their agency</option>
        </select>
      </label>
      <label className="field">
        <span className="label">{kind === "form" ? "Form link" : "Email"}</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">The page you found it on</span>
        <input className="input" inputMode="url" placeholder="https://brand.com/contact" value={page} onChange={(e) => setPage(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn" onClick={save} disabled={!value || !page}>
          Add contact
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
