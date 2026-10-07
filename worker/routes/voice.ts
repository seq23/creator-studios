// Voice narration (section 12). The screen is always there (nothing hidden, owner 26 Sep 2026).
// features.voice means "Automatic voice overs" (owner, 26 Sep 2026): on = every clip with no
// talking gets a voice over in her voice automatically (worker/lib/autoVoice.ts); off = only the
// voice overs she makes herself. Making, drafting and attaching her own voice overs always work.
// Only the owner login can create, replace or delete the voice.
// Two engines (worker/domain/voiceEngine.ts): "built-in" (free, the Chatterbox job on the GitHub
// runner, always kept as the fallback) and "elevenlabs" (premium, her own ElevenLabs account,
// made here in the Worker in seconds). Every narration row records which one made it.
//   GET    /api/voice                     state + which engine is active and why + narrations
//   PATCH  /api/voice/clips               "Use my voice on clips" on or off (owner; features.voice)
//   PATCH  /api/voice/engine              "Use premium voice when connected" on or off (owner)
//   POST   /api/voice/sample              record the uploaded sample (uploads kind "voice_sample") + consent
//                                         (+ the premium clone when ElevenLabs is connected and allows it)
//   DELETE /api/voice/sample              delete the sample and the voice model, and the premium clone (one button)
//   POST   /api/voice/draft               draft a script from the locked Brand Profile
//   POST   /api/voice/narrations          script → premium now, or queue the built-in voice job
//   PATCH  /api/voice/narrations/:id      attach to a clip (or detach)
//   DELETE /api/voice/narrations/:id
//   GET    /api/voice/narrations/:id/audio   stream the file (logged-in only, never public)
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireOwner, requireUser } from "../lib/auth";
import { getSetting, recordEvent, setSetting } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { dispatchJob } from "../services/github";
import { ENGINE_PREFERENCES, fallbackNotice, type ElevenFailure, type EnginePreference } from "../domain/voiceEngine";
import { currentEngine, dropPremiumVoice, ENGINE_SETTING, ensurePremiumVoice, premiumNarrate } from "../lib/premiumVoice";
import { getLlm } from "../services/openrouter";
import { kitName, lockedProfile, themeList } from "./mediakit";
import type { Features } from "@shared/types";
import { autoVoiceState } from "../domain/autoVoice";
import { DEFAULT_FEATURES } from "@shared/constants";

/** Voice overs per page on the Voice overs screen (day 358). */
export const VOICE_PAGE = 10;

export const voice = new Hono<{ Bindings: Env; Variables: Vars }>();
voice.use("*", requireUser);

export const CONSENT_LINE = "This is my voice and I authorize its use in this dashboard.";
const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;
const MAX_SCRIPT = 1500;
/** A sample shorter than a minute makes a thin voice; about 3 minutes is best (the script on screen). */
export const MIN_SAMPLE_SECONDS = 60;


async function featureOn(env: Env): Promise<boolean> {
  const f = await getSetting<Features>(env.DB, "features", { ...DEFAULT_FEATURES });
  return !!f.voice;
}


interface VoiceDb {
  sample_r2_key: string | null;
  consent_at: string | null;
  consent_text: string | null;
  model_r2_key: string | null;
  enabled: number;
  updated_at: string | null;
}

async function voiceRow(env: Env): Promise<VoiceDb> {
  return (
    (await env.DB.prepare("SELECT sample_r2_key, consent_at, consent_text, model_r2_key, enabled, updated_at FROM voice WHERE id = 1").first<VoiceDb>()) ?? {
      sample_r2_key: null,
      consent_at: null,
      consent_text: null,
      model_r2_key: null,
      enabled: 0,
      updated_at: null,
    }
  );
}

