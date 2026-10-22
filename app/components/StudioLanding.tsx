// A studio's optional one-page landing (studios/<slug>.json → `landing`, worker/routes/studio.ts
// readLanding()): the hero, how-it-works steps and quiet facts, wrapped around the unchanged
// sign-in card. A studio with no landing block renders its children untouched: landing is config,
// never a code fork (one theme per studio is the same shape).
import type { ReactNode } from "react";
import { studio } from "../lib/studio";
import { Wordmark } from "./Wordmark";

export function StudioLanding({ children }: { children: ReactNode }) {
  const landing = studio().landing;
  if (!landing) return <>{children}</>;
  return (
    <div className="landing">
      <section className="landing-hero">
        <Wordmark size="lg" />
        <h1>{landing.heading}</h1>
        <p>{landing.sub}</p>
        <a href="#signin" className="btn big block" data-primary>
          {landing.cta}
        </a>
      </section>
      <section className="landing-steps" aria-label="How it works">
        {landing.steps.map((s, i) => (
          <div className="landing-step" key={s.title}>
            <span className="landing-step-n" aria-hidden="true">
              {i + 1}
            </span>
            <h2>{s.title}</h2>
            <p>{s.body}</p>
          </div>
        ))}
      </section>
      <ul className="landing-facts">
        {landing.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <section id="signin" className="landing-signin">
        <h2 className="landing-signin-heading">{landing.signInHeading}</h2>
        {children}
      </section>
    </div>
  );
}
