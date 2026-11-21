// Settings → Storage and Tidy up (day 358, docs/reviews/2026-09-26-day-358.md). The meter counts
// every file (worker/lib/storage.ts storageReport): green, yellow at 70%, red at 90% of the studio's
// ceiling (the host's shared share, or her own storage's free 10 GB), what takes the space and each
// kind's rule, Measure now, and the fix guide. Use your own storage (owner, 21 Nov 2026): she pastes
// her own S3-compatible bucket (Cloudflare R2 is free up to 10 GB), Test connection writes, reads
// and deletes a test file, Save stores it encrypted, and new files go there. Tidy up (on by default)
// archives finished things at the ages listed here; it never deletes.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StorageView } from "@shared/types";
import { gbWords } from "@shared/bytes";
import { ApiFailure, get, patch, post } from "../lib/api";
import { ago } from "../lib/format";
import { Card, Dot, Notice, Skeleton, Switch, useLoad, useToast } from "./ui";

interface StorageAnswer extends StorageView {
  rules: {
    tidy: { dumpArchiveDays: number; dealArchiveDays: number; quietDealArchiveDays: number; briefArchiveDays: number; failedVoiceArchiveDays: number; unusedVoiceArchiveDays: number };
    files: { postedClipDays: number; draftDays: number; warnDays: number; keepDays: number };
    storage: { yellowAt: number; redAt: number };
    host: { maxStudioGb: number; totalGb: number; rawAfterClipsDays: number; rawAfterUploadDays: number; warnDays: number };
  };
}

const WORD = { green: "Plenty of room", yellow: "Filling up", red: "Almost full" } as const;

