// Recycle guard rails (section 7, Door B): 90-day cooldown per platform, never the identical
// file, best past performers first.
import type { Platform } from "@shared/constants";

export interface PriorPost {
  platform: Platform;
  posted_at: string;
}

export function inCooldown(prior: PriorPost[], platform: Platform, now: Date, cooldownDays: number): boolean {
  const cutoff = new Date(now.getTime() - cooldownDays * 86400_000).toISOString();
  return prior.some((p) => p.platform === platform && p.posted_at > cutoff);
}

/** Platforms a recycled asset may go to today. */
export function recyclePlatforms(prior: PriorPost[], wanted: Platform[], now: Date, cooldownDays: number): Platform[] {
  return wanted.filter((p) => !inCooldown(prior, p, now, cooldownDays));
}

/** Best past performers first: rough views if known, then most recent. */
export function rankRecycle<T extends { original_views: number | null; original_posted_at: string | null }>(assets: T[]): T[] {
  return [...assets].sort((a, b) => {
    const va = a.original_views ?? -1;
    const vb = b.original_views ?? -1;
    if (vb !== va) return vb - va;
    return (b.original_posted_at ?? "").localeCompare(a.original_posted_at ?? "");
  });
}
