// Two voice engines: built-in (free, the Chatterbox job) and ElevenLabs (premium, the Worker).
// The pure rules (which engine, how a failure is read, what the light says, how long an mp3 is)
// and the routes end to end against the real schema (sqlite-d1), an in-memory R2 and the
// ElevenLabs fake: connect, clone on save, premium narration, fallback on used-up credits, a
// refused key marks the connection broken, disconnect and delete remove the clone.
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { chooseEngine, classifyElevenError, elevenLabsLight, fallbackNotice, homeVoiceCard, mp3Duration, shouldClone, type EngineInputs, type EnginePreference } from "@worker/domain/voiceEngine";
import { fakeElevenVoices, resetFakeElevenLabs, silentMp3 } from "@worker/services/elevenlabs";
import { recheckElevenLabs } from "@worker/lib/premiumVoice";
import { saveConnection } from "@worker/lib/connections";
import { getSetting, setSetting } from "@worker/lib/db";
import { DEFAULT_FEATURES } from "@shared/constants";
import { voice } from "@worker/routes/voice";
import { connections } from "@worker/routes/connections";
import { media } from "@worker/routes/media";
import { clips } from "@worker/routes/clips";
import { mixedKey, voiceJob } from "@worker/jobs/voice";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";

const base: EngineInputs = { preference: "premium_when_available", connection: "ok", canClone: true, hasPremiumVoice: true, hasSample: true };

describe("chooseEngine: premium only when everything allows it", () => {
  const cases: [string, Partial<EngineInputs>, "built-in" | "elevenlabs", string][] = [
    ["everything ready", {}, "elevenlabs", "premium_ready"],
    ["she chose built-in only", { preference: "built_in_only" }, "built-in", "chosen_built_in"],
    ["built-in only wins even when a refused key would be the reason", { preference: "built_in_only", connection: "error" }, "built-in", "chosen_built_in"],
    ["never connected", { connection: null }, "built-in", "not_connected"],
    ["connection row missing", { connection: "missing" }, "built-in", "not_connected"],
    ["disconnected", { connection: "disconnected" }, "built-in", "not_connected"],
    ["key refused", { connection: "error" }, "built-in", "needs_reconnect"],
    ["plan without cloning, even with an old clone id", { canClone: false }, "built-in", "no_cloning"],
    ["clone not made yet", { hasPremiumVoice: false }, "built-in", "no_premium_voice"],
    ["no consented sample", { hasSample: false }, "built-in", "no_sample"],
    ["no cloning and no clone", { canClone: false, hasPremiumVoice: false }, "built-in", "no_cloning"],
  ];
  for (const [name, patch, engine, reason] of cases) {
    it(name, () => {
      const r = chooseEngine({ ...base, ...patch });
      expect(r.engine).toBe(engine);
      expect(r.reason).toBe(reason);
      expect(r.why.length).toBeGreaterThan(20);
    });
  }

  it("over every combination: premium implies allowed + connected ok + cloning on the plan + a clone + a sample", () => {
    let premium = 0;
    let total = 0;
    for (const preference of ["premium_when_available", "built_in_only"] as EnginePreference[])
      for (const connection of ["ok", "error", "disconnected", "missing", null])
        for (const canClone of [true, false])
          for (const hasPremiumVoice of [true, false])
            for (const hasSample of [true, false]) {
              total++;
              const i = { preference, connection, canClone, hasPremiumVoice, hasSample };
              const r = chooseEngine(i);
              if (r.engine !== "elevenlabs") continue;
              premium++;
              expect(i).toEqual(base);
            }
    expect(total).toBe(80);
    expect(premium).toBe(1);
  });

  it("the no-cloning sentence is the one the owner asked for, word for word", () => {
    expect(chooseEngine({ ...base, canClone: false }).why).toBe("Your ElevenLabs plan does not include voice cloning; the built-in voice will be used.");
  });

  it("shouldClone: only when premium is allowed and possible and no clone exists yet", () => {
    expect(shouldClone({ ...base, hasPremiumVoice: false })).toBe(true);
    expect(shouldClone(base)).toBe(false);
    expect(shouldClone({ ...base, hasPremiumVoice: false, canClone: false })).toBe(false);
    expect(shouldClone({ ...base, hasPremiumVoice: false, preference: "built_in_only" })).toBe(false);
    expect(shouldClone({ ...base, hasPremiumVoice: false, connection: "error" })).toBe(false);
    expect(shouldClone({ ...base, hasPremiumVoice: false, hasSample: false })).toBe(false);
  });
});

