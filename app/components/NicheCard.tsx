// "What's working in your niche" on the Brand page (studio fix, 23 Oct 2026): the newest monthly
// research in a few plain lines, and when the next one comes. Nothing to do; the clips use it.
// Clip quality (23 Oct 2026): also on the Research page, with what it learned from successful public
// creators in her niche (how they open, hooks, lengths, pacing, on-screen words, captions) and what leads.
import { get } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Card, useLoad } from "./ui";
import "../styles/brain.css";

interface NicheView {
  playbook: { formats: string[]; hooks: string[]; caption_tips: string[] } | null;
  summary: string[];
  learned?: string[];
  leads?: "past_videos" | "niche";
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
            {d.learned?.length ? (
              <>
                <h3 className="niche-sub">What the studio learned</h3>
                <ul className="niche-lines" data-niche-learned>
                  {d.learned.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </>
            ) : d.playbook?.hooks.length ? (
              <p className="hint">Openings that work: {d.playbook.hooks.slice(0, 3).map((h) => `“${h}”`).join(", ")}.</p>
            ) : null}
            <p className="hint" data-niche-leads>
              {d.leads === "past_videos"
                ? "Your own past videos lead how your clips are cut and worded; this research backs them up."
                : "Until you add your past videos, this is how your clips are cut and worded. Patterns only: never anyone else's videos or words."}
            </p>
            <p className="hint">
              Looked up {fmtDate(d.updated_at)}. Your new clips already use it; nothing for you to do. Next look: {fmtDate(d.next_on)}.
            </p>
          </>
        ) : (
          <p className="hint">The studio looks up what works for successful accounts like yours (how they open, hooks, lengths, pacing) and your clips follow it. The first one comes soon after your Brand Profile is locked, and again whenever you change it.</p>
        )}
      </Card>
    </section>
  );
}
