// Which voice makes a narration, and what the ElevenLabs light says. Pure rules, unit-tested
// (tests/unit/voice-engine.test.ts). Two engines, named the same everywhere:
//   built-in   — free: the Chatterbox job on the GitHub runner. Always there as the fallback.
//   elevenlabs — premium: ElevenLabs Instant Voice Clone + text to speech, made by the Worker.

export type VoiceEngine = "built-in" | "elevenlabs";
export type EnginePreference = "premium_when_available" | "built_in_only";
export const ENGINE_PREFERENCES: EnginePreference[] = ["premium_when_available", "built_in_only"];
export const DEFAULT_ENGINE_PREFERENCE: EnginePreference = "premium_when_available";

export interface EngineInputs {
  preference: EnginePreference;
  /** connections.status for elevenlabs ("ok" | "error" | "disconnected" | "missing" | none). */
  connection: string | null;
  /** can_use_instant_voice_cloning from her plan, as last checked. */
  canClone: boolean;
  /** voice.elevenlabs_voice_id is set. */
  hasPremiumVoice: boolean;
  /** a consented sample exists (without one neither engine can speak). */
  hasSample: boolean;
}

export type EngineReason = "chosen_built_in" | "not_connected" | "needs_reconnect" | "no_cloning" | "no_premium_voice" | "no_sample" | "premium_ready";

export interface EngineChoice {
  engine: VoiceEngine;
  reason: EngineReason;
  /** One sentence in Sam's words for the card at the top of Voice. */
  why: string;
}

const WHY: Record<EngineReason, string> = {
  chosen_built_in: "You chose the built-in voice. Switch on “Use premium voice when connected” to use ElevenLabs.",
  not_connected: "ElevenLabs is not connected, so the built-in voice is used.",
  needs_reconnect: "ElevenLabs refused your key, so the built-in voice is used until you reconnect it.",
  no_cloning: "Your ElevenLabs plan does not include voice cloning; the built-in voice will be used.",
  no_premium_voice: "Your premium voice is not made yet, so the built-in voice is used. Save your voice again to make it.",
  no_sample: "Save your voice first. Then every voice over uses the voice named here.",
  premium_ready: "ElevenLabs is connected and your premium voice is ready.",
};

/**
 * Premium only when every one of these holds: she allows it, ElevenLabs is connected and
 * answering, her plan includes cloning, and the premium voice exists. Anything else is built-in.
 */
export function chooseEngine(i: EngineInputs): EngineChoice {
  const pick = (engine: VoiceEngine, reason: EngineReason): EngineChoice => ({ engine, reason, why: WHY[reason] });
  if (i.preference === "built_in_only") return pick("built-in", "chosen_built_in");
  if (i.connection === "error") return pick("built-in", "needs_reconnect");
  if (i.connection !== "ok") return pick("built-in", "not_connected");
  if (!i.canClone) return pick("built-in", "no_cloning");
  if (!i.hasSample) return pick("built-in", "no_sample");
  if (!i.hasPremiumVoice) return pick("built-in", "no_premium_voice");
  return pick("elevenlabs", "premium_ready");
}

/** Whether a clone should be made now: premium allowed and possible, a sample, no clone yet. */
export function shouldClone(i: EngineInputs): boolean {
  return i.preference !== "built_in_only" && i.connection === "ok" && i.canClone && i.hasSample && !i.hasPremiumVoice;
}

export function readPreference(v: unknown): EnginePreference {
  return v === "built_in_only" ? "built_in_only" : DEFAULT_ENGINE_PREFERENCE;
}

// ---------------------------------------------------------------- failures

/** What a failed ElevenLabs call means for her. */
export type ElevenFailure = "auth" | "quota" | "busy" | "other";

/**
 * Classify an ElevenLabs error answer. ElevenLabs reports a used-up quota as a 401 whose
 * detail.status is "quota_exceeded", so the body decides before the status does: a quota 401
 * is never read as a refused key.
 */
export function classifyElevenError(status: number, body: string): ElevenFailure {
  let detail = "";
  try {
    const j = JSON.parse(body) as { detail?: { status?: string } | string };
    detail = typeof j.detail === "string" ? j.detail : (j.detail?.status ?? "");
  } catch {
    detail = "";
  }
  if (/quota|credit|character_limit|insufficient/i.test(detail)) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "busy";
  return "other";
}

/** The toast after a narration that could not use premium and fell back to the built-in voice. */
export function fallbackNotice(f: ElevenFailure): string {
  const tail = "so this voice over uses your built-in voice. It shows up below in a few minutes.";
  if (f === "quota") return `Your ElevenLabs credits are used up, ${tail}`;
  if (f === "auth") return `ElevenLabs refused your key, ${tail} Reconnect ElevenLabs on Connect.`;
  if (f === "busy") return `ElevenLabs is busy right now, ${tail}`;
  return `ElevenLabs did not answer, ${tail}`;
}