describe("classifyElevenError", () => {
  it("a quota 401 is used-up credits, never a refused key", () => {
    expect(classifyElevenError(401, JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } }))).toBe("quota");
    expect(classifyElevenError(401, JSON.stringify({ detail: { status: "invalid_api_key" } }))).toBe("auth");
    expect(classifyElevenError(401, "")).toBe("auth");
    expect(classifyElevenError(403, JSON.stringify({ detail: { status: "missing_permissions" } }))).toBe("auth");
  });
  it("402 is credits, 429 is busy (unless it names the quota), other statuses are other", () => {
    expect(classifyElevenError(402, "{}")).toBe("quota");
    expect(classifyElevenError(429, JSON.stringify({ detail: { status: "too_many_concurrent_requests" } }))).toBe("busy");
    expect(classifyElevenError(429, JSON.stringify({ detail: { status: "quota_exceeded" } }))).toBe("quota");
    expect(classifyElevenError(500, "oops")).toBe("other");
    expect(classifyElevenError(0, "")).toBe("other");
  });
  it("every fallback toast says the built-in voice is used, in plain words", () => {
    for (const f of ["quota", "auth", "busy", "other"] as const) expect(fallbackNotice(f)).toMatch(/uses your built-in voice/);
    expect(fallbackNotice("quota")).toMatch(/credits are used up/);
  });
});

describe("the Voice · ElevenLabs light", () => {
  it("grey not connected, red refused, yellow no cloning / low credits / used up, green ok", () => {
    expect(elevenLabsLight({ state: "not_connected" })).toMatchObject({ light: "grey", fix: "connect-elevenlabs" });
    expect(elevenLabsLight({ state: "refused" })).toMatchObject({ light: "red", fix: "reconnect-elevenlabs" });
    expect(elevenLabsLight({ state: "quota_hit" })).toMatchObject({ light: "yellow", note: expect.stringMatching(/credits used up/) });
    expect(elevenLabsLight({ state: "ok", plan: { tier: "free", used: 0, limit: 10_000, canClone: false } })).toMatchObject({ light: "yellow", note: expect.stringMatching(/does not include voice cloning/) });
    expect(elevenLabsLight({ state: "ok", plan: { tier: "creator", used: 91_000, limit: 100_000, canClone: true } })).toMatchObject({ light: "yellow", note: "Low ElevenLabs credits · 9,000 of 100,000 characters left" });
    expect(elevenLabsLight({ state: "ok", plan: { tier: "creator", used: 90_000, limit: 100_000, canClone: true } }).light).toBe("green");
    expect(elevenLabsLight({ state: "ok", plan: { tier: "starter", used: 30_000, limit: 30_000, canClone: true } }).note).toMatch(/credits used up/);
    expect(elevenLabsLight({ state: "ok", plan: { tier: "creator", used: 12_000, limit: 100_000, canClone: true } })).toEqual({ light: "green", note: "Premium voice ready · 88,000 of 100,000 characters left", fix: null });
  });
});

