// "Today's free AI is used up" (owner, 2 Nov 2026, every studio): a calm note on every screen,
// Setup included, once both free sources are spent for the day (worker/lib/freeAiState.ts). It is a
// nudge, never an alarm: the free AI comes back on its own tomorrow, and her own OpenRouter key,
// pasted on Setup, is used first from then on.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../state";

export const FREE_AI_STEPS = [
  "Go to openrouter.ai and make a free account.",
  "Open Keys and tap Create Key.",
  "Copy the key.",
  "On Setup, paste it under AI writing and tap Save.",
];

export function FreeAiNote() {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  if (!me?.freeAiUsedUp) return null;
  return (
    <div className="free-ai-note" role="status" data-free-ai="used-up">
      <p className="free-ai-line">Today's free AI is used up. To keep going, connect your own OpenRouter account.</p>
      <p className="free-ai-sub">Your own key is used first once it is in. If you wait, the free AI comes back on its own tomorrow.</p>
      {open ? (
        <ol className="free-ai-steps">
          {FREE_AI_STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      <div className="free-ai-actions">
        <button type="button" className="btn small quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the steps ▴" : "Show the steps ▾"}
        </button>
        <Link to="/setup#setup-openrouter" className="btn small quiet">
          Open AI writing on Setup ›
        </Link>
      </div>
    </div>
  );
}
