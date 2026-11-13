// Reading and storing how she steers a dump (worker/domain/steer.ts has the rules).
// A note is read by the rules every time; when the free AI (OpenRouter) is connected it reads the
// note too, through the Worker's one OpenRouter client (services/openrouter.ts), and fills only what
// the rules missed. Whatever the AI says goes through cleanControls like a tap would.
import type { Env } from "../env";
import { parseJson } from "./db";
import { getConnectionSecret } from "./connections";
import { getLlm, hasJsonObject } from "../services/openrouter";
import { log } from "./log";
import { cleanControls, describe, mergeControls, parseNotes, planLine, quickFix, type Track } from "../domain/steer";
import { LOOKS } from "../domain/looks";
import { QUICK_FIXES, STEER_KEYS, type QuickFix, type SaidBack, type SteerControls, type Understood } from "@shared/steer";
import { readStudioRules } from "./studioRules";

export async function tracksOf(env: Env): Promise<(Track & { r2_key: string })[]> {
  const { results } = await env.DB.prepare("SELECT id, file_name AS name, r2_key FROM music_tracks ORDER BY created_at").all<Track & { r2_key: string }>();
  return results;
}

const SYSTEM = `You read a video creator's note about how to cut her clips. Answer with JSON only, using only these keys when the note asks for them:
{"looks": [look ids], "music": "none" | "any" | "track:<song id>", "pace": "calm"|"normal"|"fast", "length": "short"|"medium"|"long",
 "count": number, "captions": "clean"|"karaoke"|"boxed"|"none", "platforms": ["tiktok","instagram","youtube"],
 "voice": "quiet" (a voice over on the clips with no talking) | "none" (no voice over) | "pick" (she adds them herself later), "include": [short phrases], "avoid": [short phrases],
 "unused": [parts of the note, copied word for word, that ask for something none of the keys above can express]}
Leave out every key the note does not ask about. Never invent. include/avoid are moments she said must be in or left out, 1-6 words each.`;

const loose = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** A note read into controls: rules always, the free AI too when connected. */
export async function understand(env: Env, text: string): Promise<Understood> {
  const tracks = await tracksOf(env);
  const rules = parseNotes(text, tracks);
  if (!text.trim() || !(await getConnectionSecret(env, "openrouter"))) return rules;
  try {
    const llm = await getLlm(env);
    const looks = LOOKS.map((l) => `${l.id} (${l.name})`).join(", ");
    const songs = tracks.map((t) => `${t.id} (${t.name})`).join(", ") || "none uploaded";
    const r = await llm.complete({ system: SYSTEM, user: `Looks: ${looks}\nHer songs: ${songs}\nNote: ${text.slice(0, 2000)}`, json: true, maxTokens: 600, accept: hasJsonObject });
    if (!r.ok) return rules;
    const m = r.text.match(/\{[\s\S]*\}/);
    const answer = (m ? JSON.parse(m[0]) : {}) as { unused?: unknown };
    const ai = cleanControls(answer, tracks);
    const merged: SteerControls = { ...ai.controls };
    for (const k of STEER_KEYS) if (rules.controls[k] !== undefined) (merged as Record<string, unknown>)[k] = rules.controls[k];
    const added = STEER_KEYS.filter((k) => rules.controls[k] === undefined && ai.controls[k] !== undefined).length;
    log.info("steer.understand.ai", { added });
    // A part the rules could not use stays "couldn't use" unless the AI read it into a control: when the
    // AI lists what IT could not use, only the parts on both lists are left over.
    const aiUnused = Array.isArray(answer.unused) ? answer.unused.filter((x): x is string => typeof x === "string").map(loose).filter(Boolean) : null;
    const leftover = (rules.leftover ?? []).filter((l) => !added || !aiUnused || aiUnused.some((u) => u.includes(loose(l)) || loose(l).includes(u)));
    return { controls: merged, said: describe(merged, tracks), not_followed: [...rules.not_followed, ...ai.not_followed], by: added ? "rules+ai" : "rules", leftover, plan: planLine(merged, tracks) };
  } catch {
    log.warn("steer.understand.ai_failed");
    return rules;
  }
}

