// "Write the email": pick what you need to send (the next step is already picked), tone and
// length, then one draft: three subject lines, the body in her voice from real facts, and the
// "Before you send" check, live as she edits. Open in Gmail / Copy / Mark sent. She sends every
// email herself; the dashboard never sends to a brand. Rules: worker/domain/emails.ts.
import { useEffect, useMemo, useState } from "react";
import { beforeYouSend, type CheckKey } from "@shared/emailcheck";
import { patch, post } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { gmailComposeUrl, pitchAsText } from "../../lib/gmail";
import { Modal, useToast } from "../ui";

export interface EmailView {
  id: string;
  scenario: string;
  label: string;
  subject: string;
  subjects: string[];
  body: string;
  tone: "warm" | "straight" | "short";
  length: "brief" | "standard" | "detailed";
  source: "ai" | "starter";
  status: "draft" | "sent";
  sentAt: string | null;
  createdAt: string;
  checks: { key: CheckKey; label: string; ok: boolean }[];
}

export function EmailPanel({
  dealId,
  scenarios,
  suggested,
  emails,
  contact,
  kitUrl,
  kitPublished,
  onChanged,
}: {
  dealId: string;
  scenarios: { key: string; label: string; when: string }[];
  suggested: string;
  emails: EmailView[];
  contact: { kind: "form" | "role_email" | "agency"; value: string } | null;
  kitUrl: string;
  kitPublished: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [scenario, setScenario] = useState(suggested);
  const [tone, setTone] = useState<EmailView["tone"]>("warm");
  const [length, setLength] = useState<EmailView["length"]>("standard");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => setScenario(suggested), [suggested]);
  const latest = emails.find((e) => e.scenario === scenario && e.status === "draft") ?? null;
  const [draft, setDraft] = useState<EmailView | null>(latest);
  useEffect(() => setDraft(latest), [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = scenarios.find((s) => s.key === scenario);

  const checkKeys = useMemo(() => (draft ? draft.checks.map((c) => c.key) : []), [draft]);
  const checks = draft ? beforeYouSend(`${draft.subject}\n${draft.body}`, checkKeys, kitUrl) : [];

  async function write() {
    setBusy(true);
    try {
      const r = await post<{ email: EmailView; note: string | null }>(`/api/deals/deals/${dealId}/emails`, { scenario, tone, length });
      setDraft(r.email);
      if (r.note) toast.ok(r.note);
      onChanged();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(p: Partial<Pick<EmailView, "subject" | "body">>) {
    if (!draft) return;
    const next = { ...draft, ...p };
    setDraft(next);
    try {
      await patch(`/api/deals/emails/${draft.id}`, p);
    } catch (e) {
      toast.bad(e);
    }
  }

  const to = contact && contact.kind !== "form" && contact.value.includes("@") ? contact.value : "";
  const gmail = draft ? gmailComposeUrl(to, draft.subject, draft.body) : null;

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(pitchAsText(draft.subject, draft.body));
      toast.ok("Copied. Paste it wherever you're sending it.");
    } catch {
      toast.bad(new Error("Your browser blocked copying. Select the text and copy it by hand."));
    }
  }

  return (
    <section className="email-panel" aria-label="Write the email">
      <h3>Write the email</h3>
      <div className="email-controls">
        <label className="field">
          <span className="label">Which email</span>
          <select className="select" value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {scenarios.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
                {s.key === suggested ? " (next step)" : ""}
              </option>
            ))}
          </select>
          {info ? <span className="hint">{info.when}</span> : null}
        </label>
        <div className="seg" role="radiogroup" aria-label="Tone">
          {(["warm", "straight", "short"] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={tone === t} className={tone === t ? "on" : ""} onClick={() => setTone(t)}>
              {t === "warm" ? "Warm" : t === "straight" ? "Straight" : "Short"}
            </button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Length">
          {(["brief", "standard", "detailed"] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={length === l} className={length === l ? "on" : ""} onClick={() => setLength(l)}>
              {l === "brief" ? "Brief" : l === "standard" ? "Standard" : "Detailed"}
            </button>
          ))}
        </div>
        <button type="button" className="btn" data-primary={!draft || undefined} onClick={write} disabled={busy}>
          {busy ? "Writing…" : draft ? "Rewrite" : "Write it"}
        </button>
      </div>

      {draft ? (
        <div className="email-draft" data-scenario={draft.scenario}>
          <fieldset className="email-subjects">
            <legend className="label">Pick a subject line</legend>
            {draft.subjects.map((s) => (
              <label key={s} className="check">
                <input type="radio" name={`subj-${draft.id}`} checked={draft.subject === s} onChange={() => save({ subject: s })} />
                {s}
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span className="label">Subject</span>
            <input className="input" key={`s-${draft.id}-${draft.subject}`} defaultValue={draft.subject} onBlur={(e) => e.target.value !== draft.subject && save({ subject: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Email</span>
            <textarea className="textarea email-body" key={`b-${draft.id}`} defaultValue={draft.body} onBlur={(e) => e.target.value !== draft.body && save({ body: e.target.value })} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          <p className="hint">
            {draft.source === "ai" ? "Written by the AI from your facts. " : "Starter draft from your facts. "}
            Edit anything; it saves when you tap outside the box.
          </p>

          {checks.length ? (
            <div className="before-send" aria-label="Before you send">
              <div className="label">Before you send</div>
              <ul>
                {checks.map((c) => (
                  <li key={c.key} className={c.ok ? "ok" : "miss"}>
                    <span aria-hidden="true">{c.ok ? "✓" : "○"}</span> {c.label}
                    {c.ok ? "" : " (not yet)"}
                  </li>
                ))}
              </ul>
              {!kitPublished && checkKeys.includes("kit") ? <p className="hint">Your media kit isn't published yet, so the link shows nothing. Publish it on the Media kit tab first.</p> : null}
            </div>
          ) : null}

          <div className="btn-row send-row">
            {contact?.kind === "form" ? (
              <a className="btn big" href={contact.value} target="_blank" rel="noreferrer" onClick={copy}>
                Open their form
              </a>
            ) : gmail ? (
              <a className="btn big" href={gmail} target="_blank" rel="noreferrer">
                Open in Gmail
              </a>
            ) : null}
            <button type="button" className="btn quiet" onClick={copy}>
              Copy
            </button>
            {draft.status === "draft" ? (
              <button type="button" className="btn quiet" onClick={() => setSending(true)}>
                Mark sent
              </button>
            ) : (
              <span className="pill ok">Sent {fmtDate(draft.sentAt)}</span>
            )}
          </div>
          {contact?.kind === "form" ? <p className="hint">Open their form copies this email too, so you can paste it in.</p> : !to ? <p className="hint">No email address yet: Open in Gmail leaves "To" empty. Reply in their Gmail thread, or add their contact above.</p> : null}
        </div>
      ) : (
        <p className="soft">Tap Write it: the email is written from this deal's facts, your numbers and your rate card.</p>
      )}

      {sending && draft ? (
        <SentModal
          label={draft.label}
          onClose={() => setSending(false)}
          onSent={async (sentAt) => {
            try {
              await post(`/api/deals/emails/${draft.id}/sent`, { sent_at: sentAt });
              toast.ok("Marked as sent. The next step is on the card.");
              setSending(false);
              onChanged();
            } catch (e) {
              toast.bad(e);
            }
          }}
        />
      ) : null}
    </section>
  );
}

export function SentModal({ label, onClose, onSent }: { label: string; onClose: () => void; onSent: (sentAt: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  const min = useMemo(() => new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10), []);
  return (
    <Modal title="Mark as sent" onClose={onClose}>
      <p>{label}: when did you send it from Gmail?</p>
      <label className="field">
        <span className="label">When did you send it?</span>
        <input className="input" type="date" value={day} min={min} max={today} onChange={(e) => setDay(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => onSent(day === today ? new Date().toISOString() : `${day}T12:00:00.000Z`)}>
          Yes, I sent it
        </button>
        <button type="button" className="btn quiet" onClick={onClose}>
          Not yet
        </button>
      </div>
    </Modal>
  );
}
