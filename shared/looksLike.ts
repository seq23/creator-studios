// The plain line (studio intelligence layer 7, owner's plan 22 Oct 2026): what the studio thinks the
// footage shows, on the Dump screen and in Review, with one-tap "Change" that re-plans the cut.
// "Looks like: <service> · <before and after / walk-through / …> · camera sound <off/on>", and when
// unsure "Not sure what this shows". Pure; tests/unit/looks-like.test.ts.

export const SHAPES = ["transformation", "walkthrough", "talking", "montage"] as const;
export type Shape = (typeof SHAPES)[number];

/** What each shape is called on screen (the same words jobs/cut.py SHAPE_WORDS reports). */
export const SHAPE_LABELS: Record<Shape, string> = {
  transformation: "before and after",
  walkthrough: "walk-through",
  talking: "talking to camera",
  montage: "close-ups",
};

export interface LooksLike {
  service: string | null;
  shape: Shape | null;
  camera: "on" | "off" | "mixed";
  sure: boolean;
}

/** Her pick on "Change" or a one-tap question: a service (or "unsure"), a shape, the videos that show the BEFORE. */
export interface PlanOverride {
  service?: string;
  shape?: Shape;
  /** Videos she says show the space before the work (layer 7 "Is this a before?"): their shots are cut as before shots. */
  before_assets?: string[];
  /** Questions she has answered (never asked again for this dump). */
  answered?: QuestionId[];
}

export type QuestionId = "service" | "before";

export function isShape(v: unknown): v is Shape {
  return typeof v === "string" && (SHAPES as readonly string[]).includes(v);
}

export function cleanLooksLike(v: unknown): LooksLike | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const service = typeof o.service === "string" && o.service.trim() ? o.service.trim().slice(0, 60) : null;
  const shape = isShape(o.shape) ? o.shape : null;
  const camera = o.camera === "off" || o.camera === "mixed" ? o.camera : "on";
  return { service, shape, camera, sure: o.sure === true && !!service };
}

function cameraWords(c: LooksLike["camera"]): string {
  return c === "off" ? "camera sound off" : c === "mixed" ? "camera sound on for some" : "camera sound on";
}

/** The line itself. Never names a service the studio is not sure about. */
export function plainLine(l: LooksLike | null): string {
  if (!l || !l.sure || !l.service) return "Not sure what this shows";
  const parts = [`Looks like: ${l.service}`];
  if (l.shape) parts.push(SHAPE_LABELS[l.shape]);
  parts.push(cameraWords(l.camera));
  return parts.join(" · ");
}

/** A clip's own line in Review (its shape and service; the camera from its own sound). */
export function clipLine(c: { service: string | null; shape: string | null; muted: boolean }): string {
  return plainLine({ service: c.service, shape: isShape(c.shape) ? c.shape : null, camera: c.muted ? "off" : "on", sure: !!c.service });
}

export function cleanOverride(v: unknown, services: readonly string[], assetIds?: readonly string[]): PlanOverride {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: PlanOverride = {};
  if (o.service === "unsure") out.service = "unsure";
  else if (typeof o.service === "string") {
    const match = services.find((s) => s.toLowerCase() === String(o.service).trim().toLowerCase());
    if (match) out.service = match;
  }
  if (isShape(o.shape)) out.shape = o.shape;
  if (assetIds && Array.isArray(o.before_assets)) {
    const ids = [...new Set(o.before_assets.filter((a): a is string => typeof a === "string" && assetIds.includes(a)))].slice(0, 30);
    if (ids.length || o.before_assets.length === 0) out.before_assets = ids;
  }
  if (Array.isArray(o.answered)) {
    const a = [...new Set(o.answered.filter((x): x is QuestionId => x === "service" || x === "before"))];
    if (a.length) out.answered = a;
  }
  return out;
}

// ---------------------------------------------------------------- one-tap questions (layer 7)

/** One video as the questions show it: a number she can see and what the studio saw in it. */
export interface QuestionVideo {
  id: string;
  n: number;
  what: string;
  before: boolean;
}

export interface Question {
  id: QuestionId;
  text: string;
  /** Plain hint under it, saying what a tap does. */
  hint: string;
}

/**
 * The questions under the plain line, at most two, never one she has answered. Never needs typing:
 * every answer is a tap (Yes / No / one of her services / "This one is a before").
 */
export function questionsFor(l: LooksLike | null, o: PlanOverride, videos: readonly QuestionVideo[], services: readonly string[]): Question[] {
  const done = new Set(o.answered ?? []);
  const out: Question[] = [];
  if (!done.has("service") && services.length) {
    out.push(
      l?.sure && l.service
        ? { id: "service", text: `Is this ${l.service}?`, hint: "Tap Yes if that's right. Tap No to pick what it really is." }
        : { id: "service", text: "What do these videos show?", hint: "Tap one. The clips are made again to match." },
    );
  }
  if (!done.has("before") && videos.length > 1 && l?.shape !== "transformation") {
    out.push({ id: "before", text: "Is one of these a before?", hint: "A before shows the space empty or not set up yet. Tap the videos that do, and the clips show the before and then the finished setup." });
  }
  return out;
}

/** What she answered, merged into the dump's override (pure; the route stores it and re-plans when needed). */
export function answerQuestion(o: PlanOverride, a: { id: QuestionId; yes?: boolean; service?: string; before_assets?: string[] }): { override: PlanOverride; replan: boolean } {
  const answered = [...new Set([...(o.answered ?? []), a.id])];
  if (a.id === "service") {
    if (a.service) return { override: { ...o, service: a.service, answered }, replan: a.service !== o.service };
    return { override: { ...o, answered }, replan: false }; // "Yes, that's right": nothing to cut again
  }
  if (a.before_assets && a.before_assets.length) return { override: { ...o, before_assets: a.before_assets, answered }, replan: true };
  return { override: { ...o, answered }, replan: false }; // "No, none of them"
}
