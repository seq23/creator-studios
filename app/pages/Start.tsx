// Get set up (owner, 13 Nov 2026): the one calm flow a new studio lands in. Three steps, one at a
// time: where her posts go, a few facts about her business, her first photos and videos. It reads
// the same steps Home counts (worker/routes/home.ts getSetUp), so the two can never disagree. A
// studio that arrives already connected shows "✓ Connected" and she only presses Next.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ConnectionView, HomeSummary } from "@shared/types";
import { get } from "../lib/api";
import { HelpButton, PageHead, Skeleton, useLoad } from "../components/ui";
import "../styles/home.css";

export const START_SEEN_KEY = "ss-start-seen";

const PLACES: { platform: string; name: string; optional?: boolean }[] = [
  { platform: "instagram", name: "Instagram" },
  { platform: "tiktok", name: "TikTok" },
  { platform: "facebook", name: "Facebook", optional: true },
];

export function Start() {
  const home = useLoad(() => get<HomeSummary>("/api/home"));
  const conns = useLoad(() => get<ConnectionView[]>("/api/connections"));
  const [picked, setPicked] = useState<number | null>(null);
  const steps = home.data?.getSetUp ?? null;
  const firstOpen = steps ? Math.max(0, steps.findIndex((s) => !s.done)) : 0;
  const step = picked ?? firstOpen;
  const buffer = conns.data?.find((c) => c.service === "buffer");
  const channels = buffer?.status === "ok" ? ((buffer.meta.channels as { platform: string; connected: boolean }[] | undefined) ?? []) : [];
  const fbPage = buffer?.status === "ok" ? (buffer.meta.facebook as { connected: boolean } | null | undefined) : null;
  const connected = (p: string) => (p === "facebook" ? !!fbPage?.connected : channels.some((c) => c.platform === p && c.connected));
  const later = () => {
    try {
      localStorage.setItem(START_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  if (!home.data || !conns.data)
    return (
      <div className="page start">
        <PageHead title="Get set up" />
        <Skeleton lines={4} />
      </div>
    );

  if (!steps)
    return (
      <div className="page start">
        <PageHead title="You’re set up" lede="Nothing left to do here. Add photos and videos whenever you like." />
        <Link to="/dump" className="btn big" data-primary>
          + Add photos and videos
        </Link>
        <HelpButton guide="getting-started" />
      </div>
    );

  const s = steps[step];
  return (
    <div className="page start" data-start-step={step + 1}>
      <PageHead eyebrow={`Step ${step + 1} of ${steps.length}`} title={step === 0 ? "Where should your posts go?" : step === 1 ? "A few facts about your business" : "Add your first photos and videos"} />

      {step === 0 ? (
        <ul className="home-list" data-places>
          {PLACES.map((p) => {
            const ok = connected(p.platform);
            return (
              <li key={p.platform} data-place={p.platform} data-connected={ok || undefined}>
                <span className="grow">
                  <span className="title">{p.name}</span>
                  <span className="hint">{ok ? "✓ Connected" : p.optional ? "Optional" : "Not connected yet"}</span>
                </span>
                {ok ? null : (
                  <Link to="/settings/connections" className="home-go">
                    Connect ›
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {step === 1 ? (
        <>
          <p>{s.done ? "✓ The studio has your facts and uses them in every post. You can read or change them any time." : "Add a few things about you, like your website or a price list. The studio writes your profile from them and uses it in every post."}</p>
          <Link to="/brain" className={s.done ? "home-go" : "btn"}>
            {s.done ? "Read or change them ›" : "Add your facts ›"}
          </Link>
        </>
      ) : null}
      {step === 2 ? <p>Pick photos and videos from your phone, together. The studio makes your posts and emails you when they are ready to look at.</p> : null}

      <p className="hint">
        <Link to={`/help/${s.guide}`}>How to do this</Link>
      </p>

      <div className="row wrap">
        {step < steps.length - 1 ? (
          <button type="button" className="btn big" data-primary data-start-next onClick={() => setPicked(step + 1)}>
            Next ›
          </button>
        ) : (
          <Link to="/dump" className="btn big" data-primary onClick={later}>
            + Add photos and videos
          </Link>
        )}
        {step > 0 ? (
          <button type="button" className="btn quiet" onClick={() => setPicked(step - 1)}>
            ← Back
          </button>
        ) : null}
        <Link to="/" className="link-btn" data-start-later onClick={later}>
          I’ll do this later
        </Link>
      </div>
      <HelpButton guide="getting-started" />
    </div>
  );
}
