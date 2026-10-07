// Daily brand refresh (owner, 26 Sep 2026: "an emphasis on finding brands to give you $$"): the
// daily lane starts a light brand-finder run (mode "daily": a few searches, inside the free web
// and OpenRouter budgets) so "Brands to pitch this week" stays fresh. The Monday lane still runs
// the full search. Rule 0: every run writes the "Daily brand refresh" health row saying what it
// did or why it did not.
import type { Env } from "../env";
import { setHealth } from "../lib/db";
import { log } from "../lib/log";
import { dispatchJob } from "../services/github";

/** Skip when a finder ran (or is running) in the last 20 hours, or before her Brand Profile is locked. */
export function shouldRefreshBrands(lastStartedAt: string | null, profileLocked: boolean, now: Date): { run: boolean; why: string } {
  if (!profileLocked) return { run: false, why: "Waiting for a locked Brand Profile (Client Brain)." };
  if (lastStartedAt && now.getTime() - new Date(lastStartedAt).getTime() < 20 * 3600_000) return { run: false, why: "The brand finder already ran in the last 20 hours." };
  return { run: true, why: "Started the daily brand refresh." };
}

export async function dailyBrandRefresh(env: Env): Promise<void> {
  const last = await env.DB.prepare("SELECT created_at FROM jobs WHERE type = 'brand_finder' ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  const locked = !!(await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first());
  const d = shouldRefreshBrands(last?.created_at ?? null, locked, new Date());
  if (d.run) {
    const r = await dispatchJob(env, "brand_finder", "daily");
    await setHealth(env.DB, "Daily brand refresh", r.dispatched ? "green" : "yellow", r.dispatched ? d.why : "The daily brand refresh could not start; it tries again tomorrow.", r.dispatched ? null : "reconnect-github");
  } else {
    await setHealth(env.DB, "Daily brand refresh", "green", d.why, null);
  }
  log.info("deals.daily_refresh", { ran: d.run });
}
