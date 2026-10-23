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

/** Her pick on "Change": a service (or "unsure"), a shape, or both. */
export interface PlanOverride {
  service?: string;
  shape?: Shape;
}

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

export function cleanOverride(v: unknown, services: readonly string[]): PlanOverride {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: PlanOverride = {};
  if (o.service === "unsure") out.service = "unsure";
  else if (typeof o.service === "string") {
    const match = services.find((s) => s.toLowerCase() === String(o.service).trim().toLowerCase());
    if (match) out.service = match;
  }
  if (isShape(o.shape)) out.shape = o.shape;
  return out;
}
