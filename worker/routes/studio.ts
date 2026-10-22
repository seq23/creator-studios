// The studio's identity, from its registry entry (studios/<slug>.json → wrangler vars APP_NAME,
// OWNER_NAME, STUDIO_SLUG, STUDIO_THEME). One codebase, a theme per studio, never a code fork:
//   GET /api/studio        name, owner's first name and wordmark (public: the login screen needs it)
//   GET /studio-theme.css  the studio's palette and type as CSS custom properties over
//                          app/styles/tokens.css (index.html links it before the app's own CSS)
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { studioSlug } from "../env";
import { parseJson } from "../lib/db";

export interface StudioTheme {
  /** A Google Fonts stylesheet URL for the theme's families. */
  fonts?: string;
  /** Token overrides for light mode: "--name": "value". */
  light?: Record<string, string>;
  /** Token overrides for dark mode. */
  dark?: Record<string, string>;
  /** The wordmark: a name set in the display face, an optional small tag line under it, and a mark glyph. */
  wordmark?: { name: string; tag?: string; mark?: string };
  /** Browser chrome colour (meta theme-color). */
  chrome?: string;
}

const NAME = /^--[a-z0-9-]+$/;
// A value may never close the declaration or the block, or open markup.
const SAFE_VALUE = /^[^;{}<>\\]+$/;
const FONTS_URL = /^https:\/\/fonts\.googleapis\.com\/css2\?[^"'()\s<>]+$/;

export function readTheme(env: Pick<Env, "STUDIO_THEME">): StudioTheme {
  return parseJson<StudioTheme>(env.STUDIO_THEME, {});
}

function block(vars: Record<string, string> | undefined): string {
  return Object.entries(vars ?? {})
    .filter(([k, v]) => NAME.test(k) && typeof v === "string" && SAFE_VALUE.test(v))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
}

/** The theme as CSS. Pure; unsafe names, values and font URLs are dropped, never echoed. */
export function themeToCss(theme: StudioTheme): string {
  const out: string[] = [];
  if (theme.fonts && FONTS_URL.test(theme.fonts)) out.push(`@import url("${theme.fonts}");`);
  const light = block(theme.light);
  const dark = block(theme.dark);
  // :not(#_) lifts each rule one id-level above app/styles/tokens.css, so the studio's theme wins
  // whatever order the two stylesheets load in, and its dark blocks still beat its light one.
  if (light) out.push(`:root:not(#_) {\n${light}\n}`);
  if (dark) {
    out.push(`@media (prefers-color-scheme: dark) {\n  :root:not(#_):not([data-theme="light"]) {\n${dark.replace(/^/gm, "  ")}\n  }\n}`);
    out.push(`:root:not(#_)[data-theme="dark"] {\n${dark}\n}`);
  }
  return out.join("\n") + "\n";
}

export interface LandingStep {
  title: string;
  body: string;
}

/** A studio's optional one-page landing (studios/<slug>.json → `landing`). */
export interface Landing {
  heading: string;
  sub: string;
  cta: string;
  steps: LandingStep[];
  facts: string[];
  signInHeading: string;
}

// A value may never open or close markup.
const NO_MARKUP = /^[^<>]*$/;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max && NO_MARKUP.test(v) ? v : null);

/**
 * A studio's landing, from STUDIO_LANDING (JSON, studios/<slug>.json → `landing`). Strict: a wrong
 * type, an over-long line, markup, or a step/fact count outside 3-6 returns null, so a bad or
 * missing entry falls back to the plain login card rather than showing something broken.
 */
export function readLanding(env: Pick<Env, "STUDIO_LANDING">): Landing | null {
  if (!env.STUDIO_LANDING) return null;
  try {
    const raw = JSON.parse(env.STUDIO_LANDING);
    const heading = text(raw.heading, 120);
    const sub = text(raw.sub, 400);
    const cta = text(raw.cta, 40);
    const signInHeading = text(raw.signInHeading, 80);
    if (!heading || !sub || !cta || !signInHeading) return null;
    if (!Array.isArray(raw.steps) || raw.steps.length < 3 || raw.steps.length > 6) return null;
    const steps: LandingStep[] = [];
    for (const s of raw.steps) {
      const title = text(s?.title, 40);
      const body = text(s?.body, 200);
      if (!title || !body) return null;
      steps.push({ title, body });
    }
    if (!Array.isArray(raw.facts) || raw.facts.length < 3 || raw.facts.length > 6) return null;
    const facts: string[] = [];
    for (const f of raw.facts) {
      const t = text(f, 140);
      if (!t) return null;
      facts.push(t);
    }
    return { heading, sub, cta, steps, facts, signInHeading };
  } catch {
    return null;
  }
}

export const studio = new Hono<{ Bindings: Env; Variables: Vars }>();

studio.get("/", (c) => {
  const t = readTheme(c.env);
  return c.json({
    slug: studioSlug(c.env),
    appName: c.env.APP_NAME,
    ownerName: c.env.OWNER_NAME ?? "",
    wordmark: t.wordmark ?? { name: c.env.APP_NAME },
    chrome: t.chrome ?? null,
    landing: readLanding(c.env),
  });
});

export const themeCss = new Hono<{ Bindings: Env; Variables: Vars }>();

themeCss.get("/", (c) => {
  c.header("Content-Type", "text/css; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(themeToCss(readTheme(c.env)));
});
