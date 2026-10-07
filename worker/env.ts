export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;

  APP_NAME: string;
  /** The studio owner's first name as the app greets her ("Hadiyah"); empty for a sample until claimed. */
  OWNER_NAME?: string;
  /**
   * The owner's login email from the studio's registry entry (studios/<slug>.json). Empty for a
   * sample studio: its first-login invite link (scripts/studio.mjs create) claims it, and the
   * claimed address lives in D1 (settings.owner_email), which wins over this var.
   */
  OWNER_EMAIL: string;
  /** Which studio this Worker is (studios/<slug>.json). Jobs carry it so Actions picks its secret. */
  STUDIO_SLUG?: string;
  /** The studio's theme (JSON from studios/<slug>.json: palette tokens, fonts, wordmark). */
  STUDIO_THEME?: string;
  FAKE_SERVICES: string;
  PUBLIC_BASE_URL: string;
  GITHUB_REPO: string;
  AUDIENCE_TIMEZONE: string;
  /**
   * "production" (every studio Worker) | "dev" (.dev.vars, e2e). Missing reads as production.
   */
  ENV_NAME?: string;
  /**
   * Always "code" (the email one-time-code login) in every studio. The old "open" mode is gone:
   * authMode() ignores the var and the validator `login-never-open` fails any config that sets it.
   */
  AUTH_MODE?: string;

  // secrets
  /**
   * The PLATFORM sender: the one shared piece across studios. Login codes (and only login codes)
   * go through it, because a new client studio has no email service of its own yet. Every other
   * email from a studio uses that studio's own Resend (Setup → Email). See README "Platform sender".
   */
  PLATFORM_RESEND_API_KEY?: string;
  /** The platform sender's From line, e.g. "Studio login <login@example.com>". A secret so no config names it. */
  PLATFORM_EMAIL_FROM?: string;
  /** Filled at request time by worker/lib/practice.ts: the setup services with no key yet (practice mode). */
  PRACTICE?: string[];
  /** Practice-mode jobs started by this request, run after it answers (services/github.ts). */
  PRACTICE_JOBS?: { jobId: string; type: string; refId: string | null }[];
  SESSION_SECRET: string;
  SECRETS_KEY: string;
  JOB_SHARED_SECRET: string;
  GITHUB_DISPATCH_TOKEN?: string;
  RESEND_API_KEY?: string;
  /** The studio's own From line (Setup → Email); Resend's test sender when empty. */
  RESEND_FROM?: string;
  // Stats OAuth (phase 3). Optional: without them the Connect row says the stats app is not
  // set up yet and links the guide. Each is the vendor's own app credential, set once by the
  // builder with `wrangler secret put`; her tokens are stored encrypted in D1, not here.
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // No-login YouTube numbers: a YouTube Data API v3 key (public channel and video numbers only, no
  // Google sign-in). Vendor-prefixed on purpose, not a reserved name. A studio can instead paste its
  // own on Setup (stored encrypted in D1, read first); without either, Stats runs in practice mode.
  YOUTUBE_API_KEY?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  role: "owner" | "helper";
}

/** Hono context variables set by middleware. */
export type Vars = {
  user: SessionUser;
  fake: boolean;
};

export const fakeServices = (env: Env): boolean => env.FAKE_SERVICES === "1";

/** Which deployment this is (/healthz reports it): "dev" locally and in e2e, "production" in every studio. */
export const envName = (env: Pick<Env, "ENV_NAME">): "production" | "dev" => (env.ENV_NAME === "dev" ? "dev" : "production");

/** The studio a job dispatch names, so the workflow picks that studio's shared secret (JOB_SHARED_SECRET_<SLUG>). */
export const studioSlug = (env: Pick<Env, "STUDIO_SLUG">): string => (env.STUDIO_SLUG || "dev").toLowerCase();

/**
 * How people get in: always the email one-time code. Every studio logs in; nothing turns it off
 * (the brief: "never open"). Kept as a function so every caller states the mode it relies on.
 */
export const authMode = (_env?: Pick<Env, "AUTH_MODE">): "code" => "code";
