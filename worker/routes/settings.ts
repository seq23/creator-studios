// Settings (section 4): caps, times, threshold, emails, features, helper login, and the
// Health panel. Connections have their own file.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { getSetting, listHealth, recordEvent, setSetting } from "../lib/db";
import { fail, isEmail, readJson } from "../lib/http";
import { DEFAULT_FEATURES, DEFAULT_RECYCLE_COOLDOWN_DAYS, DEFAULT_RUNWAY_THRESHOLD_WEEKS, DEFAULT_WEEKLY_CAPS, HARD_CAP_PER_CHANNEL_PER_WEEK, PLATFORMS } from "@shared/constants";
import type { Features, SettingsShape } from "@shared/types";

export const settings = new Hono<{ Bindings: Env; Variables: Vars }>();
settings.use("*", requireUser);

export async function readSettings(env: Env): Promise<SettingsShape> {
  const [weekly_caps, hard_cap_per_channel, runway_threshold_weeks, notify_emails, posting_slots_source, features, recycle_cooldown_days, helper_email] = await Promise.all([
    getSetting(env.DB, "weekly_caps", DEFAULT_WEEKLY_CAPS),
    getSetting(env.DB, "hard_cap_per_channel", HARD_CAP_PER_CHANNEL_PER_WEEK),
    getSetting(env.DB, "runway_threshold_weeks", DEFAULT_RUNWAY_THRESHOLD_WEEKS),
    getSetting<string[]>(env.DB, "notify_emails", []),
    getSetting<"research" | "custom">(env.DB, "posting_slots_source", "research"),
    getSetting<Features>(env.DB, "features", { ...DEFAULT_FEATURES }),
    getSetting(env.DB, "recycle_cooldown_days", DEFAULT_RECYCLE_COOLDOWN_DAYS),
    getSetting<string | null>(env.DB, "helper_email", null),
  ]);
  const emails = notify_emails.length ? notify_emails : [env.OWNER_EMAIL];
  return { weekly_caps, hard_cap_per_channel, runway_threshold_weeks, notify_emails: emails, posting_slots_source, features, recycle_cooldown_days, helper_email, audience_timezone: env.AUDIENCE_TIMEZONE };
}

settings.get("/", async (c) => c.json(await readSettings(c.env)));

settings.patch("/", requireOwner, async (c) => {
  const body = await readJson<Partial<SettingsShape>>(c);
  if (!body) return fail(c, 400, "Nothing to save.");
  if (body.weekly_caps) {
    for (const p of PLATFORMS) {
      const n = Number(body.weekly_caps[p]);
      if (!Number.isInteger(n) || n < 0 || n > HARD_CAP_PER_CHANNEL_PER_WEEK) return fail(c, 422, `Posts per week must be 0 to ${HARD_CAP_PER_CHANNEL_PER_WEEK}.`);
    }
    await setSetting(c.env.DB, "weekly_caps", { tiktok: body.weekly_caps.tiktok, instagram: body.weekly_caps.instagram, youtube: body.weekly_caps.youtube });
  }
  if (body.runway_threshold_weeks !== undefined) {
    const w = Number(body.runway_threshold_weeks);
    if (!(w >= 1 && w <= 8)) return fail(c, 422, "The runway warning must be 1 to 8 weeks.");
    await setSetting(c.env.DB, "runway_threshold_weeks", w);
  }
  if (body.notify_emails) {
    const emails = body.notify_emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    if (emails.some((e) => !isEmail(e))) return fail(c, 422, "One of the email addresses does not look right.");
    await setSetting(c.env.DB, "notify_emails", emails);
  }
  if (body.posting_slots_source) await setSetting(c.env.DB, "posting_slots_source", body.posting_slots_source === "custom" ? "custom" : "research");
  if (body.features) {
    const current = await getSetting<Features>(c.env.DB, "features", { ...DEFAULT_FEATURES });
    await setSetting(c.env.DB, "features", { ...current, ...body.features });
  }
  if (body.recycle_cooldown_days !== undefined) {
    const d = Number(body.recycle_cooldown_days);
    if (!(d >= 30 && d <= 365)) return fail(c, 422, "The recycle wait must be 30 to 365 days.");
    await setSetting(c.env.DB, "recycle_cooldown_days", d);
  }
  if (body.helper_email !== undefined) {
    if (body.helper_email && !isEmail(body.helper_email)) return fail(c, 422, "That helper email does not look right.");
    await setSetting(c.env.DB, "helper_email", body.helper_email ? body.helper_email.trim().toLowerCase() : null);
    if (!body.helper_email) await c.env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'helper')").run();
  }
  await recordEvent(c.env.DB, "settings.changed", null, { keys: Object.keys(body) }, c.get("user").email);
  return c.json(await readSettings(c.env));
});

settings.get("/health", async (c) => c.json(await listHealth(c.env.DB)));

/** "Check everything now": re-check Buffer and every pasted key, rewrite the lights, return them. */
settings.post("/health/recheck", async (c) => {
  const { recheckEverything } = await import("../crons/buffer-sync");
  await recheckEverything(c.env);
  await recordEvent(c.env.DB, "health.recheck", null, {}, c.get("user").email);
  return c.json(await listHealth(c.env.DB));
});
