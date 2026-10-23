// "What's working in your niche" (studio fix, 23 Oct 2026). Once a month the niche job
// (jobs/niche_research.py, $0: the free web search in jobs/common.py and the free AI ladder in
// jobs/ai.py) researches what converts for this studio's niche, read from its locked Brand Profile.
// The playbook is stored in D1 (niche_playbooks), handed to every cut as spec.niche_playbook, shown
// calmly on the Brand page, and sent once as a short plain-English note through the studio's own
// email path (a studio with NOTIFY_EMAIL sends only there: worker/services/email.ts routeRecipients).
// Nothing waits on the owner: with no locked profile yet it waits on that, says so in a health light,
// and runs the day the profile is locked. Guard: tests/unit/niche-playbook.test.ts.
import type { Env } from "../env";
import { newId, nowIso } from "./ids";
import { parseJson, recordEvent, setHealth } from "./db";
import { log } from "./log";
import { emailFrame, sendEmail } from "../services/email";
import { dispatchJob } from "../services/github";

export interface NichePlaybook {
  updated_at: string;
  /** Clip formats that convert in this niche, best first ("Before and after, finished result in the first second"). */
  formats: string[];
  /** Opening lines or on-screen hooks that work. */
  hooks: string[];
  /** Caption and call-to-action tips. */
  caption_tips: string[];
}

export const NICHE_HEALTH = "What's working in your niche";
/** Re-research after this many days; the daily lane checks. */
export const NICHE_EVERY_DAYS = 30;
/** A job that failed is tried again after this many days, not every day. */
export const NICHE_RETRY_DAYS = 3;

const list = (v: unknown, n: number, chars: number): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, chars) : "")).filter(Boolean).slice(0, n) : [];

/** The job's answer, checked: plain strings only, bounded. Null when there is nothing usable. Pure. */
export function cleanPlaybook(v: unknown, at = nowIso()): { playbook: NichePlaybook; summary: string[]; sources: number } | null {
  const r = (v ?? {}) as Record<string, unknown>;
  const p = (r.playbook ?? {}) as Record<string, unknown>;
  const playbook: NichePlaybook = { updated_at: at, formats: list(p.formats, 8, 160), hooks: list(p.hooks, 8, 120), caption_tips: list(p.caption_tips, 8, 160) };
  if (!playbook.formats.length && !playbook.hooks.length && !playbook.caption_tips.length) return null;
  const summary = list(r.summary, 5, 200);
  return { playbook, summary: summary.length ? summary : summaryOf(playbook), sources: Math.max(0, Math.min(100, Math.floor(Number(r.sources) || 0))) };
}

/** Three plain lines when the job sent none. Pure. */
export function summaryOf(p: NichePlaybook): string[] {
  return [p.formats[0] && `Works best: ${p.formats[0]}`, p.hooks[0] && `A strong opening: ${p.hooks[0]}`, p.caption_tips[0] && `In the caption: ${p.caption_tips[0]}`].filter((x): x is string => !!x);
}

/** The newest playbook (what the cut reads), or null before the first run. */
export async function latestPlaybook(env: Pick<Env, "DB">): Promise<NichePlaybook | null> {
  const row = await env.DB.prepare("SELECT body FROM niche_playbooks ORDER BY created_at DESC LIMIT 1").first<{ body: string }>();
  return parseJson<NichePlaybook | null>(row?.body ?? null, null);
}

export interface NicheView {
  playbook: NichePlaybook | null;
  summary: string[];
  updated_at: string | null;
  next_on: string | null;
}

/** For the Brand page: the newest summary and when the next one is due. */
export async function nicheView(env: Pick<Env, "DB">): Promise<NicheView> {
  const row = await env.DB.prepare("SELECT body, summary, created_at FROM niche_playbooks ORDER BY created_at DESC LIMIT 1").first<{ body: string; summary: string; created_at: string }>();
  if (!row) return { playbook: null, summary: [], updated_at: null, next_on: null };
  return {
    playbook: parseJson<NichePlaybook | null>(row.body, null),
    summary: parseJson<string[]>(row.summary, []),
    updated_at: row.created_at,
    next_on: new Date(Date.parse(row.created_at) + NICHE_EVERY_DAYS * 86400_000).toISOString().slice(0, 10),
  };
}

