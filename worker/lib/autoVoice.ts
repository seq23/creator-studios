// Automatic voice overs, from a finished dump to a voiced clip in Review (owner, 26 Sep 2026).
//   autoVoiceDump  after a built-in cut: when "Automatic voice overs" is on and her voice is saved,
//                  every clip with no talking (worker/domain/autoVoice.ts isSilentClip) gets a
//                  script (the free AI with her locked Brand Profile, the clip's hook and caption,
//                  fitted to its length; a starter script when the AI is busy), is voiced with the
//                  active engine (ElevenLabs premium here in the Worker, else the built-in voice),
//                  and ONE voice job run makes the built-in voices and mixes every clip (the model
//                  loads once per dump, not once per clip).
//   redoVoiceOver  Review: Redo with her own words (Edit the script); removeVoiceOver: Remove.
// Every voice over is her cloned voice, i.e. AI-generated audio: narrations.ai_generated, and the
// post is disclosed through Buffer's isAiGenerated (worker/services/buffer.ts postMetadata).
// Auto off, or no voice yet: nothing happens, quietly (the switch says "Record your voice first").
import type { Env } from "../env";
import { getSetting, recordEvent } from "./db";
import { newId } from "./ids";
import { log } from "./log";
import { dispatchJob } from "../services/github";
import { groundScript } from "@shared/grounded";
import { getLlm } from "../services/openrouter";
import { fakeServices } from "../env";
import { currentEngine, ensurePremiumVoice, premiumNarrate } from "./premiumVoice";
import { fitScript, isSilentClip, maxWords, starterScript, voiceFor, type VoicePlan } from "../domain/autoVoice";
import { cleanControls, mergeControls } from "../domain/steer";
import { readUnderstood, tracksOf } from "./steerStore";
import { parseJson } from "./db";
import { kitName, lockedProfile } from "../routes/mediakit";
import { DEFAULT_FEATURES } from "@shared/constants";
import type { Features } from "@shared/types";
import { readSound } from "../routes/settings";
import { cleanScript } from "@shared/clipWords";
import { readStudioRules } from "./studioRules";

export const AUTO_BATCH_PREFIX = "auto/";

export async function autoVoiceOn(env: Env): Promise<boolean> {
  return !!(await getSetting<Features>(env.DB, "features", { ...DEFAULT_FEATURES })).voice;
}

/**
 * A voice the voice overs can use: the stock voice when the studio uses one (Settings → Sound,
 * shared/sound.ts), else her own recorded sample.
 */
export async function voiceReady(env: Env): Promise<boolean> {
  return (await readSound(env)).voice_source === "stock" || (await hasVoiceSample(env));
}

/** The stock voice's id when voice overs use one, else null (her own recorded voice). */
export async function stockVoice(env: Env): Promise<string | null> {
  const s = await readSound(env);
  return s.voice_source === "stock" ? s.stock_voice : null;
}

export async function hasVoiceSample(env: Env): Promise<boolean> {
  const v = await env.DB.prepare("SELECT sample_r2_key, consent_at FROM voice WHERE id = 1").first<{ sample_r2_key: string | null; consent_at: string | null }>();
  return !!(v?.sample_r2_key && v.consent_at);
}

interface TargetClip {
  id: string;
  hook_text: string;
  caption: string;
  start_s: number;
  end_s: number;
  speech: number | null;
  /** What the shot sheet says is on screen, and the clip's story shape (null for clips made before). */
  on_screen?: string | null;
  shape?: string | null;
  /** The clip engine's own script for this clip (jobs/script_clean.py), spoken first when it passes. */
  voice_script?: string | null;
}

/**
 * A script for one clip with no talking, in her voice, fitted to the clip. Never empty.
 * The clip engine's voice_script comes first; every script, the engine's or drafted here, passes
 * jobs/script_rules.json (shared/clipWords.ts cleanScript): reasoning-shaped text is never spoken,
 * no sentence twice, the call to action once, the caption never read back.
 */
