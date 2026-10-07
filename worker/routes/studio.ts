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

export const studio = new Hono<{ Bindings: Env; Variables: Vars }>();

studio.get("/", (c) => {
  const t = readTheme(c.env);
  return c.json({
    slug: studioSlug(c.env),
    appName: c.env.APP_NAME,
    ownerName: c.env.OWNER_NAME ?? "",
    wordmark: t.wordmark ?? { name: c.env.APP_NAME },
    chrome: t.chrome ?? null,
  });
});

export const themeCss = new Hono<{ Bindings: Env; Variables: Vars }>();

themeCss.get("/", (c) => {
  c.header("Content-Type", "text/css; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(themeToCss(readTheme(c.env)));
});
