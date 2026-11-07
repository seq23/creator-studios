// The niche brief, in one calm line (owner, 7 Nov 2026): while it is researched, "Learning your niche
// first, about a minute"; if the free research failed, the named stop with Try again; once ready, a
// quiet line. Nothing for a studio from before briefs. Worker: worker/routes/setup.ts /brief.
import { useEffect, useState } from "react";
import { get, post } from "../lib/api";
import { useToast } from "./ui";

type Brief = { state: "ready" | "researching" | "failed" | "none"; message: string | null; accounts?: number; researched_on?: string | null };

export function NicheBriefLine() {
  const [b, setB] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = () => get<Brief>("/api/setup/brief").then(setB).catch(() => setB(null));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (b?.state !== "researching") return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [b?.state]);
  if (!b || b.state === "none") return null;
  if (b.state === "ready")
    return (
      <p className="hint" data-niche-brief="ready">
        Your niche brief is ready: {b.accounts} accounts in your niche studied{b.researched_on ? ` (${b.researched_on})` : ""}.
      </p>
    );
  if (b.state === "researching")
    return (
      <p className="notice info" role="status" data-niche-brief="researching">
        {b.message}
      </p>
    );
  const retry = async () => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/setup/brief/retry");
      toast.ok(r.message);
      await load();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice warn niche-stop" role="alert" data-niche-brief="failed">
      <p>{b.message}</p>
      <button className="btn" onClick={retry} disabled={busy}>
        {busy ? "Trying again…" : "Try again"}
      </button>
    </div>
  );
}
