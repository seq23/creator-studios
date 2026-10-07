import { Link } from "react-router-dom";
import type { HomeNotice, HomeSummary, HomeYoutubeCard } from "@shared/types";
import { get, post } from "../lib/api";
import { fmtDate, plural } from "../lib/format";
import { foldHealth } from "../lib/health";
import { dismissWithUndo } from "../lib/archive";
import { gbWords } from "@shared/bytes";
import { Card, DismissButton, Dot, Empty, HelpButton, Notice, PageHead, Skeleton, Stat, useLoad, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import { useApp } from "../state";
import { PLATFORM_LABEL, PLATFORMS } from "@shared/constants";
import "../styles/home.css";

type RecentDump = HomeSummary["recentDumps"]["items"][number];

const DUMP_STATUS: Record<RecentDump["status"], { text: string; tone: "ok" | "warn" | "bad" | "" }> = {
  uploading: { text: "Still uploading", tone: "warn" },
  queued: { text: "Waiting to cut", tone: "" },
  cutting: { text: "Cutting…", tone: "" },
  ready: { text: "Ready for review", tone: "ok" },
  reviewed: { text: "Reviewed", tone: "ok" },
  failed: { text: "Needs a look", tone: "bad" },
};

const DOOR_WORDS: Record<RecentDump["door"], string> = { new: "New footage", recycle: "Old posts", youtube: "Full video" };

// Day 358 (docs/reviews/2026-09-26-day-358.md): Home stays one phone screen however much piles
// up. Every list arrives capped by the Worker (shared/constants.ts HOME_CAPS) with its true total;
// "See all (N)" goes to the screen that holds the rest, and every card has a × with Undo.
export function Home() {
  const { me } = useApp();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => get<HomeSummary>("/api/home"));
  const firstName = me?.role === "owner" ? me.ownerName || "" : (me?.email.split("@")[0] ?? "");
  const dismiss = (key: string, text?: string) => dismissWithUndo(toast, key, reload, text);

  async function keepDrafts() {
    try {
      const r = await post<{ kept: number; until: string }>("/api/clips/keep", {});
      toast.ok(`Kept ${plural(r.kept, "clip")} until ${fmtDate(r.until)}.`);
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <div className="page home">
      <PageHead eyebrow={fmtDate(new Date().toISOString(), { weekday: "long", month: "short", day: "numeric" })} title={firstName ? `Hi ${firstName}` : "Hi there"} lede="What needs you today, and how the week is going.">
        <Link to="/dump" className="btn big" data-primary>
          + Dump videos
        </Link>
      </PageHead>

      {loading && !data ? (
        <>
          <Skeleton blocks={4} columns={4} />
          <Skeleton blocks={2} columns={2} />
        </>
      ) : null}
      {error ? <Notice tone="bad">The dashboard could not load your numbers. Pull down to refresh, or check your connection.</Notice> : null}

      {data ? (
        <>
          {data.notices.items.map((n) => (
            <HomeNoticeCard key={n.key} n={n} more={data.notices.total - data.notices.items.length} onDismiss={() => dismiss(n.key)} onKeep={keepDrafts} />
          ))}

          <div className="grid cols-4 home-stats">
            <Card to="/review" accent={data.waiting.clips > 0}>
              <Stat
                label="Waiting for you"
                value={plural(data.waiting.clips, "clip")}
                sub={
                  data.waiting.clips ? (
                    <strong className="home-go">
                      {data.waiting.clipsThisWeek ? `${data.waiting.clipsThisWeek} new in 7 days` : "Review now"} <Icon name="arrow" size="sm" />
                    </strong>
                  ) : data.waiting.dumpsCutting ? (
                    `${plural(data.waiting.dumpsCutting, "dump")} cutting`
                  ) : (
                    "Nothing to review"
                  )
                }
              />
            </Card>
            <Card>
              <Stat
                label="Runway"
                value={Number.isFinite(data.runway.weeks) ? `${data.runway.weeks} weeks` : "∞"}
                meter={{ fraction: Number.isFinite(data.runway.weeks) ? Math.min(1, data.runway.weeks / (data.runway.thresholdWeeks * 2)) : 1, tone: data.runway.weeks < data.runway.thresholdWeeks ? "warn" : "ok" }}
                sub={`${plural(data.runway.approvedClips, "approved clip")} left`}
              />
            </Card>
            <Card>
              <Stat
                label="This week"
                value={
                  <>
                    {data.thisWeek.posted} <small>/ {data.thisWeek.planned} posted</small>
                  </>
                }
              >
                <ul className="home-plats" aria-label="Posted this week per platform">
                  {PLATFORMS.map((p) => (
                    <li key={p}>
                      <span>{PLATFORM_LABEL[p].split(" ")[0]}</span>
                      <span className="nums">
                        {data.thisWeek.perPlatform[p].posted} / {data.thisWeek.perPlatform[p].cap}
                      </span>
                    </li>
                  ))}
                </ul>
              </Stat>
            </Card>
            <Card to={data.health.total === 0 ? "/settings/connections" : "/settings"}>
              <div className="card-label">Health</div>
              {data.health.total === 0 ? (
                <>
                  <div className="hint">Nothing connected yet</div>
                  <strong className="home-go">
                    Connect your accounts <Icon name="arrow" size="sm" />
                  </strong>
                </>
              ) : (
                <>
                  <ul className="home-health">
                    {foldHealth(data.health.items).map((h) => (
                      <li key={h.name}>
                        <Dot light={h.light} />
                        <span className="truncate">{h.label}</span>
                      </li>
                    ))}
                  </ul>
                  {data.health.total > data.health.items.length ? <span className="hint nums">+ {data.health.total - data.health.items.length} more</span> : null}
                </>
              )}
            </Card>
            <div className="card home-voice" data-voice={data.voice.state}>
              <div className="card-label">Your voice overs</div>
              <div className={`home-voice-line${data.voice.state === "problem" ? " bad" : ""}`}>
                {data.voice.state === "problem" ? <Dot light="red" /> : null}
                <span>{data.voice.line}</span>
              </div>
              <Link to={data.voice.link.to} className="home-go">
                {data.voice.link.label} <Icon name="arrow" size="sm" />
              </Link>
            </div>
          </div>

          <div className="split home-lists">
            <section className="section">
              <div className="section-head">
                <h2>Recent dumps</h2>
                <Link to="/dump">
                  {data.recentDumps.total > data.recentDumps.items.length ? `See all (${data.recentDumps.total})` : "All dumps"} <Icon name="arrow" size="sm" />
                </Link>
              </div>
              {data.recentDumps.items.length === 0 ? (
                <Empty title="No dumps yet" cta={{ to: "/dump", label: "Dump your first videos" }}>
                  Drop in phone footage or old videos. The cutter turns them into short clips for you to approve.
                </Empty>
              ) : (
                <Card className="flat">
                  <div className="list">
                    {data.recentDumps.items.map((d) => {
                      const s = DUMP_STATUS[d.status];
                      return (
                        <Link key={d.id} to={d.status === "ready" ? "/review" : `/dump/${d.id}`} className="list-row home-row" data-home-key={d.key}>
                          <div className="grow">
                            <div className="title">
                              {fmtDate(d.created_at)} · {DOOR_WORDS[d.door]} · {plural(d.files, "video")}
                            </div>
                            <div className="meta home-row-extra">{d.clips_made ? `${plural(d.clips_made, "clip")} made` : d.progress ? `${d.progress.step} · ${d.progress.done}/${d.progress.total}` : ""}</div>
                          </div>
                          <span className={`pill ${s.tone}`}>{s.text}</span>
                          <DismissButton label="Hide this dump from Home" onClick={() => dismiss(d.key, "Hidden from Home. It is still on Dump.")} />
                        </Link>
                      );
                    })}
                  </div>
                </Card>
              )}
            </section>

            <section className="section">
              <div className="section-head">
                <h2>Follow-ups</h2>
                <Link to="/deals">
                  {data.followups.total > data.followups.items.length ? `See all (${data.followups.total})` : "Deals"} <Icon name="arrow" size="sm" />
                </Link>
              </div>
              {data.followups.items.length === 0 ? (
                <p className="soft home-empty">Nothing due. Pitches you send from Deals come back here on day 5, 12 and 19.</p>
              ) : (
                <Card className="flat">
                  <div className="list">
                    {data.followups.items.map((f) => {
                      const overdue = Date.parse(f.dueAt) < Date.now() - 86400_000;
                      return (
                        <Link key={f.key} to={`/deals?deal=${f.dealId}`} className="list-row home-row" data-home-key={f.key}>
                          <div className="grow">
                            <div className="title">
                              {f.brand}: {f.what}
                            </div>
                          </div>
                          <span className={`pill ${overdue ? "bad" : "warn"}`}>
                            {overdue ? "Overdue" : "Due"} {fmtDate(f.dueAt)}
                          </span>
                          <DismissButton label={`Hide ${f.brand} from Home`} onClick={() => dismiss(f.key, "Hidden from Home. It is still on Deals.")} />
                        </Link>
                      );
                    })}
                  </div>
                </Card>
              )}
            </section>
          </div>
        </>
      ) : null}
      <HelpButton guide="what-runway-means" />
    </div>
  );
}

function HomeNoticeCard({ n, more, onDismiss, onKeep }: { n: HomeNotice; more: number; onDismiss: () => void; onKeep: () => void }) {
  const tone = n.kind === "storage" ? (n.light === "red" ? "bad" : "warn") : n.kind === "clearing" || (n.kind === "youtube" && (n.card.kind === "removal_soon" || n.card.kind === "youtube_note")) ? "warn" : "info";
  return (
    <Notice tone={tone}>
      <div className="home-card" data-notice={n.kind} data-notice-key={n.key}>
        <span className="grow">
          {n.kind === "youtube" ? (
            <YoutubeCardBody y={n.card} />
          ) : n.kind === "profile" ? (
            <>
              <strong>First things first:</strong> lock your Brand Profile so every clip sounds like you. <Link to="/brain">Open Client Brain</Link>
            </>
          ) : n.kind === "brief" ? (
            <>
              <strong>Your new Research Brief is ready.</strong> <Link to="/research">Read and approve it</Link>
            </>
          ) : n.kind === "storage" ? (
            <>
              <strong>Storage {n.light === "red" ? "almost full" : "filling up"}:</strong> {n.line.split(". ")[0].replace(/\.$/, "")}. <Link to="/settings#storage">See what takes the space</Link>
            </>
          ) : n.kind === "clearing" ? (
            <>
              <strong>
                {plural(n.drafts, "unreviewed clip")} cleared from {fmtDate(n.first_on)}
              </strong>{" "}
              ({gbWords(n.bytes)}).{" "}
              <button type="button" className="link-btn" onClick={onKeep}>
                Keep them
              </button>{" "}
              or <Link to="/review">review them</Link>
            </>
          ) : null}
        </span>
        <span className="home-dismiss">
          <DismissButton label="Hide this notice" onClick={onDismiss} />
          {more > 0 ? (
            <span className="hint nums home-more" title={`${more} more after this`}>
              1 of {more + 1}
            </span>
          ) : null}
        </span>
      </div>
    </Notice>
  );
}

function YoutubeCardBody({ y: card }: { y: HomeYoutubeCard }) {
  // Long YouTube titles are cut and the links sit on one line, so the card stays short on a phone (day 358).
  const y = { ...card, title: card.title.length > 28 ? `${card.title.slice(0, 26).trimEnd()}…` : card.title };
  return (
    <div className="home-yt" data-youtube-card={y.kind}>
      {y.kind === "finish_in_studio" ? (
        <>
          <strong>“{y.title}” is up.</strong> Add its thumbnail and tags:
          <span className="home-yt-links">
            <a href={y.studio_url} target="_blank" rel="noreferrer">
              Open YouTube Studio
            </a>
            {y.thumbnail_url ? (
              <a href={y.thumbnail_url} download>
                Thumbnail
              </a>
            ) : null}
            <Link to="/review?tab=approved">Copy the tags</Link>
          </span>
        </>
      ) : y.kind === "youtube_note" ? (
        <>
          <strong>“{y.title}”:</strong> {y.note}
          {y.link ? (
            <span className="home-yt-links">
              <a href={y.link.url} target="_blank" rel="noreferrer">
                {y.link.label}
              </a>
            </span>
          ) : null}
        </>
      ) : y.kind === "upload_yourself" ? (
        <>
          {y.note ? (
            <>
              <strong>“{y.title}”:</strong> {y.note} We mark it posted when it shows on your channel.
            </>
          ) : (
            <>
              <strong>Buffer couldn't take “{y.title}”.</strong> Upload it on YouTube yourself; we mark it posted when it shows on your channel.
            </>
          )}
          <span className="home-yt-links">
            {y.download_url ? (
              <a href={y.download_url} download>
                Download for YouTube
              </a>
            ) : null}
            <a href={y.studio_url} target="_blank" rel="noreferrer">
              Open YouTube upload
            </a>
          </span>
        </>
      ) : (
        <>
          <strong>“{y.title}” is removed on {fmtDate(y.delete_on!)}</strong> unless you approve it. <Link to="/review">Review it now</Link>
        </>
      )}
    </div>
  );
}