/** Is a monthly run due? Pure: the newest playbook's age, and the last niche job's. */
export function nicheDue(o: { now: Date; lastPlaybookAt: string | null; lastJob: { status: string; created_at: string } | null; profileLocked: boolean }): { run: boolean; note: string; light: "green" | "yellow" } {
  if (!o.profileLocked) return { run: false, note: "Waiting for your Brand Profile to be locked; the first niche research runs the day it is.", light: "yellow" };
  const age = (iso: string | null) => (iso ? (o.now.getTime() - Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`)) / 86400_000 : Infinity);
  if (o.lastJob && ["queued", "dispatched", "running"].includes(o.lastJob.status) && age(o.lastJob.created_at) < 1) return { run: false, note: "Researching your niche now.", light: "green" };
  if (age(o.lastPlaybookAt) < NICHE_EVERY_DAYS) return { run: false, note: "Up to date: researched within the last month.", light: "green" };
  if (o.lastJob?.status === "failed" && age(o.lastJob.created_at) < NICHE_RETRY_DAYS) return { run: false, note: `The last niche research did not finish; it tries again within ${NICHE_RETRY_DAYS} days. Your clips use the last one meanwhile.`, light: "yellow" };
  return { run: true, note: "Monthly niche research started.", light: "green" };
}

/** Daily lane: start the monthly niche research when it is due. */
export async function monthlyNicheRefresh(env: Env, now = new Date()): Promise<{ dispatched: boolean; note: string }> {
  const profile = await env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first();
  const last = await env.DB.prepare("SELECT created_at FROM niche_playbooks ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  const job = await env.DB.prepare("SELECT status, created_at FROM jobs WHERE type = 'niche' ORDER BY created_at DESC LIMIT 1").first<{ status: string; created_at: string }>();
  const d = nicheDue({ now, lastPlaybookAt: last?.created_at ?? null, lastJob: job ?? null, profileLocked: !!profile });
  if (!d.run) {
    await setHealth(env.DB, NICHE_HEALTH, d.light, d.note, null);
    return { dispatched: false, note: d.note };
  }
  const r = await dispatchJob(env, "niche", null);
  const note = r.dispatched ? d.note : `The niche research could not start (${r.error ?? "unknown"}). It tries again tomorrow; your clips use the last one meanwhile.`;
  await setHealth(env.DB, NICHE_HEALTH, r.dispatched ? "green" : "yellow", note, r.dispatched ? null : "reconnect-github");
  log.info("niche.monthly", { dispatched: r.dispatched });
  return { dispatched: r.dispatched, note };
}

/** Store a finished run and send the short monthly note (once per playbook). */
export async function storePlaybook(env: Env, jobId: string, result: unknown): Promise<string | null> {
  const clean = cleanPlaybook(result);
  if (!clean) {
    await setHealth(env.DB, NICHE_HEALTH, "yellow", "The niche research found nothing usable this time; it tries again in a few days. Your clips use the last one meanwhile.", null);
    return null;
  }
  const id = newId("nch");
  await env.DB.prepare("INSERT INTO niche_playbooks (id, body, summary, sources) VALUES (?, ?, ?, ?)").bind(id, JSON.stringify(clean.playbook), JSON.stringify(clean.summary), clean.sources).run();
  await recordEvent(env.DB, "niche.researched", jobId, { formats: clean.playbook.formats.length, hooks: clean.playbook.hooks.length, tips: clean.playbook.caption_tips.length, sources: clean.sources });
  await setHealth(env.DB, NICHE_HEALTH, "green", "Up to date: researched this month.", null);
  await sendNicheNote(env, id, clean.summary);
  return id;
}

/** The monthly note: a few plain lines, a link to the Brand page. */
export async function sendNicheNote(env: Env, playbookId: string, summary: string[]): Promise<void> {
  const { readSettings } = await import("../routes/settings");
  const s = await readSettings(env);
  const { html, text } = emailFrame(
    "What's working in your niche this month",
    ["We looked at what is bringing people in for businesses like yours. Your next clips already use it:", ...summary.map((l) => `• ${l}`), "Nothing for you to do."],
    { label: "See it on your Brand page", url: `${env.PUBLIC_BASE_URL}/brain#niche` },
  );
  const r = await sendEmail(env, { kind: "niche_note", to: s.notify_emails, subject: "What's working in your niche this month", html, text, refId: playbookId });
  if (r.ok) await env.DB.prepare("UPDATE niche_playbooks SET emailed_at = ? WHERE id = ?").bind(nowIso(), playbookId).run();
}
