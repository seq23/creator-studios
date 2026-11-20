// A content plan: the pieces the engine makes for one studio, each with its format, pictures, words,
// music, captions per platform and local posting time. Pure: render.mjs and queue (scripts/studio.mjs
// engine-queue) read it, tests/unit/engine-plan.test.ts guards it. The checks here are structure and
// hard brand rules only; whether a piece reads as real, on-brand work is the reviewer's call on its
// real frames (review.mjs), never a keyword test.
import { formatById } from "./library";

export type Platform = "tiktok" | "instagram" | "facebook";
export const PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook"];

export interface PlanPic {
  /** "real:<file>" = our own job photo (may be shown as our work); "ai:<path>" = an AI-made scene. */
  src: string;
  fx?: number;
  fy?: number;
  label?: string;
}

export interface PlanPiece {
  id: string;
  format: string;
  /** Local time in the plan's zone, "YYYY-MM-DD HH:mm". */
  at: string;
  platforms: Platform[];
  music?: string;
  pics: PlanPic[];
  hook: string;
  lines?: string[];
  count?: number;
  spots?: { fx: number; fy: number; label: string }[];
  endLine?: string;
  captions: Partial<Record<Platform, string>>;
}

export interface Plan {
  studio: string;
  brand: string;
  tz: string;
  /** Local hours a post may go out, [from, to) (Memphis evening for P&P). */
  window: [number, number];
  /** Where the pictures live on the Mac: real (our job photos) and ai (AI-made scenes). Never committed. */
  sources?: Partial<Record<"real" | "ai", string>>;
  /** Text every caption carries: the one next step. */
  cta: string;
  pieces: PlanPiece[];
}

export const PIECE_KEY = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** No prices in clips or captions (porch-and-party brain, FILLER CONTENT). */
const PRICE = /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i;

/** A photo-real AI scene is in the piece: TikTok's own AI switch is set (risk R-END-03 filler exception). */
export const aiScene = (p: PlanPiece): boolean => p.pics.some((x) => x.src.startsWith("ai:"));

/** "YYYY-MM-DD HH:mm" in `tz` → UTC ISO. */
export function localToUtc(local: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!m) return "";
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (asLocal - guess)).toISOString();
}

export function validatePlan(plan: Plan, now: number): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const sorted = [...plan.pieces].sort((a, b) => a.at.localeCompare(b.at));
  const slots = new Set<string>();
  for (const p of plan.pieces) {
    const at = `${p.id}:`;
    if (!PIECE_KEY.test(p.id)) out.push(`${at} id must be lowercase letters, digits and dashes`);
    if (ids.has(p.id)) out.push(`${at} id used twice`);
    ids.add(p.id);
    const f = formatById(p.format);
    if (!f) {
      out.push(`${at} unknown format ${p.format}`);
      continue;
    }
    if (p.pics.length < f.pics[0] || p.pics.length > f.pics[1]) out.push(`${at} ${f.id} takes ${f.pics[0]}–${f.pics[1]} pictures`);
    const lines = p.lines ?? [];
    if (lines.length < f.lines[0] || lines.length > f.lines[1]) out.push(`${at} ${f.id} takes ${f.lines[0]}–${f.lines[1]} lines`);
    if (f.realOnly && aiScene(p)) out.push(`${at} ${f.id} shows our own work: real photos only`);
    if (p.pics.some((x) => !/^(real|ai):[\w./-]+$/.test(x.src))) out.push(`${at} every picture is real:<file> or ai:<path>`);
    if (new Set(p.pics.map((x) => x.src)).size !== p.pics.length) out.push(`${at} a picture repeats inside the piece`);
    if (f.kind === "reel" && !p.music) out.push(`${at} a reel never goes out silent`);
    if (p.format === "detail-zoom" && (p.spots?.length ?? 0) < 2) out.push(`${at} detail-zoom needs at least 2 spots`);
    if (p.format === "this-or-that" && p.pics.length % 2) out.push(`${at} this-or-that takes pairs`);
    const words = [p.hook, ...lines, p.endLine ?? "", ...p.pics.map((x) => x.label ?? ""), ...(p.spots ?? []).map((s) => s.label)];
    if (words.some((w) => PRICE.test(w))) out.push(`${at} no prices on screen`);
    const utc = localToUtc(p.at, plan.tz);
    if (!utc) out.push(`${at} time must be "YYYY-MM-DD HH:mm"`);
    else {
      if (Date.parse(utc) < now + 10 * 60_000) out.push(`${at} time is not in the future`);
      const hour = Number(p.at.slice(11, 13));
      if (hour < plan.window[0] || hour >= plan.window[1]) out.push(`${at} outside the posting window ${plan.window[0]}:00–${plan.window[1]}:00`);
    }
    if (!p.platforms.length || p.platforms.some((x) => !PLATFORMS.includes(x))) out.push(`${at} platforms are tiktok, instagram, facebook`);
    for (const pl of p.platforms) {
      const c = p.captions[pl] ?? "";
      if (!c.trim()) out.push(`${at} no ${pl} caption`);
      if (!c.includes(plan.cta)) out.push(`${at} the ${pl} caption must carry ${plan.cta}`);
      if (PRICE.test(c)) out.push(`${at} no prices in the ${pl} caption`);
      if (/made with ai/i.test(c)) out.push(`${at} no "Made with AI" caption line on engine pieces (R-END-03 filler exception)`);
      if ((c.match(/#\w+/g) ?? []).length > 3) out.push(`${at} at most 3 hashtags on ${pl}`);
      if (c.length > 2200) out.push(`${at} the ${pl} caption is too long`);
      const slot = `${pl}|${f.kind}|${p.at.slice(0, 10)}`;
      if (slots.has(slot)) out.push(`${at} two ${f.kind}s on ${pl} the same day`);
      slots.add(slot);
    }
  }
  // No picture in two neighbouring pieces (ship-ready B).
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Set(sorted[i - 1].pics.map((x) => x.src));
    const shared = sorted[i].pics.find((x) => prev.has(x.src));
    if (shared) out.push(`${sorted[i].id}: repeats ${shared.src} from the piece before it`);
  }
  return out;
}
