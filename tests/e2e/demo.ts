// Demo data for the help screenshots and the deals/voice/help spec (section 12c: demo data only,
// never her real content). Seeded straight into the local D1 the e2e Worker is using, and
// removed again afterwards so the other specs see the database they expect.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";

const ROOT = process.cwd(); // playwright runs from the repo root
const SEED = path.join("tests", "e2e", "seed-demo.sql");
const DB = "creator-studios-dev-db";

function d1(args: string[]) {
  execFileSync("npx", ["wrangler", "d1", "execute", DB, "--local", ...args], { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } });
}

/**
 * The seed files were written on SEEDED_ON and their timestamps are fixed. Every age rule in the app
 * (files go 7 days after posting, drafts warned before 14 days, Home's newest cards) reads them
 * against today, so a fixed date turns a "posted yesterday" row into a "cleared two weeks ago" one
 * as the calendar moves (7 Oct 2026: finish-in-youtube-studio lost its card that way). Apply them
 * moved forward by the days since then, so every row keeps its age relative to today.
 */
export const SEEDED_ON = "2026-09-26";
export function shiftSeed(sql: string, now = new Date()): string {
  const days = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.parse(`${SEEDED_ON}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return sql;
  return sql.replace(/\b(20\d\d-\d\d-\d\d)T(\d\d:\d\d:\d\d(?:\.\d+)?Z)/g, (_m, d: string, t: string) => new Date(Date.parse(`${d}T${t}`) + days * 86_400_000).toISOString());
}
/** How the app prints a seeded timestamp once shifted to today ("Oct 5, 2026"): for assertions on seeded dates. */
export function seedLabel(iso: string, now = new Date()): string {
  return new Date(shiftSeed(iso, now)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function d1File(file: string) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "seed-")), path.basename(file));
  writeFileSync(out, shiftSeed(readFileSync(path.join(ROOT, file), "utf8")));
  d1(["--file", out]);
}

export function seedDemo() {
  d1File(SEED);
  d1(["--command", demoPostsSql(new Date())]);
}

/**
 * A calendar with something on it, dated from today (the SQL file cannot know "today"): one post
 * that went out (a month ago), one that failed, one waiting in Buffer and two planned. Without these the
 * Calendar guides ("A post failed", "Move or remove a post") pictured an empty week (Phase 0 live
 * review of the help-screenshots PR, 26 Sep 2026).
 */
export function demoPostsSql(now: Date): string {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const rows: [string, string, string, string, string, string | null, string | null][] = [
    // posted 35 days ago: outside the 30-day window the deals screen counts (TikTok One: "0 of 3")
    ["demo_post_1", "demo_clip_1", "tiktok", at(-35, 23), "posted", "https://www.tiktok.com/@demo/video/1", null],
    ["demo_post_2", "demo_clip_2", "instagram", at(0, 1), "failed", null, "Instagram did not accept the video. Reconnect Instagram in Buffer."],
    ["demo_post_3", "demo_clip_3", "tiktok", at(1, 23), "in_buffer", null, null],
    ["demo_post_4", "demo_clip_4", "youtube", at(2, 22), "planned", null, null],
    ["demo_post_5", "demo_clip_5", "instagram", at(3, 23), "planned", null, null],
  ];
  const q = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
  return rows
    .map(([id, clip, platform, when, status, url, error]) => `INSERT INTO posts (id, clip_id, platform, scheduled_at, status, url, error, posted_at) VALUES (${q(id)}, ${q(clip)}, ${q(platform)}, ${q(when)}, ${q(status)}, ${q(url)}, ${q(error)}, ${status === "posted" ? q(when) : "NULL"});`)
    .join(" ");
}

/** The seed file's own clean-up block (everything before the first INSERT). */
export function clearDemo() {
  const sql = readFileSync(path.join(ROOT, SEED), "utf8");
  const clean = sql
    .slice(0, sql.indexOf("INSERT"))
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .join(" ");
  d1(["--command", clean]);
}

const EXTRA = path.join("tests", "e2e", "seed-help-extra.sql");
const LIGHTS = path.join("tests", "e2e", "seed-help-lights.sql");

/** A seed file's own clean-up block (everything before the first INSERT). */
function cleanupOf(file: string): string {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  return text
    .slice(0, text.indexOf("INSERT"))
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .join(" ");
}
const BUCKET = "creator-studios-dev-files";

/** The services the help pictures show as connected (fake keys, FAKE_SERVICES=1). */
export const HELP_CONNECTED: Record<string, string> = {
  buffer: "good-key-e2e-000",
  openrouter: "good-demo-openrouter",
  elevenlabs: "good-demo-creator",
};

/**
 * The help screenshots' base state on top of seedDemo(): the connections a set-up dashboard has
 * (through the real Connect routes, so the cards and lights are the app's own), her typed
 * Instagram numbers, an inbound offer read by the real offer reader, then the extra rows in
 * seed-help-extra.sql (applied last, so its health board is what the screens show).
 */
export async function seedHelpBaseline(request: APIRequestContext) {
  for (const [service, key] of Object.entries(HELP_CONNECTED)) {
    const r = await request.post(`/api/connections/${service}/key`, { data: { key } });
    if (!r.ok()) throw new Error(`demo: could not connect ${service}: ${r.status()}`);
  }
  const ig = await request.post("/api/stats/instagram-numbers", { data: { followers: 8200, avg_reach: 1900 } });
  if (!ig.ok()) throw new Error(`demo: Instagram numbers refused: ${ig.status()}`);
  d1File(EXTRA);
  d1File(LIGHTS);
  d1(["--command", helpPostsSql(new Date())]);
  const offer = await request.post("/api/deals/deals/demo_deal_4/offer", {
    data: {
      text: "Hi Sam! We love your morning routine videos. We'd like 2 TikTok videos and 1 Instagram Reel featuring our new travel tumbler for our holiday launch. Our budget is $600 total. We'd need usage rights in perpetuity across all our channels including paid ads, and exclusivity in drinkware for 6 months. Payment is net 90 after posting. Can you post by Oct 20? Best, Priya, Lark & Laurel",
    },
  });
  if (!offer.ok()) throw new Error(`demo: offer reader refused: ${offer.status()}`);
}

/**
 * Today's week on the Calendar for the help pictures: one post that went out (with its link), one
 * that failed, one waiting in Buffer and one planned, all today between 14:00 and 21:00 UTC so they
 * sit on today in any US time zone whatever day the job runs.
 */
export function helpPostsSql(now: Date): string {
  const at = (hour: number) => {
    const d = new Date(now);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const rows: [string, string, string, number, string, string | null, string | null][] = [
    ["demo_post_h1", "demo_clip_1", "youtube", 14, "posted", "https://www.youtube.com/shorts/demoyt00001", null],
    ["demo_post_h2", "demo_clip_6", "instagram", 16, "failed", null, "Instagram did not accept the video. Instagram is disconnected inside Buffer: reconnect it there."],
    ["demo_post_h3", "demo_clip_7", "tiktok", 18, "in_buffer", null, null],
    ["demo_post_h4", "demo_clip_8", "tiktok", 21, "planned", null, null],
  ];
  const q = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
  return rows
    .map(([id, clip, platform, hour, status, url, error]) => `INSERT OR REPLACE INTO posts (id, clip_id, platform, scheduled_at, status, url, error, posted_at) VALUES (${q(id)}, ${q(clip)}, ${q(platform)}, ${q(at(hour))}, ${q(status)}, ${q(url)}, ${q(error)}, ${status === "posted" ? q(at(hour)) : "NULL"});`)
    .join(" ");
}

/** After a guide changed a connection or a light: the base connections and health board again. */
export async function restoreHelpLights(request: APIRequestContext) {
  for (const [service, key] of Object.entries(HELP_CONNECTED)) await request.post(`/api/connections/${service}/key`, { data: { key } });
  await request.patch("/api/editing", { data: { editors: { cut_from_source: "built-in", caption: "built-in", enhance: "built-in" } } });
  d1(["--file", LIGHTS]);
}

/** One health light as a step describes it (`<!-- light: Name | red | note -->`). */
export function setLight(name: string, light: string, note: string) {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  d1(["--command", `INSERT OR REPLACE INTO health (name, light, note, fix_guide, checked_at) VALUES (${q(name)}, ${q(light)}, ${q(note)}, (SELECT fix_guide FROM health WHERE name = ${q(name)}), '2026-09-26T04:00:00.000Z');`]);
}

/** Puts back what seedHelpBaseline changed (seedDemo's own clean-up runs in clearDemo). */
export async function clearHelpBaseline(request: APIRequestContext) {
  for (const s of Object.keys(HELP_CONNECTED)) await request.post(`/api/connections/${s}/disconnect`);
  d1(["--command", `${cleanupOf(EXTRA)} ${cleanupOf(LIGHTS)} DELETE FROM connections WHERE service IN ('buffer', 'openrouter', 'elevenlabs'); DELETE FROM health WHERE name IN ('buffer', 'openrouter', 'elevenlabs', 'Voice · ElevenLabs');`]);
}

/** Store a file in the local R2 bucket the e2e Worker serves (covers for the demo clips). */
export function putObject(key: string, file: string, contentType: string) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--local", "--file", file, "--content-type", contentType], { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } });
}

export async function setVoice(request: APIRequestContext, on: boolean) {
  const r = await request.patch("/api/settings", { data: { features: { voice: on } } });
  if (!r.ok()) throw new Error(`could not switch voice ${on ? "on" : "off"}: ${r.status()}`);
}

export const TOUR_OFF = () => {
  try {
    localStorage.setItem("ss-tour-done", "1");
  } catch {
    /* ignore */
  }
};
