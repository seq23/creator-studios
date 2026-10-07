// Monday lane: weekly recap email (optional), learning update, brand finder job, stats.
// Stats are no-login first (owner decision 25 Sep 2026): YouTube's public numbers with the API
// key and Instagram's public numbers (or her typed ones) are read here every week, whether or
// not a Google / Instagram sign-in exists. The metrics job (the sign-in path) is dispatched
// only when a sign-in is connected; without one it would have nothing to read (Rule 0).
import type { Env } from "../env";
import { followupsDueLine } from "../domain/deals";
import { runwayWeeks, weeklyNeed } from "../domain/runway";
import { weekBounds } from "../domain/slotting";
import { log } from "../lib/log";
import { readSettings } from "../routes/settings";
import { emailFrame, sendEmail } from "../services/email";
import { dispatchJob } from "../services/github";
import { dueDealItems } from "../routes/deals";
import { instagramReminderLine, refreshPublicStats } from "../lib/publicStats";

export async function weekly(env: Env): Promise<void> {
  const s = await readSettings(env);
  const profileLocked = await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first();

  // No-login stats: always, before anything else (the recap below reads them).
  const pub = await refreshPublicStats(env, { force: true });
  const signedIn = (await env.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE service IN ('meta', 'google') AND status = 'ok'").first<{ n: number }>())?.n ?? 0;
  log.info("weekly.stats", { youtube: pub.youtube.state, instagram: pub.instagram.path, sign_in_job: signedIn > 0 });

  // Learning loop + brand finder only make sense once there is a locked profile.
  if (profileLocked) {
    if (signedIn > 0) await dispatchJob(env, "metrics", null);
    await dispatchJob(env, "brand_finder", "full");
  }

  if (!s.features.weekly_recap) return;
  const { start, end } = weekBounds(new Date(), s.audience_timezone, -1);
  const top = await env.DB.prepare(
    "SELECT c.hook_text, MAX(m.views) AS views FROM posts p JOIN clips c ON c.id = p.clip_id LEFT JOIN metrics m ON m.post_id = p.id WHERE p.status = 'posted' AND p.posted_at >= ? AND p.posted_at < ? GROUP BY c.id ORDER BY views DESC LIMIT 1",
  )
    .bind(start, end)
    .first<{ hook_text: string; views: number | null }>();
  const postedN = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'posted' AND posted_at >= ? AND posted_at < ?").bind(start, end).first<{ n: number }>())?.n ?? 0;
  const approved = (await env.DB.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved' AND id NOT IN (SELECT clip_id FROM posts WHERE status IN ('posted','in_buffer','planned'))").first<{ n: number }>())?.n ?? 0;
  const thisWeek = weekBounds(new Date(), s.audience_timezone);
  const plannedN = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('planned','in_buffer') AND scheduled_at >= ? AND scheduled_at < ?").bind(thisWeek.start, thisWeek.end).first<{ n: number }>())?.n ?? 0;
  const weeks = runwayWeeks(approved, weeklyNeed(s.weekly_caps));
  // Deal emails she owes this week (or already owes): the same list Home shows, over the coming
  // seven days instead of the next two (worker/routes/deals.ts dueDealItems).
  const due = await dueDealItems(env, new Date(Date.now() + 7 * 86400_000));
  const followups = followupsDueLine(due, s.audience_timezone);
  const lines = [
    `Last week: ${postedN} posts went out.`,
    top ? `Top clip: “${top.hook_text}”${top.views ? ` · ${top.views.toLocaleString()} views` : ""}.` : "No results are in yet for last week.",
    `Runway: ${Number.isFinite(weeks) ? weeks : "∞"} weeks of approved clips.`,
    `This week: ${plannedN} posts are scheduled.`,
    ...(followups ? [followups] : []),
  ];
  // Her "remind me monthly" for the Instagram numbers she types on Stats.
  const igReminder = await instagramReminderLine(env);
  if (igReminder) lines.push(igReminder);
  const { html, text } = emailFrame("Your week at a glance", lines, { label: "Open the dashboard", url: env.PUBLIC_BASE_URL });
  await sendEmail(env, { kind: "weekly_recap", to: s.notify_emails, subject: "Weekly recap", html, text });
  log.info("weekly.recap", { posted: postedN, planned: plannedN, followups_due: due.length });
}
