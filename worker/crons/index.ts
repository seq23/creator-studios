// Cron lanes (wrangler.jsonc triggers). Each lane is its own file; this switch is the
// only place a cron string is interpreted. The section 6 brief crons ride the existing three
// expressions rather than adding a fourth: the monthly refresh is a daily check that acts on
// the 1st (retrying the 2nd and 3rd), its "draft ready" email goes out on the next hourly run
// after the research job lands, and the weekly adjustment runs in the Monday lane. Rule 0: a lane never exits having done nothing
// silently. Each lane records a health row so Settings shows "last run".
import { reapStuckJobs } from "./reapJobs";
import type { Env } from "../env";
import { setHealth } from "../lib/db";
import { readSettings } from "../routes/settings";
import { log, safeError } from "../lib/log";
import { bufferSync } from "./buffer-sync";
import { dailyMaintenance } from "./daily";
import { weekly } from "./weekly";
import { briefDraftNotice, monthlyBriefRefresh, weeklyBriefAdjust } from "./brief";
import { monthlyNicheRefresh } from "../lib/niche";
import { pollEditorJobs } from "../lib/editorJobs";
import { dailyBrandRefresh } from "./deals";
import { refreshPublicStats } from "../lib/publicStats";
import { youtubeDirectSync } from "../lib/youtubeDirect";
import { photoPostsTick, photoStopLights } from "../lib/photoPosts";
import { wordsPass } from "../lib/wordsPass";
import { ensureFirstResearch } from "../lib/setupWait";
import { sendWaitingDumps } from "../routes/dumps";

/**
 * The "Last <lane> run" note: "OK · Wed, Oct 7, 1:00 PM" in her audience time zone, the same parts
 * the app's fmtDateTime shows (7 Oct 2026: it showed a raw "Wed, 07 Oct 2026 17:00:00 GMT"). Pure.
 */
export function laneOkNote(at: Date, timeZone: string): string {
  let when: string;
  try {
    when = at.toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    when = at.toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " UTC";
  }
  return `OK · ${when}`;
}

export async function runCron(env: Env, cron: string): Promise<void> {
  const lane = cron === "0 * * * *" ? "buffer-sync" : cron === "30 13 * * *" ? "daily" : cron === "0 12 * * 1" ? "weekly" : "unknown";
  log.info("cron.start", { lane });
  try {
    if (lane === "buffer-sync") {
      await bufferSync(env);
      const reaped = await reapStuckJobs(env);
      if (reaped) log.warn("cron.jobs_reaped", { reaped });
      // Full videos straight to her channel (Connect YouTube): uploads due, Calendar moves, read-backs.
      await youtubeDirectSync(env);
      // Photo posts (per studio, studios/<slug>.json photoPosts): heads-ups, Skip honoured, due posts out.
      await photoPostsTick(env);
      await photoStopLights(env);
      await briefDraftNotice(env);
      // Setup runs by itself: a locked profile with no brief on the way gets one, and dumps waiting
      // for setup go once it is done (worker/lib/setupWait.ts; each dump is sent at most once).
      await ensureFirstResearch(env);
      await sendWaitingDumps(env, null);
      // Studio fix: clips that came back with no words of their own get them (worker/lib/wordsPass.ts).
      await wordsPass(env).catch(() => log.warn("cron.words_failed"));
      // Connected editors (docs/EDITORS.md): the screens ask while they are open; this catches the rest.
      const e = await pollEditorJobs(env);
      if (e.polled) log.info("cron.editors", e);
    } else if (lane === "daily") {
      await dailyMaintenance(env);
      await monthlyBriefRefresh(env);
      // Studio fix: what converts in this studio's niche, researched monthly (worker/lib/niche.ts).
      await monthlyNicheRefresh(env).catch(() => log.warn("cron.niche_failed"));
      // No-login stats, daily: YouTube's public numbers; Instagram's at most once a day.
      await refreshPublicStats(env);
      await dailyBrandRefresh(env);
    } else if (lane === "weekly") {
      await weekly(env);
      await weeklyBriefAdjust(env);
    }
    else {
      log.warn("cron.unknown");
      return;
    }
    const tz = (await readSettings(env).catch(() => null))?.audience_timezone || env.AUDIENCE_TIMEZONE || "America/New_York";
    await setHealth(env.DB, `Last ${lane} run`, "green", laneOkNote(new Date(), tz), null);
    log.info("cron.done", { lane });
  } catch (e) {
    await setHealth(env.DB, `Last ${lane} run`, "red", safeError(e), "i-didnt-get-an-email");
    log.error("cron.failed", { lane });
  }
}
