// "Looks like someone else's video" on a dump (worker/domain/sourceCheck.ts): the sentence, the
// one-tap "This is my video", and the guide. Shown on Dump and on the dump's group in Review.
import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api";
import { Notice, useToast } from "./ui";

export function HeldNotice({ dumpId, note, onDone }: { dumpId: string; note: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function mine() {
    setBusy(true);
    try {
      await post(`/api/dumps/${dumpId}/mine`);
      toast.ok("Thanks. Its clips can go on your calendar now.");
      onDone();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Notice tone="warn">
      <span className="grow" data-held-note>
        {note} <Link to="/help/someone-elses-video">Why?</Link>
      </span>
      <button className="btn small" onClick={mine} disabled={busy}>
        This is my video
      </button>
    </Notice>
  );
}