describe("mp3Duration", () => {
  it("reads the fake's real silent mp3 frame by frame", () => {
    expect(mp3Duration(silentMp3())).toBeCloseTo(1.045, 2);
  });
  it("skips an ID3 tag", () => {
    const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const mp3 = silentMp3();
    const both = new Uint8Array(tag.length + mp3.length);
    both.set(tag);
    both.set(mp3, tag.length);
    expect(mp3Duration(both)).toBeCloseTo(1.045, 2);
  });
  it("is null, never a guess, for bytes that are not an mp3", () => {
    expect(mp3Duration(new Uint8Array(5000).fill(7))).toBeNull();
    expect(mp3Duration(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
  });
});

// ---------------------------------------------------------------- routes, end to end on fakes

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  await next();
});
app.route("/api/voice", voice);
app.route("/api/connections", connections);
app.route("/api/clips", clips);
app.route("/media", media);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${path}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const light = () => db.raw.prepare("SELECT light, note, fix_guide FROM health WHERE name = 'Voice · ElevenLabs'").get() as { light: string; note: string; fix_guide: string | null } | undefined;
const conn = () => db.raw.prepare("SELECT status, meta, last_error FROM connections WHERE service = 'elevenlabs'").get() as { status: string; meta: string; last_error: string | null } | undefined;
const voiceId = () => (db.raw.prepare("SELECT elevenlabs_voice_id AS v FROM voice WHERE id = 1").get() as { v: string | null }).v;
const narration = (id: string) => db.raw.prepare("SELECT status, engine, r2_key, duration_s FROM narrations WHERE id = ?").get(id) as { status: string; engine: string; r2_key: string | null; duration_s: number | null };

async function saveSample(seconds = 75) {
  const upload = `upl_${Math.random().toString(36).slice(2, 12)}`;
  await r2.FILES.put(`voice/sample/${upload}`, new Uint8Array(4000).fill(1), { httpMetadata: { contentType: "audio/wav" } });
  return call("POST", "/api/voice/sample", { upload_id: upload, consent: true, duration_s: seconds });
}
const narrate = (script = "Hello friends, welcome back to the table today.") => call("POST", "/api/voice/narrations", { script });

beforeEach(async () => {
  db = sqliteD1();
  r2 = memoryR2();
  resetFakeElevenLabs();
  env = {
    DB: db.DB,
    FILES: r2.FILES,
    OWNER_EMAIL: "owner@studio.example",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
  } as unknown as Env;
  await setSetting(env.DB, "features", { voice: true, deeper_research: false, weekly_recap: true, help_ask: false });
});

describe("Connect: Voice · ElevenLabs (premium)", () => {
  it("a good key shows the tier, characters and cloning; stored encrypted; the light is green", async () => {
    const r = await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    expect(r.status).toBe(200);
    expect(r.json.meta).toEqual({ tier: "creator", characters_used: 12_000, characters_limit: 100_000, can_clone: true });
    expect(r.json.note).toMatch(/premium voice/);
    const row = db.raw.prepare("SELECT status, secret_enc FROM connections WHERE service = 'elevenlabs'").get() as { status: string; secret_enc: string };
    expect(row.status).toBe("ok");
    expect(row.secret_enc).not.toContain("good-abcdef123");
    expect(light()).toMatchObject({ light: "green", fix_guide: null });
  });

  it("a bad key is refused with the not-valid sentence and the connect guide", async () => {
    const r = await call("POST", "/api/connections/elevenlabs/key", { key: "nope-abcdef123" });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: "ElevenLabs says this key is not valid.", fix_guide: "connect-elevenlabs" });
    expect(conn()?.status).toBe("error");
  });

  it("a plan without cloning is accepted and says so plainly; narrations stay built-in", async () => {
    const r = await call("POST", "/api/connections/elevenlabs/key", { key: "good-nocloning-abc" });
    expect(r.status).toBe(200);
    expect(r.json.note).toBe("Your ElevenLabs plan does not include voice cloning; the built-in voice will be used.");
    expect(light()).toMatchObject({ light: "yellow", fix_guide: "connect-elevenlabs" });
    await saveSample();
    expect(voiceId()).toBeNull();
    const s = await call("GET", "/api/voice");
    expect(s.json.engine).toMatchObject({ active: "built-in", reason: "no_cloning", connected: true, can_clone: false });
  });
});

