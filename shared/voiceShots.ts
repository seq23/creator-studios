// The voice-over script follows the shots (Follow-on V, owner 23 Oct 2026). A clip's shot list is
// its shots on its own timeline: each shot's start and end, its stage (prep → process → hero) and
// what the shot sheet saw. The script writer reads it as timed lines; the starter script (no AI)
// is built from it too, in stage order, and never reads the caption back. Pure; guarded by
// tests/unit/voice-follow-on.test.ts.

export interface ClipShot {
  t0: number;
  t1: number;
  stage: string;
  what: string;
}

/** Stage words a script may lean on, in story order (jobs/stages.py STAGES + the clip engine's own). */
const STAGE_WORD: Record<string, string> = {
  arrival: "the start",
  prep: "getting ready",
  team: "the team at work",
  process: "the work",
  detail: "a close look",
  finished: "the finished result",
  hero: "the finished result",
  flash: "a quick look ahead",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A clean shot list from anything stored: a JSON list of shots, else null. Pure. */
export function cleanShotList(v: unknown): ClipShot[] | null {
  const raw = typeof v === "string" ? safeParse(v) : v;
  if (!Array.isArray(raw)) return null;
  const out: ClipShot[] = [];
  for (const s of raw.slice(0, 24)) {
    const o = (s ?? {}) as Record<string, unknown>;
    const t0 = num(o.t0);
    const t1 = num(o.t1);
    if (t0 === null || t1 === null || t1 <= t0) continue;
    out.push({ t0: Math.round(t0 * 100) / 100, t1: Math.round(t1 * 100) / 100, stage: text(o.stage, 20), what: text(o.what, 120) });
  }
  return out.length ? out : null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * A clip's shots: its stored shot list; else (clips cut before the list existed) its parts' lengths
 * paired with what is on screen when the two counts match; else one shot for the whole clip. Pure.
 */
export function shotsOf(clip: { shot_list?: string | null; parts?: string | null; on_screen?: string | null; start_s: number; end_s: number }): ClipShot[] {
  const stored = cleanShotList(clip.shot_list ?? null);
  if (stored) return stored;
  const whats = (clip.on_screen ?? "").split(" · ").map((w) => w.trim()).filter(Boolean);
  const parts = safeParse(clip.parts ?? "") as unknown;
  if (Array.isArray(parts) && parts.length && parts.length === whats.length) {
    let t = 0;
    return parts.map((p, i) => {
      const d = Array.isArray(p) ? Math.max(0, Number(p[1]) - Number(p[0])) || 0 : 0;
      const shot = { t0: Math.round(t * 100) / 100, t1: Math.round((t + d) * 100) / 100, stage: "", what: whats[i] };
      t += d;
      return shot;
    });
  }
  const len = Math.max(0, clip.end_s - clip.start_s);
  return [{ t0: 0, t1: Math.round(len * 100) / 100, stage: "", what: whats.join(", ") }];
}

/** The shots as timed lines for the script writer: "0.0–2.4 s · getting ready · fabric laid out". */
export function shotLines(shots: ClipShot[]): string {
  return shots.map((s) => [`${s.t0.toFixed(1)}–${s.t1.toFixed(1)} s`, STAGE_WORD[s.stage] ?? "", s.what].filter(Boolean).join(" · ")).join("\n");
}

const sentence = (s: string) => {
  const t = s.replace(/[.!?…]+$/, "").trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
};

/**
 * The starter script (the free AI busy): the hook, then each distinct shot in order, worded by its
 * stage ("First, …", "Then …", "And here it is: …"), then her call to action. Never the caption. Pure.
 */
export function shotScript(shots: ClipShot[], hook: string, cta: string | null): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  const h = sentence(hook.replace(/[…]+$/, ""));
  if (h) lines.push(h);
  const distinct = shots.filter((s) => s.what && !seen.has(s.what.toLowerCase()) && seen.add(s.what.toLowerCase()));
  distinct.forEach((s, i) => {
    const what = s.what.replace(/[.!?]+$/, "");
    if (s.stage === "hero" || s.stage === "finished") lines.push(`And here it is: ${what}.`);
    else if (i === 0) lines.push(`First, ${what}.`);
    else lines.push(`Then ${what}.`);
  });
  if (cta) lines.push(sentence(cta));
  return lines.join(" ");
}

/** Her "notes for the voice" from the Dump screen, cleaned for a prompt (one line, at most 400). */
export function cleanVoiceNotes(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) : "";
}