/** The three things a one-tap fix can change (worker/domain/steer.ts quickFix). */
const FIX_KEYS = ["count", "captions", "platforms"] as const;

/** About how many posts an upload gives when she names no number: one per file, inside the studio's own range. */
export async function aboutHowMany(env: Env, dumpId: string | null): Promise<number | undefined> {
  if (!dumpId) return undefined;
  const files = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE dump_id = ? AND upload_status = 'uploaded'").bind(dumpId).first<{ n: number }>();
  if (!files?.n) return undefined;
  const rules = await readStudioRules(env);
  return Math.max(1, Math.min(rules.clip_target.max, files.n));
}

/**
 * The line said back before anything is made (POST /api/dumps/understand): her note read, her
 * one-tap fixes on top, the choices she tapped under both, and every clash and unused part said.
 * Nothing is stored here; the screen sends back what it showed when she presses the button.
 */
export async function sayBack(env: Env, input: { text: string; chips?: unknown; dumpId?: string | null; fixed?: unknown; prevNote?: unknown; fix?: unknown }): Promise<SaidBack> {
  const tracks = await tracksOf(env);
  const u = await understand(env, input.text);
  const about = await aboutHowMany(env, input.dumpId ?? null);
  const chips = cleanControls(input.chips, tracks).controls;
  const prev = cleanControls(input.prevNote, tracks).controls;
  const fixedIn = cleanControls(input.fixed, tracks).controls;
  const fixed: SteerControls = {};
  // What she typed wins over an earlier tap: a fix stays only while the note still says the same about it.
  for (const k of FIX_KEYS) if (fixedIn[k] !== undefined && JSON.stringify(prev[k]) === JSON.stringify(u.controls[k])) (fixed as Record<string, unknown>)[k] = fixedIn[k];
  const merged = mergeControls(chips, u.controls);
  if ((QUICK_FIXES as readonly string[]).includes(String(input.fix))) {
    const now = quickFix({ ...merged.controls, ...fixed }, input.fix as QuickFix, merged.controls.count ?? fixed.count ?? about ?? 4);
    for (const k of FIX_KEYS) if (JSON.stringify(now[k]) !== JSON.stringify(merged.controls[k])) (fixed as Record<string, unknown>)[k] = now[k];
  }
  const controls = { ...u.controls, ...fixed };
  const all = { ...merged.controls, ...fixed };
  return { ...u, controls, said: describe(controls, tracks), plan: planLine(all, tracks, about), clashes: merged.clashes, note_controls: u.controls, fixed, about: all.count ?? about ?? 0 };
}

/** What she confirmed on screen, made safe again (a stored or posted Understood is never trusted as is). */
export async function confirmUnderstood(env: Env, text: string, posted: unknown): Promise<Understood> {
  const tracks = await tracksOf(env);
  const p = (posted ?? null) as Partial<Understood> | null;
  if (!p || typeof p !== "object" || !p.controls) return parseNotes(text, tracks);
  const clean = cleanControls(p.controls, tracks);
  const nf = Array.isArray(p.not_followed) ? p.not_followed.filter((x) => x && typeof x.what === "string" && typeof x.why === "string").slice(0, 12).map((x) => ({ what: x.what.slice(0, 120), why: x.why.slice(0, 240) })) : [];
  const leftover = Array.isArray(p.leftover) ? p.leftover.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 6).map((x) => x.slice(0, 120)) : [];
  return { controls: clean.controls, said: describe(clean.controls, tracks), not_followed: [...nf, ...clean.not_followed], by: p.by === "rules+ai" ? "rules+ai" : "rules", leftover, plan: planLine(clean.controls, tracks) };
}

export function readUnderstood(v: string | null): Understood | null {
  const u = parseJson<Understood | null>(v, null);
  return u && typeof u === "object" && u.controls ? u : null;
}