describe("clone, narrate, fall back", () => {
  it("a sample under a minute is refused in plain words; the built-in voice path is unchanged", async () => {
    const r = await saveSample(45);
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/under a minute/);
    expect(r.json.fix_guide).toBe("record-your-voice");
    const ok = await saveSample(61);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ engine: "built-in", premium_voice: false });
  });

  it("connected + sample saved → clone made; narration is premium, ready at once, an mp3 with its real length", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    const s = await saveSample();
    expect(s.json).toMatchObject({ engine: "elevenlabs", premium_voice: true });
    const id = voiceId();
    expect(id).toMatch(/^fake_voice_/);
    expect(fakeElevenVoices()).toEqual([id]);

    const n = await narrate();
    expect(n.status).toBe(200);
    expect(n.json).toMatchObject({ engine: "elevenlabs", jobId: null, notice: null });
    const row = narration(n.json.id as string);
    expect(row).toMatchObject({ status: "ready", engine: "elevenlabs", r2_key: `voice/narrations/${n.json.id}.mp3` });
    expect(row.duration_s).toBeCloseTo(1.045, 2);
    expect(r2.objects.get(row.r2_key!)?.contentType).toBe("audio/mpeg");
    const jobs = db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'voice'").get() as { n: number };
    expect(jobs.n).toBe(0); // premium never touches the runner

    const list = await call("GET", "/api/voice");
    const first = (list.json.narrations as { engine: string; audio_url: string | null }[])[0];
    expect(first.engine).toBe("elevenlabs");
    expect(first.audio_url).toBe(`/api/voice/narrations/${n.json.id}/audio`);
    const audio = await app.request(`${BASE_URL}${first.audio_url}`, { headers: { cookie: await ownerCookie(env) } }, env);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("connecting after the sample was saved makes the clone right away", async () => {
    await saveSample();
    expect(voiceId()).toBeNull();
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    expect(voiceId()).toMatch(/^fake_voice_/);
  });

  it("used-up credits: the narration falls back to built-in with a plain toast; yellow light; the key stays connected", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-quota-abcdef" });
    await saveSample();
    expect(voiceId()).toMatch(/^fake_voice_/);
    const n = await narrate();
    expect(n.status).toBe(200);
    expect(n.json.engine).toBe("built-in");
    expect(n.json.jobId).toMatch(/^job_/);
    expect(n.json.notice).toBe("Your ElevenLabs credits are used up, so this voice over uses your built-in voice. It shows up below in a few minutes.");
    expect(narration(n.json.id as string)).toMatchObject({ engine: "built-in", status: "queued" });
    expect(light()).toMatchObject({ light: "yellow", note: expect.stringMatching(/credits used up/) });
    expect(conn()?.status).toBe("ok");
  });

  it("a refused key (401) marks the connection broken, turns the light red, and the narration still happens built-in", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    await saveSample();
    // the key is revoked in ElevenLabs after it was connected
    await saveConnection(env, "elevenlabs", "revoked-abcdef", "ok", { tier: "creator", characters_used: 0, characters_limit: 100_000, can_clone: true });
    const n = await narrate();
    expect(n.json.engine).toBe("built-in");
    expect(n.json.notice).toMatch(/refused your key/);
    expect(conn()).toMatchObject({ status: "error", last_error: "ElevenLabs says this key is not valid." });
    expect(light()).toMatchObject({ light: "red", fix_guide: "reconnect-elevenlabs" });
    const s = await call("GET", "/api/voice");
    expect(s.json.engine).toMatchObject({ active: "built-in", reason: "needs_reconnect" });
  });

  it("built_in_only: built-in even when premium is ready; switching back uses premium again", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    await saveSample();
    expect((await call("PATCH", "/api/voice/engine", { preference: "sometimes" })).status).toBe(422);
    const off = await call("PATCH", "/api/voice/engine", { preference: "built_in_only" });
    expect(off.json).toMatchObject({ ok: true, active: "built-in" });
    expect((await narrate()).json).toMatchObject({ engine: "built-in", notice: null });
    await call("PATCH", "/api/voice/engine", { preference: "premium_when_available" });
    expect((await narrate()).json.engine).toBe("elevenlabs");
  });

  it("disconnect deletes the clone from ElevenLabs; the next narration is built-in; the light is grey", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    await saveSample();
    expect(fakeElevenVoices()).toHaveLength(1);
    expect((await call("POST", "/api/connections/elevenlabs/disconnect")).status).toBe(200);
    expect(fakeElevenVoices()).toEqual([]);
    expect(voiceId()).toBeNull();
    expect(light()).toMatchObject({ light: "grey", fix_guide: "connect-elevenlabs" });
    expect((await narrate()).json).toMatchObject({ engine: "built-in", notice: null });
  });

  it("Delete my voice also deletes the premium clone; a new sample replaces the old clone", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    await saveSample();
    const first = voiceId();
    await saveSample();
    const second = voiceId();
    expect(second).not.toBe(first);
    expect(fakeElevenVoices()).toEqual([second]);
    expect((await call("DELETE", "/api/voice/sample")).status).toBe(200);
    expect(fakeElevenVoices()).toEqual([]);
    expect(voiceId()).toBeNull();
  });

  it("every narration row carries an engine", async () => {
    await call("POST", "/api/connections/elevenlabs/key", { key: "good-abcdef123" });
    await saveSample();
    await narrate();
    await call("PATCH", "/api/voice/engine", { preference: "built_in_only" });
    await narrate();
    const rows = db.raw.prepare("SELECT engine FROM narrations").all() as { engine: string }[];
    expect(rows.map((r) => r.engine).sort()).toEqual(["built-in", "elevenlabs"]);
  });
});