voice.get("/", async (c) => {
  const v = await voiceRow(c.env);
  // Day 358: a page at a time, search, and archived ones only under "Show archived"; the totals are true.
  const archived = c.req.query("archived") === "1";
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? VOICE_PAGE) || VOICE_PAGE));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const where = `${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"}${q ? " AND script LIKE ?" : ""}`;
  const binds: unknown[] = q ? [`%${q}%`] : [];
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM narrations WHERE ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const archivedTotal = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM narrations WHERE archived_at IS NOT NULL").first<{ n: number }>())?.n ?? 0;
  const { results } = await c.env.DB.prepare(`SELECT id, script, status, clip_id, engine, duration_s, mix_status, created_at, archived_at FROM narrations WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<{
    archived_at: string | null;
    id: string;
    script: string;
    status: "queued" | "generating" | "ready" | "failed";
    clip_id: string | null;
    engine: "built-in" | "elevenlabs";
    duration_s: number | null;
    mix_status: "mixing" | "ready" | "failed" | null;
    created_at: string;
  }>();
  const e = await currentEngine(c.env);
  const plan = e.state.plan;
  return c.json({
    engine: {
      active: e.engine,
      reason: e.reason,
      why: e.why,
      preference: e.state.preference,
      connected: e.state.connection === "ok",
      connection: e.state.connection ?? "missing",
      can_clone: e.state.canClone,
      premium_voice: e.state.hasPremiumVoice,
      tier: plan?.tier ?? null,
      characters_left: plan ? Math.max(0, plan.limit - plan.used) : null,
      characters_limit: plan?.limit ?? null,
    },
    min_sample_seconds: MIN_SAMPLE_SECONDS,
    enabled: await featureOn(c.env),
    hasSample: !!v.sample_r2_key && !!v.consent_at,
    /** "on", "needs_voice" (on, but her voice isn't saved yet: a quiet state, never an error) or "off". */
    auto: autoVoiceState(await featureOn(c.env), !!v.sample_r2_key && !!v.consent_at),
    consent_at: v.consent_at,
    consent_line: CONSENT_LINE,
    hasModel: !!v.model_r2_key,
    owner: c.get("user").role === "owner",
    narrations: results.map((n) => ({ ...n, audio_url: n.status === "ready" ? `/api/voice/narrations/${n.id}/audio` : null })),
    narrations_page: { total, limit, offset, archived: archivedTotal, q },
  });
});

/** "Use premium voice when connected": premium_when_available (default) or built_in_only. */
voice.patch("/engine", requireOwner, async (c) => {
  const body = await readJson<{ preference?: string }>(c);
  const pref = body?.preference as EnginePreference | undefined;
  if (!pref || !ENGINE_PREFERENCES.includes(pref)) return fail(c, 422, "Pick premium or built-in.", "record-your-voice");
  await setSetting(c.env.DB, ENGINE_SETTING, pref);
  await recordEvent(c.env.DB, "voice.engine.preference", null, { preference: pref }, c.get("user").email);
  if (pref === "premium_when_available") await ensurePremiumVoice(c.env);
  const e = await currentEngine(c.env);
  return c.json({ ok: true, active: e.engine, why: e.why });
});

/** "Automatic voice overs" (features.voice). Off = only the voice overs she makes herself. */
voice.patch("/clips", requireOwner, async (c) => {
  const body = await readJson<{ on?: boolean }>(c);
  if (typeof body?.on !== "boolean") return fail(c, 422, "Pick on or off.", "record-your-voice");
  const current = await getSetting<Features>(c.env.DB, "features", { ...DEFAULT_FEATURES });
  await setSetting(c.env.DB, "features", { ...current, voice: body.on });
  await recordEvent(c.env.DB, "voice.clips.switch", null, { on: body.on }, c.get("user").email);
  return c.json({ ok: true, enabled: body.on });
});

voice.post("/sample", requireOwner, async (c) => {
  const body = await readJson<{ upload_id?: string; consent?: boolean; consent_text?: string; duration_s?: number }>(c);
  if (!body?.consent) return fail(c, 422, "Tick the consent box first: it confirms this is your own voice.", "record-your-voice");
  const seconds = Number(body.duration_s);
  if (!Number.isFinite(seconds) || seconds < MIN_SAMPLE_SECONDS) {
    return fail(c, 422, "That recording is under a minute. Record at least 1 minute; about 3 minutes (the whole script) gives the best voice.", "record-your-voice");
  }
  const uploadId = body.upload_id ?? "";
  if (!/^upl_[a-z0-9]{6,40}$/.test(uploadId)) return fail(c, 400, "That upload is not a voice sample.", "record-your-voice");
  const key = `voice/sample/${uploadId}`;
  const head = await c.env.FILES.head(key);
  if (!head) return fail(c, 404, "The recording did not finish uploading. Try again.", "record-your-voice");
  const type = head.httpMetadata?.contentType ?? "";
  if (!type.startsWith("audio/") && !type.startsWith("video/")) {
    await c.env.FILES.delete(key);
    return fail(c, 422, "That file is not a recording. Record here, or pick an audio file.", "record-your-voice");
  }
  if (head.size > MAX_SAMPLE_BYTES) {
    await c.env.FILES.delete(key);
    return fail(c, 413, "That recording is too long. 10 to 30 seconds is plenty.", "record-your-voice");
  }
  const old = await voiceRow(c.env);
  await dropPremiumVoice(c.env, "replaced"); // a new voice means a new premium clone too
  if (old.sample_r2_key && old.sample_r2_key !== key) await c.env.FILES.delete(old.sample_r2_key);
  if (old.model_r2_key) await c.env.FILES.delete(old.model_r2_key); // a new voice means a new model
  const consentText = (body.consent_text ?? CONSENT_LINE).trim().slice(0, 300) || CONSENT_LINE;
  const at = nowIso();
  await c.env.DB.prepare("UPDATE voice SET sample_r2_key = ?, consent_at = ?, consent_text = ?, model_r2_key = NULL, enabled = 1, updated_at = ? WHERE id = 1").bind(key, at, consentText, at).run();
  await recordEvent(c.env.DB, "voice.sample.saved", null, { bytes: head.size, replaced: !!old.sample_r2_key }, c.get("user").email);
  log.info("voice.sample.saved", { bytes: head.size, seconds: Math.round(seconds) });
  // The built-in voice is made on the first narration; the premium clone right now, if possible.
  const premium = await ensurePremiumVoice(c.env);
  const e = await currentEngine(c.env);
  return c.json({ ok: true, consent_at: at, engine: e.engine, premium_voice: !!premium.voiceId, why: e.why });
});

voice.delete("/sample", requireOwner, async (c) => {
  const v = await voiceRow(c.env);
  await dropPremiumVoice(c.env, "deleted"); // also deletes the clone from her ElevenLabs account
  if (v.sample_r2_key) await c.env.FILES.delete(v.sample_r2_key);
  if (v.model_r2_key) await c.env.FILES.delete(v.model_r2_key);
  await c.env.DB.prepare("UPDATE voice SET sample_r2_key = NULL, consent_at = NULL, consent_text = NULL, model_r2_key = NULL, enabled = 0, updated_at = ? WHERE id = 1").bind(nowIso()).run();
  await recordEvent(c.env.DB, "voice.deleted", null, { sample: !!v.sample_r2_key, model: !!v.model_r2_key }, c.get("user").email);
  log.info("voice.deleted");
  return c.json({ ok: true });
});

/** A short narration script in her voice from the locked profile. */
voice.post("/draft", async (c) => {
  const body = await readJson<{ topic?: string }>(c);
  const profile = await lockedProfile(c.env);
  if (!profile) return fail(c, 409, "Lock your Brand Profile first, so the script sounds like you.", "upload-brand-docs");
  const topic = (body?.topic ?? "").trim().slice(0, 200) || themeList(profile.themes)[0] || "what I'm working on this week";
  const first = kitName(c.env).split(" ")[0];
  const starter = `Hi, it's ${first}. Today is all about ${topic.toLowerCase()}. Here's the one thing I always do first, and why it makes everything easier. Watch to the end, then tell me in the comments how you do it.`;
  if (c.get("fake")) return c.json({ script: starter, note: null });
  const llm = await getLlm(c.env);
  const r = await llm.complete({
    system: `You write short voice-over scripts (20–40 seconds spoken, under 90 words) for the creator ${kitName(c.env)}. Her voice: ${profile.voice || "warm and direct"}. Do: ${profile.do_dont || ""}. Never mention: ${profile.off_limits || "nothing listed"}. Plain spoken sentences, one call to action from: ${profile.ctas || "follow for more"}. Reply with the script only.`,
    user: `Topic: ${topic}`,
    maxTokens: 300,
  });
  const text = r.ok ? r.text.trim().replace(/^["“]|["”]$/g, "") : "";
  if (!text) return c.json({ script: starter, note: "The free AI model is busy, so this is a starter script. Edit it, or try again in a minute." });
  return c.json({ script: text.slice(0, MAX_SCRIPT), note: null });
});

voice.post("/narrations", async (c) => {
  const body = await readJson<{ script?: string }>(c);
  const script = (body?.script ?? "").trim();
  if (script.length < 10) return fail(c, 422, "Write a sentence or two first, or tap Draft with AI.", "record-your-voice");
  if (script.length > MAX_SCRIPT) return fail(c, 422, "Keep the script under about 2 minutes (1,500 characters).", "record-your-voice");
  const v = await voiceRow(c.env);
  if (!v.sample_r2_key || !v.consent_at) return fail(c, 409, "Save your voice first (steps 1 to 4 above).", "record-your-voice");
  const id = newId("nar");
  // Premium when she allows it, ElevenLabs is connected, her plan clones and the clone exists
  // (made now if it should exist and does not). Anything else, or any premium failure: built-in.
  const cloned = await ensurePremiumVoice(c.env);
  const choice = await currentEngine(c.env);
  let fellBack: ElevenFailure | null = cloned.failure;
  if (choice.engine === "elevenlabs" && choice.state.voiceId) {
    await c.env.DB.prepare("INSERT INTO narrations (id, script, status, engine) VALUES (?, ?, 'generating', 'elevenlabs')").bind(id, script).run();
    const p = await premiumNarrate(c.env, id, script, choice.state.voiceId);
    if (p.ok) {
      await recordEvent(c.env.DB, "voice.narration.generated", id, { engine: "elevenlabs", chars: script.length, bytes: p.bytes, seconds: p.duration }, c.get("user").email);
      log.info("voice.premium.narrated", { bytes: p.bytes, chars: script.length });
      return c.json({ id, jobId: null, engine: "elevenlabs", notice: null });
    }
    fellBack = p.failure;
    await c.env.DB.prepare("UPDATE narrations SET engine = 'built-in', status = 'queued' WHERE id = ?").bind(id).run();
  } else {
    await c.env.DB.prepare("INSERT INTO narrations (id, script, status, engine) VALUES (?, ?, 'queued', 'built-in')").bind(id, script).run();
  }
  const r = await dispatchJob(c.env, "voice", id);
  if (!r.dispatched) {
    await c.env.DB.prepare("UPDATE narrations SET status = 'failed' WHERE id = ?").bind(id).run();
    return fail(c, 502, r.error ?? "The voice over could not start.", "reconnect-github");
  }
  await recordEvent(c.env.DB, "voice.narration.queued", id, { engine: "built-in", chars: script.length, fallback: fellBack }, c.get("user").email);
  return c.json({ id, jobId: r.jobId, engine: "built-in", notice: fellBack ? fallbackNotice(fellBack) : null });
});

voice.patch("/narrations/:id", async (c) => {
  const body = await readJson<{ clip_id?: string | null }>(c);
  const clipId = body?.clip_id ?? null;
  if (clipId) {
    const ok = await c.env.DB.prepare("SELECT id FROM clips WHERE id = ? AND status IN ('draft','approved')").bind(clipId).first();
    if (!ok) return fail(c, 422, "That clip is not available.", "record-your-voice");
  }
  const id = c.req.param("id") ?? "";
  const before = await c.env.DB.prepare("SELECT mixed_r2_key FROM narrations WHERE id = ? AND status = 'ready'").bind(id).first<{ mixed_r2_key: string | null }>();
  if (!before) return fail(c, 404, "That voice over is not ready.");
  // A new clip (or none) means the old mixed file is out of date: the clip's link goes back to the
  // original at once, and the mix job makes the new one.
  if (before.mixed_r2_key) await c.env.FILES.delete(before.mixed_r2_key);
  await c.env.DB.prepare("UPDATE narrations SET clip_id = ?, mixed_r2_key = NULL, mix_status = ? WHERE id = ?").bind(clipId, clipId ? "mixing" : null, id).run();
  await recordEvent(c.env.DB, clipId ? "voice.narration.attached" : "voice.narration.detached", id, {}, c.get("user").email);
  if (!clipId) return c.json({ ok: true, mixing: false });
  const job = await dispatchJob(c.env, "voice", id);
  if (!job.dispatched) {
    await c.env.DB.prepare("UPDATE narrations SET mix_status = 'failed' WHERE id = ?").bind(id).run();
    return fail(c, 502, job.error ?? "The voice over could not be added to the clip.", "reconnect-github");
  }
  return c.json({ ok: true, mixing: true, jobId: job.jobId });
});

voice.delete("/narrations/:id", async (c) => {
  const n = await c.env.DB.prepare("SELECT r2_key, mixed_r2_key FROM narrations WHERE id = ?").bind(c.req.param("id")).first<{ r2_key: string | null; mixed_r2_key: string | null }>();
  if (!n) return fail(c, 404, "That voice over is gone.");
  if (n.r2_key) await c.env.FILES.delete(n.r2_key);
  if (n.mixed_r2_key) await c.env.FILES.delete(n.mixed_r2_key); // the clip's link goes back to the original
  await c.env.DB.prepare("DELETE FROM narrations WHERE id = ?").bind(c.req.param("id")).run();
  await recordEvent(c.env.DB, "voice.narration.deleted", c.req.param("id"), {}, c.get("user").email);
  return c.json({ ok: true });
});

voice.get("/narrations/:id/audio", async (c) => {
  const n = await c.env.DB.prepare("SELECT r2_key FROM narrations WHERE id = ? AND status = 'ready'").bind(c.req.param("id")).first<{ r2_key: string | null }>();
  if (!n?.r2_key) return c.text("Not found", 404);
  const range = c.req.header("range");
  const obj = await c.env.FILES.get(n.r2_key, range ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const type = headers.get("content-type") ?? (n.r2_key.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
  headers.set("content-type", type);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  if (c.req.query("download") === "1") headers.set("content-disposition", `attachment; filename="voice-over-${c.req.param("id")}.${type.includes("wav") ? "wav" : "mp3"}"`);
  if (range && obj.range && "offset" in obj.range) {
    const start = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});
