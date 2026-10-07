// Reading and storing how she steers a dump (worker/domain/steer.ts has the rules).
// A note is read by the rules every time; when the free AI (OpenRouter) is connected it reads the
// note too, through the Worker's one OpenRouter client (services/openrouter.ts), and fills only what
// the rules missed. Whatever the AI says goes through cleanControls like a tap would.
import type { Env } from "../env";
import { parseJson } from "./db";
import { getConnectionSecret } from "./connections";
import { getLlm, hasJsonObject } from "../services/openrouter";
import { log } from "./log";
import { cleanControls, describe, parseNotes, type Track } from "../domain/steer";
import { LOOKS } from "../domain/looks";
import { STEER_KEYS, type SteerControls, type Understood } from "@shared/steer";

export async function tracksOf(env: Env): Promise<(Track & { r2_key: string })[]> {
  const { results } = await env.DB.prepare("SELECT id, file_name AS name, r2_key FROM music_tracks ORDER BY created_at").all<Track & { r2_key: string }>();
  return results;
}

const SYSTEM = `You read a video creator's note about how to cut her clips. Answer with JSON only, using only these keys when the note asks for them:
{"looks": [look ids], "music": "none" | "any" | "track:<song id>", "pace": "calm"|"normal"|"fast", "length": "short"|"medium"|"long",
 "count": number, "captions": "clean"|"karaoke"|"boxed"|"none", "platforms": ["tiktok","instagram","youtube"],
 "voice": "quiet" (a voice over on the clips with no talking) | "none" (no voice over) | "pick" (she adds them herself later), "include": [short phrases], "avoid": [short phrases]}
Leave out every key the note does not ask about. Never invent. include/avoid are moments she said must be in or left out, 1-6 words each.`;

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
    const ai = cleanControls(m ? JSON.parse(m[0]) : {}, tracks);
    const merged: SteerControls = { ...ai.controls };
    for (const k of STEER_KEYS) if (rules.controls[k] !== undefined) (merged as Record<string, unknown>)[k] = rules.controls[k];
    const added = STEER_KEYS.filter((k) => rules.controls[k] === undefined && ai.controls[k] !== undefined).length;
    log.info("steer.understand.ai", { added });
    return { controls: merged, said: describe(merged, tracks), not_followed: [...rules.not_followed, ...ai.not_followed], by: added ? "rules+ai" : "rules" };
  } catch {
    log.warn("steer.understand.ai_failed");
    return rules;
  }
}

/** What she confirmed on screen, made safe again (a stored or posted Understood is never trusted as is). */
export async function confirmUnderstood(env: Env, text: string, posted: unknown): Promise<Understood> {
  const tracks = await tracksOf(env);
  const p = (posted ?? null) as Partial<Understood> | null;
  if (!p || typeof p !== "object" || !p.controls) return parseNotes(text, tracks);
  const clean = cleanControls(p.controls, tracks);
  const nf = Array.isArray(p.not_followed) ? p.not_followed.filter((x) => x && typeof x.what === "string" && typeof x.why === "string").slice(0, 12).map((x) => ({ what: x.what.slice(0, 120), why: x.why.slice(0, 240) })) : [];
  return { controls: clean.controls, said: describe(clean.controls, tracks), not_followed: [...nf, ...clean.not_followed], by: p.by === "rules+ai" ? "rules+ai" : "rules" };
}

export function readUnderstood(v: string | null): Understood | null {
  const u = parseJson<Understood | null>(v, null);
  return u && typeof u === "object" && u.controls ? u : null;
}
