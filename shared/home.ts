// Home as one list (owner, 13 Nov 2026): what needs her, each row with why and one action. Pure, so
// the screen and tests/unit/get-set-up.test.ts read the same rules.
import type { HomeSummary } from "./types";
import { foldHealth } from "./health";
import { plainDay } from "./posts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface HomeRow {
  key: string;
  title: string;
  why: string;
  to: string;
  action: string;
  primary?: boolean;
}

/** "About a week of posts left": the one line that says whether to add more. */
export function postsLeftLine(d: HomeSummary): string {
  if (d.thisWeek.toGo === 0) return "No posts left to go out.";
  if (!Number.isFinite(d.runway.weeks)) return "Plenty of posts planned.";
  if (d.runway.weeks < 1) return "Less than a week of posts left.";
  const w = Math.round(d.runway.weeks);
  return w === 1 ? "About a week of posts left." : `About ${w} weeks of posts left.`;
}

/** What needs her, most urgent first; every row says why and has one action. Lights that are not red are not hers. */
export function homeRows(d: HomeSummary): HomeRow[] {
  const rows: HomeRow[] = [];
  if (d.getSetUp) {
    const left = d.getSetUp.filter((s) => !s.done).length;
    rows.push({ key: "get-set-up", title: "Get set up", why: `${left === 1 ? "One step" : `${left} steps`} left. Why: your posts go out once this is done.`, to: "/start", action: "Start", primary: true });
  }
  if (d.waiting.clips > 0) rows.push({ key: "look", title: `${plural(d.waiting.clips, "new post")} to look at`, why: "Why: nothing posts until you say yes.", to: "/review", action: "Look" });
  if (!d.getSetUp && Number.isFinite(d.runway.weeks) && d.runway.weeks < d.runway.thresholdWeeks)
    rows.push({
      key: "add-more",
      title: "Add more to keep posting",
      why: `${plural(d.thisWeek.toGo, "post")} left.${d.thisWeek.plannedThrough ? ` Why: nothing is planned after ${plainDay(d.thisWeek.plannedThrough, d.thisWeek.tz)}.` : " Why: nothing more is planned."}`,
      to: "/dump",
      action: "Add",
    });
  for (const h of foldHealth(d.health.items).filter((x) => x.light === "red")) rows.push({ key: `fix-${h.name}`, title: `${h.label} needs a look`, why: "Why: it stopped working, so something may not go out.", to: "/settings", action: "Fix" });
  return rows;
}
