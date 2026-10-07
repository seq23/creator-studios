import { useState, type FormEvent } from "react";
import { post } from "../lib/api";
import { useApp } from "../state";
import { useToast } from "../components/ui";
import { LegalLinks } from "../components/Shell";
import { Wordmark } from "../components/Wordmark";
import { studio } from "../lib/studio";

export function Login() {
  const { refreshMe } = useApp();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  // A first-login invite link (#invite=<token>, printed by `npm run studio:invite`): the hash never
  // reaches a server log; the token is traded once for the studio's owner email.
  const invite = new URLSearchParams(window.location.hash.slice(1)).get("invite");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = invite
        ? await post<{ ok: boolean; dev_code?: string }>("/api/auth/invite", { token: invite, email })
        : await post<{ ok: boolean; dev_code?: string }>("/api/auth/request", { email });
      if (invite) window.history.replaceState(null, "", window.location.pathname);
      setDevCode(r.dev_code ?? null);
      setStage("code");
    } catch (err) {
      toast.bad(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/api/auth/verify", { email, code });
      await refreshMe();
    } catch (err) {
      toast.bad(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-title">
          <h1 aria-label={studio().appName}>
            <Wordmark size="lg" />
          </h1>
          <span className="script">welcome back</span>
        </div>
        {stage === "email" ? (
          <form onSubmit={request} className="section">
            <div className="field">
              {invite ? <p className="hint">Welcome to {studio().appName}. Type the email you will log in with from now on: it becomes this studio's owner login.</p> : null}
              <label htmlFor="email">Your email</label>
              <input id="email" className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              <div className="hint">We email you a 6-digit code. No password to remember.</div>
            </div>
            <button className="btn big block" data-primary disabled={busy}>
              {busy ? "Sending…" : invite ? "Claim my studio" : "Email me a code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="section">
            <div className="field">
              <label htmlFor="code">The code from your email</label>
              <input id="code" className="input code-input" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" autoFocus />
              <div className="hint">Sent to {email}. It works for 10 minutes.</div>
              {devCode ? (
                <div className="notice info">
                  Local mode: your code is <strong className="mono">{devCode}</strong>
                </div>
              ) : null}
            </div>
            <button className="btn big block" data-primary disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Log in"}
            </button>
            <button type="button" className="btn quiet block" onClick={() => setStage("email")}>
              Use a different email
            </button>
          </form>
        )}
        <LegalLinks />
      </div>
    </div>
  );
}
