import { Link } from "react-router-dom";
import type { HomeNotice, HomeSummary, HomeYoutubeCard } from "@shared/types";
import { get, post } from "../lib/api";
import { fmtDate, plural } from "../lib/format";
import { dismissWithUndo } from "../lib/archive";
import { gbWords } from "@shared/bytes";
import { plainDay } from "@shared/posts";
import { makingLine } from "@shared/making";
import { homeRows, postsLeftLine } from "@shared/home";
import { Card, DismissButton, Dot, Empty, HelpButton, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import { useApp } from "../state";
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

  const rows = data ? homeRows(data) : [];

  return (
    <div className="page home">
      <PageHead
        eyebrow={fmtDate(new Date().toISOString(), { weekday: "short", month: "short", day: "numeric" })}
        title={firstName ? `Hi ${firstName}` : "Hi there"}
      >
        {/* One next step per screen: while setting up, it is Get set up. */}
        <Link to="/dump" className="btn big" data-primary={data?.getSetUp ? undefined : true}>
          + Add photos and videos
        </Link>
      </PageHead>

      {/* Posts are being made: when they should be ready, in one line (nothing to keep open). */}
      {data?.waiting.making ? (
        <p className="home-making" data-making>
          {makingLine(data.waiting.making.readyAt)}
        </p>
      ) : null}

      {loading && !data ? <Skeleton blocks={3} /> : null}
      {error ? <Notice tone="bad">Home could not load. Pull down to refresh, or check your connection.</Notice> : null}

      {data ? (
        <>
          {/* The first line answers "does anything need me?" (owner, 13 Nov 2026), on the phone too. */}
          <p className="home-left">
            <span data-needs-you>{rows.length === 0 ? "Nothing needs you today." : rows.length === 1 ? "1 thing needs you." : `${rows.length} things need you.`}</span>{" "}
            <span data-posts-left>{postsLeftLine(data)}</span>
          </p>

          {data.notices.items.map((n) => (
            <HomeNoticeCard key={n.key} n={n} more={data.notices.total - data.notices.items.length} onDismiss={() => dismiss(n.key)} onKeep={keepDrafts} />
          ))}

          {/* One list (owner, 13 Nov 2026): what needs her, each with why and one action. No tiles. */}
          <ul className="home-list" data-home-list>
            {rows.map((r) => (
              <li key={r.key} data-row={r.key}>
                <span className="grow">
                  <span className="title">{r.title}</span>
                  <span className="hint">{r.why}</span>
                </span>
                <Link to={r.to} className={r.primary ? "btn small" : "home-go"} data-primary={r.primary || undefined}>
                  {r.action} ›
                </Link>
              </li>
            ))}
            {!data.getSetUp ? (
              <li data-row="set-up" className="done">
                <span className="grow soft">✓ Set up</span>
              </li>
            ) : null}
          </ul>

          <p className="home-week" data-this-week>
            <strong>This week</strong> · <span data-count="posted">{data.thisWeek.posted} posted</span> · <span data-count="to-go">{data.thisWeek.toGo} still to go out</span> ·{" "}
            <Link to="/calendar" className="home-to-go" title={data.thisWeek.plannedThrough ? `Planned through ${plainDay(data.thisWeek.plannedThrough, data.thisWeek.tz)}` : undefined}>
              See them on Posts ›
            </Link>
          </p>

          <div className="home-voice" data-voice={data.voice.state}>
            <span className="card-label">Your voice overs</span>{" "}
            <span className={`home-voice-line${data.voice.state === "problem" ? " bad" : ""}`}>
              {data.voice.state === "problem" ? <Dot light="red" /> : null}
              <span>{data.voice.line}</span>
            </span>{" "}
            <Link to={data.voice.link.to} className="home-go">
              {data.voice.link.label} <Icon name="arrow" size="sm" />
            </Link>
          </div>

          <div className="split home-lists">
            <section className="section">
              <div className="section-head">
                <h2>What you added</h2>
                <Link to="/dump">
                  {data.recentDumps.total > data.recentDumps.items.length ? `See all (${data.recentDumps.total})` : "See all"} <Icon name="arrow" size="sm" />
                </Link>
              </div>
              {data.recentDumps.items.length === 0 ? (
                <Empty title="Nothing added yet" cta={{ to: "/dump", label: "Add your first photos and videos" }}>
                  Add photos and videos from your phone. The studio turns them into posts for you to look at.
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
                          <DismissButton label="Hide this from Home" onClick={() => dismiss(d.key, "Hidden from Home. It is still on Add.")} />
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
              <strong>First things first:</strong> tell the studio about you, so every post sounds like you. <Link to="/brain">Open Client Brain</Link>
            </>
          ) : n.kind === "brief" ? (
            <>
              <strong>Your Research Brief was updated and is already in use.</strong> <Link to="/research">Read or change it</Link>
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
