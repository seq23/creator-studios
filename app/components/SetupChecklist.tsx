// "Your 19 videos are saved. Two quick steps first, then your clips start by themselves:" — the
// setup a dump waits for (worker/lib/setupWait.ts), as a plain checklist with a link per step and
// a ✓ on the steps already done. Calm: info tone, never red; nothing for her to press again.
import { Link } from "react-router-dom";
import type { SetupStep } from "@shared/types";
import { Notice } from "./ui";

const NUMBERS = ["①", "②", "③"];

export function setupLine(files: number, steps: SetupStep[]): string {
  const left = steps.filter((s) => !s.done).length;
  const what = files === 1 ? "Your video is saved." : `Your ${files} videos are saved.`;
  return `${what} ${left === 1 ? "One quick step" : "Two quick steps"} first, then your clips start by themselves:`;
}

/** "Waiting for: Approve your Research Brief" (the dump card, collapsed). */
export function waitingLine(steps: SetupStep[]): string {
  const left = steps.filter((s) => !s.done).map((s) => s.label);
  return left.length ? `Waiting for: ${left.join(", then ")}` : "Starting your clips now";
}

export function SetupChecklist({ files, steps }: { files: number; steps: SetupStep[] }) {
  return (
    <Notice tone="info">
      <div data-setup-checklist>
        <strong>{setupLine(files, steps)}</strong>
        <ol className="setup-steps">
          {steps.map((s, i) => (
            <li key={s.key} data-setup-step={s.key} data-done={s.done || undefined}>
              <span className="setup-mark" aria-hidden="true">
                {s.done ? "✓" : NUMBERS[i]}
              </span>
              <span className="grow">
                {s.done ? (
                  <span>{s.label}: done</span>
                ) : (
                  <Link to={s.href} className="btn small" data-primary>
                    {s.label} →
                  </Link>
                )}
                {s.note && !s.done ? <span className="hint setup-note"> {s.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        <span className="hint">You don’t need to press Dump again. We start cutting the moment both are done.</span>
      </div>
    </Notice>
  );
}
