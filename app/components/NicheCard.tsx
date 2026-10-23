// "What's working in your niche" on the Brand page (studio fix, 23 Oct 2026): the newest monthly
// research in a few plain lines, and when the next one comes. Nothing to do; the clips use it.
import { get } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Card, useLoad } from "./ui";

interface NicheView {
  playbook: { formats: string[]; hooks: string[]; caption_tips: string[] } | null;
  summary: string[];
  updated_at: string | null;
  next_on: string | null;
}

export function NicheCard() {
  const v = useLoad(() => get<NicheView>("/api/brain/niche"));
  const d = v.data;
  return (
    <section className="section" id="niche" aria-labelledby="niche-h" data-niche>
      <h2 id="niche-h">What’s working in your niche</h2>
      <Card>
        {!d ? null : d.summary.length ? (
          <>
            <ul className="niche-lines">
              {d.summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {d.playbook?.hooks.length ? <p className="hint">Openings that work: {d.playbook.hooks.slice(0, 3).map((h) => `“${h}”`).join(", ")}.</p> : null}
            <p className="hint">
              Looked up {fmtDate(d.updated_at)}. Your new clips already use it; nothing for you to do. Next look: {fmtDate(d.next_on)}.
            </p>
          </>
        ) : (
          <p className="hint">Once a month the studio looks up what brings people in for businesses like yours, and your clips use it. The first one comes soon after your Brand Profile is locked.</p>
        )}
      </Card>
    </section>
  );
}
