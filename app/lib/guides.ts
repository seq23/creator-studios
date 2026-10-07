/// <reference types="vite/client" />
// The help guides, bundled at build time (section 12c): Markdown text changes need no code
// change, yet they ship with the build and work offline. Screenshots made by the help
// screenshots job (help/screenshots/<slug>-<n>.png and <slug>-<n>-phone.png) are bundled the
// same way; a step whose picture has not been made yet shows a placeholder frame instead.
import index from "../../help/index.json";
import { parseGuide, type ParsedGuide } from "./markdown";

const RAW = import.meta.glob("/help/guides/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SHOTS = import.meta.glob("/help/screenshots/*.png", { query: "?url", import: "default", eager: true }) as Record<string, string>;

export interface IndexGuide {
  slug: string;
  title: string;
  group: "getting_started" | "everyday" | "brand_deals" | "fix_it";
  screen: string | null;
}

export const GROUPS = index.groups as { key: IndexGuide["group"]; title: string }[];
export const INDEX = index.guides as IndexGuide[];

/**
 * A guide about the login screen (index "screen": "login") means nothing when the deployment has
 * no login (AUTH_MODE "open", production by the owner's choice), so open mode hides it.
 */
export const isLoginGuide = (g: Pick<IndexGuide, "screen">) => g.screen === "login";

/** The guides this deployment shows: all of them, minus the login guides in open mode. */
export function visibleGuides(mode: "open" | "code" | undefined): IndexGuide[] {
  return mode === "open" ? INDEX.filter((g) => !isLoginGuide(g)) : INDEX;
}

const cache = new Map<string, ParsedGuide>();

export function guide(slug: string): ParsedGuide | null {
  if (cache.has(slug)) return cache.get(slug)!;
  const raw = RAW[`/help/guides/${slug}.md`];
  if (raw === undefined) return null;
  const g = parseGuide(raw);
  cache.set(slug, g);
  return g;
}

export function allGuides(): { entry: IndexGuide; parsed: ParsedGuide | null }[] {
  return INDEX.map((entry) => ({ entry, parsed: guide(entry.slug) }));
}

/** Bundled URL for a screenshot path like /help/screenshots/pitch-a-brand-2.png, or null if not made yet. */
export function shotUrl(path: string | null, phone = false): string | null {
  if (!path) return null;
  // A Look's own picture (public/looks/<id>.webp, made by the cut self-test): one image for both sizes.
  if (/^\/looks\/[a-z_]+\.webp$/.test(path)) return path;
  const p = phone ? path.replace(/\.png$/, "-phone.png") : path;
  return SHOTS[p] ?? null;
}

// Words that carry no meaning in how she asks ("how do I post", "why is my light red").
const STOP = new Set("a an and are at be by can do does for from get got how i if in is it its me my of on or the this to up what when where which who why will with you your".split(" "));

/** A word and its plain stem (posted → post, pitches → pitch), so either form matches. */
function forms(w: string): string[] {
  const out = [w];
  for (const end of ["ing", "ed", "es", "s"]) if (w.length > end.length + 2 && w.endsWith(end)) out.push(w.slice(0, -end.length));
  return out;
}

/**
 * Search the way she asks. Filler words are dropped; a guide scores for every word found in its
 * title (most), its keywords, then its steps, and most of all when one of its keyword phrases is
 * all in her question. Every meaningful word must match somewhere; if nothing matches every word,
 * the guides matching the most words are shown instead, so a question never comes back empty
 * when some guide is about it. Best match first.
 */
export function searchGuides(q: string, mode?: "open" | "code"): IndexGuide[] {
  const raw = q.toLowerCase().replace(/[^a-z0-9#@\s-]/g, " ").split(/\s+/).filter(Boolean);
  if (!raw.length) return [];
  const words = raw.filter((w) => !STOP.has(w));
  const terms = words.length ? words : raw;
  const visible = new Set(visibleGuides(mode).map((g) => g.slug));
  const scored = allGuides()
    .filter(({ entry }) => visible.has(entry.slug))
    .map(({ entry, parsed }) => {
      const title = entry.title.toLowerCase();
      const keys = parsed?.meta.keywords ?? [];
      const keyText = keys.join(" ");
      const hay = `${title} ${parsed?.text ?? ""}`;
      let score = 0;
      let hits = 0;
      for (const w of terms) {
        const f = forms(w);
        const inTitle = f.some((x) => title.includes(x));
        const inKeys = f.some((x) => keyText.includes(x));
        const inText = f.some((x) => hay.includes(x));
        if (inTitle || inKeys || inText) hits++;
        score += (inTitle ? 3 : 0) + (inKeys ? 2 : 0) + (inText ? 1 : 0);
      }
      for (const k of keys) {
        const kw = k.split(/\s+/);
        if (kw.length > 1 && kw.every((x) => raw.includes(x))) score += 6;
      }
      return { entry, score, hits };
    })
    .filter((x) => x.hits > 0);
  const all = scored.filter((x) => x.hits === terms.length);
  const best = Math.max(0, ...scored.map((x) => x.hits));
  const pool = all.length ? all : scored.filter((x) => x.hits === best);
  return pool.sort((a, b) => b.score - a.score).map((x) => x.entry);
}

export const CHECKLIST_KEY = "ss-help-checklist";
export const TOUR_KEY = "ss-tour-done";
export const LAST_SCREEN_KEY = "ss-last-screen";

export function lastScreen(): string {
  try {
    return sessionStorage.getItem(LAST_SCREEN_KEY) ?? "/";
  } catch {
    return "/";
  }
}

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the ticks just won't stick */
  }
}

/** A pre-filled email to her helper that says which screen (and guide) she was on. */
export function helperMail(helper: string, screen: string, guideTitle?: string): string {
  const subject = guideTitle ? `Help with "${guideTitle}"` : "Help with the dashboard";
  const body = `Hi,\n\nI'm stuck${guideTitle ? ` on the guide "${guideTitle}"` : ""}.\nScreen: ${screen}\n\nWhat happened:\n`;
  return `mailto:${helper}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