export async function draftScript(env: Env, clip: TargetClip): Promise<string> {
  const seconds = clip.end_s - clip.start_s;
  const ctas = (await readStudioRules(env)).cta_phrases;
  const own = clip.voice_script ? cleanScript(clip.voice_script, clip.caption, ctas, maxWords(seconds)) : "";
  if (own.length >= 10) return fitScript(own, seconds);
  const profile = await lockedProfile(env);
  const cta = (profile?.ctas ?? "").split("\n").map((l) => l.replace(/^[\s\-•]+/, "").trim()).find(Boolean) ?? null;
  // Grounded (studio intelligence layer 4): no sentence mentions automation, none claims a finished
  // result or a "before" the picture does not show (shared/grounded.ts, one word list with the cutter).
  const ground = clip.shape ? { hasAfter: clip.shape === "transformation" || clip.shape === "walkthrough", hasBefore: clip.shape === "transformation" } : { hasAfter: true, hasBefore: true };
  const starter = groundScript(starterScript(clip, cta, seconds), ground) || fitScript(cta ? `${cta.replace(/[.!]*$/, "")}.` : "Take a look.", seconds);
  if (fakeServices(env)) return starter;
  const llm = await getLlm(env);
  const r = await llm.complete({
    system: `You write a voice-over for a ${Math.round(seconds)}-second vertical video with no talking in it (b-roll, montage, product shots), for the creator ${kitName(env)}, spoken in her own voice. At most ${maxWords(seconds)} words. Her voice: ${profile?.voice || "warm and direct"}. Do: ${profile?.do_dont || ""}. Never mention: ${profile?.off_limits || "nothing listed"}. End with one call to action from: ${profile?.ctas || "follow for more"}. Describe only what is on screen; never mention automation, software or how the video was made. Reply with the script only, plain spoken sentences.`,
    user: `On-screen hook: ${clip.hook_text}\nCaption: ${clip.caption}${clip.on_screen ? `\nOn screen, in order: ${clip.on_screen}` : ""}`,
    maxTokens: 300,
  });
  const text = r.ok ? cleanScript(groundScript(r.text.trim().replace(/^["“]|["”]$/g, ""), ground), clip.caption, ctas, maxWords(seconds)) : "";
  return text.length >= 10 ? fitScript(text, seconds) : starter;
}

/** Make the voice overs for these clips and start ONE voice job run for all of them. */
async function voiceClips(env: Env, items: { clip: TargetClip; script: string; auto: boolean }[]): Promise<{ batch: string | null; premium: number; builtIn: number }> {
  if (!items.length) return { batch: null, premium: 0, builtIn: 0 };
  const batch = newId("vb");
  // A stock voice is spoken on the job runner; the premium engine clones HER voice, so it is skipped then.
  const stock = await stockVoice(env);
  const cloned = stock ? { voiceId: null } : await ensurePremiumVoice(env);
  const choice = await currentEngine(env);
  let premium = 0;
  let builtIn = 0;
  for (const it of items) {
    const id = newId("nar");
    const usePremium = !stock && choice.engine === "elevenlabs" && !!(choice.state.voiceId ?? cloned.voiceId);
    await env.DB.prepare("INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, batch, mix_status) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'mixing')")
      .bind(id, it.script, it.clip.id, usePremium ? "generating" : "queued", usePremium ? "elevenlabs" : "built-in", it.auto ? 1 : 0, batch)
      .run();
    if (usePremium) {
      const p = await premiumNarrate(env, id, it.script, (choice.state.voiceId ?? cloned.voiceId)!);
      if (p.ok) {
        premium++;
        continue;
      }
      // Any premium failure: the built-in voice makes it in the same run (fallback, never a stop).
      await env.DB.prepare("UPDATE narrations SET engine = 'built-in', status = 'queued' WHERE id = ?").bind(id).run();
    }
    builtIn++;
  }
  const job = await dispatchJob(env, "voice", `${AUTO_BATCH_PREFIX}${batch}`);
  if (!job.dispatched) {
    await env.DB.prepare("UPDATE narrations SET mix_status = 'failed', status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END WHERE batch = ?").bind(batch).run();
    log.warn("voice.auto.dispatch_failed", {});
    return { batch: null, premium, builtIn };
  }
  return { batch, premium, builtIn };
}

/**
 * Her voice-over plan for a dump, per video: the video's own note > the "Voice over" chip > the
 * dump's note > the Settings switch (worker/domain/autoVoice.ts voiceFor).
 */
export async function voicePlans(env: Env, dumpId: string): Promise<{ dump: VoicePlan; assets: Map<string, VoicePlan> }> {
  const [on, sample, tracks] = [await autoVoiceOn(env), await voiceReady(env), await tracksOf(env)];
  const dump = await env.DB.prepare("SELECT steer, steer_notes FROM dumps WHERE id = ?").bind(dumpId).first<{ steer: string | null; steer_notes: string | null }>();
  const chips = cleanControls(parseJson(dump?.steer ?? null, {}), tracks).controls;
  const note = readUnderstood(dump?.steer_notes ?? null)?.controls ?? {};
  const { results } = await env.DB.prepare("SELECT id, steer_notes FROM assets WHERE dump_id = ?").bind(dumpId).all<{ id: string; steer_notes: string | null }>();
  const assets = new Map(results.map((a) => [a.id, voiceFor(mergeControls(chips, note, readUnderstood(a.steer_notes)?.controls ?? {}).controls.voice, on, sample)]));
  return { dump: voiceFor(mergeControls(chips, note).controls.voice, on, sample), assets };
}

