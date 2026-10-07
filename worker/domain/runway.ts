// Runway (section 11): weeks of approved, unposted clips at the current weekly cap.
// "Weekly need" is unique clips per week: every clip goes to the platform with the highest
// cap, so the need is the max cap, not the sum (10 unique clips feed 22 posts at 10/7/5).
import type { Platform } from "@shared/constants";

export function weeklyNeed(caps: Record<Platform, number>): number {
  return Math.max(0, ...Object.values(caps));
}

export function runwayWeeks(approvedUnpostedClips: number, need: number): number {
  if (need <= 0) return Infinity;
  return Math.round((approvedUnpostedClips / need) * 10) / 10;
}

/** The "Time to dump" email fires when runway is under the threshold. */
export function runwayLow(approvedUnpostedClips: number, caps: Record<Platform, number>, thresholdWeeks: number): boolean {
  const need = weeklyNeed(caps);
  if (need <= 0) return false;
  return approvedUnpostedClips < need * thresholdWeeks;
}