describe("daily lane: recheckElevenLabs", () => {
  it("grey when not connected, green on a healthy plan, yellow when credits are gone, red when the key is refused", async () => {
    await recheckElevenLabs(env);
    expect(light()?.light).toBe("grey");
    await saveConnection(env, "elevenlabs", "good-abcdef123", "ok", {});
    await recheckElevenLabs(env);
    expect(light()?.light).toBe("green");
    expect(JSON.parse(conn()!.meta)).toMatchObject({ tier: "creator", can_clone: true });
    await saveConnection(env, "elevenlabs", "good-quota-abcdef", "ok", {});
    await recheckElevenLabs(env);
    expect(light()).toMatchObject({ light: "yellow", note: expect.stringMatching(/credits used up/) });
    await saveConnection(env, "elevenlabs", "revoked-abcdef", "ok", {});
    await recheckElevenLabs(env);
    expect(light()).toMatchObject({ light: "red", fix_guide: "reconnect-elevenlabs" });
    expect(conn()?.status).toBe("error");
  });
});

describe("Home: the Your voice card", () => {
  const ready = { hasSample: true, engine: "built-in" as const, connection: null, problem: null };
  it("not set up, built-in ready (with or without the premium hint), premium on, problem", () => {
    expect(homeVoiceCard({ ...ready, hasSample: false })).toEqual({ state: "not_set_up", line: "Optional: record your voice so your clips can have voice overs in it", link: { to: "/voice", label: "Set up in 5 steps" } });
    expect(homeVoiceCard(ready)).toEqual({ state: "built_in_ready", line: "Built-in voice ready · Premium available with ElevenLabs", link: { to: "/voice", label: "Manage" } });
    expect(homeVoiceCard({ ...ready, connection: "ok" }).line).toBe("Built-in voice ready");
    expect(homeVoiceCard({ ...ready, engine: "elevenlabs", connection: "ok" })).toMatchObject({ state: "premium_on", line: "Premium voice on" });
    expect(homeVoiceCard({ ...ready, hasSample: false, problem: { note: "ElevenLabs refused the key · voice overs use the built-in voice", fix: "reconnect-elevenlabs" } })).toEqual({
      state: "problem",
      line: "ElevenLabs refused the key · voice overs use the built-in voice",
      link: { to: "/help/reconnect-elevenlabs", label: "How to fix" },
    });
  });
});

