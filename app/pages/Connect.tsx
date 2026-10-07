// Connect accounts (section 4b): Buffer (paste key → channels found), stats (no sign-in first:
// YouTube public numbers, Instagram numbers typed on Stats, TikTok export upload on Stats; the
// Instagram and Google sign-ins via /api/oauth stay visible as optional extra detail), AI (OpenRouter), web research (Firecrawl),
// Hunter (optional), Voice overs · ElevenLabs (premium, optional: her own ElevenLabs account; without it
// the free built-in voice is used), Editing apps (docs/EDITORS.md: CapCut and InShot need no key,
// she sends a clip from Review and uploads her edit back; Opus Clip, Vizard, Klap, Submagic and
// Descript connect with her own key and are picked under Settings > Editing > Who edits). Every
// connection has Connect / Check again / Disconnect, plus Disconnect everything. She always logs
// in on the platform's own page.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ConnectionView } from "@shared/types";
import { get, post } from "../lib/api";
import { ago } from "../lib/format";
import { Card, Dot, HelpButton, Modal, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import "../styles/settings.css";
import { useApp } from "../state";
import { PLATFORM_LABEL, type Platform } from "@shared/constants";
import { EDITORS as EDITOR_LIST, HANDOFF } from "@shared/editors";

type Service = ConnectionView["service"];

// `title` is the section-and-vendor name the key box is labelled with (guides and specs find the
// box by it); `name` is the vendor alone, shown as the card title under the numbered step.
const KEY_SERVICES: { service: Service; title: string; name: string; why: string; steps: string[]; guide: string; optional?: boolean; editor?: boolean }[] = [
  { service: "buffer", title: "Posting · Buffer", name: "Buffer", why: "Buffer publishes your clips to TikTok, Instagram and YouTube.", steps: ["Open Buffer → Settings → API", "Click Create key, then copy it", "Paste it here"], guide: "connect-buffer" },
  { service: "openrouter", title: "AI · OpenRouter", name: "OpenRouter", why: "Writes captions, hooks, your Research Brief and pitch drafts. Free models by default.", steps: ["Open openrouter.ai → Keys", "Create key, copy it", "Paste it here"], guide: "connect-openrouter" },
  { service: "firecrawl", title: "Web research · Firecrawl", name: "Firecrawl", why: "Optional, faster web research for your Research Brief and brand finder. 1,000 free credits a month. Without it the dashboard searches the web for free.", steps: ["Open firecrawl.dev → API Keys", "Copy your key", "Paste it here"], guide: "connect-firecrawl" },
  { service: "hunter", title: "Brand deals · Hunter.io", name: "Hunter.io", why: "Finds public partnership emails on brand websites. Free account: 50 lookups a month.", steps: ["Create a free Hunter account", "Open API → copy key", "Paste it here"], guide: "connect-hunter", optional: true },
  {
    service: "elevenlabs",
    title: "Voice overs · ElevenLabs (premium)",
    name: "ElevenLabs",
    why: "Premium voice cloning: best quality, seconds per voice over, uses your own ElevenLabs credits. Without it the free built-in voice is used, which is good quality and takes a few minutes.",
    steps: ["Open elevenlabs.io → your profile → API keys", "Create API key, copy it", "Paste it here"],
    guide: "connect-elevenlabs",
    optional: true,
  },
  // Connected editors (worker/domain/editors.ts is the one list; these rows show it).
  ...EDITOR_LIST.map((e) => ({ service: e.id as Service, title: `Editor · ${e.name}`, name: e.name, why: e.why, steps: e.steps, guide: `connect-${e.id}`, optional: true, editor: true })),
];

export function Connect() {
  const { me } = useApp();
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => get<ConnectionView[]>("/api/connections"));
  const [confirmAll, setConfirmAll] = useState(false);
  const [params, setParams] = useSearchParams();
  const oauthNote = oauthMessage(params);
  const byService = (s: Service) => data?.find((c) => c.service === s) ?? null;
  const owner = me?.role === "owner";
  // The screen's one next step: the first thing not connected yet, in the order she sets them up.
  // With everything connected, Buffer's "Check again" (posting is what matters most).
  // The stats sign-ins are optional extra detail (owner decision 25 Sep 2026), never the next step.
  const order: Service[] = ["buffer", "openrouter", "firecrawl", "hunter"];
  const primary: Service | null = !owner || !data ? null : (order.find((sv) => byService(sv)?.status !== "ok") ?? "buffer");

  async function disconnectAll() {
    try {
      await post("/api/connections/disconnect-all");
      toast.ok("Everything disconnected. Nothing will post until you reconnect Buffer.");
      setConfirmAll(false);
      reload();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <div className="page">
      <PageHead
        crumb={
          <>
            <Link to="/settings">Settings</Link> <Icon name="right" size="sm" /> Connections
          </>
        }
        title="Connect your accounts"
        lede="You always log in on TikTok, Instagram, Google or Buffer’s own page. We never see your passwords, and keys are stored encrypted in your Cloudflare account."
      />

      {oauthNote ? (
        <Notice tone={oauthNote.ok ? "ok" : "bad"}>
          <span className="grow">
            {oauthNote.text} {oauthNote.guide ? <Link to={`/help/${oauthNote.guide}`}>How to fix</Link> : null}
          </span>
          <button className="btn quiet small" onClick={() => setParams({}, { replace: true })}>
            OK
          </button>
        </Notice>
      ) : null}

      {loading && !data ? <Skeleton blocks={3} /> : null}

      {data ? (
        <>
          <Section n={1} title={KEY_SERVICES[0].title}>
            <KeyCard def={KEY_SERVICES[0]} conn={byService("buffer")} owner={owner} primary={primary === "buffer"} onChange={reload} />
            <ChannelsCard conn={byService("buffer")} />
          </Section>

          <Section n={2} title="YouTube · full videos">
            <YouTubeDirectCard conn={byService("youtube")} owner={owner} onChange={reload} />
          </Section>

          <Section n={3} title="Stats · no sign-in needed">
            <Card className="flat">
              <div className="hint">Lets the dashboard learn what works for you. Your numbers come in without signing in anywhere.</div>
              <div className="list">
                <NoLoginRow name="YouTube" line="Public numbers, read on their own through the channel Buffer posts to." cta="See YouTube numbers" />
                <NoLoginRow name="Instagram" line="Type your followers and reach on Stats whenever you like (2 minutes)." cta="Add Instagram numbers" />
                <TikTokRow conn={byService("tiktok")} />
              </div>
              <div className="hint">TikTok: upload the export from TikTok Studio once a month (the zip it gives you is fine).</div>
            </Card>
            <Card className="flat">
              <div className="title">Extra detail · optional</div>
              <div className="hint">
                Signing in adds a little more (YouTube watch time, Instagram reach per video). Nothing waits on it. Google or Meta may show a warning page until the app is approved; that is expected.
              </div>
              <div className="list">
                <StatsRow name="Instagram (optional)" provider="meta" conn={byService("meta")} connectLabel="Connect with Instagram" owner={owner} primary={false} onChange={reload} />
                <StatsRow name="YouTube (optional)" provider="google" conn={byService("google")} connectLabel="Connect with Google" owner={owner} primary={false} onChange={reload} />
              </div>
            </Card>
          </Section>

          <Section n={4} title="AI and research">
            <div className="grid cols-2">
              <KeyCard def={KEY_SERVICES[1]} conn={byService("openrouter")} owner={owner} primary={primary === "openrouter"} onChange={reload} />
              <KeyCard def={KEY_SERVICES[2]} conn={byService("firecrawl")} owner={owner} primary={primary === "firecrawl"} onChange={reload} />
            </div>
          </Section>

          <Section n={5} title="Brand deals · optional">
            <KeyCard def={KEY_SERVICES[3]} conn={byService("hunter")} owner={owner} primary={primary === "hunter"} onChange={reload} />
          </Section>

          <Section n={6} title="Voice overs · premium, optional">
            <KeyCard def={KEY_SERVICES[4]} conn={byService("elevenlabs")} owner={owner} primary={false} onChange={reload} />
          </Section>

          <Section n={7} title="Editing apps · optional">
            <Card className="flat">
              <div className="hint">The built-in editor makes every clip for free. Use your own apps on top whenever you like.</div>
              <div className="list">
                {(["capcut", "inshot"] as const).map((app) => (
                  <div key={app} className="list-row" data-handoff={app}>
                    <Dot light="green" />
                    <div className="grow">
                      <div className="title">{HANDOFF[app].name}</div>
                      <div className="meta">{HANDOFF[app].row}</div>
                    </div>
                    <span className="pill ok">Ready</span>
                    <Link className="btn quiet small" to="/help/edit-in-capcut">
                      How
                    </Link>
                  </div>
                ))}
              </div>
            </Card>
            <div className="hint">Editors with their own key: connect one, then pick it under Settings → Editing → Who edits. <Link to="/help/connect-an-editor">Which editor does what</Link></div>
            <div className="grid cols-2">
              {KEY_SERVICES.filter((d) => d.editor).map((d) => (
                <KeyCard key={d.service} def={d} conn={byService(d.service)} owner={owner} primary={false} onChange={reload} />
              ))}
            </div>
          </Section>

          {owner ? (
            <section className="section connect-danger">
              <h2>Start over</h2>
              <p className="soft">Removes every key at once. Nothing posts until you reconnect Buffer.</p>
              <div>
                <button className="btn danger" onClick={() => setConfirmAll(true)}>
                  Disconnect everything
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {confirmAll ? (
        <Modal title="Disconnect everything?" onClose={() => setConfirmAll(false)}>
          <p>Every key is removed. Nothing posts until you reconnect Buffer. Your clips and calendar are kept.</p>
          <div className="btn-row">
            <button className="btn danger" onClick={disconnectAll}>
              Yes, disconnect everything
            </button>
            <button className="btn quiet" onClick={() => setConfirmAll(false)}>
              Keep them
            </button>
          </div>
        </Modal>
      ) : null}
      <HelpButton guide="connect-buffer" />
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="row">
        <span className="step-num">{n}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function StatusPill({ conn }: { conn: ConnectionView | null }) {
  const status = conn?.status ?? "missing";
  const light = status === "ok" ? "green" : status === "error" ? "red" : "grey";
  const text = status === "ok" ? `Connected${conn?.last_ok_at ? ` · checked ${ago(conn.last_ok_at)}` : ""}` : status === "error" ? (conn?.last_error ?? "Needs you") : status === "disconnected" ? "Disconnected" : "Not connected";
  return (
    <span className="row status-pill">
      <Dot light={light} />
      {text}
    </span>
  );
}

function KeyCard({ def, conn, owner, primary, onChange }: { def: (typeof KEY_SERVICES)[number]; conn: ConnectionView | null; owner: boolean; primary: boolean; onChange: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = conn?.status === "ok";
  const credits = conn?.meta.credits_left as number | undefined;

  async function check() {
    setBusy(true);
    try {
      const r = await post<{ note?: string | null }>(`/api/connections/${def.service}/key`, { key });
      toast.ok(r.note ?? `${def.name} connected.`);
      setKey("");
      onChange();
    } catch (e) {
      toast.bad(e);
      onChange();
    } finally {
      setBusy(false);
    }
  }
  async function recheck() {
    setBusy(true);
    try {
      await post(`/api/connections/${def.service}/recheck`);
      toast.ok("Still working.");
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
      onChange();
    }
  }
  async function disconnect() {
    try {
      await post(`/api/connections/${def.service}/disconnect`);
      onChange();
    } catch (e) {
      toast.bad(e);
    }
  }

  return (
    <Card>
      <div className="row between wrap">
        <h3>{def.name}</h3>
        <StatusPill conn={conn} />
      </div>
      <p className="soft">{def.why}</p>
      {def.service === "elevenlabs" ? <ElevenLabsPlan conn={conn} /> : null}
      {credits !== undefined ? (
        <div className="hint nums">
          {credits} of {(conn?.meta.credits_total as number | undefined) ?? "your"} credits left this month
        </div>
      ) : def.editor && connected ? (
        <div className="hint">{def.name}’s API doesn’t report credits; see them in your {def.name} account.</div>
      ) : null}
      {!connected ? (
        <>
          <div>
            <div className="label">How to connect (2 minutes)</div>
            <ol className="soft key-steps">
              {def.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          <div className="key-row">
            <input className="input" type="password" aria-label={`${def.title} key`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key" disabled={!owner} />
            <button className={primary ? "btn" : "btn quiet"} data-primary={primary || undefined} onClick={check} disabled={!owner || busy || key.length < 8}>
              {busy ? "Checking…" : "Check key"}
            </button>
          </div>
          <div className="row between wrap">
            <Link to={`/help/${def.guide}`} className="link-btn">
              Picture-by-picture guide
            </Link>
            {/* A stored key that stopped working is still stored: she must be able to remove it
                (live test 25 Sep 2026: a revoked Buffer key left no way to disconnect it). */}
            {owner && conn?.status === "error" ? (
              <button className="btn danger small" onClick={disconnect}>
                Disconnect
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="btn-row">
          <button className={primary ? "btn small" : "btn quiet small"} data-primary={primary || undefined} onClick={recheck} disabled={busy}>
            Check again
          </button>
          {owner ? (
            <button className="btn danger small" onClick={disconnect}>
              Disconnect
            </button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** Her ElevenLabs plan as last checked: tier, characters used of the limit, and cloning. */
function ElevenLabsPlan({ conn }: { conn: ConnectionView | null }) {
  const m = conn?.meta ?? {};
  if (conn?.status !== "ok" || typeof m.tier !== "string") return null;
  const used = Number(m.characters_used ?? 0);
  const limit = Number(m.characters_limit ?? 0);
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    <div className="eleven-plan" data-testid="elevenlabs-plan">
      <div className="hint nums">
        Plan: <strong>{m.tier}</strong> · {n(used)} of {n(limit)} characters used this month
      </div>
      {m.can_clone === true ? (
        <Notice tone="ok">Voice cloning is on your plan: your voice overs use the premium voice.</Notice>
      ) : (
        <Notice tone="warn">Your ElevenLabs plan does not include voice cloning; the built-in voice will be used.</Notice>
      )}
    </div>
  );
}

function ChannelsCard({ conn }: { conn: ConnectionView | null }) {
  if (conn?.status !== "ok") return null;
  const channels = (conn.meta.channels as { platform: Platform; handle: string; connected: boolean }[] | undefined) ?? [];
  const missing = (["tiktok", "instagram", "youtube"] as Platform[]).filter((p) => !channels.some((c) => c.platform === p));
  return (
    <Card className="flat">
      <div className="label">Channels we found in your Buffer</div>
      <div className="list">
        {channels.map((ch) => (
          <div key={ch.platform} className="list-row">
            <Dot light={ch.connected ? "green" : "red"} />
            <div className="grow">
              <div className="title">{PLATFORM_LABEL[ch.platform]}</div>
              <div className="meta">{ch.connected ? `${ch.handle} · posting OK` : "Needs reconnect in Buffer"}</div>
            </div>
            {!ch.connected ? (
              <a className="btn quiet small" href="https://publish.buffer.com/channels" target="_blank" rel="noreferrer">
                Open Buffer to reconnect
              </a>
            ) : null}
          </div>
        ))}
        {missing.map((p) => (
          <div key={p} className="list-row">
            <Dot light="red" />
            <div className="grow">
              <div className="title">{PLATFORM_LABEL[p]}</div>
              <div className="meta">Not added in Buffer yet</div>
            </div>
            <a className="btn quiet small" href="https://publish.buffer.com/channels/connect" target="_blank" rel="noreferrer">
              Open Buffer to add it
            </a>
          </div>
        ))}
      </div>
      <div>
        <Link to="/help/add-channels-in-buffer" className="link-btn">
          How to add TikTok, Instagram and YouTube in Buffer
        </Link>
      </div>
    </Card>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  not_set_up: "stats sign-in is not set up on this dashboard yet (the app keys are missing).",
  denied: "the sign-in was cancelled, so nothing was connected.",
  expired: "the sign-in took too long. Press Connect again.",
  no_account: "that account has no Professional Instagram or YouTube channel to read.",
  no_upload: "Google didn't give permission to upload. Tap Connect YouTube again, leave every box ticked, then tap Continue.",
  failed: "the connection did not finish. Press Connect again.",
};

/** The redirect back from /api/oauth/<provider>/callback carries ?connected= or ?oauth_error=. */
function oauthMessage(params: URLSearchParams): { ok: boolean; text: string; guide: string | null } | null {
  const who = (p: string | null) => (p === "google" ? "YouTube" : "Instagram");
  const connected = params.get("connected");
  if (connected === "youtube") return { ok: true, text: "YouTube connected. Your full videos now upload straight to your channel, with their thumbnail and tags.", guide: null };
  if (params.get("oauth_error") && params.get("provider") === "youtube") return { ok: false, text: `YouTube: ${OAUTH_ERRORS[params.get("oauth_error")!] ?? OAUTH_ERRORS.failed}`, guide: "connect-youtube-full-videos" };
  if (connected === "meta" || connected === "google") return { ok: true, text: `${who(connected)} stats connected. We’ll read your results every week.`, guide: null };
  const err = params.get("oauth_error");
  if (!err) return null;
  const provider = params.get("provider") === "google" ? "google" : "meta";
  return { ok: false, text: `${who(provider)}: ${OAUTH_ERRORS[err] ?? OAUTH_ERRORS.failed}`, guide: `connect-${provider}` };
}

function StatsRow({ name, provider, conn, connectLabel, owner, primary, onChange }: { name: string; provider: "meta" | "google"; conn: ConnectionView | null; connectLabel: string; owner: boolean; primary: boolean; onChange: () => void }) {
  const toast = useToast();
  const status = conn?.status ?? "missing";
  const account = conn?.meta.account as string | undefined;
  const synced = (conn?.meta.last_sync_at as string | null | undefined) ?? null;
  const start = `/api/oauth/${provider}/start`;
  async function disconnect() {
    try {
      await post(`/api/connections/${provider}/disconnect`);
      onChange();
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <div className="list-row stats-row">
      <Dot light={status === "ok" ? "green" : status === "error" ? "red" : "grey"} />
      <div className="grow">
        <div className="title">{name}</div>
        <div className="meta">
          {status === "ok"
            ? `${account ? `${account} · ` : ""}${synced ? `Numbers updated ${ago(synced)}` : "Connected · first numbers this week"}`
            : status === "error"
              ? (conn?.last_error ?? "Needs reconnect")
              : "Not connected (optional)"}
        </div>
      </div>
      {owner ? (
        status === "ok" || status === "error" ? (
          <>
            <a className={primary ? "btn small" : "btn quiet small"} data-primary={primary || undefined} href={start}>
              Reconnect
            </a>
            <button className="btn danger small" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <a className={primary ? "btn small" : "btn quiet small"} data-primary={primary || undefined} href={start}>
            {connectLabel}
          </a>
        )
      ) : null}
    </div>
  );
}

function NoLoginRow({ name, line, cta }: { name: string; line: string; cta: string }) {
  return (
    <div className="list-row">
      <div className="grow">
        <div className="title">{name}</div>
        <div className="meta">{line}</div>
      </div>
      <Link className="btn quiet small" to="/stats">
        {cta}
      </Link>
    </div>
  );
}

function TikTokRow({ conn }: { conn: ConnectionView | null }) {
  const imported = conn?.meta.last_import_at as string | undefined;
  return (
    <div className="list-row">
      <Dot light={imported ? "green" : "grey"} />
      <div className="grow">
        <div className="title">TikTok</div>
        <div className="meta">{imported ? `Last import ${ago(imported)}` : "No export uploaded yet"}</div>
      </div>
      <Link className="btn quiet small" to="/stats">
        Upload TikTok export
      </Link>
    </div>
  );
}

/**
 * Connect YouTube (full videos): her own Google sign-in, once. The only thing she ever does is tap
 * the button, pick her Google account, Advanced, Go to workers.dev (unsafe), Continue (worker/routes/oauth.ts
 * /api/oauth/youtube/start). Red when Google refused the sign-in: Reconnect YouTube.
 */
function YouTubeDirectCard({ conn, owner, onChange }: { conn: ConnectionView | null; owner: boolean; onChange: () => void }) {
  const toast = useToast();
  const status = conn?.status ?? "missing";
  const account = conn?.meta.account as string | undefined;
  const start = "/api/oauth/youtube/start";
  async function disconnect() {
    try {
      await post("/api/connections/youtube/disconnect");
      toast.ok("YouTube disconnected. Full videos go back to Upload it yourself.");
      onChange();
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <div data-youtube-direct>
    <Card className="flat">
      <div className="list-row">
        <Dot light={status === "ok" ? "green" : status === "error" ? "red" : "grey"} />
        <div className="grow">
          <div className="title">YouTube (full videos)</div>
          <div className="meta">
            {status === "ok"
              ? `Connected${account ? ` · ${account}` : ""} · full videos upload straight to your channel`
              : status === "error"
                ? (conn?.last_error ?? "YouTube needs you to reconnect.")
                : "Not connected: full videos wait for you to upload them yourself"}
          </div>
        </div>
      </div>
      {owner ? (
        <div className="btn-row">
          {status === "ok" ? (
            <button className="btn danger small" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <a className="btn small" href={start}>
              {status === "error" ? "Reconnect YouTube" : "Connect YouTube (full videos)"}
            </a>
          )}
        </div>
      ) : null}
      <div className="hint">
        Your long videos go straight to your own channel with the thumbnail, title, description, chapters and tags you approved, at the time on your Calendar. Your Shorts, TikToks and Reels keep going through Buffer.
      </div>
      {status !== "ok" ? (
        <div className="hint" data-unverified-note>
          You sign in on Google's own page. Pick your account. Google then shows “Google hasn't verified this app”: that is expected (it's your own dashboard). Tap the small <strong>Advanced</strong> link, then <strong>Go to workers.dev (unsafe)</strong>, then <strong>Continue</strong>.
        </div>
      ) : null}
    </Card>
    </div>
  );
}
