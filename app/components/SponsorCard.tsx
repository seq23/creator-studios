// The one way into Get it sponsored: a card at the top of Brand deals (owner-approved mock-up,
// 23 Oct 2026). Not a menu item. A business studio reads "Get an event sponsored".
import { Link } from "react-router-dom";
import { get } from "../lib/api";
import { useLoad } from "./ui";
import { sponsorWords, type SponsorAskView, type SponsorKind } from "@shared/sponsored";
import "../styles/sponsored.css";

export function SponsorCard() {
  const { data } = useLoad(() => get<{ kind: SponsorKind; asks: SponsorAskView[]; total: number }>("/api/sponsored"));
  const w = sponsorWords(data?.kind ?? "experience");
  const ready = data?.asks.find((a) => a.status === "ready");
  const researching = data?.asks.find((a) => a.status === "researching");
  const line = data?.total ? [`${data.total} saved`, researching ? `${researching.title} is researching` : ready ? `${ready.title} is ready` : null].filter(Boolean).join(" · ") : null;
  return (
    <section className="card sp-card" aria-label={w.cta} data-sponsor-card>
      <h2>{w.cardTitle}</h2>
      <p>{w.cardLine}</p>
      <Link className="btn" to="/deals/sponsored">
        {w.cta} →
      </Link>
      {line ? <p className="hint">{line}</p> : null}
    </section>
  );
}
