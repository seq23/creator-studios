// Photo posts, the pure parts (tested in tests/unit/photo-posts.test.ts): when each piece of a pack
// goes out, the plain line she sees under a post, and the signed Skip link in the heads-up email.
import { zonedToUtc } from "./slotting";
import { PACK_PLAN, SOCIAL_LABEL, type ItemKind, type PhotoPostsConfig, type Social, type SocialPostStatus } from "@shared/photoPosts";
import { hmacHex, timingSafeEqual } from "../lib/crypto";

/** "2026-10-23" for an instant, in the studio's time zone. */
export function localDate(ms: number, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export interface PlannedSocialPost {
  kind: ItemKind;
  platform: Social;
  scheduled_at: string;
}

/**
 * When each piece of a new pack goes out. Day 1 the reel, day 2 the photo set, day 3 the
 * before/after (when two photos made one), each at the studio's post hour, never sooner than the
 * heads-up lead (so the heads-up always comes first), and at most one photo post per platform
 * per local day (`taken`: "platform|YYYY-MM-DD" already used), skipping any week that channel
 * already has 10 posts in (`weekFull`: the locked hard cap, clips and photo posts together). Pure.
 */
export function planPack(nowMs: number, cfg: PhotoPostsConfig, timeZone: string, kinds: ItemKind[], taken: Set<string>, weekFull: (platform: Social, at: string) => boolean = () => false): PlannedSocialPost[] {
  const earliest = nowMs + cfg.headsUpHours * 3_600_000;
  // The possible post times, in order: the post hour on each local day, from the first one the lead allows.
  const slots: string[] = [];
  for (let k = 0; slots.length < 90 && k < 120; k++) {
    const [y, m, d] = localDate(earliest + k * 86_400_000, timeZone).split("-").map(Number);
    const at = zonedToUtc(y, m, d, cfg.postHour, 0, timeZone);
    if (Date.parse(at) >= earliest && !slots.includes(at)) slots.push(at);
  }
  const out: PlannedSocialPost[] = [];
  const used = new Set(taken);
  for (const step of PACK_PLAN) {
    if (!kinds.includes(step.kind)) continue;
    for (const platform of step.platforms) {
      if (!cfg.platforms.includes(platform)) continue;
      const at = slots.slice(step.day - 1).find((s) => !used.has(`${platform}|${localDate(Date.parse(s), timeZone)}`) && !weekFull(platform, s));
      if (!at) continue;
      used.add(`${platform}|${localDate(Date.parse(at), timeZone)}`);
      out.push({ kind: step.kind, platform, scheduled_at: at });
    }
  }
  return out.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at) || a.platform.localeCompare(b.platform));
}

/** "Thu, Oct 23, 11 AM" in the studio's time zone. */
export function whenLine(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(":00", "");
  } catch {
    return new Date(iso).toUTCString();
  }
}

/** The plain line under a post, in her words. Pure. */
export function postLine(p: { status: SocialPostStatus; scheduled_at: string; platform: Social; error: string | null; posted_at?: string | null }, timeZone: string, waitingOn: string | null): string {
  const when = whenLine(p.scheduled_at, timeZone);
  switch (p.status) {
    case "scheduled":
      return `Goes out on its own ${when}. Tap Skip to stop it.`;
    case "waiting":
      return waitingOn ? `Waiting: ${waitingOn}. It goes out after that.` : "Waiting to go out.";
    case "sending":
      return "Going out now.";
    case "posted":
      return `Posted to ${SOCIAL_LABEL[p.platform]}${p.posted_at ? ` ${whenLine(p.posted_at, timeZone)}` : ""}.`;
    case "skipped":
      return "Skipped. It will not go out.";
    case "held":
      return `Stopped before posting: ${p.error ?? "it broke a studio rule"}`;
    case "failed":
      return `Did not go out: ${p.error ?? "the platform said no"}`;
  }
}

/** The Skip link in the heads-up email: /skip/<postId>.<signature>, signed with the session secret. */
export async function skipToken(secret: string, postId: string): Promise<string> {
  return `${postId}.${(await hmacHex(secret, `skip:${postId}`)).slice(0, 32)}`;
}

/** The post id a Skip link names, or null when the signature is wrong. */
export async function readSkipToken(secret: string, token: string): Promise<string | null> {
  const [id, sig] = String(token ?? "").split(".");
  if (!id || !sig || !/^spo_[a-z0-9]{6,32}$/.test(id)) return null;
  const want = (await hmacHex(secret, `skip:${id}`)).slice(0, 32);
  return timingSafeEqual(sig, want) ? id : null;
}

/** Three short starter captions, used when the free AI is busy or a draft broke a rule. Pure. */
export function starterCaptions(note: string, appName: string): string[] {
  const n = note.replace(/\s+/g, " ").trim().slice(0, 140);
  const name = appName.replace(/\s*studio$/i, "").trim() || "us";
  return [n || `Fresh from ${name} this week.`, "Swipe through the details.", `Made with care by ${name}.`];
}
