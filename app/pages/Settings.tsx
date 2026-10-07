// Settings (section 4): posting caps (max 10), times, audience time zone, runway threshold,
// emails, connections + Health panel, feature switches, help, helper login.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HealthItem, SettingsShape } from "@shared/types";
import { get, patch, post } from "../lib/api";
import { ago } from "../lib/format";
import { foldHealth } from "../lib/health";
import { Card, Dot, Empty, HelpButton, PageHead, Skeleton, Stepper, Switch, useLoad, useToast } from "../components/ui";
import { useApp } from "../state";
import { PLATFORMS, PLATFORM_LABEL } from "@shared/constants";
import { Icon } from "../components/Icon";
import { EditingCard } from "../components/EditingSettings";
import { AUTO_VOICE_HINT } from "@shared/autoVoice";
import { StorageSection } from "../components/StorageSection";
import "../styles/settings.css";

export function Settings() {
  const { me, refreshMe } = useApp();
  const toast = useToast();
  const s = useLoad(() => get<SettingsShape>("/api/settings"));
  const health = useLoad(() => get<HealthItem[]>("/api/settings/health"));
  // "Record your voice first" under Automatic voice overs: the server says when it is on but her voice isn't saved.
  const voiceState = useLoad(() => get<{ auto: "on" | "needs_voice" | "off" }>("/api/voice"));
  const [draft, setDraft] = useState<SettingsShape | null>(null);
  const [emails, setEmails] = useState("");
  const [helper, setHelper] = useState("");
  const owner = me?.role === "owner";
  // Open mode has no login, so the helper is who "Email my helper" writes to, not a second login.
  const openMode = me?.authMode === "open";

  useEffect(() => {
    if (s.data) {
      setDraft(s.data);
      setEmails(s.data.notify_emails.join(", "));
      setHelper(s.data.helper_email ?? "");
    }
  }, [s.data]);

  async function save(partial: Partial<SettingsShape>) {
    try {
      const next = await patch<SettingsShape>("/api/settings", partial);
      setDraft(next);
      s.setData(next);
      if (partial.features) await refreshMe();
      voiceState.reload();
      toast.ok("Saved.");
    } catch (e) {
      toast.bad(e);
    }
  }

  const head = (
    <PageHead title="Settings" lede="How often to post, where emails go, what is connected and who can help.">
      <Link to="/settings/connections" className="btn" data-primary>
        Connect accounts
      </Link>
    </PageHead>
  );

  if (!draft)
    return (
      <div className="page">
        {head}
        <div className="settings-cols">
          <Skeleton blocks={3} />
          <Skeleton blocks={2} />
        </div>
        <HelpButton guide="settings-and-switches" />
      </div>
    );
  const total = PLATFORMS.reduce((n, p) => n + draft.weekly_caps[p], 0);

  return (
    <div className="page">
      {head}

      <div className="settings-cols">
        <div className="settings-col">
          <section className="section">
            <h2>Posting</h2>
            <Card>
              {PLATFORMS.map((p) => (
                <div key={p} className="set-row">
                  <div className="set-text">
                    <div className="set-label">{PLATFORM_LABEL[p]} per week</div>
                    <div className="hint">max {draft.hard_cap_per_channel}</div>
                  </div>
                  <Stepper label={`${PLATFORM_LABEL[p]} posts per week`} value={draft.weekly_caps[p]} max={draft.hard_cap_per_channel} onChange={(n) => owner && save({ weekly_caps: { ...draft.weekly_caps, [p]: n } })} />
                </div>
              ))}
              <div className="hint nums">
                {total} posts a week from {Math.max(...PLATFORMS.map((p) => draft.weekly_caps[p]))} unique clips. Raise a platform only if its reach holds for two straight weeks.
              </div>
            </Card>
            <Card>
              <div className="set-row">
                <div className="set-text">
                  <div className="set-label">Posting times</div>
                  <div className="hint">{draft.posting_slots_source === "research" ? "From your research brief (auto)" : "Custom"}</div>
                </div>
                <span className="pill">{draft.posting_slots_source === "research" ? "Auto" : "Custom"}</span>
              </div>
              <div className="set-row">
                <div className="set-text">
                  <div className="set-label">Audience time zone</div>
                  <div className="hint">All posting times are in your audience’s local time.</div>
                </div>
                <span className="mono">{draft.audience_timezone}</span>
              </div>
            </Card>
          </section>

          <section className="section">
            <h2>Emails</h2>
            <Card>
              <div className="set-row">
                <div className="set-text">
                  <div className="set-label">Email me when runway is under</div>
                  <div className="hint">Runway = weeks of approved clips left.</div>
                </div>
                <div className="row">
                  <Stepper label="weeks of runway" value={draft.runway_threshold_weeks} min={1} max={8} onChange={(n) => owner && save({ runway_threshold_weeks: n })} />
                  <span>weeks</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="emails">Emails go to</label>
                <div className="set-input-row">
                  <input id="emails" className="input" value={emails} onChange={(e) => setEmails(e.target.value)} disabled={!owner} />
                  <button className="btn quiet" disabled={!owner} onClick={() => save({ notify_emails: emails.split(/[,\s]+/).filter(Boolean) })}>
                    Save
                  </button>
                </div>
                <div className="hint">Separate several addresses with commas.</div>
              </div>
            </Card>
          </section>

          <section className="section">
            <h2>Features</h2>
            <Card>
              <Switch label="Automatic voice overs" hint={AUTO_VOICE_HINT} checked={draft.features.voice} onChange={(v) => owner && save({ features: { ...draft.features, voice: v } })} />
              {voiceState.data?.auto === "needs_voice" ? (
                <p className="hint" data-auto-voice="needs_voice">
                  <Link to="/voice#voice-steps">Record your voice first</Link>: until then no voice overs are made, and nothing else changes.
                </p>
              ) : null}
              <Switch label="Deeper web research" hint="Off = the brief uses the free web search only. On = Perplexity search through OpenRouter too, about $0.25 per brief, only when OpenRouter is connected." checked={draft.features.deeper_research} onChange={(v) => owner && save({ features: { ...draft.features, deeper_research: v } })} />
              <Switch label="Weekly recap email" hint="Off = no Monday email. On = every Monday: last week’s top clip, runway, what’s scheduled." checked={draft.features.weekly_recap} onChange={(v) => owner && save({ features: { ...draft.features, weekly_recap: v } })} />
            </Card>
            <Card>
              <div className="set-row">
                <div className="set-text">
                  <div className="set-label">Recycle wait per platform</div>
                  <div className="hint">An old video never goes back to the same platform inside this window.</div>
                </div>
                <div className="row">
                  <input className="input set-days" type="number" min={30} max={365} aria-label="Recycle wait in days" value={draft.recycle_cooldown_days} disabled={!owner} onChange={(e) => setDraft({ ...draft, recycle_cooldown_days: Number(e.target.value) })} onBlur={() => owner && save({ recycle_cooldown_days: draft.recycle_cooldown_days })} />
                  <span>days</span>
                </div>
              </div>
            </Card>
          </section>
        </div>

        <div className="settings-col">
          <EditingCard owner={owner} />
          <StorageSection owner={owner} />
          <HealthSection health={health.data} onChange={(rows) => health.setData(rows)} />

          <section className="section">
            <h2>Help + people</h2>
            <Card>
              <div className="list">
                <Link to="/help/getting-started" className="list-row">
                  <div className="grow title">How the dashboard works (illustrated guide)</div>
                  <Icon name="arrow" size="sm" />
                </Link>
                <Link to="/help/reconnect-an-account" className="list-row">
                  <div className="grow title">Fix a disconnected account</div>
                  <Icon name="arrow" size="sm" />
                </Link>
              </div>
            </Card>
            <Card>
              <div className="field">
                <label htmlFor="helper">{openMode ? "Your helper" : "Helper login"}</label>
                <div className="hint">{openMode ? "Who “Email my helper” writes to. You can remove them any time." : "A second person who can log in to help. You can remove them any time."}</div>
                <div className="set-input-row">
                  <input id="helper" className="input" type="email" value={helper} onChange={(e) => setHelper(e.target.value)} disabled={!owner} placeholder="helper@example.com" />
                  <button className="btn quiet" disabled={!owner} onClick={() => save({ helper_email: helper.trim() || null })}>
                    Save
                  </button>
                  {draft.helper_email ? (
                    <button className="btn danger" disabled={!owner} onClick={() => save({ helper_email: null })}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            </Card>
          </section>
        </div>
      </div>
      <HelpButton guide="settings-and-switches" />
    </div>
  );
}

// ---------- Health (section 11): every light, plain names, a How to fix link on anything not green.
// The labels and the fold live in app/lib/health.ts, shared with Home's card.

const LIGHT_WORD: Record<HealthItem["light"], string> = { green: "Working", yellow: "Needs a look", red: "Not working", grey: "Not set up" };

function HealthSection({ health, onChange }: { health: HealthItem[] | null; onChange: (rows: HealthItem[]) => void }) {
  const toast = useToast();
  const { refreshCounts } = useApp();
  const [checking, setChecking] = useState(false);
  const rows = foldHealth(health);
  const bad = rows.filter((r) => r.light === "red").length;

  async function recheck() {
    setChecking(true);
    try {
      onChange(await post<HealthItem[]>("/api/settings/health/recheck"));
      // The sidebar's "All systems OK" reads the same lights; refresh it now, not in 60 s
      // (live test 25 Sep 2026: Buffer red on this list, "All systems OK" beside it).
      await refreshCounts();
      toast.ok("Checked everything.");
    } catch (e) {
      toast.bad(e);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="section" aria-label="Connections and health">
      <div className="section-head">
        <h2>Connections + health</h2>
        <button className="btn quiet small" onClick={recheck} disabled={checking}>
          {checking ? "Checking…" : "Check everything now"}
        </button>
      </div>
      {bad ? <div className="hint">{bad === 1 ? "One thing needs you." : `${bad} things need you.`} Each red light has a How to fix link.</div> : null}
      {rows.length > 0 ? (
        <Card className="flat">
          <div className="list">
            {rows.map((h) => (
              <div key={h.name} className="list-row" data-health={h.name}>
                <Dot light={h.light} />
                <div className="grow">
                  <div className="title">{h.label}</div>
                  <div className="meta">
                    <span className={`light-word ${h.light}`} aria-hidden="true">{LIGHT_WORD[h.light]}</span> · {h.note} · checked {ago(h.checked_at)}
                  </div>
                </div>
                {h.fix_guide && h.light !== "green" ? (
                  <Link className="btn quiet small" to={`/help/${h.fix_guide}`}>
                    How to fix
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Empty title="Nothing connected yet" secondary={{ to: "/settings/connections", label: "Connect Buffer" }}>
          Start with Buffer, then press Check everything now.
        </Empty>
      )}
    </section>
  );
}