describe("nothing hidden, nothing switched off", () => {
  it("every feature defaults on, in the constant and in a fresh database", async () => {
    expect(Object.values(DEFAULT_FEATURES).every((v) => v === true)).toBe(true);
    const fresh = sqliteD1();
    expect(await getSetting(fresh.DB, "features", {})).toEqual({ voice: true, deeper_research: true, weekly_recap: true, help_ask: true });
  });

  it("Automatic voice overs off: her voice can still be saved; the voice overs she makes herself still work; the switch persists", async () => {
    // Owner, 26 Sep 2026: the switch is "Automatic voice overs". Off = only the voice overs she adds
    // herself, so narrations and drafts work either way (they used to refuse with a 409).
    expect((await call("PATCH", "/api/voice/clips", { on: "yes" })).status).toBe(422);
    expect((await call("PATCH", "/api/voice/clips", { on: false })).json).toEqual({ ok: true, enabled: false });
    expect((await getSetting<Record<string, boolean>>(env.DB, "features", {})).voice).toBe(false);
    expect((await saveSample()).status).toBe(200);
    const n = await narrate();
    expect(n.status).toBe(200);
    expect(n.json).toMatchObject({ engine: "built-in", jobId: expect.stringMatching(/^job_/) });
    expect(db.raw.prepare("SELECT auto, ai_generated FROM narrations WHERE id = ?").get(n.json.id as string)).toEqual({ auto: 0, ai_generated: 1 });
    // a draft is refused only for its own reason (no locked Brand Profile here), never for the switch
    expect((await call("POST", "/api/voice/draft", {})).json).toEqual({ error: "Lock your Brand Profile first, so the script sounds like you.", fix_guide: "upload-brand-docs" });
    expect((await call("GET", "/api/voice")).json).toMatchObject({ enabled: false, hasSample: true, auto: "off" });
    await call("PATCH", "/api/voice/clips", { on: true });
    const f = await getSetting<Record<string, boolean>>(env.DB, "features", {});
    expect(f).toEqual({ voice: true, deeper_research: false, weekly_recap: true, help_ask: false });
    expect((await call("GET", "/api/voice")).json).toMatchObject({ enabled: true, auto: "on" });
    expect((await narrate()).status).toBe(200);
  });
});

