// Studio Memory (studio intelligence layer 8, owner's plan 22 Oct 2026) and the live switch of
// layer 9. The studio learns from what already happened in its own D1, read fresh for every cut
// (nothing is copied into a second list that could drift):
//   - approvals and rejections in Review (clips.status, clips.reject_reason), by story shape and service;
//   - "Try another version" notes (clips.again_notes);
//   - her one-tap answers under the plain line (events "dump.question_answered": a service she
//     corrected, a video she said is a before);
//   - post stats (metrics views per clip, by shape).
// The cut spec carries the summary (spec.memory); jobs/plan.py uses it to prefer the shapes she keeps,
// to re-label a service she has corrected twice, and to tell the copy model which hooks she kept and
// which she turned down; jobs/critic.py is told what she rejected.
//
// Layer 9, live: when more than half of the last reviewed clips (at least MIN_REVIEWED, within
// WINDOW_DAYS) were rejected, the studio switches its approach to "careful" on its own (fewer clips,
// only the strongest plans, her best-kept shape first, the critic stricter) and logs why; it switches
// back once the rate falls to SWITCH_BACK or under. Pure summary + one loader; tests/unit/studio-memory.test.ts.
import type { Env } from "../env";
import { getSetting, recordEvent, setSetting } from "../lib/db";
import { log } from "../lib/log";
import { nowIso } from "../lib/ids";

export const WINDOW_DAYS = 30;
export const RECENT_REVIEWED = 30;
export const MIN_REVIEWED = 10;
export const SWITCH_AT = 0.5;
export const SWITCH_BACK = 0.35;

export type Approach = "standard" | "careful";

export interface ReviewedRow {
  status: "approved" | "rejected";
  shape: string | null;
  service: string | null;
  hook_text: string;
  reject_reason: string | null;
  reviewed_at: string;
  views: number | null;
}

export interface MemorySummary {
  shapes: Record<string, { approved: number; rejected: number; views: number }>;
  kept_hooks: string[];
  turned_down_hooks: string[];
  reject_reasons: string[];
  notes: string[];
  /** A service the studio saw, and what she said it really is (at least twice). */
  relabel: Record<string, string>;
  rejection: { rate: number; reviewed: number; window_days: number };
  approach: Approach;
  why: string;
}

