// Setup (studio brief §3): the guided screen where the studio's owner pastes each of her own
// service keys. Every step says what it powers, what practice mode does until it is set, where to
// get the key, and has Test key (one live read-only check, nothing saved) and Save (checked again,
// then stored encrypted). Services the studio's host runs for her show "Provided".
import { useState } from "react";
import { SETUP_STEPS, type SetupStatus, type SetupStep, type SetupView } from "@shared/setup";
import { post, get } from "../lib/api";
import { Card, HelpButton, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { useApp } from "../state";
import "../styles/setup.css";

const STATE_LABEL: Record<SetupStatus["state"], { text: string; tone: "ok" | "warn" | "bad" | "" }> = {
  live: { text: "Live · your key", tone: "ok" },
  provided: { text: "Provided by your studio host", tone: "ok" },
  practice: { text: "Practice mode", tone: "warn" },
  error: { text: "Needs a new key", tone: "bad" },
};

export function Setup() {
  const { data, reload } = useLoad(() => get<SetupView>("/api/setup"));
  const { refreshMe } = useApp();
  const done = data ? data.steps.filter((s) => s.state === "live" || s.state === "provided").length : 0;
  return (
    <div className="page setup-page">
      <PageHead
        eyebrow="Setup"
        title="Connect your own services"
        lede="Each service your studio runs on, one at a time. Until a key is in, that feature runs in practice mode: it works, shows sample results, and never posts, sends or spends."
      >
        <HelpButton guide="setup" />
      </PageHead>
      {!data ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <p className="setup-progress" aria-live="polite">
            <strong>
              {done} of {SETUP_STEPS.length}
            </strong>{" "}
            set up
          </p>
          <ol className="setup-steps">
            {SETUP_STEPS.map((step, i) => (
              <li key={step.id}>
                <StepCard
                  n={i + 1}
                  step={step}
                  status={data.steps.find((s) => s.id === step.id)!}
                  view={data}
                  onChange={async () => {
                    await reload();
                    await refreshMe();
                  }}
                />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function StepCard({ n, step, status, view, onChange }: { n: number; step: SetupStep; status: SetupStatus; view: SetupView; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "test" | "save" | "remove">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const label = STATE_LABEL[status.state];
  const ready = step.fields.every((f) => f.optional || (fields[f.name] ?? "").trim());

  async function run(kind: "test" | "save") {
    setBusy(kind);
    setResult(null);
    try {
      const r = await post<{ ok: boolean; note?: string | null }>(`/api/setup/${step.id}/${kind}`, { fields });
      setResult({ ok: true, text: r.note ?? (kind === "test" ? "That key works. Nothing was saved yet: press Save to use it." : "Saved and encrypted. This feature is live now.") });
      if (kind === "save") {
        setFields({});
        await onChange();
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "That did not work. Try again." });
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await post(`/api/setup/${step.id}/remove`);
      toast.ok(`${step.title} removed. It runs in practice mode again.`);
      await onChange();
    } catch (err) {
      toast.bad(err);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card className="setup-step">
      <div className="setup-step-head">
        <span className="setup-n" aria-hidden="true">
          {n}
        </span>
        <h2 className="card-title" id={`setup-${step.id}`}>
          {step.title}
        </h2>
        <span className={`pill ${label.tone}`} data-state={status.state}>
          {label.text}
        </span>
      </div>
      <p>{step.powers}</p>
      {status.state === "practice" ? <Notice tone="info">Practice mode: {step.practice}</Notice> : null}
      {status.state === "error" ? <Notice tone="bad">{status.last_error ?? "The stored key stopped working."} Paste a new one below.</Notice> : null}
      {Object.keys(status.shown).length ? (
        <p className="hint">
          {Object.entries(status.shown)
            .map(([k, v]) => `${step.fields.find((f) => f.name === k)?.label ?? k}: ${v}`)
            .join(" · ")}
        </p>
      ) : null}
      {status.state !== "provided" ? (
        <details className="setup-where" open={status.state === "practice" || status.state === "error"}>
          <summary>Where to get it{step.free ? " (free)" : ""}</summary>
          <ol>
            {step.where.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ol>
          {step.id === "google_app" ? (
            <p className="hint">
              Redirect address: <code className="mono">{view.redirects.google}</code>
            </p>
          ) : null}
          {step.id === "meta_app" ? (
            <p className="hint">
              Redirect address: <code className="mono">{view.redirects.meta}</code>
            </p>
          ) : null}
          {step.id === "github" && view.job_secret ? (
            <p className="hint">
              JOB_SHARED_SECRET value: <code className="mono setup-secret">{view.job_secret}</code>
            </p>
          ) : null}
          <a className="btn small quiet" href={step.link.url} target="_blank" rel="noreferrer">
            {step.link.label}
          </a>
        </details>
      ) : null}
      {status.state !== "provided" ? (
        <form
          className="setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("save");
          }}
        >
          {step.fields.map((f) => (
            <div className="field" key={f.name}>
              <label htmlFor={`${step.id}-${f.name}`}>
                {step.title} · {f.label}
              </label>
              <input
                id={`${step.id}-${f.name}`}
                className="input"
                type={f.plain ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={fields[f.name] ?? ""}
                onChange={(e) => setFields((x) => ({ ...x, [f.name]: e.target.value }))}
              />
            </div>
          ))}
          {result ? <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice> : null}
          <div className="setup-actions">
            <button type="button" className="btn small quiet" disabled={!ready || !!busy} onClick={() => void run("test")}>
              {busy === "test" ? "Testing…" : "Test key"}
            </button>
            <button type="submit" className="btn small" data-primary disabled={!ready || !!busy}>
              {busy === "save" ? "Saving…" : status.state === "live" ? "Replace key" : "Save"}
            </button>
            {status.state === "live" || status.state === "error" ? (
              <button type="button" className="btn small quiet" disabled={!!busy} onClick={() => void remove()}>
                {busy === "remove" ? "Removing…" : "Remove"}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}