describe("a voice over attached to a clip is mixed in: Review plays it, Buffer posts it", () => {
  const TOKEN = "t".repeat(40);
  async function seedClip() {
    db.raw.prepare("INSERT INTO dumps (id, door, status) VALUES ('dmp_1', 'new', 'ready')").run();
    db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_1', 'dmp_1', 'a.mp4', 'video/mp4', 'raw/dmp_1/ast_1', 'uploaded')").run();
    db.raw.prepare(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, media_token, status) VALUES ('clp_1', 'ast_1', 'dmp_1', 0, 6, 'story', 'clips/dmp_1/clp_1.mp4', '${TOKEN}', 'approved')`).run();
    await r2.FILES.put("clips/dmp_1/clp_1.mp4", new TextEncoder().encode("ORIGINAL-CLIP"), { httpMetadata: { contentType: "video/mp4" } });
  }
  async function readyNarration(): Promise<string> {
    await saveSample();
    const n = await narrate();
    const id = n.json.id as string;
    await voiceJob.applyResult(env, n.json.jobId as string, id, await voiceJob.fakeRun!(env, n.json.jobId as string, id, {}));
    return id;
  }
  const served = async () => new TextDecoder().decode(await (await app.request(`${BASE_URL}/media/${TOKEN}`, {}, env)).arrayBuffer());
  const mix = (id: string) => db.raw.prepare("SELECT clip_id, mix_status, mixed_r2_key FROM narrations WHERE id = ?").get(id) as { clip_id: string | null; mix_status: string | null; mixed_r2_key: string | null };

  it("attach → mixing, the job builds a mix spec for exactly that clip, the result makes the clip's link serve the voiced file", async () => {
    await seedClip();
    const id = await readyNarration();
    const a = await call("PATCH", `/api/voice/narrations/${id}`, { clip_id: "clp_1" });
    expect(a.json).toMatchObject({ ok: true, mixing: true });
    expect(mix(id)).toEqual({ clip_id: "clp_1", mix_status: "mixing", mixed_r2_key: null });
    expect(await served()).toBe("ORIGINAL-CLIP"); // until the mix is ready, the original

    const spec = await voiceJob.buildSpec(env, a.json.jobId as string, id);
    expect(spec).toMatchObject({ mode: "mix", clip_key: "clips/dmp_1/clp_1.mp4", narration_key: `voice/narrations/${id}.wav`, output_key: mixedKey(id) });

    await voiceJob.applyResult(env, a.json.jobId as string, id, await voiceJob.fakeRun!(env, a.json.jobId as string, id, {}));
    expect(mix(id)).toEqual({ clip_id: "clp_1", mix_status: "ready", mixed_r2_key: mixedKey(id) });
    await r2.FILES.put(mixedKey(id), new TextEncoder().encode("VOICED-CLIP"), { httpMetadata: { contentType: "video/mp4" } });
    expect(await served()).toBe("VOICED-CLIP"); // Review's player and Buffer's fetch use this link

    const review = await call("GET", "/api/clips?tab=approved");
    const clip = (review.json.groups as { clips: { id: string; voice_over: string | null; media_url: string }[] }[])[0].clips[0];
    expect(clip).toMatchObject({ id: "clp_1", voice_over: "ready", media_url: `/media/${TOKEN}?v=${id}` });

    // detach: the original is back at once and the mixed file is gone
    await call("PATCH", `/api/voice/narrations/${id}`, { clip_id: null });
    expect(mix(id)).toEqual({ clip_id: null, mix_status: null, mixed_r2_key: null });
    expect(r2.objects.has(mixedKey(id))).toBe(false);
    expect(await served()).toBe("ORIGINAL-CLIP");
  });

  it("a failed mix leaves the voice over ready and the clip untouched, says so on Review, and a red light with a fix", async () => {
    await seedClip();
    const id = await readyNarration();
    const a = await call("PATCH", `/api/voice/narrations/${id}`, { clip_id: "clp_1" });
    await voiceJob.onFailure(env, a.json.jobId as string, id, "CalledProcessError at voice.py:120");
    expect(db.raw.prepare("SELECT status, mix_status FROM narrations WHERE id = ?").get(id)).toEqual({ status: "ready", mix_status: "failed" });
    expect(await served()).toBe("ORIGINAL-CLIP");
    const review = await call("GET", "/api/clips?tab=approved");
    expect((review.json.groups as { clips: { voice_over: string | null }[] }[])[0].clips[0].voice_over).toBe("failed");
    expect(db.raw.prepare("SELECT light, fix_guide FROM health WHERE name = 'Voice'").get()).toEqual({ light: "red", fix_guide: "record-your-voice" });
  });

  it("a detach while the mix runs wins: the late result is thrown away", async () => {
    await seedClip();
    const id = await readyNarration();
    const a = await call("PATCH", `/api/voice/narrations/${id}`, { clip_id: "clp_1" });
    const result = await voiceJob.fakeRun!(env, a.json.jobId as string, id, {});
    await call("PATCH", `/api/voice/narrations/${id}`, { clip_id: null });
    await voiceJob.applyResult(env, a.json.jobId as string, id, result);
    expect(mix(id).mix_status).toBeNull();
    expect(r2.objects.has(mixedKey(id))).toBe(false);
    expect(await served()).toBe("ORIGINAL-CLIP");
  });
});