/**
 * After a built-in cut: a voice over for every new clip with no talking, where her plan for that
 * clip's video is "quiet" (on quiet clips) and her voice is saved. "none" and "pick" make nothing;
 * with "pick" she adds them one by one in Review.
 */
export async function autoVoiceDump(env: Env, dumpId: string): Promise<{ state: "off" | "needs_voice" | "voiced"; clips: number }> {
  const plans = await voicePlans(env, dumpId);
  const quiet = (p: VoicePlan) => p === "quiet";
  if (![plans.dump, ...plans.assets.values()].some(quiet)) {
    // quiet either way: the switch and the Dump screen say "Record your voice first"; no light, no email
    return { state: [plans.dump, ...plans.assets.values()].includes("needs_voice") ? "needs_voice" : "off", clips: 0 };
  }
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.asset_id, c.hook_text, c.caption, c.start_s, c.end_s, c.speech, c.on_screen, c.shape, c.voice_script FROM clips c WHERE c.dump_id = ? AND c.status IN ('draft', 'approved') AND c.words_pending = 0 AND NOT EXISTS (SELECT 1 FROM narrations n WHERE n.clip_id = c.id)",
  )
    .bind(dumpId)
    .all<TargetClip & { asset_id: string }>();
  const targets = results.filter((c) => quiet(plans.assets.get(c.asset_id) ?? plans.dump) && isSilentClip(c.speech));
  if (!targets.length) return { state: "voiced", clips: 0 };
  const items = [];
  for (const clip of targets) items.push({ clip, script: await draftScript(env, clip), auto: true });
  const r = await voiceClips(env, items);
  await recordEvent(env.DB, "voice.auto", dumpId, { clips: targets.length, premium: r.premium, built_in: r.builtIn });
  log.info("voice.auto", { clips: targets.length, premium: r.premium, built_in: r.builtIn });
  return { state: "voiced", clips: targets.length };
}

/**
 * "Add voice over to all clips in this dump" (Review): every clip of the dump with no talking that
 * has no voice over yet gets one, in ONE voice job run, whatever the dump's plan was. Clips where
 * someone talks never do. Returns how many were started (0 = nothing to voice).
 */
export async function voiceAllInDump(env: Env, dumpId: string): Promise<{ clips: number; started: boolean }> {
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.hook_text, c.caption, c.start_s, c.end_s, c.speech, c.on_screen, c.shape, c.voice_script FROM clips c WHERE c.dump_id = ? AND c.status IN ('draft', 'approved') AND c.full_video = 0 AND c.words_pending = 0 AND NOT EXISTS (SELECT 1 FROM narrations n WHERE n.clip_id = c.id)",
  )
    .bind(dumpId)
    .all<TargetClip>();
  const targets = results.filter((c) => isSilentClip(c.speech));
  if (!targets.length) return { clips: 0, started: false };
  const items = [];
  for (const clip of targets) items.push({ clip, script: await draftScript(env, clip), auto: true });
  const r = await voiceClips(env, items);
  await recordEvent(env.DB, "voice.all", dumpId, { clips: targets.length });
  log.info("voice.all", { clips: targets.length, started: !!r.batch });
  return { clips: targets.length, started: !!r.batch };
}

/** Remove: the clip goes back to its own sound; the voice over and its mixed file are deleted. */
export async function removeVoiceOver(env: Env, clipId: string): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, r2_key, mixed_r2_key FROM narrations WHERE clip_id = ?").bind(clipId).all<{ id: string; r2_key: string | null; mixed_r2_key: string | null }>();
  const keys = results.flatMap((n) => [n.r2_key, n.mixed_r2_key]).filter((k): k is string => !!k);
  if (keys.length) await env.FILES.delete(keys);
  await env.DB.prepare("DELETE FROM narrations WHERE clip_id = ?").bind(clipId).run();
  return results.length;
}

/** Redo with her own words (Edit the script in Review): re-voice and re-mix just that clip. */
export async function redoVoiceOver(env: Env, clipId: string, script: string): Promise<{ batch: string | null }> {
  const clip = await env.DB.prepare("SELECT id, hook_text, caption, start_s, end_s, speech FROM clips WHERE id = ? AND status != 'deleted'").bind(clipId).first<TargetClip>();
  if (!clip) return { batch: null };
  const wasAuto = !!(await env.DB.prepare("SELECT 1 AS x FROM narrations WHERE clip_id = ? AND auto = 1 LIMIT 1").bind(clipId).first());
  await removeVoiceOver(env, clipId);
  const r = await voiceClips(env, [{ clip, script, auto: wasAuto }]); // her words as written (the route checks the length)
  return { batch: r.batch };
}
