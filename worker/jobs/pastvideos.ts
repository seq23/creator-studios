// Learn from my past videos (owner's plan, 23 Oct 2026). jobs/pastvideos.py watches her 3 to 10 old
// FINISHED videos (R2 pastvideos/, never footage, never cut) with the cutter's footage reading and
// $0 AI only, and sends back the "How my videos feel" section (video_feel). The Worker adds it as a
// NEW unlocked version of the Brand Profile: a locked profile is never changed underneath her; the
// clips keep using the locked one until she reads the section and locks again (lib/profileInUse.ts).
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { getConnectionSecret } from "../lib/connections";
import { getSetting, parseJson, recordEvent, setSetting } from "../lib/db";
import { log } from "../lib/log";
import { nowIso } from "../lib/ids";
import { servicesOf } from "@shared/services";
import { cleanSections, SECTION_MAX_CHARS } from "../domain/profile";
import { PROFILE_IN_USE } from "../lib/profileInUse";
import { PAST_VIDEOS_MAX } from "@shared/constants";

export interface PastVideosSpec {
  job_id: string;
  type: "pastvideos";
  llm_key: string | null;
  videos: { id: string; r2_key: string }[];
  services: string[];
  profile: { voice: string };
}

/** What the last reading did (shown on Client Brain). */
export interface PastVideosRead {
  at: string;
  videos?: number;
  by?: "ai" | "rules";
  /** The new unlocked version the section went into. */
  version?: number;
  /** A locked profile was in use when it landed: she is asked to read it and lock again. */
  lockedInUse?: boolean;
  failed?: string;
}
export const PAST_READ_KEY = "past_videos_read";

async function buildSpec(env: Env, jobId: string): Promise<PastVideosSpec> {
  const { results } = await env.DB.prepare("SELECT id, r2_key FROM past_videos WHERE upload_status = 'uploaded' ORDER BY created_at LIMIT ?").bind(PAST_VIDEOS_MAX).all<{ id: string; r2_key: string }>();
  const row = await env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
  const sections = row ? parseJson<Record<string, string>>(row.sections, {}) : {};
  return {
    job_id: jobId,
    type: "pastvideos",
    llm_key: await getConnectionSecret(env, "openrouter"),
    videos: results,
    services: servicesOf(row ? sections : null),
    profile: { voice: String(sections.voice ?? "").slice(0, 600) },
  };
}

/** The section as stored: plain lines, bounded, nothing but text. */
export function cleanFeel(x: unknown): string {
  return String(typeof x === "string" ? x : "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, SECTION_MAX_CHARS);
}

/**
 * Put "How my videos feel" into a NEW unlocked version built on the newest one. The locked version
 * (if any) is left exactly as it is. Returns the new version.
 */
export async function addVideoFeel(env: Env, section: string): Promise<{ version: number; lockedInUse: boolean }> {
  const latest = await env.DB.prepare("SELECT version, sections FROM brand_profile ORDER BY version DESC LIMIT 1").first<{ version: number; sections: string }>();
  const sections = cleanSections({ ...(latest ? parseJson<Record<string, unknown>>(latest.sections, {}) : {}), video_feel: section });
  const res = await env.DB.prepare("INSERT INTO brand_profile (sections, locked, source) VALUES (?, 0, 'draft')").bind(JSON.stringify(sections)).run();
  const lockedInUse = !!(await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first());
  return { version: Number(res.meta.last_row_id), lockedInUse };
}

async function applyResult(env: Env, _jobId: string, _refId: string | null, result: unknown): Promise<void> {
  const r = (result ?? {}) as { section?: unknown; videos?: unknown; by?: unknown };
  const section = cleanFeel(r.section);
  if (!section) throw new Error("pastvideos: empty section");
  const { version, lockedInUse } = await addVideoFeel(env, section);
  await env.DB.prepare("UPDATE past_videos SET read_at = ? WHERE upload_status = 'uploaded'").bind(nowIso()).run();
  const read: PastVideosRead = { at: nowIso(), videos: Number(r.videos) || 0, by: r.by === "ai" ? "ai" : "rules", version, lockedInUse };
  await setSetting(env.DB, PAST_READ_KEY, read);
  await recordEvent(env.DB, "profile.video_feel", String(version), { videos: read.videos, by: read.by });
  log.info("pastvideos.apply", { videos: read.videos, by: read.by, lockedInUse });
}

async function onFailure(env: Env): Promise<void> {
  const prev = await getSetting<PastVideosRead | null>(env.DB, PAST_READ_KEY, null);
  await setSetting(env.DB, PAST_READ_KEY, { ...(prev ?? {}), at: prev?.at ?? nowIso(), failed: nowIso() });
}

/** FAKE_SERVICES=1: the section the rules write for three short, quick, music-led videos. */
async function fakeRun(env: Env): Promise<unknown> {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM past_videos WHERE upload_status = 'uploaded'").first<{ n: number }>())?.n ?? 0;
  return {
    section: [
      "Hooks and first 2 seconds: The finished result first; no talking at the start; a cut in the first 2 seconds.",
      "Pacing and cut length: Quick: a cut about every 2 seconds.",
      "Typical length: 12 to 25 seconds.",
      "Captions and on-screen text: Short white text near the top, three to five words.",
      "Music and energy: Mostly music under the picture, high energy.",
      "How I talk to camera: Rarely on camera; text carries it.",
      "Recurring formats: Before and after, and a slow walk-through of the finished room.",
    ].join("\n"),
    videos: n,
    by: "rules",
  };
}

export const pastVideosJob: JobHandler = { buildSpec, applyResult, onFailure, fakeRun };
