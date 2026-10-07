// The media kit sheet brands see: one page on the phone, two printed pages on paper. Used by the
// public page (/kit/:slug), the print page (/kit/:slug/print) and the editor's Preview. Every
// figure shows its "as of" date and where it came from; figures she typed are marked
// self-reported (validator `mediakit-deals` checks this file keeps both).
import { useState } from "react";
import { PLATFORM_LABEL, type Platform } from "@shared/constants";
import type { PublicKit } from "../../../worker/domain/kit";

const PROFILE_URL: Record<Platform, (h: string) => string> = {
  tiktok: (h) => `https://www.tiktok.com/${h}`,
  instagram: (h) => `https://www.instagram.com/${h.replace(/^@/, "")}`,
  youtube: (h) => `https://www.youtube.com/${h}`,
};

export function num(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function asOf(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function Clip({ c, print }: { c: PublicKit["showcase"][number]; print: boolean }) {
  const [play, setPlay] = useState(false);
  if (print)
    return (
      <figure className="ks-clip">
        {c.coverUrl ? <img src={c.coverUrl} alt="" /> : <span className="ks-clip-blank" aria-hidden="true" />}
        <figcaption>{c.hook || "Video"}</figcaption>
      </figure>
    );
  return (
    <figure className="ks-clip">
      {play ? (
        <video src={c.mediaUrl} poster={c.coverUrl ?? undefined} controls autoPlay playsInline aria-label={c.hook || "Video"} />
      ) : (
        <button type="button" className="ks-clip-play" onClick={() => setPlay(true)} aria-label={`Play: ${c.hook || "video"}`}>
          {c.coverUrl ? <img src={c.coverUrl} alt="" /> : <span className="ks-clip-blank" aria-hidden="true" />}
          <span className="ks-play" aria-hidden="true">
            ▶
          </span>
        </button>
      )}
      <figcaption>{c.hook || "Video"}</figcaption>
    </figure>
  );
}

export function KitSheet({ kit, print = false, pdfHref }: { kit: PublicKit; print?: boolean; pdfHref?: string }) {
  const mail = kit.contactEmail ? `mailto:${kit.contactEmail}?subject=${encodeURIComponent(`Working together: ${kit.name}`)}` : null;
  const handles = (Object.entries(kit.handles) as [Platform, string][]).filter(([, h]) => h);
  const dates = [...new Set(kit.figures.map((f) => asOf(f.asOf)))];
  return (
    <article className={`ks${print ? " ks-print" : ""}`} aria-label={`${kit.name} media kit`}>
      <header className="ks-cover">
        {kit.photoUrl ? (
          <img className="ks-photo" src={kit.photoUrl} alt={kit.name} />
        ) : (
          <span className="ks-mark">
            <span className="ks-initial" aria-hidden="true">
              {(kit.name || "?").trim().charAt(0).toUpperCase()}
            </span>
          </span>
        )}
        <span className="script ks-script">media kit</span>
        <h1>{kit.name}</h1>
        {kit.positioning ? <p className="ks-positioning">{kit.positioning}</p> : null}
        {kit.niche || kit.location ? <p className="ks-niche">{[kit.niche, kit.location].filter(Boolean).join(" · ")}</p> : null}
        {handles.length ? (
          <div className="ks-handles" aria-label="Profiles">
            {handles.map(([p, h]) => (
              <a key={p} className="ks-chip" href={PROFILE_URL[p](h)} target="_blank" rel="noreferrer">
                {PLATFORM_LABEL[p]} {h}
              </a>
            ))}
          </div>
        ) : null}
        {mail && !print ? (
          <a className="btn big ks-cta" data-primary href={mail}>
            Work with me
          </a>
        ) : null}
      </header>

      {kit.figures.length ? (
        <section className="ks-section ks-glance" aria-label="Audience at a glance">
          <h2>Audience at a glance</h2>
          <div className="ks-figures">
            {kit.figures.map((f) => (
              <div key={f.platform} className="ks-figure" data-asof={f.asOf} data-source={f.source}>
                <div className="ks-fig-p">{PLATFORM_LABEL[f.platform]}</div>
                <div className="ks-fig-n nums">{num(f.followers)}</div>
                <div className="ks-fig-l">followers</div>
                <div className="ks-fig-row nums">
                  {num(f.avgViews)} average {f.platform === "instagram" ? "reach" : "views"}
                  {f.avgSelfReported ? " (self-reported)" : ""}
                </div>
                {f.engagement ? <div className="ks-fig-row nums">{f.engagement.rate}% engagement</div> : null}
                {f.bestTimes.length ? <div className="ks-fig-row">Best times: {f.bestTimes.map((b) => b.label).join(", ")}</div> : null}
                {f.topFormats.length ? <div className="ks-fig-row">Top formats: {f.topFormats.join(", ")}</div> : null}
                <div className="ks-asof">
                  As of {asOf(f.asOf)} · {f.source}
                </div>
              </div>
            ))}
          </div>
          {kit.figures.some((f) => f.engagement) ? <p className="ks-note">Engagement = likes, comments, shares and saves ÷ views, last 90 days.</p> : null}
        </section>
      ) : null}

      {kit.manual.length ? (
        <section className="ks-section" aria-label="Self-reported figures">
          <h2>More about my audience</h2>
          <dl className="ks-manual">
            {kit.manual.map((m) => (
              <div key={m.id} data-self-reported="true">
                <dt>
                  {m.platform ? `${PLATFORM_LABEL[m.platform]}: ` : ""}
                  {m.label}
                </dt>
                <dd className="nums">{m.value}</dd>
                <dd className="ks-asof">Self-reported, as of {asOf(m.asOf)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {kit.bio ? (
        <section className="ks-section" aria-label="About">
          <h2>About</h2>
          <p className="ks-bio">{kit.bio}</p>
        </section>
      ) : null}

      {kit.pillars.length ? (
        <section className="ks-section" aria-label="What I make">
          <h2>What I make</h2>
          <div className="ks-pillars">
            {kit.pillars.map((p) => (
              <div key={p.title} className="ks-pillar">
                <strong>{p.title}</strong>
                {p.text ? <span>{p.text}</span> : null}
              </div>
            ))}
          </div>
          {kit.series.length ? (
            <div className="ks-series">
              <h3>Signature series</h3>
              {kit.series.map((s) => (
                <p key={s.title}>
                  <strong>{s.title}</strong>
                  {s.text ? ` · ${s.text}` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {kit.showcase.length ? (
        <section className="ks-section ks-page2 ks-rest" aria-label="Recent work">
          <h2>Recent work</h2>
          <div className="ks-clips">
            {kit.showcase.map((c) => (
              <Clip key={c.id} c={c} print={print} />
            ))}
          </div>
        </section>
      ) : null}

      {kit.collabs.length ? (
        <section className={`ks-section ks-rest${kit.showcase.length ? "" : " ks-page2"}`} aria-label="Past collaborations">
          <h2>Brands I've worked with</h2>
          <div className="ks-collabs">
            {kit.collabs.map((c) => (
              <div key={c.brand} className="ks-collab">
                {c.logoUrl ? <img src={c.logoUrl} alt="" className="ks-logo" /> : <span className="ks-logo ks-logo-letter">{c.brand.slice(0, 1)}</span>}
                <div>
                  <strong>{c.brand}</strong>
                  {c.what ? <div>{c.what}</div> : null}
                  {c.result ? <div className="ks-result">{c.result}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {kit.packages.length ? (
        <section className="ks-section ks-rest" aria-label="Packages and rates">
          <h2>Packages and rates</h2>
          <div className="ks-packages">
            {kit.packages.map((p) => (
              <div key={p.name} className="ks-package">
                <div className="ks-pkg-top">
                  <strong>{p.name}</strong>
                  <span className="nums">{p.price}</span>
                </div>
                <div className="ks-pkg-what">{p.what}</div>
                {p.note ? <div className="ks-pkg-note">{p.note}</div> : null}
              </div>
            ))}
          </div>
          {kit.addOns.length ? <p className="ks-note">Add-ons: {kit.addOns.join(" · ")}. Every package includes 30 days of reposting on your channels.</p> : null}
        </section>
      ) : null}

      {kit.testimonials.length ? (
        <section className="ks-section ks-says" aria-label="What brands say">
          <h2>What brands say</h2>
          {(print ? kit.testimonials.slice(0, 2) : kit.testimonials).map((t) => (
            <blockquote key={t.quote} className="ks-quote">
              <p>“{t.quote}”</p>
              <footer>
                {t.name}
                {t.role ? `, ${t.role}` : ""}
              </footer>
            </blockquote>
          ))}
        </section>
      ) : null}

      <section className="ks-section ks-contact ks-rest" aria-label="Contact">
        <div className="ks-contact-text">
          <h2>Work with me</h2>
          {kit.contactEmail ? (
            <p>
              <a href={mail!}>{kit.contactEmail}</a>
            </p>
          ) : null}
          <p className="ks-url">{kit.url}</p>
          {!print ? (
            <div className="btn-row">
              {mail ? (
                <a className="btn" href={mail}>
                  Email me
                </a>
              ) : null}
              {pdfHref ? (
                <a className="btn quiet" href={pdfHref} target="_blank" rel="noreferrer">
                  Download PDF
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="ks-qr" dangerouslySetInnerHTML={{ __html: kit.qrSvg }} />
      </section>
      <p className="ks-foot ks-rest">
        {dates.length ? `Figures as of ${dates.join(", ")}, from the platforms. ` : ""}
        {kit.manual.length ? "Self-reported figures are marked. " : ""}
        {kit.version ? `Version ${kit.version}, published ${asOf(kit.publishedAt)}.` : "Preview: not published."}
      </p>
    </article>
  );
}
