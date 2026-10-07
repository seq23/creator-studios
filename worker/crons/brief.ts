// Section 6 brief crons: "After that it refreshes monthly and adjusts weekly from her results."
// Hosted by the existing lanes (no new cron expression, see crons/index.ts):
//   daily   → monthlyBriefRefresh: on the 1st (retrying the 2nd and 3rd) starts the research job
//             for a fresh draft. It does not stop for approval: the approved brief stays live.
//   hourly  → briefDraftNotice: once that draft lands, emails "New brief draft ready" (once).
//   weekly  → weeklyBriefAdjust: rewrites the live brief's own her-data claims from the last 7
//             days of results and stamps adjusted_at; never approval, never web claims.
// Every step writes a health row, so a skipped refresh is a light with a reason, never silence.
// The decisions are pure functions in domain/brief.ts; this file only reads and writes.
import type { Env } from "../env";
import { practice } from "../lib/practice";
import { getConnectionSecret } from "../lib/connections";
import { parseJson, recordEvent, setHealth } from "../lib/db";
import { log } from "../lib/log";
import { readSettings } from "../routes/settings";
import { emailFrame, sendEmail } from "../services/email";
import { dispatchJob } from "../services/github";
import { loadObservations } from "../jobs/metrics";
import { adjustBrief, draftNoticeDue, monthlyRefreshDecision, summarizeWeek, type LiveBrief } from "../domain/brief";
import type { BriefBody, BriefSource } from "@shared/types";

export const MONTHLY_HEALTH = "Monthly brief refresh";
export const WEEKLY_HEALTH = "Weekly brief adjustment";

export async function monthlyBriefRefresh(env: Env, now = new Date()): Promise<{ dispatched: boolean; note: string }> {
  const approved = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' LIMIT 1").first();
  const profile = await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first();
  const aiReady = practice(env, "openrouter") || !!(await getConnectionSecret(env, "openrouter"));
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { results: researchJobs } = await env.DB.prepare("SELECT status, created_at FROM jobs WHERE type = 'research' AND created_at >= ?").bind(since).all<{ status: string; created_at: string }>();
  const d = monthlyRefreshDecision({ now, hasApproved: !!approved, profileLocked: !!profile, aiReady, researchJobs });
  if (!d.run) {
    await setHealth(env.DB, MONTHLY_HEALTH, d.light, d.note, d.fix_guide);
    log.info("brief.monthly.skip", { light: d.light });
    return { dispatched: false, note: d.note };
  }
  const r = await dispatchJob(env, "research", null);
  if (!r.dispatched) {
    const note = `The monthly refresh could not start (${r.error ?? "unknown"}). It tries again tomorrow; your approved brief stays live.`;
    await setHealth(env.DB, MONTHLY_HEALTH, "yellow", note, "approve-research-brief");
    log.warn("brief.monthly.dispatch_failed");
    return { dispatched: false, note };
  }
  await recordEvent(env.DB, "brief.monthly_refresh", r.jobId, {});
  await setHealth(env.DB, MONTHLY_HEALTH, "green", d.note, null);
  log.info("brief.monthly.dispatched");
  return { dispatched: true, note: d.note };
}

export async function briefDraftNotice(env: Env): Promise<string | null> {
  const draft = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'draft' ORDER BY version DESC LIMIT 1").first<{ version: number }>();
  const approved = await env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ version: number }>();
  if (!draft || !approved) return null;
  const { results } = await env.DB.prepare("SELECT DISTINCT ref_id FROM emails_sent WHERE kind = 'brief_ready' AND ref_id IS NOT NULL").all<{ ref_id: string }>();
  const ref = draftNoticeDue({ draftVersion: draft.version, approvedVersion: approved.version, notifiedRefs: results.map((r) => r.ref_id) });
  if (!ref) return null;
  const s = await readSettings(env);
  const { html, text } = emailFrame(
    "New brief draft ready",
    [
      "This month's Research Brief has a new draft, built from your latest results and fresh research.",
      "Your approved brief stays live and keeps guiding the cutter until you approve the new one. Nothing is paused.",
      "Read it, change anything you like, and press Approve when it looks right.",
    ],
    { label: "Open the brief", url: `${env.PUBLIC_BASE_URL}/research` },
  );
  await sendEmail(env, { kind: "brief_ready", to: s.notify_emails, subject: "New brief draft ready", html, text, refId: ref });
  await recordEvent(env.DB, "brief.draft_notice", ref, {});
  log.info("brief.draft_notice");
  return ref;
}

interface BriefRow {
  version: number;
  status: LiveBrief["status"];
  approved_at: string | null;
  adjusted_at: string | null;
  body: string;
  sources: string;
}

export async function weeklyBriefAdjust(env: Env, now = new Date()): Promise<{ changed: boolean; version: number | null }> {
  const row = await env.DB.prepare("SELECT version, status, approved_at, adjusted_at, body, sources FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<BriefRow>();
  if (!row) {
    await setHealth(env.DB, WEEKLY_HEALTH, "green", "No approved brief yet: weekly adjustments start after the first one.", null);
    return { changed: false, version: null };
  }
  const live: LiveBrief = {
    version: row.version,
    status: row.status,
    approved_at: row.approved_at,
    adjusted_at: row.adjusted_at,
    body: parseJson<BriefBody>(row.body, { audience: [], themes: [], hooks: [], cut_styles: [], best_times: { tiktok: [], instagram: [], youtube: [] }, comparable_creators: [], shot_list: [] }),
    sources: parseJson<BriefSource[]>(row.sources, []),
  };
  const week = summarizeWeek(await loadObservations(env), now);
  const { brief, changed } = adjustBrief(live, week, now);
  const videos = week.reduce((a, w) => a + w.videos, 0);
  if (changed) {
    // Only body, sources and adjusted_at are written, and only while the row is still the
    // approved one: approval is hers and this lane never touches it.
    await env.DB.prepare("UPDATE research_briefs SET body = ?, sources = ?, adjusted_at = ? WHERE version = ? AND status = 'approved'")
      .bind(JSON.stringify(brief.body), JSON.stringify(brief.sources), brief.adjusted_at, brief.version)
      .run();
    await recordEvent(env.DB, "brief.adjusted", String(brief.version), { platforms: week.length, videos });
  }
  const note = changed && videos === 0
    ? "No results in the last 7 days: last week's numbers were taken off the brief."
    : changed
    ? `Updated your numbers from ${videos} video${videos === 1 ? "" : "s"} in the last 7 days.`
    : videos
      ? "Checked your last 7 days: your numbers had not changed."
      : "No new results in the last 7 days; the brief's numbers are unchanged.";
  await setHealth(env.DB, WEEKLY_HEALTH, "green", note, null);
  log.info("brief.weekly", { changed, platforms: week.length });
  return { changed, version: brief.version };
}
