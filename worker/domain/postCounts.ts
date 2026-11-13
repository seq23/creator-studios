// The ONE source for "posted this week", "still to go out" and "planned through" (owner, 13 Nov
// 2026: Home said 13 / 17, the Calendar 16 and Settings 22). Home, the Calendar and the Settings
// line all read postCounts through worker/lib/postsList.ts readSummary; photo posts are counted
// with reels. Pure: no database, no clock of its own. Guard: tests/unit/posts-list.test.ts.
import type { PostsSummary } from "@shared/posts";

export interface CountRow {
  /** clip: a row of `posts` · photo: a row of `social_posts`. */
  source: "clip" | "photo";
  status: string;
  scheduled_at: string;
  posted_at: string | null;
}

/** A post that will go out by itself: planned or handed over (reels), scheduled or going out (photo posts). */
export function isComing(r: Pick<CountRow, "source" | "status">): boolean {
  return r.source === "clip" ? r.status === "planned" || r.status === "in_buffer" : r.status === "scheduled" || r.status === "sending";
}

export function postCounts(rows: CountRow[], week: { start: string; end: string }, now: string): PostsSummary {
  let postedThisWeek = 0;
  let toGo = 0;
  let plannedThrough: string | null = null;
  for (const r of rows) {
    if (r.status === "posted") {
      const at = r.posted_at ?? r.scheduled_at;
      if (at >= week.start && at < week.end) postedThisWeek++;
      continue;
    }
    if (!isComing(r)) continue;
    toGo++;
    if (r.scheduled_at >= now && (!plannedThrough || r.scheduled_at > plannedThrough)) plannedThrough = r.scheduled_at;
  }
  return { postedThisWeek, toGo, plannedThrough };
}
