// Practice mode, on every screen (studio brief §3): while any service on Setup has no key, its
// feature runs on a stand-in. This line says which, in plain words, and links to Setup. It is a
// label, never an error, and it never hides anything.
import { Link } from "react-router-dom";
import { SETUP_STEPS } from "@shared/setup";
import { useApp } from "../state";

export function PracticeBanner() {
  const { me } = useApp();
  const ids = me?.practice ?? [];
  if (!ids.length) return null;
  const names = SETUP_STEPS.filter((s) => ids.includes(s.id)).map((s) => s.title);
  return (
    <div className="practice-banner" role="status" data-practice={ids.join(" ")}>
      <span className="pill warn">Practice mode</span>
      <span className="practice-text">
        {names.length === SETUP_STEPS.length ? "Every outside service runs" : `${names.join(" · ")} ${names.length === 1 ? "runs" : "run"}`} on practice stand-ins until you add your keys.
      </span>
      <Link to="/setup" className="btn small quiet">
        Open Setup
      </Link>
    </div>
  );
}