export function StorageSection({ owner }: { owner: boolean }) {
  const toast = useToast();
  const s = useLoad(() => get<StorageAnswer>("/api/archive/storage"));
  const [measuring, setMeasuring] = useState(false);

  async function measure() {
    setMeasuring(true);
    try {
      const r = await post<StorageView>("/api/archive/storage/measure");
      s.setData((d) => (d ? { ...d, ...r } : d));
      toast.ok(`Measured: ${r.line}.`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setMeasuring(false);
    }
  }
  async function setTidy(on: boolean) {
    try {
      await patch("/api/archive/tidy", { on });
      s.setData((d) => (d ? { ...d, tidy_on: on } : d));
      toast.ok(on ? "Tidy up is on." : "Tidy up is off. Nothing is archived on its own now.");
    } catch (e) {
      toast.bad(e);
    }
  }

  // Home's "See what takes the space" and the Storage light's link land here (/settings#storage).
  useEffect(() => {
    if (s.data && window.location.hash === "#storage") document.getElementById("storage")?.scrollIntoView({ block: "start" });
  }, [s.data]);

  if (!s.data) return <Skeleton lines={3} />;
  const d = s.data;
  const pct = d.limit_bytes > 0 ? Math.min(100, Math.round((d.used_bytes / d.limit_bytes) * 100)) : 0;
  const t = d.rules.tidy;
  const f = d.rules.files;
  return (
    <>
      <section className="section" id="storage" aria-label="Storage">
        <div className="section-head">
          <h2>Storage</h2>
          <button className="btn quiet small" onClick={measure} disabled={measuring}>
            {measuring ? "Measuring…" : "Measure now"}
          </button>
        </div>
        <Card>
          <div className="storage-head">
            <Dot light={d.light} />
            <strong>{WORD[d.light]}</strong>
            <span className="nums">{d.line}</span>
          </div>
          <div className={`meter storage-meter ${d.light === "green" ? "ok" : d.light === "yellow" ? "warn" : "bad"}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Storage ${pct}% used`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="hint">
            {d.place === "none"
              ? "Your studio keeps your files in your own storage. Add it below before you upload videos or photos."
              : d.place === "own"
                ? `Your files go to your own storage (${d.own?.bucket || "your bucket"}); its free plan is 10 GB. `
                : `Your studio shares the host's storage, so it has ${gbWords(d.limit_bytes)} and files rotate out often: original uploads clear ${d.rules.host.rawAfterClipsDays} days after their clips are made, or ${d.rules.host.rawAfterUploadDays} days after upload, whichever comes first. An upload that would go over ${gbWords(d.limit_bytes)} waits until you use your own storage. `}
            {d.place !== "none" ? `Yellow at ${Math.round(d.rules.storage.yellowAt * 100)}%, red at ${Math.round(d.rules.storage.redAt * 100)}%. Every day the studio clears files by the rules below, and if it is still over ${gbWords(d.budget_bytes)} it clears the oldest originals, rejected clips and posted clips first; never a clip waiting to post, a media kit clip, or a draft without a warning. ` : ""}
            {d.place === "own" && d.host_left_bytes > 0 ? `${gbWords(d.host_left_bytes)} from before is still on the shared storage; it opens as usual and clears by the shared rules. ` : ""}
            {d.measured_at ? `Last measured ${ago(d.measured_at)}.` : ""}{" "}
            {d.light !== "green" ? <Link to="/help/storage-almost-full">What to do when it fills up</Link> : null}
          </div>
          <ul className="storage-kinds">
            {d.kinds
              .filter((k) => k.bytes > 0 || k.count > 0)
              .map((k) => (
                <li key={k.key} data-storage-kind={k.key}>
                  <span className="grow">
                    <strong>{k.label}</strong>
                    {k.count ? <span className="hint nums"> · {k.count}</span> : null}
                    <span className="hint storage-rule">{k.rule}</span>
                  </span>
                  <span className="nums">{gbWords(k.bytes)}</span>
                </li>
              ))}
          </ul>
        </Card>
        <OwnStorage view={d} owner={owner} onChange={s.reload} />
      </section>

      <section className="section" id="tidy" aria-label="Tidy up">
        <h2>Tidy up</h2>
        <Card>
          <Switch checked={d.tidy_on} onChange={(v) => owner && setTidy(v)} label="Tidy up automatically" hint="Moves finished things to Archived so your lists stay short. Nothing is deleted: Show archived brings any of it back." />
          <ul className="tidy-rules">
            <li>Dumps you finished: archived after {t.dumpArchiveDays} days</li>
            <li>Deals that are paid, done, declined or lost: after {t.dealArchiveDays} days</li>
            <li>An open deal with nothing happening (not one you invoiced): after {t.quietDealArchiveDays} days</li>
            <li>Research briefs a newer one replaced: after {t.briefArchiveDays} days</li>
            <li>Voice overs that failed: after {t.failedVoiceArchiveDays} days; never used: after {t.unusedVoiceArchiveDays} days</li>
          </ul>
          <div className="hint">
            Files (always on, to stay inside the free storage): posted clips {f.postedClipDays} days after posting (not media kit clips); clips you never reviewed {f.draftDays} days after they were made, with a warning on Home {f.warnDays} days before and a Keep button ({f.keepDays} more days).
          </div>
        </Card>
      </section>
    </>
  );
}

type Fields = { endpoint: string; bucket: string; access_key_id: string; secret_access_key: string };
const EMPTY: Fields = { endpoint: "", bucket: "", access_key_id: "", secret_access_key: "" };
const FIELD_LABELS: { name: keyof Fields; label: string; placeholder: string; secret?: boolean }[] = [
  { name: "endpoint", label: "Account ID or S3 API address", placeholder: "Your Cloudflare Account ID, or https://…r2.cloudflarestorage.com" },
  { name: "bucket", label: "Bucket name", placeholder: "my-studio-files" },
  { name: "access_key_id", label: "Access Key ID", placeholder: "Paste the Access Key ID", secret: true },
  { name: "secret_access_key", label: "Secret Access Key", placeholder: "Paste the Secret Access Key", secret: true },
];

/** Settings → Storage → Use your own storage: paste, Test connection, Save; or Remove. */
function OwnStorage({ view, owner, onChange }: { view: StorageAnswer; owner: boolean; onChange: () => void }) {
  const toast = useToast();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [open, setOpen] = useState(view.place === "none" || window.location.hash === "#own-storage");
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = FIELD_LABELS.every((f) => fields[f.name].trim());

  useEffect(() => {
    if (window.location.hash === "#own-storage") document.getElementById("own-storage")?.scrollIntoView({ block: "start" });
  }, []);

  async function run(what: "test" | "save") {
    setBusy(what);
    setResult(null);
    try {
      const r = await post<{ ok: boolean; line: string }>(what === "test" ? "/api/archive/storage/own/test" : "/api/archive/storage/own", fields);
      setResult({ ok: true, text: r.line });
      if (what === "save") {
        setFields(EMPTY);
        setOpen(false);
        toast.ok(r.line);
        onChange();
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiFailure ? e.body.error : "That did not work. Try again in a moment." });
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!window.confirm("Stop using your own storage? New files go back to the studio's shared storage, and files already in your bucket stay there (your studio stops reading them).")) return;
    setBusy("remove");
    try {
      await post("/api/archive/storage/own/remove");
      toast.ok("Your own storage is removed from this studio.");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="own-storage">
      <div id="own-storage" className="section-head">
        <h3>Use your own storage</h3>
        {view.place === "own" ? <span className="hint">Connected</span> : null}
      </div>
      {view.place === "own" ? (
        <p className="hint">
          New uploads, clips and voice overs go to <strong>{view.own?.bucket}</strong>
          {view.own?.host ? <> at {view.own.host}</> : null}. Files from before still open from the studio's storage.
        </p>
      ) : (
        <p className="hint">
          {view.place === "none" ? "Your studio needs storage of your own before you upload." : "Keep more files, and keep your originals as long as you like, in storage you own."} Cloudflare R2 is free up to 10 GB, and setup takes about 10 minutes.
        </p>
      )}
      <details className="setup-where" open={view.place === "none"}>
        <summary>How to set up free Cloudflare R2</summary>
        <ol>
          <li>Sign up or log in at dash.cloudflare.com (a free account).</li>
          <li>In the menu, open <strong>R2 Object Storage</strong>. Cloudflare may ask you to add a card to turn R2 on; you pay nothing while you store under 10 GB.</li>
          <li>Tap <strong>Create bucket</strong>, name it (for example my-studio-files), leave the location on Automatic and tap Create.</li>
          <li>Back on the R2 page, copy your <strong>Account ID</strong> and paste it below, with the bucket name.</li>
          <li>Open <strong>Manage API tokens</strong>, then <strong>Create API token</strong>. Pick <strong>Object Read &amp; Write</strong>, choose only your new bucket, and tap Create.</li>
          <li>Copy the <strong>Access Key ID</strong> and the <strong>Secret Access Key</strong> (Cloudflare shows the secret once) and paste them below.</li>
          <li>Tap <strong>Test connection</strong>, then <strong>Save</strong>.</li>
        </ol>
        <p className="hint">Other S3 storage (Backblaze B2, Wasabi, Amazon S3) works too: paste its S3 address instead of the Account ID.</p>
        <a className="btn small quiet" href="https://dash.cloudflare.com/?to=/:account/r2/overview" target="_blank" rel="noreferrer">
          Open Cloudflare R2
        </a>
      </details>
      {view.place === "own" && !open ? (
        <div className="setup-actions">
          <button type="button" className="btn small quiet" disabled={!owner || !!busy} onClick={() => setOpen(true)}>
            Change storage
          </button>
          <button type="button" className="btn small quiet" disabled={!owner || !!busy} onClick={() => void remove()}>
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : !open ? (
        <button type="button" className="btn small" disabled={!owner} onClick={() => setOpen(true)}>
          Add my own storage
        </button>
      ) : (
        <form
          className="setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("save");
          }}
        >
          {FIELD_LABELS.map((f) => (
            <div className="field" key={f.name}>
              <label htmlFor={`own-storage-${f.name}`}>{f.label}</label>
              <input
                id={`own-storage-${f.name}`}
                className="input"
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                placeholder={f.placeholder}
                value={fields[f.name]}
                onChange={(e) => setFields((x) => ({ ...x, [f.name]: e.target.value }))}
              />
            </div>
          ))}
          {result ? <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice> : null}
          <div className="setup-actions">
            <button type="button" className="btn small quiet" disabled={!owner || !ready || !!busy} onClick={() => void run("test")}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" className="btn small" data-primary disabled={!owner || !ready || !!busy}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="hint">Saving checks it again (a test file is written, read back and deleted), then keeps your keys encrypted in your studio.</p>
        </form>
      )}
    </Card>
  );
}