function clip(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

/** Decisions this close together, the same way for the same reason, are one decision (a clear-out). */
export const BURST_S = 5;

/**
 * The reviewed clips as decisions (newest first): a run of the same decision for the same reason,
 * each within BURST_S of the one before, counts once. Nobody watches a clip in under 5 seconds: 16
 * "bad cut" rejections 0.7 s apart (23 Oct 2026, a dump cut by two since-fixed bugs, then Started
 * over) are one "this cut is bad", not 16 tastes, and must not switch a studio to careful for 30 days.
 */
export function decisions<T extends Pick<ReviewedRow, "status" | "reject_reason" | "reviewed_at">>(rows: readonly T[]): T[] {
  const out: T[] = [];
  let prev: T | null = null;
  for (const r of rows) {
    const t = Date.parse(r.reviewed_at);
    const pt = prev ? Date.parse(prev.reviewed_at) : NaN;
    const same = !!prev && prev.status === r.status && (prev.reject_reason ?? "") === (r.reject_reason ?? "") && Number.isFinite(t) && Number.isFinite(pt) && Math.abs(pt - t) <= BURST_S * 1000;
    if (!same) out.push(r);
    prev = r;
  }
  return out;
}

/** The rejection rate over the most recent decisions (newest first; a clear-out counts once). */
export function rejectionRate(rows: readonly ReviewedRow[]): { rate: number; reviewed: number } {
  const recent = decisions(rows).slice(0, RECENT_REVIEWED);
  const rejected = recent.filter((r) => r.status === "rejected").length;
  return { rate: recent.length ? Math.round((rejected / recent.length) * 1000) / 1000 : 0, reviewed: recent.length };
}

/** Layer 9: which approach, given the rate and the approach in use (hysteresis so it never flaps). */
export function chooseApproach(prev: Approach, r: { rate: number; reviewed: number }): { approach: Approach; why: string } {
  if (r.reviewed < MIN_REVIEWED) return { approach: prev === "careful" ? "careful" : "standard", why: `only ${r.reviewed} clips reviewed in ${WINDOW_DAYS} days` };
  if (r.rate > SWITCH_AT) return { approach: "careful", why: `${Math.round(r.rate * 100)}% of the last ${r.reviewed} clips were turned down (over ${SWITCH_AT * 100}%)` };
  if (prev === "careful" && r.rate > SWITCH_BACK) return { approach: "careful", why: `${Math.round(r.rate * 100)}% turned down: staying careful until it is ${SWITCH_BACK * 100}% or less` };
  return { approach: "standard", why: `${Math.round(r.rate * 100)}% of the last ${r.reviewed} clips were turned down` };
}

/** The summary the cut job reads. Pure. */
export function summarize(rows: readonly ReviewedRow[], notes: readonly string[], corrections: readonly { from: string; to: string }[], prev: Approach): MemorySummary {
  const shapes: MemorySummary["shapes"] = {};
  for (const r of rows) {
    const k = r.shape ?? "unsure";
    const s = (shapes[k] ??= { approved: 0, rejected: 0, views: 0 });
    if (r.status === "approved") s.approved++;
    else s.rejected++;
    s.views += r.views ?? 0;
  }
  const counts = new Map<string, number>();
  for (const c of corrections) if (c.from && c.to && c.from.toLowerCase() !== c.to.toLowerCase()) counts.set(`${c.from}\u0000${c.to}`, (counts.get(`${c.from}\u0000${c.to}`) ?? 0) + 1);
  const relabel: Record<string, string> = {};
  for (const [k, n] of counts) {
    const [from, to] = k.split("\u0000") as [string, string];
    if (n >= 2 && !relabel[from]) relabel[from] = to;
  }
  const rate = rejectionRate(rows);
  const { approach, why } = chooseApproach(prev, rate);
  return {
    shapes,
    kept_hooks: [...new Set(rows.filter((r) => r.status === "approved" && r.hook_text.trim()).map((r) => clip(r.hook_text, 80)))].slice(0, 8),
    turned_down_hooks: [...new Set(rows.filter((r) => r.status === "rejected" && r.hook_text.trim()).map((r) => clip(r.hook_text, 80)))].slice(0, 8),
    reject_reasons: [...new Set(rows.map((r) => (r.reject_reason ? clip(r.reject_reason, 120) : "")).filter(Boolean))].slice(0, 6),
    notes: [...new Set(notes.map((n) => clip(n, 200)).filter(Boolean))].slice(0, 6),
    relabel,
    rejection: { rate: rate.rate, reviewed: rate.reviewed, window_days: WINDOW_DAYS },
    approach,
    why,
  };
}

/** Read the studio's memory for a cut, and switch the approach (logged, recorded) when the rate says so. */
export async function loadMemory(env: Pick<Env, "DB">): Promise<MemorySummary> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { results: rows } = await env.DB.prepare(
    `SELECT c.status, c.shape, c.service, c.hook_text, c.reject_reason, c.reviewed_at,
            (SELECT MAX(m.views) FROM posts p JOIN metrics m ON m.post_id = p.id WHERE p.clip_id = c.id) AS views
     FROM clips c WHERE c.status IN ('approved', 'rejected') AND c.reviewed_at >= ? ORDER BY c.reviewed_at DESC LIMIT 200`,
  )
    .bind(since)
    .all<ReviewedRow>();
  const { results: noteRows } = await env.DB.prepare("SELECT again_notes FROM clips WHERE again_notes IS NOT NULL AND again_notes != '' AND created_at >= ? ORDER BY created_at DESC LIMIT 12").bind(since).all<{ again_notes: string }>();
  const { results: answers } = await env.DB.prepare("SELECT detail FROM events WHERE kind = 'dump.question_answered' AND created_at >= ? ORDER BY created_at DESC LIMIT 100").bind(since).all<{ detail: string }>();
  const corrections = answers
    .map((a) => {
      try {
        const d = JSON.parse(a.detail) as { from_service?: unknown; to_service?: unknown };
        return typeof d.from_service === "string" && typeof d.to_service === "string" ? { from: d.from_service, to: d.to_service } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { from: string; to: string } => !!x);
  const prevSetting = await getSetting<{ approach?: Approach }>(env.DB, "cut_approach", {});
  const prev: Approach = prevSetting.approach === "careful" ? "careful" : "standard";
  const m = summarize(rows, noteRows.map((r) => r.again_notes), corrections, prev);
  if (m.approach !== prev) {
    await setSetting(env.DB, "cut_approach", { approach: m.approach, since: nowIso(), rate: m.rejection.rate, reviewed: m.rejection.reviewed });
    await recordEvent(env.DB, "studio.approach_switched", null, { from: prev, to: m.approach, rate: m.rejection.rate, reviewed: m.rejection.reviewed, why: m.why });
    log.warn("studio.approach_switched", { from: prev, to: m.approach, rate: m.rejection.rate, reviewed: m.rejection.reviewed });
  }
  return m;
}
