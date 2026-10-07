// Help center home (section 12c): search, the Getting Started checklist (ticks remembered on
// this device), guides by topic, the Fix-it section, "Replay the tour", and "Email my helper".
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SettingsShape } from "@shared/types";
import { get } from "../lib/api";
import { CHECKLIST_KEY, GROUPS, TOUR_KEY, guide, helperMail, lastScreen, readStore, searchGuides, visibleGuides, writeStore } from "../lib/guides";
import { useApp } from "../state";
import { Card, HelpButton, PageHead, useLoad } from "../components/ui";
import { Icon } from "../components/Icon";
import "../styles/help.css";

const MINUTES: Record<string, string> = {
  "log-in": "1 min",
  "connect-buffer": "3 min",
  "add-channels-in-buffer": "5 min",
  "connect-stats": "3 min",
  "upload-brand-docs": "5 min",
  "approve-research-brief": "5 min",
  "media-kit": "10 min",
  "record-your-voice": "5 min",
};

// Getting Started: the setup guides she walks once, in order (section 12c guide list). The
// validator help-pictures checks every slug here is a real guide.
export const CHECKLIST = ["log-in", "connect-buffer", "add-channels-in-buffer", "connect-stats", "upload-brand-docs", "approve-research-brief", "media-kit", "record-your-voice"];

export function Help() {
  const nav = useNavigate();
  const { me } = useApp();
  // Open mode (no login) drops the "Log in" guide from the checklist, the topics and search.
  const shown = visibleGuides(me?.authMode);
  const [q, setQ] = useState("");
  const [ticks, setTicks] = useState<string[]>(() => readStore<string[]>(CHECKLIST_KEY, []));
  const settings = useLoad(() => get<SettingsShape>("/api/settings"));
  const results = useMemo(() => searchGuides(q, me?.authMode), [q, me?.authMode]);
  const checklist = CHECKLIST.map((slug) => shown.find((g) => g.slug === slug)).filter((g): g is (typeof shown)[number] => !!g);
  const done = checklist.filter((g) => ticks.includes(g.slug)).length;

  function toggle(slug: string) {
    const next = ticks.includes(slug) ? ticks.filter((s) => s !== slug) : [...ticks, slug];
    setTicks(next);
    writeStore(CHECKLIST_KEY, next);
  }

  function replayTour() {
    try {
      localStorage.removeItem(TOUR_KEY);
    } catch {
      /* ignore */
    }
    nav("/");
  }

  const helper = settings.data?.helper_email ?? null;
  const topics = GROUPS.filter((g) => g.key !== "getting_started" && g.key !== "fix_it");
  const fixIt = shown.filter((g) => g.group === "fix_it" && !g.slug.startsWith("reconnect-") && !g.slug.startsWith("connect-"));
  const reconnects = shown.filter((g) => g.group === "fix_it" && g.slug.startsWith("reconnect-") && g.slug !== "reconnect-an-account");

  return (
    <div className="page help-home">
      <PageHead title="Help" lede="A picture-by-picture guide for every screen. Search for what you need, or start at the top of Getting started.">
        <button type="button" className="btn quiet" onClick={replayTour}>
          Replay the tour
        </button>
      </PageHead>

      <div className="help-search">
        <label htmlFor="help-q" className="sr-only">
          What do you need help with?
        </label>
        <input id="help-q" className="input" type="search" placeholder="What do you need help with?" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>

      {q.trim() ? (
        <section className="section" aria-label="Search results">
          <div className="section-head">
            <h2>{results.length ? `${results.length} guide${results.length === 1 ? "" : "s"}` : "Nothing found"}</h2>
          </div>
          {results.length ? (
            <Card className="flat">
              <div className="list">
                {results.map((g) => (
                  <GuideRow key={g.slug} slug={g.slug} title={g.title} />
                ))}
              </div>
            </Card>
          ) : (
            <p className="soft">Try a shorter word, like “pitch”, “Buffer” or “caption”. Or email your helper below.</p>
          )}
        </section>
      ) : null}

      <div className="help-grid">
        <div className="help-col">
          <section className="section">
            <div className="section-head">
              <h2>Getting started</h2>
              <span className="soft nums">
                {done} of {checklist.length} done
              </span>
            </div>
            <Card className="flat">
              <div className="meter ok" aria-hidden="true">
                <span style={{ width: `${(done / Math.max(1, checklist.length)) * 100}%` }} />
              </div>
              <ol className="checklist">
                {checklist.map((g, i) => {
                  const on = ticks.includes(g.slug);
                  return (
                    <li key={g.slug} className={on ? "on" : ""}>
                      <button type="button" className="tick" aria-pressed={on} aria-label={`${on ? "Untick" : "Tick"} ${g.title}`} onClick={() => toggle(g.slug)}>
                        {on ? <Icon name="check" size="sm" /> : i + 1}
                      </button>
                      <Link to={`/help/${g.slug}`} className="grow checklist-link">
                        {g.title}
                      </Link>
                      <span className="help-minutes nums">{MINUTES[g.slug] ?? ""}</span>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </section>

          <section className="section fixit">
            <div className="section-head">
              <h2>Something’s wrong? Fix it</h2>
            </div>
            <Card className="flat">
              <div className="list">
                {fixIt.map((g) => (
                  <GuideRow key={g.slug} slug={g.slug} title={g.title} />
                ))}
                <GuideRow slug="reconnect-an-account" title="Reconnect an account" />
                <details className="reconnects">
                  <summary>
                    <span className="grow">Reconnect one service</span>
                    <Icon name="right" size="sm" className="reconnects-chev" />
                  </summary>
                  <div className="list">
                    {reconnects.map((g) => (
                      <GuideRow key={g.slug} slug={g.slug} title={g.title} />
                    ))}
                  </div>
                </details>
              </div>
            </Card>
          </section>
        </div>

        <div className="help-col">
          {topics.map((t) => (
            <section key={t.key} className="section">
              <div className="section-head">
                <h2>{t.title}</h2>
              </div>
              <Card className="flat">
                <div className="list">
                  {shown.filter((g) => g.group === t.key).map((g) => (
                    <GuideRow key={g.slug} slug={g.slug} title={g.title} />
                  ))}
                </div>
              </Card>
            </section>
          ))}
        </div>
      </div>

      <Card className="flat stuck">
        <div className="grow">
          <h3>Still stuck?</h3>
          <p className="soft">{helper ? "Email your helper. We’ll include which screen you were on." : "Add a helper in Settings and this button emails them for you."}</p>
        </div>
        {helper ? (
          <a className="btn" href={helperMail(helper, lastScreen())}>
            Email my helper
          </a>
        ) : (
          <Link className="btn quiet" to="/settings">
            Add a helper
          </Link>
        )}
      </Card>
      <HelpButton guide="getting-started" />
    </div>
  );
}

function GuideRow({ slug, title }: { slug: string; title: string }) {
  const steps = guide(slug)?.steps.length ?? 0;
  return (
    <Link to={`/help/${slug}`} className="list-row guide-row">
      <div className="grow">
        <div className="title">{title}</div>
        {steps ? <div className="meta nums">{steps} steps</div> : null}
      </div>
      <Icon name="right" size="sm" className="guide-row-chev" />
    </Link>
  );
}
