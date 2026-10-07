// One help guide, step by step (section 12c): "Step n of N", a big screenshot with the numbered
// callout the screenshot job drew (phone version under 900 px), one plain sentence, Back / Next,
// and "Did this work?" at the end. "No" opens the matching fix-it guide or a pre-filled email to
// her helper. Print / PDF prints every step on paper.
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { SettingsShape } from "@shared/types";
import { get, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { GROUPS, INDEX, guide, helperMail, isLoginGuide, lastScreen, shotUrl } from "../lib/guides";
import { useApp } from "../state";
import { SCREEN_ROUTES, type Block, type GuideStep, type Inline } from "../lib/markdown";
import { Empty, HelpButton, Notice, PageHead, useLoad, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import "../styles/help.css";

export function HelpGuide() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const g = guide(slug);
  const entry = INDEX.find((x) => x.slug === slug);
  const settings = useLoad(() => get<SettingsShape>("/api/settings"));
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);
  const total = g?.steps.length ?? 0;
  const n = Math.min(Math.max(1, Number(params.get("step") ?? 1) || 1), Math.max(1, total));

  const { me } = useApp();

  useEffect(() => setAnswer(null), [slug]);

  // No login in open mode, so the "Log in" guide would describe a screen that never appears.
  if (me?.authMode === "open" && entry && isLoginGuide(entry)) return <Navigate to="/help" replace />;

  if (!g) {
    return (
      <div className="page">
        <PageHead crumb={<Link to="/help">Help</Link>} title={entry?.title ?? slug.replace(/-/g, " ")} />
        <Empty title="This guide is being written" cta={{ to: "/help", label: "Back to Help" }}>
          Every screen gets a picture-by-picture guide. Until this one is ready, the Help page lists the others.
        </Empty>
      </div>
    );
  }

  const group = GROUPS.find((x) => x.key === (entry?.group ?? g.meta.group));
  const step = g.steps[n - 1];
  const last = n === total;
  const helper = settings.data?.helper_email ?? null;
  const screenRoute = g.meta.screen ? SCREEN_ROUTES[g.meta.screen] : null;

  const go = (to: number) => setParams(to === 1 ? {} : { step: String(to) }, { replace: true });

  async function feedback(worked: boolean) {
    setAnswer(worked ? "yes" : "no");
    try {
      await post("/api/help/feedback", { slug, worked });
    } catch {
      /* feedback is best effort; the next action still happens */
    }
    if (worked) return;
    if (g!.meta.fix && g!.meta.fix !== slug) nav(`/help/${g!.meta.fix}`);
    else if (helper) window.location.href = helperMail(helper, lastScreen(), g!.meta.title);
  }

  async function reportProblem() {
    try {
      await post("/api/help/feedback", { slug, worked: false, kind: "problem", note: `step ${n}` });
      toast.ok("Thanks. This guide is flagged to be checked.");
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <div className="page guide">
      <PageHead
        crumb={
          <>
            <Link to="/help">Help</Link>
            {group ? (
              <>
                <Icon name="right" size="sm" />
                <span>{group.title}</span>
              </>
            ) : null}
          </>
        }
        title={g.meta.title}
      >
        <button type="button" className="btn quiet" onClick={() => window.print()}>
          Print / PDF
        </button>
      </PageHead>

      <div className="guide-screen-only">
        {g.intro.length ? <Blocks blocks={g.intro} /> : null}
        {total === 0 ? (
          <Notice tone="info">This guide has no steps yet.</Notice>
        ) : (
          <>
            <div className="guide-progress" aria-live="polite">
              <span className="nums">
                Step {n} of {total}
              </span>
              <div className="meter ok" aria-hidden="true">
                <span style={{ width: `${(n / total) * 100}%` }} />
              </div>
            </div>
            <Step step={step} n={n} />
            <div className="guide-nav">
              <button type="button" className="btn quiet" onClick={() => go(n - 1)} disabled={n === 1}>
                <Icon name="left" size="sm" />
                Back
              </button>
              {!last ? (
                <button type="button" className="btn" data-primary onClick={() => go(n + 1)}>
                  Next
                  <Icon name="right" size="sm" />
                </button>
              ) : screenRoute ? (
                <Link className="btn quiet" to={screenRoute}>
                  Open this screen
                </Link>
              ) : null}
            </div>
          </>
        )}

        {last || total === 0 ? (
          <div className="card flat guide-done">
            <h3>Did this work?</h3>
            {g.outro.length ? <Blocks blocks={g.outro} /> : null}
            {answer === "yes" ? (
              <Notice tone="ok">Great. You can close this guide.</Notice>
            ) : answer === "no" && !g.meta.fix && !helper ? (
              <Notice tone="warn">
                <span>
                  Add a helper email in <Link to="/settings">Settings</Link> and this button will email them for you.
                </span>
              </Notice>
            ) : (
              <div className="btn-row">
                <button type="button" className="btn" data-primary onClick={() => feedback(true)}>
                  Yes
                </button>
                <button type="button" className="btn quiet" onClick={() => feedback(false)}>
                  No, show me a fix
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="guide-print-only" aria-hidden="true">
        {g.steps.map((s, i) => (
          <Step key={i} step={s} n={i + 1} />
        ))}
      </div>

      <div className="guide-meta">
        <span>{g.meta.last_checked ? `Last checked: ${fmtDate(g.meta.last_checked, { month: "long", day: "numeric", year: "numeric" })}` : null}</span>
        <button type="button" className="btn quiet small" onClick={reportProblem}>
          Report a problem with this guide
        </button>
      </div>
      <HelpButton guide="getting-started" />
    </div>
  );
}

function Step({ step, n }: { step: GuideStep; n: number }) {
  return (
    <section className="guide-step" aria-label={`Step ${n}`}>
      <h2>
        <span className="step-num">{n}</span>
        {step.title}
      </h2>
      <Shot src={step.image} n={n} />
      <Blocks blocks={step.blocks} />
    </section>
  );
}

function Shot({ src, n }: { src: string | null; n: number }) {
  const desktop = shotUrl(src);
  const phone = shotUrl(src, true);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!desktop || broken) {
    return (
      <div className="guide-shot placeholder" role="img" aria-label={`Picture for step ${n} is coming`}>
        <span>
          Picture for step {n} is on its way.
          <br />
          The words below are all you need.
        </span>
      </div>
    );
  }
  return (
    <div className="guide-shot">
      <picture>
        {phone ? <source media="(max-width: 900px)" srcSet={phone} /> : null}
        <img src={desktop} alt={`Step ${n}: the numbered circle shows where to tap`} onError={() => setBroken(true)} />
      </picture>
    </div>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>
            <Inlines xs={b.inline} />
          </p>
        ) : b.kind === "ul" ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines xs={it} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines xs={it} />
              </li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}

function Inlines({ xs }: { xs: Inline[] }) {
  return (
    <>
      {xs.map((x, i) =>
        x.t === "bold" ? (
          <strong key={i}>{x.v}</strong>
        ) : x.t === "code" ? (
          <code key={i}>{x.v}</code>
        ) : x.t === "link" ? (
          x.href.startsWith("/") ? (
            <Link key={i} to={x.href}>
              {x.v}
            </Link>
          ) : (
            <a key={i} href={x.href} target="_blank" rel="noreferrer">
              {x.v}
            </a>
          )
        ) : (
          <span key={i}>{x.v}</span>
        ),
      )}
    </>
  );
}
