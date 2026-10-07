// Stats (BUILD_PLAN.md section 4: "What's working: top clips, best times, best cut styles";
// phase 8 learning loop). Her accounts per platform, top videos, best posting times, best cut
// styles, and whether the Calendar is on her own best times yet.
// No login (owner decision 25 Sep 2026): YouTube's public numbers are read with the dashboard's
// key (her channel found through Buffer, or typed once here); Instagram's public numbers when
// Instagram answers, and always the "Your Instagram numbers" form; TikTok from the export she
// uploads (the zip TikTok gives her, or the CSV). The Google / Instagram sign-ins stay visible
// as optional extra detail; nothing here waits on them.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PLATFORMS, PLATFORM_LABEL, type Platform, type Slot } from "@shared/constants";
import { ApiFailure, get, post } from "../lib/api";
import { ago, fmtDate, plural } from "../lib/format";
import { Card, Dot, Empty, HelpButton, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import "../styles/stats.css";

interface StatsData {
  accounts: { platform: Platform; followers: number; avg_views: number; captured_at: string; source: string }[];
  topClips: { id: string; platform: Platform; title: string | null; recipe: string | null; url: string | null; posted_at: string | null; views: number; likes: number; origin: string }[];
  bestTimes: Record<Platform, { day: number; hour: number; posts: number; avg_views: number }[]>;
  bestRecipes: { recipe: string; label: string; posts: number; avg_views: number }[];
  learning: Record<Platform, { videos: number; days: number; needDays: number; ready: boolean }>;
  learnedSlots: Partial<Record<Platform, Slot[]>>;
  learnedAt: string | null;
  connections: { service: string; status: string; last_ok_at: string | null; meta: Record<string, unknown> }[];
  job: { id: string; status: string; safe_error: string | null; created_at: string } | null;
  recapOn: boolean;
  public: {
    youtube: { state: string; checked_at: string; subscribers?: number; views?: number; videos?: number; read?: number } | null;
    youtubeChannel: { id: string; title: string; handle: string | null; source: "buffer" | "typed" | "search" } | null;
    youtubeTyped: string | null;
    instagram: { path: "public" | "manual" | "oauth"; checked_at: string; handle: string | null; why?: string; followers?: number; posts?: number } | null;
    instagramManual: { followers: number; avg_reach: number; updated_at: string } | null;
    instagramReminder: boolean;
  };
}

/** What the YouTube card says about the public numbers, in plain words. */
const YT_STATE: Record<string, string> = {
  no_key: "Practice mode: YouTube numbers start once a YouTube key is added on Setup (YouTube numbers). Everything else on Stats works now.",
  no_channel: "Type your YouTube channel below so we can read its numbers.",
  not_found: "We couldn’t find that YouTube channel. Check the @name below.",
  key_refused: "YouTube refused this dashboard’s key. Your helper has the same message; we’ll try again tomorrow.",
  quota: "YouTube asked us to slow down today. We’ll read your numbers tomorrow.",
  failed: "YouTube didn’t answer this time. We’ll try again tomorrow.",
};

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
const num = (n: number) => n.toLocaleString();
const SERVICE: Record<Platform, string> = { instagram: "meta", youtube: "google", tiktok: "tiktok" };

export function Stats() {
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => get<StatsData>("/api/stats"));
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = !!data?.job && ["queued", "dispatched", "running"].includes(data.job.status);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 6000);
    return () => clearInterval(t);
  }, [running, reload]);

  const conn = (p: Platform) => data?.connections.find((c) => c.service === SERVICE[p]) ?? null;
  // One next step while nothing has been read yet: Update numbers (no sign-in needed).
  const nothingYet = !!data && data.accounts.length === 0;

  async function sync() {
    setBusy("sync");
    try {
      const r = await post<{ youtube: { state: string }; instagram: { path: string }; jobId: string | null }>("/api/stats/sync");
      toast.ok(r.youtube.state === "ok" ? `Numbers updated.${r.jobId ? " Extra detail from your sign-ins in a few minutes." : ""}` : `${YT_STATE[r.youtube.state] ?? "Numbers updated."}`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
      reload();
    }
  }

  async function importTikTok(files: FileList) {
    const f = files[0];
    if (!f) return;
    setBusy("import");
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch("/api/stats/tiktok-import", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json()) as { error?: string; fix_guide?: string; videos?: number; kind?: string; followers?: number | null };
      if (!res.ok) {
        toast.bad(new ApiFailure(res.status, { error: body.error ?? "That file could not be read.", fix_guide: body.fix_guide ?? "upload-your-tiktok-export" }));
        return;
      }
      toast.ok(body.kind === "followers" ? `Follower count updated${body.followers != null ? `: ${num(body.followers)}` : ""}.` : `Imported ${plural(body.videos ?? 0, "TikTok video")}.`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
      reload();
    }
  }

  const hasAny = !!data && (data.accounts.length > 0 || data.topClips.length > 0);

  return (
    <div className="page">
      <PageHead title="Stats" lede="What’s working: your numbers, your best videos and the times your audience watches.">
        <button className={nothingYet ? "btn" : "btn quiet"} data-primary={nothingYet || undefined} onClick={sync} disabled={running || busy === "sync"}>
          {running || busy === "sync" ? "Updating…" : "Update numbers"}
        </button>
        <button className="btn quiet" onClick={() => fileRef.current?.click()} disabled={busy === "import"}>
          {busy === "import" ? "Importing…" : "Upload TikTok export"}
        </button>
        <input ref={fileRef} type="file" hidden aria-label="Choose your TikTok export" accept=".csv,.zip,text/csv,application/zip,application/x-zip-compressed" onChange={(e) => (e.target.files ? importTikTok(e.target.files).finally(() => (e.target.value = "")) : undefined)} />
      </PageHead>

      {loading && !data ? <Skeleton blocks={3} columns={3} /> : null}
      {running ? (
        <Notice tone="info">
          <span>
            <strong>Updating…</strong> started {ago(data?.job?.created_at)}. Your numbers update here when it finishes.
          </span>
        </Notice>
      ) : null}
      {data?.job?.status === "failed" ? (
        <Notice tone="bad">
          <span>
            The last update stopped ({data.job.safe_error ?? "unknown reason"}). <Link to="/help/connect-stats">How to fix</Link>
          </span>
        </Notice>
      ) : null}

      {data && !hasAny ? (
        <Empty title="No results yet" secondary={{ to: "/help/upload-your-tiktok-export", label: "How to get the TikTok export" }}>
          Tap Update numbers: YouTube is read on its own, no sign-in. Add your Instagram numbers below and upload your TikTok export from TikTok Studio. After about 4 weeks of posting, the Calendar switches from the big studies’ times to your own best times.
        </Empty>
      ) : null}

      {data ? (
        <>
          <div className="grid cols-3">
            {PLATFORMS.map((p) => {
              const a = data.accounts.find((x) => x.platform === p);
              const c = conn(p);
              const when = p === "tiktok" ? (c?.meta.last_import_at as string | undefined) : p === "youtube" ? (data.public.youtube?.state === "ok" ? data.public.youtube.checked_at : ((c?.meta.last_sync_at as string | undefined) ?? undefined)) : a?.captured_at;
              return (
                <Card key={p}>
                  <div className="card-label">{PLATFORM_LABEL[p]}</div>
                  {a ? (
                    <>
                      <div className="stat">{num(a.followers)}</div>
                      <div className="hint nums">followers · {num(a.avg_views)} average views</div>
                    </>
                  ) : (
                    <div className="soft">No numbers yet</div>
                  )}
                  <div className="hint" data-source={p}>
                    {sourceLine(p, data, when)}
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="stats-split">
            <YouTubeChannelCard data={data} onChange={reload} />
            <InstagramNumbersCard data={data} onChange={reload} />
          </div>

          <OptionalSignIns data={data} />

          <section className="section" aria-labelledby="learn-h">
            <h2 id="learn-h">Your posting times</h2>
            <Card className="flat">
              <div className="list">
                {PLATFORMS.map((p) => {
                  const L = data.learning[p];
                  const learned = data.learnedSlots[p];
                  return (
                    <div key={p} className="list-row">
                      <span className={`pill ${learned ? "ok" : ""}`}>{learned ? "Your times" : "Study times"}</span>
                      <div className="grow">
                        <div className="title">{PLATFORM_LABEL[p]}</div>
                        <div className="meta nums">
                          {learned
                            ? `From your own results: ${learned.map((s) => `${DAY[s.day]} ${hour(s.hour)}`).join(" · ")}`
                            : `Launch times from the big studies until there are 4 weeks of your results (${Math.min(L.days, L.needDays)} of ${L.needDays} days, ${plural(L.videos, "video")}).`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </section>

          <div className="stats-split">
            <section className="section" aria-labelledby="top-h">
              <h2 id="top-h">Top clips</h2>
              {data.topClips.length === 0 ? (
                <p className="soft">Your best videos show here once results come in.</p>
              ) : (
                <Card className="flat">
                  <ol className="list stats-top">
                    {data.topClips.map((t, i) => (
                      <li key={t.id} className="list-row">
                        <span className="stats-rank nums">{i + 1}</span>
                        <div className="grow">
                          <div className="title stats-ellipsis">{t.title || "Untitled video"}</div>
                          <div className="meta">
                            {PLATFORM_LABEL[t.platform]}
                            {t.posted_at ? ` · ${fmtDate(t.posted_at)}` : ""}
                            {t.origin === "dashboard" ? " · made here" : ""}
                          </div>
                        </div>
                        <div className="stats-views nums">
                          <strong>{num(t.views)}</strong>
                          <span className="meta">views</span>
                        </div>
                        {t.url ? (
                          <a className="btn quiet small" href={t.url} target="_blank" rel="noreferrer" aria-label="Open this video">
                            Open
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </Card>
              )}
            </section>

            <section className="section" aria-labelledby="times-h">
              <h2 id="times-h">Best times</h2>
              {PLATFORMS.map((p) => {
                const rows = data.bestTimes[p];
                const max = Math.max(1, ...rows.map((r) => r.avg_views));
                return (
                  <Card key={p} className="flat">
                    <div className="card-label">{PLATFORM_LABEL[p]}</div>
                    {rows.length === 0 ? <div className="hint">No results yet.</div> : null}
                    {rows.map((r) => (
                      <div key={`${r.day}-${r.hour}`} className="stats-bar">
                        <span className="mono stats-when">
                          {DAY[r.day]} {hour(r.hour)}
                        </span>
                        <div className="meter">
                          <span style={{ width: `${(r.avg_views / max) * 100}%` }} />
                        </div>
                        <span className="meta stats-num">
                          {num(r.avg_views)} avg · {plural(r.posts, "post")}
                        </span>
                      </div>
                    ))}
                  </Card>
                );
              })}
            </section>
          </div>

          <section className="section" aria-labelledby="cuts-h">
            <h2 id="cuts-h">Best cut styles</h2>
            {data.bestRecipes.length === 0 ? (
              <p className="soft">Shows once clips made here have results.</p>
            ) : (
              <Card className="flat">
                {data.bestRecipes.map((r) => (
                  <div key={r.recipe} className="stats-bar">
                    <span className="stats-when">{r.label}</span>
                    <div className="meter">
                      <span style={{ width: `${(r.avg_views / Math.max(1, data.bestRecipes[0].avg_views)) * 100}%` }} />
                    </div>
                    <span className="meta stats-num">
                      {num(r.avg_views)} avg · {plural(r.posts, "post")}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </section>
        </>
      ) : null}
      <HelpButton guide="read-your-stats" />
    </div>
  );
}

/** Where a platform card's numbers come from, in one plain line. */
function sourceLine(p: Platform, data: StatsData, when: string | undefined): string {
  if (p === "tiktok") return when ? `From your export · imported ${ago(when)}` : "Upload the export from TikTok Studio";
  if (p === "youtube") {
    const yt = data.public.youtube;
    if (yt?.state === "ok") return `Public numbers, no sign-in · updated ${ago(yt.checked_at)}`;
    if (when) return `Updated ${ago(when)}`;
    return yt ? (YT_STATE[yt.state] ?? "Tap Update numbers") : "Tap Update numbers: no sign-in needed";
  }
  const ig = data.public.instagram;
  const m = data.public.instagramManual;
  if (ig?.path === "public") return `Public numbers, no sign-in · updated ${ago(ig.checked_at)}`;
  if (ig?.path === "oauth") return when ? `From your Instagram sign-in · updated ${ago(when)}` : "From your Instagram sign-in";
  if (m) return `Your numbers · updated ${ago(m.updated_at)}`;
  return "Add your numbers below (2 minutes)";
}

function YouTubeChannelCard({ data, onChange }: { data: StatsData; onChange: () => void }) {
  const toast = useToast();
  const ch = data.public.youtubeChannel;
  const yt = data.public.youtube;
  const [text, setText] = useState(data.public.youtubeTyped ?? "");
  const [busy, setBusy] = useState(false);
  async function use() {
    setBusy(true);
    try {
      await post("/api/stats/youtube-channel", { channel: text });
      toast.ok(text.trim() ? "Channel saved. Your YouTube numbers are updated." : "Back to the channel Buffer posts to.");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }
  const found = ch ? `${ch.title}${ch.handle ? ` (${ch.handle})` : ""} · ${ch.source === "typed" ? "the channel you typed" : ch.source === "buffer" ? "found through Buffer" : "found by its name"}` : null;
  return (
    <section className="section" aria-labelledby="yt-h">
      <h2 id="yt-h">Your YouTube channel</h2>
      <Card className="flat">
        <div className="list-row">
          <Dot light={yt?.state === "ok" ? "green" : yt ? "yellow" : "grey"} />
          <div className="grow">
            <div className="title">{found ?? "No channel yet"}</div>
            <div className="meta nums">
              {yt?.state === "ok" ? `${num(yt.subscribers ?? 0)} subscribers · ${num(yt.views ?? 0)} views · ${plural(yt.videos ?? 0, "video")}` : yt ? (YT_STATE[yt.state] ?? "") : "Tap Update numbers. No sign-in needed: YouTube numbers are public."}
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="yt-channel">Different channel? Paste its @name or link</label>
          <div className="row">
            <input id="yt-channel" className="input" value={text} placeholder="@yourchannel" onChange={(e) => setText(e.target.value)} />
            <button className="btn quiet" onClick={use} disabled={busy}>
              {busy ? "Checking…" : "Use this channel"}
            </button>
          </div>
          <div className="hint">
            Leave it empty to use the channel Buffer posts to. <Link to="/help/your-youtube-numbers">How to find it</Link>
          </div>
        </div>
      </Card>
    </section>
  );
}

function InstagramNumbersCard({ data, onChange }: { data: StatsData; onChange: () => void }) {
  const toast = useToast();
  const ig = data.public.instagram;
  const m = data.public.instagramManual;
  const [followers, setFollowers] = useState(m ? String(m.followers) : "");
  const [reach, setReach] = useState(m ? String(m.avg_reach) : "");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  async function save() {
    setBusy("save");
    try {
      await post("/api/stats/instagram-numbers", { followers, avg_reach: reach });
      toast.ok("Instagram numbers saved.");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }
  async function remind(on: boolean) {
    setBusy("remind");
    try {
      await post("/api/stats/instagram-reminder", { on });
      toast.ok(on ? (data.recapOn ? "We’ll remind you once a month in your Monday recap email." : "Reminder on. It comes in the Monday recap email: turn that on in Settings → Features.") : "Monthly reminder off.");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }
  async function saveHandle() {
    setBusy("handle");
    try {
      await post("/api/stats/instagram-handle", { handle });
      toast.ok("Instagram name saved.");
      onChange();
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(null);
    }
  }
  const status =
    ig?.path === "public"
      ? `We read your public follower count${ig.handle ? ` for @${ig.handle}` : ""} on our own (${num(ig.followers ?? 0)} followers). Reach isn’t public, so add it here.`
      : ig?.path === "oauth"
        ? "Your Instagram sign-in sends the numbers. You can still add them here any time."
        : "Instagram keeps these numbers behind its login, so you add them here, whenever you like.";
  return (
    <section className="section" aria-labelledby="ig-h">
      <h2 id="ig-h">Your Instagram numbers</h2>
      <Card className="flat">
        <p className="soft" data-ig-path={ig?.path ?? "none"}>
          {status}
        </p>
        <ol className="stats-steps">
          <li>
            Open the <strong>Instagram app</strong> and tap your profile picture.
          </li>
          <li>
            Tap <strong>Professional dashboard</strong>.
          </li>
          <li>
            Under <strong>Insights</strong>, pick the last 30 days: note <strong>Accounts reached</strong> (or Views) and <strong>Followers</strong>.
          </li>
        </ol>
        <div className="stats-form">
          <div className="field">
            <label htmlFor="ig-followers">Followers</label>
            <input id="ig-followers" className="input nums" inputMode="numeric" value={followers} placeholder="4820" onChange={(e) => setFollowers(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ig-reach">Average reach or views</label>
            <input id="ig-reach" className="input nums" inputMode="numeric" value={reach} placeholder="1500" onChange={(e) => setReach(e.target.value)} />
          </div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={save} disabled={busy === "save" || !followers.trim() || !reach.trim()}>
            {busy === "save" ? "Saving…" : "Save my numbers"}
          </button>
          <button className="btn quiet" aria-pressed={data.public.instagramReminder} onClick={() => remind(!data.public.instagramReminder)} disabled={busy === "remind"}>
            {data.public.instagramReminder ? "Monthly reminder on" : "Remind me monthly"}
          </button>
          <Link className="btn quiet" to="/help/update-instagram-numbers">
            Show me how
          </Link>
        </div>
        <div className="hint">{m ? `Last saved ${ago(m.updated_at)}.` : "Nothing saved yet."}</div>
        {!ig?.handle ? (
          <div className="field">
            <label htmlFor="ig-handle">Your Instagram name (so we can read your public follower count)</label>
            <div className="row">
              <input id="ig-handle" className="input" value={handle} placeholder="@yourname" onChange={(e) => setHandle(e.target.value)} />
              <button className="btn quiet" onClick={saveHandle} disabled={busy === "handle" || !handle.trim()}>
                Save
              </button>
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

/** The sign-ins stay visible (nothing hidden), labelled as optional extra detail; nothing waits on them. */
function OptionalSignIns({ data }: { data: StatsData }) {
  const google = data.connections.find((c) => c.service === "google");
  const meta = data.connections.find((c) => c.service === "meta");
  return (
    <section className="section" aria-labelledby="extra-h">
      <h2 id="extra-h">Extra detail (optional)</h2>
      <Card className="flat">
        <p className="soft">
          Everything above works without signing in. Signing in adds a little more (YouTube watch time, Instagram reach per video). Google or Meta may show a warning page until the app is approved; that is expected and safe to skip.
        </p>
        <div className="row wrap">
          <a className="btn quiet small" href="/api/oauth/google/start">
            {google?.status === "ok" ? "Google connected · reconnect" : "Connect with Google (optional)"}
          </a>
          <a className="btn quiet small" href="/api/oauth/meta/start">
            {meta?.status === "ok" ? "Instagram connected · reconnect" : "Connect with Instagram (optional)"}
          </a>
        </div>
      </Card>
    </section>
  );
}