// ---------------------------------------------------------------- the light

export const ELEVEN_HEALTH = "Voice · ElevenLabs";
export const LOW_CREDIT_FRACTION = 0.1;

export interface ElevenPlan {
  tier: string;
  used: number;
  limit: number;
  canClone: boolean;
}

export type ElevenLightInput = { state: "not_connected" } | { state: "refused" } | { state: "unreachable" } | { state: "quota_hit" } | { state: "ok"; plan: ElevenPlan };

export interface Light {
  light: "green" | "yellow" | "red" | "grey";
  note: string;
  fix: string | null;
}

const fmt = (n: number) => Math.max(0, Math.round(n)).toLocaleString("en-US");

/** grey not connected · red key refused · yellow low credits (< 10% left) or no cloning · green ok. */
export function elevenLabsLight(i: ElevenLightInput): Light {
  if (i.state === "not_connected") return { light: "grey", note: "Not connected · voice overs use the built-in voice", fix: "connect-elevenlabs" };
  if (i.state === "refused") return { light: "red", note: "ElevenLabs refused the key · voice overs use the built-in voice", fix: "reconnect-elevenlabs" };
  if (i.state === "unreachable") return { light: "yellow", note: "ElevenLabs did not answer · checking again tomorrow", fix: "reconnect-elevenlabs" };
  if (i.state === "quota_hit") return { light: "yellow", note: "ElevenLabs credits used up · voice overs use the built-in voice", fix: "connect-elevenlabs" };
  const { plan } = i;
  if (!plan.canClone) return { light: "yellow", note: "Your ElevenLabs plan does not include voice cloning; the built-in voice will be used", fix: "connect-elevenlabs" };
  const left = Math.max(0, plan.limit - plan.used);
  if (plan.limit <= 0 || left / plan.limit < LOW_CREDIT_FRACTION) {
    return { light: "yellow", note: left <= 0 ? "ElevenLabs credits used up · voice overs use the built-in voice" : `Low ElevenLabs credits · ${fmt(left)} of ${fmt(plan.limit)} characters left`, fix: "connect-elevenlabs" };
  }
  return { light: "green", note: `Premium voice ready · ${fmt(left)} of ${fmt(plan.limit)} characters left`, fix: null };
}

// ---------------------------------------------------------------- mp3 duration

const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;

/**
 * Seconds of audio in an MPEG Layer III file, by walking its frames (exact, not an estimate
 * from the byte count). null when the bytes are not a readable mp3: the duration is then left
 * empty, never invented.
 */
export function mp3Duration(bytes: Uint8Array): number | null {
  let i = 0;
  // skip an ID3v2 tag
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    i = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) {
      if (frames > 0) break; // trailing tag or junk after the audio
      i++;
      if (i > 4096) return null; // no frame near the start: not an mp3
      continue;
    }
    const version = (bytes[i + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (bytes[i + 1] >> 1) & 0x03; // 1 = Layer III
    const brIdx = (bytes[i + 2] >> 4) & 0x0f;
    const srIdx = (bytes[i + 2] >> 2) & 0x03;
    const pad = (bytes[i + 2] >> 1) & 0x01;
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      if (frames > 0) break;
      i++;
      continue;
    }
    const sr = SR[version][srIdx];
    const br = (version === 3 ? BR_V1_L3 : BR_V2_L3)[brIdx] * 1000;
    const perFrame = version === 3 ? 1152 : 576;
    const len = Math.floor(((perFrame / 8) * br) / sr) + pad;
    if (len < 4) return null;
    samples += perFrame;
    rate = sr;
    frames++;
    i += len;
  }
  if (!frames || !rate) return null;
  return Math.round((samples / rate) * 100) / 100;
}

// ---------------------------------------------------------------- the Home card

/** Home's quiet "Your voice" card: optional, never a nag. Red only for a real error. */
export interface HomeVoiceCard {
  state: "not_set_up" | "built_in_ready" | "premium_on" | "problem";
  line: string;
  link: { to: string; label: string };
}

export function homeVoiceCard(i: { hasSample: boolean; engine: VoiceEngine; connection: string | null; problem: { note: string; fix: string | null } | null }): HomeVoiceCard {
  if (i.problem) return { state: "problem", line: i.problem.note, link: i.problem.fix ? { to: `/help/${i.problem.fix}`, label: "How to fix" } : { to: "/voice", label: "Open Voice" } };
  if (!i.hasSample) return { state: "not_set_up", line: "Optional: record your voice so your clips can have voice overs in it", link: { to: "/voice", label: "Set up in 5 steps" } };
  if (i.engine === "elevenlabs") return { state: "premium_on", line: "Premium voice on", link: { to: "/voice", label: "Manage" } };
  const line = i.connection === "ok" || i.connection === "error" ? "Built-in voice ready" : "Built-in voice ready · Premium available with ElevenLabs";
  return { state: "built_in_ready", line, link: { to: "/voice", label: "Manage" } };
}
