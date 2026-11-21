// A content plan: the pieces the engine makes for one studio, each with its format, pictures, words,
// music, captions per platform and local posting time. Pure: render.mjs and queue (scripts/studio.mjs
// engine-queue) read it, tests/unit/engine-plan.test.ts guards it. The checks here are structure and
// hard brand rules only; whether a piece reads as real, on-brand work is the reviewer's call on its
// real frames (review.mjs), never a keyword test.
import { formatById } from "./library";

export type Platform = "tiktok" | "instagram" | "facebook";
export const PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook"];

export interface PlanPic {
  /** "real:<file>" = our own job photo (may be shown as our work); "ai:<path>" = an existing AI scene; "gen:<file>" = a scene engine/imagine.mjs makes from plan.generate. */
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
  /** Carousel cover: the first picture full-bleed (default) or the first two side by side, tagged 1 and 2 ("pick one" sets). */
  cover?: "pair";
  spots?: { fx: number; fy: number; label: string }[];
  endLine?: string;
  /** Where the hook sits, as a share of the height, over a plain part of the first picture (engine/src/parts.tsx HookY). */
  hookY?: number;
  captions: Partial<Record<Platform, string>>;
  /** Which service the piece sells (the weekly mix below). A piece that shows several takes its lead one. */
  service: Service;
}

/** The services a piece can sell. Owner's ruling 20 Nov 2026 (porch-and-party brain, Settled decisions): every
 *  week shows the full range: at least one romantic setup (proposal, anniversary, romantic hotel room), one
 *  celebration (baby shower, birthday, bridal, gender reveal), one other party or event (office party,
 *  grazing, game rentals), and porch decor in at most 2 of every 7 pieces. */
export const SERVICES = ["romantic", "celebration", "event", "porch"] as const;
export type Service = (typeof SERVICES)[number];

export interface Plan {
  studio: string;
  brand: string;
  tz: string;
  /** Local hours a post may go out, [from, to) (Memphis evening for P&P). */
  window: [number, number];
  /** Where the pictures live on the Mac: real (our job photos) and ai (AI-made scenes). Never committed. */
  sources?: Partial<Record<"real" | "ai" | "gen", string>>;
  /** Prompts for the gen: pictures, by file name (engine/imagine.mjs adds the fixed no-people rules); {prompt, ref} edits another gen picture (FLUX.2). */
  generate?: Record<string, string | { prompt: string; ref?: string }>;
  /** Text every caption carries: the one next step. */
  cta: string;
  pieces: PlanPiece[];
}

export const PIECE_KEY = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** No prices in clips or captions (porch-and-party brain, FILLER CONTENT). */
const PRICE = /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i;

/** A photo-real AI scene is in the piece: TikTok's own AI switch is set (risk R-END-03 filler exception). */
/** Words that present a picture as a job we did. */
export const JOB_CLAIM = /\b(?:a|an|one|the|this|that)\s[\w’' -]{0,30}?\bwe (?:set (?:it |this |them )?up|did|made|decorated|styled)\b|\bwe did (?:this|it)\b|\bour client\b|\bthis job\b|\breal setups?\b/i;
export const aiScene = (p: PlanPiece): boolean => p.pics.some((x) => !x.src.startsWith("real:"));

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
    // her ruling 20 Nov 2026: an AI picture is an idea, never a job; only her real photos carry "we set up"
    if (aiScene(p)) {
      const said = [p.hook, ...(p.lines ?? []), ...p.pics.map((x) => x.label ?? ""), ...Object.values(p.captions ?? {})].join(" \n ");
      const claim = said.match(JOB_CLAIM);
      if (claim) out.push(`${at} shows an AI picture but says "${claim[0]}": caption it as an idea, never as our job`);
    }
    if (p.pics.some((x) => !/^(real|ai|gen):[\w./-]+$/.test(x.src))) out.push(`${at} every picture is real:<file>, ai:<path> or gen:<file>`);
    for (const x of p.pics) if (x.src.startsWith("gen:") && !plan.generate?.[x.src.slice(4)]) out.push(`${at} ${x.src} has no prompt in generate`);
    if (new Set(p.pics.map((x) => x.src)).size !== p.pics.length) out.push(`${at} a picture repeats inside the piece`);
    if (f.kind === "reel" && !p.music) out.push(`${at} a reel never goes out silent`);
    if (p.hookY !== undefined && !(p.hookY >= 0.12 && p.hookY <= 0.6)) out.push(`${at} hookY sits between 0.12 and 0.6 of the height (inside the safe area)`);
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
  // The weekly service mix (owner's ruling 20 Nov 2026), over 7-day weeks from the first piece; the last,
  // shorter week is held to the same floor.
  for (const p of plan.pieces) if (!SERVICES.includes(p.service)) out.push(`${p.id}: service must be one of ${SERVICES.join(", ")}`);
  if (sorted.length) {
    const start = Date.parse(localToUtc(sorted[0].at.slice(0, 10) + " 00:00", plan.tz));
    const weeks = new Map<number, PlanPiece[]>();
    for (const p of sorted) {
      const w = Math.floor((Date.parse(localToUtc(p.at, plan.tz)) - start) / (7 * 86_400_000));
      weeks.set(w, [...(weeks.get(w) ?? []), p]);
    }
    for (const ps of weeks.values()) {
      const label = `week of ${ps[0].at.slice(0, 10)}`;
      for (const need of ["romantic", "celebration", "event"] as const) if (!ps.some((p) => p.service === need)) out.push(`${label}: no ${need} piece (every week shows the full range)`);
      const porch = ps.filter((p) => p.service === "porch").length;
      if (porch * 7 > ps.length * 2) out.push(`${label}: ${porch} porch pieces of ${ps.length} (porch is at most 2 of every 7)`);
    }
  }
  // No picture in two neighbouring pieces (ship-ready B).
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Set(sorted[i - 1].pics.map((x) => x.src));
    const shared = sorted[i].pics.find((x) => prev.has(x.src));
    if (shared) out.push(`${sorted[i].id}: repeats ${shared.src} from the piece before it`);
  }
  // One real setup at most once a week across pieces (review 20 Nov 2026: the same hotel balloons in
  // three pieces Sat to Sat). A setup is the file name without its trailing shot number.
  const setup = (src: string) => src.slice(5).replace(/\.[a-z]+$/i, "").replace(/-\d+$/, "");
  const lastSeen = new Map<string, { id: string; t: number }>();
  for (const p of sorted) {
    const t = Date.parse(localToUtc(p.at, plan.tz));
    const keys = new Set(p.pics.filter((x) => x.src.startsWith("real:")).map((x) => setup(x.src)));
    for (const k of keys) {
      const seen = lastSeen.get(k);
      if (seen && t - seen.t < 7 * 86_400_000) out.push(`${p.id}: real setup "${k}" was in ${seen.id} less than a week before`);
      lastSeen.set(k, { id: p.id, t });
    }
  }
  return out;
}
