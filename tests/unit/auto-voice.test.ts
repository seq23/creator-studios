// Automatic voice overs (owner, 26 Sep 2026): on + her voice saved → every clip of a dump with no
// talking (under 15% speech) gets a script, her voice, the mix, and the AI label when it posts; a
// clip where she talks never does. Off → only the voice overs she adds herself. On with no voice
// saved → a quiet "Record your voice first", never a failure or a red light. One voice job run per
// dump. Review: Remove, and Redo with Edit the script. Real schema (sqlite-d1), in-memory R2, fakes.
// Validator `auto-voice-silent-only` reads the two test names marked (validator) below.
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { SILENT_BELOW, voiceFor, autoVoiceState, fitScript, isSilentClip, maxWords, silentClips, starterScript, AUTO_VOICE_HINT } from "@worker/domain/autoVoice";
import { autoVoiceDump } from "@worker/lib/autoVoice";
import { cutJob, steerOutcome } from "@worker/jobs/cut";
import { parseNotes } from "@worker/domain/steer";
import { voiceJob } from "@worker/jobs/voice";
import { mixedKey } from "@worker/jobs/voice_batch";
import { dispatchJob } from "@worker/services/github";
import { fakePostMetadata, postMetadata, resetFakeBuffer } from "@worker/services/buffer";
import { bufferSync } from "@worker/crons/buffer-sync";
import { saveConnection } from "@worker/lib/connections";
import { setSetting } from "@worker/lib/db";
import { clips as clipsRoute } from "@worker/routes/clips";
import { voice as voiceRoute } from "@worker/routes/voice";
import { ownerCookie } from "./helpers/owner-session";

// ---------------------------------------------------------------- the rules

describe("which clips count as having no talking", () => {
  it("under 15% of the clip is her words", () => {
    expect(SILENT_BELOW).toBe(0.15);
    expect(isSilentClip(0)).toBe(true);
    expect(isSilentClip(0.04)).toBe(true);
    expect(isSilentClip(0.149)).toBe(true);
    expect(isSilentClip(0.15)).toBe(false);
    expect(isSilentClip(0.72)).toBe(false);
    expect(isSilentClip(1)).toBe(false);
  });
  it("an unmeasured clip counts as talking: isSilentClip(null) is false, and so is anything not a share", () => {
    expect(isSilentClip(null)).toBe(false);
    expect(isSilentClip(undefined)).toBe(false);
    expect(isSilentClip(Number.NaN)).toBe(false);
    expect(isSilentClip(-0.1)).toBe(false);
    expect(silentClips([{ speech: 0.02 }, { speech: null }, { speech: 0.5 }])).toEqual([{ speech: 0.02 }]);
  });
  it("the switch: on, on but no voice saved yet (quiet), off", () => {
    expect(autoVoiceState(true, true)).toBe("on");
    expect(autoVoiceState(true, false)).toBe("needs_voice");
    expect(autoVoiceState(false, true)).toBe("off");
    expect(autoVoiceState(false, false)).toBe("off");
    expect(AUTO_VOICE_HINT).toBe("On = clips with no talking get a voice over in your voice automatically; you can remove it in Review. Off = only the voice overs you add yourself.");
  });
  it("a script always fits its clip and is never empty", () => {
    const long = "This is a sentence about candles. ".repeat(40);
    for (const s of [3, 8, 14, 30, 60]) {
      expect(fitScript(long, s).split(" ").length).toBeLessThanOrEqual(maxWords(s));
      const st = starterScript({ hook_text: "", caption: "" }, null, s);
      expect(st.length).toBeGreaterThan(10);
      expect(st.split(" ").length).toBeLessThanOrEqual(maxWords(s));
    }
    expect(starterScript({ hook_text: "Three candles, five minutes…", caption: "Set the table fast #table" }, "Follow for more!", 14)).toBe("Three candles, five minutes. Set the table fast Follow for more.");
  });
});

describe("the Voice over chip and notes: not all or none", () => {
  it("her choice for the dump wins over the switch; untapped, the switch decides; no voice saved is quiet", () => {
    expect(voiceFor(undefined, true, true)).toBe("quiet");
    expect(voiceFor(undefined, false, true)).toBe("none");
    expect(voiceFor(undefined, true, false)).toBe("needs_voice");
    expect(voiceFor("quiet", false, true)).toBe("quiet");
    expect(voiceFor("none", true, true)).toBe("none");
    expect(voiceFor("pick", true, true)).toBe("pick");
    expect(voiceFor("quiet", true, false)).toBe("needs_voice");
    expect(voiceFor("pick", false, false)).toBe("pick");
  });
  it("notes read as a voice-over choice", () => {
    expect(parseNotes("no voice over", []).controls.voice).toBe("none");
    expect(parseNotes("voice over the b-roll", []).controls.voice).toBe("quiet");
    expect(parseNotes("I'll pick the voice overs", []).controls.voice).toBe("pick");
    expect(parseNotes("voice over the b-roll", []).said).toContain("Voice over: on quiet clips");
    expect(parseNotes("don't use voice over", []).controls.avoid).toBeUndefined();
    expect(parseNotes("voice only", []).controls.voice).toBeUndefined(); // that is about music
  });
});

describe("the AI label goes with every post that carries her cloned voice", () => {
  it("TikTok, Instagram and YouTube get isAiGenerated only when the clip has a voice over", () => {
    expect(postMetadata("tiktok", "t", true)).toEqual({ tiktok: { isAiGenerated: true } });
    expect(postMetadata("instagram", "t", true)).toEqual({ instagram: { type: "reel", shouldShareToFeed: true, isAiGenerated: true } });
    expect(postMetadata("youtube", "t", true)).toMatchObject({ youtube: { title: "t", isAiGenerated: true } });
    expect(postMetadata("tiktok", "t")).toBeUndefined();
    expect(postMetadata("instagram", "t")).toEqual({ instagram: { type: "reel", shouldShareToFeed: true } });
    expect((postMetadata("youtube", "t") as { youtube: Record<string, unknown> }).youtube).not.toHaveProperty("isAiGenerated");
  });
});

// ---------------------------------------------------------------- a dump, end to end on fakes

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/clips", clipsRoute);
app.route("/api/voice", voiceRoute);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as T[];
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${path}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

async function features(voice: boolean) {
  await setSetting(env.DB, "features", { voice, deeper_research: false, weekly_recap: true, help_ask: false });
}
async function voiceSaved() {
  await r2.FILES.put("voice/sample/upl_s", new Uint8Array(4000).fill(1), { httpMetadata: { contentType: "audio/wav" } });
  db.raw.exec("UPDATE voice SET sample_r2_key = 'voice/sample/upl_s', consent_at = '2026-09-26T00:00:00Z', enabled = 1 WHERE id = 1");
}
/** The fake cutter over a dump row that already exists (a test set its steer first); one video, optionally with its own note. */
async function cutDumpExisting(id: string, asset: { steer_notes?: string } = {}) {
  db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status, steer_notes) VALUES (?, ?, 'a.mp4', 'video/mp4', ?, 'uploaded', ?)").run(`ast_${id}`, id, `raw/${id}/ast`, asset.steer_notes ?? null);
  await r2.FILES.put(`raw/${id}/ast`, new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
  const job = await dispatchJob(env, "cut", id);
  await cutJob.applyResult(env, job.jobId, id, await cutJob.fakeRun!(env, job.jobId, id, { clips: 8 }));
}
/** A dump of 8 clips through the fake cutter: montage clips have no talking (speech 0.04), the rest talk (0.72). */
async function cutDump(id = "dmp_av1") {
  db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('${id}', 'new', '', 'cutting');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_${id}', '${id}', 'a.mp4', 'video/mp4', 'raw/${id}/ast', 'uploaded');`);
  await r2.FILES.put(`raw/${id}/ast`, new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
  const job = await dispatchJob(env, "cut", id);
  await cutJob.applyResult(env, job.jobId, id, await cutJob.fakeRun!(env, job.jobId, id, { clips: 8 }));
}
const clipRows = (dump = "dmp_av1") => all<{ id: string; speech: number | null; recipe: string }>("SELECT id, speech, recipe FROM clips WHERE dump_id = ? ORDER BY id", dump);
const voiceJobs = () => all<{ id: string; ref_id: string; status: string }>("SELECT id, ref_id, status FROM jobs WHERE type = 'voice' ORDER BY created_at");
async function runVoice(ref: string) {
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE type = 'voice' AND ref_id = ? ORDER BY created_at DESC LIMIT 1", ref);
  await voiceJob.applyResult(env, job.id, ref, await voiceJob.fakeRun!(env, job.id, ref, {}));
}

beforeEach(async () => {
  db = sqliteD1();
  r2 = memoryR2();
  resetFakeBuffer();
  env = {
    DB: db.DB,
    FILES: r2.FILES,
    OWNER_EMAIL: "owner@example.com",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
  } as unknown as Env;
});

describe("on, with her voice saved", () => {
  it("a clip where she talks is never voiced (validator); every clip with no talking is, in ONE voice job run", async () => {
    await features(true);
    await voiceSaved();
    await cutDump();
    const rows = clipRows();
    const silent = rows.filter((c) => isSilentClip(c.speech));
    const talking = rows.filter((c) => !isSilentClip(c.speech));
    expect(silent.length).toBeGreaterThan(0);
    expect(talking.length).toBeGreaterThan(0);
    const nars = all<{ clip_id: string; auto: number; ai_generated: number; batch: string; mix_status: string; engine: string }>("SELECT clip_id, auto, ai_generated, batch, mix_status, engine FROM narrations");
    expect(nars.map((n) => n.clip_id).sort()).toEqual(silent.map((c) => c.id).sort());
    for (const t of talking) expect(nars.some((n) => n.clip_id === t.id)).toBe(false);
    expect(nars.every((n) => n.auto === 1 && n.ai_generated === 1 && n.mix_status === "mixing" && n.engine === "built-in")).toBe(true);
    expect(new Set(nars.map((n) => n.batch)).size).toBe(1);
    const jobs = voiceJobs();
    expect(jobs).toHaveLength(1); // one run for the whole dump: the model loads once
    expect(jobs[0].ref_id).toBe(`auto/${nars[0].batch}`);

    // the batch spec speaks every one and mixes it into its own clip
    const spec = (await voiceJob.buildSpec(env, jobs[0].id, jobs[0].ref_id)) as { mode: string; items: { narration_id: string; speak: boolean; clip_key: string; output_key: string }[] };
    expect(spec.mode).toBe("batch");
    expect(spec.items).toHaveLength(silent.length);
    expect(spec.items.every((i) => i.speak && i.output_key === mixedKey(i.narration_id))).toBe(true);

    await runVoice(jobs[0].ref_id);
    const done = all<{ id: string; status: string; mix_status: string; mixed_r2_key: string }>("SELECT id, status, mix_status, mixed_r2_key FROM narrations");
    expect(done.every((n) => n.status === "ready" && n.mix_status === "ready" && n.mixed_r2_key === mixedKey(n.id))).toBe(true);
    for (const n of done) expect(await r2.FILES.head(n.mixed_r2_key)).toBeTruthy();
    expect(one<{ light: string }>("SELECT light FROM health WHERE name = 'Voice'").light).toBe("green");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'voice.batch.done'").n).toBe(1);

    // Review shows it, with the words to edit
    const list = await call("GET", "/api/clips?tab=new&hidden=1");
    const shown = (list.json.groups as { clips: { id: string; voice_over: string | null; voice_auto: boolean; voice_script: string | null }[] }[]).flatMap((g) => g.clips);
    for (const c of shown) {
      if (silent.some((s) => s.id === c.id)) expect(c).toMatchObject({ voice_over: "ready", voice_auto: true, voice_script: expect.any(String) });
      else expect(c.voice_over).toBeNull();
    }
  });

  it("an unmeasured clip (older, speech null) is treated as talking and left alone", async () => {
    await features(true);
    await voiceSaved();
    db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_old', 'new', '', 'ready');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_old', 'dmp_old', 'a.mp4', 'video/mp4', 'raw/dmp_old/ast', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, score, r2_key, status, speech) VALUES ('clp_old000000001', 'ast_old', 'dmp_old', 0, 12, 'montage', 'Old one', 0.7, 'clips/dmp_old/a.mp4', 'draft', NULL);`);
    expect(await autoVoiceDump(env, "dmp_old")).toEqual({ state: "voiced", clips: 0 });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
    expect(voiceJobs()).toHaveLength(0);
  });

  it("a clip that already has a voice over is not voiced again", async () => {
    await features(true);
    await voiceSaved();
    await cutDump();
    const before = one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n;
    expect(await autoVoiceDump(env, "dmp_av1")).toMatchObject({ clips: 0 });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(before);
  });

  it("a failed run is a yellow light and a Redo, never red; the clips keep their own sound", async () => {
    await features(true);
    await voiceSaved();
    await cutDump();
    const [job] = voiceJobs();
    await voiceJob.onFailure(env, job.id, job.ref_id, "runner died");
    expect(one<{ light: string; note: string }>("SELECT light, note FROM health WHERE name = 'Voice'")).toMatchObject({ light: "yellow", note: expect.stringMatching(/Redo/) });
    expect(all<{ mix_status: string }>("SELECT mix_status FROM narrations").every((n) => n.mix_status === "failed")).toBe(true);
  });
});

describe("the Voice over chip (per dump) and a video's own note (per video)", () => {
  it("None for this dump: the switch is on and her voice is saved, still no voice overs", async () => {
    await features(true);
    await voiceSaved();
    db.raw.exec("INSERT INTO dumps (id, door, notes, status, steer) VALUES ('dmp_av1', 'new', '', 'cutting', '{\"voice\":\"none\"}')");
    await cutDumpExisting("dmp_av1");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
    expect(voiceJobs()).toHaveLength(0);
  });
  it("Let me pick in Review: none now; Add voice over drafts a script and voices just that clip", async () => {
    await features(true);
    await voiceSaved();
    db.raw.exec("INSERT INTO dumps (id, door, notes, status, steer) VALUES ('dmp_av1', 'new', '', 'cutting', '{\"voice\":\"pick\"}')");
    await cutDumpExisting("dmp_av1");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
    const talking = clipRows().find((c) => !isSilentClip(c.speech))!;
    const d = await call("POST", `/api/clips/${talking.id}/voice-over/draft`);
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ has_voice: true, script: expect.any(String) });
    const r = await call("POST", `/api/clips/${talking.id}/voice-over`, { script: d.json.script });
    expect(r.status).toBe(200); // her own pick may go on a clip where she talks
    expect(one<{ auto: number; ai_generated: number }>("SELECT auto, ai_generated FROM narrations WHERE clip_id = ?", talking.id)).toEqual({ auto: 0, ai_generated: 1 });
    expect(voiceJobs()).toHaveLength(1);
  });
  it("the Voice over chip On quiet clips works with the switch off", async () => {
    await features(false);
    await voiceSaved();
    db.raw.exec("INSERT INTO dumps (id, door, notes, status, steer) VALUES ('dmp_av1', 'new', '', 'cutting', '{\"voice\":\"quiet\"}')");
    await cutDumpExisting("dmp_av1");
    const silent = clipRows().filter((c) => isSilentClip(c.speech));
    expect(all<{ clip_id: string }>("SELECT clip_id FROM narrations").map((n) => n.clip_id).sort()).toEqual(silent.map((c) => c.id).sort());
  });
  it("a video's own note wins for that video's clips", async () => {
    await features(true);
    await voiceSaved();
    db.raw.exec("INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_av1', 'new', '', 'cutting')");
    await cutDumpExisting("dmp_av1", { steer_notes: JSON.stringify(parseNotes("no voice over on this one", [])) });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
  });
  it("asked for (chip) with no voice saved: said on the dump, never dropped; nothing fails", async () => {
    await features(true);
    db.raw.exec("INSERT INTO dumps (id, door, notes, status, steer) VALUES ('dmp_av1', 'new', '', 'cutting', '{\"voice\":\"quiet\"}')");
    await cutDumpExisting("dmp_av1");
    const nf = JSON.parse(one<{ not_followed: string }>("SELECT not_followed FROM dumps WHERE id = 'dmp_av1'").not_followed) as { what: string; why: string }[];
    expect(nf).toContainEqual({ what: "voice overs on the quiet clips", why: expect.stringMatching(/your voice isn't saved yet/) });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'").n).toBe(0);
    // the default (untapped) with no voice is not a request: nothing is said
    db.raw.exec("UPDATE dumps SET steer = NULL WHERE id = 'dmp_av1'");
    expect((await steerOutcome(env, "dmp_av1", [], [])).not_followed).toEqual([]);
  });
});

describe("off, or no voice yet", () => {
  it("off: nothing automatic, and a voice over she makes herself still works", async () => {
    await features(false);
    await voiceSaved();
    await cutDump();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
    expect(voiceJobs()).toHaveLength(0);
    const state = await call("GET", "/api/voice");
    expect(state.json.auto).toBe("off");
    const n = await call("POST", "/api/voice/narrations", { script: "Hello friends, welcome back to the table today." });
    expect(n.status).toBe(200);
    expect(one<{ auto: number }>("SELECT auto FROM narrations WHERE id = ?", n.json.id as string).auto).toBe(0);
  });

  it("on with no voice saved: the switch says Record your voice first; no failure, no light", async () => {
    await features(true);
    await cutDump();
    expect(await autoVoiceDump(env, "dmp_av1")).toEqual({ state: "needs_voice", clips: 0 });
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations").n).toBe(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM health WHERE name = 'Voice'").n).toBe(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'").n).toBe(0);
    expect((await call("GET", "/api/voice")).json.auto).toBe("needs_voice");
  });
});

describe("Review: Remove and Redo (Edit the script)", () => {
  async function voiced() {
    await features(true);
    await voiceSaved();
    await cutDump();
    await runVoice(voiceJobs()[0].ref_id);
    return one<{ id: string; clip_id: string; mixed_r2_key: string; r2_key: string }>("SELECT id, clip_id, mixed_r2_key, r2_key FROM narrations ORDER BY clip_id LIMIT 1");
  }

  it("Remove: the clip goes back to its own sound and the files are deleted", async () => {
    const n = await voiced();
    const r = await call("POST", `/api/clips/${n.clip_id}/voice-over/remove`);
    expect(r.status).toBe(200);
    expect((r.json.clip as { voice_over: string | null }).voice_over).toBeNull();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM narrations WHERE clip_id = ?", n.clip_id).n).toBe(0);
    expect(await r2.FILES.head(n.mixed_r2_key)).toBeNull();
    expect(await r2.FILES.head(n.r2_key)).toBeNull();
    expect((await call("POST", `/api/clips/${n.clip_id}/voice-over/remove`)).status).toBe(404);
  });

  it("Redo: her words as written, voiced and mixed again; too long is refused in plain words", async () => {
    const n = await voiced();
    const clip = one<{ start_s: number; end_s: number }>("SELECT start_s, end_s FROM clips WHERE id = ?", n.clip_id);
    const tooLong = "word ".repeat(maxWords(clip.end_s - clip.start_s) + 5).trim();
    const refused = await call("POST", `/api/clips/${n.clip_id}/voice-over`, { script: tooLong });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toBe(`That's ${maxWords(clip.end_s - clip.start_s) + 5} words; this ${Math.round(clip.end_s - clip.start_s)}-second clip has room for about ${maxWords(clip.end_s - clip.start_s)}. Shorten it a little.`);
    expect((await call("POST", `/api/clips/${n.clip_id}/voice-over`, { script: "hi" })).status).toBe(422);

    const script = "Three candles and a runner. That is the whole trick.";
    const r = await call("POST", `/api/clips/${n.clip_id}/voice-over`, { script });
    expect(r.status).toBe(200);
    expect((r.json.clip as { voice_over: string; voice_script: string }).voice_over).toBe("mixing");
    const now = all<{ id: string; script: string; auto: number; batch: string }>("SELECT id, script, auto, batch FROM narrations WHERE clip_id = ?", n.clip_id);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ script, auto: 1 });
    expect(now[0].id).not.toBe(n.id);
    expect(await r2.FILES.head(n.mixed_r2_key)).toBeNull();
    await runVoice(`auto/${now[0].batch}`);
    expect(one<{ mix_status: string }>("SELECT mix_status FROM narrations WHERE id = ?", now[0].id).mix_status).toBe("ready");
  });

  it("Redo with no voice saved says Record your voice first", async () => {
    const n = await voiced();
    db.raw.exec("UPDATE voice SET sample_r2_key = NULL, consent_at = NULL WHERE id = 1");
    const r = await call("POST", `/api/clips/${n.clip_id}/voice-over`, { script: "A short new line for this clip." });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Record your voice first, on Voice overs.");
  });
});

describe("posting: a voiced clip carries the AI label to Buffer", () => {
  it("isAiGenerated on the voiced clip's posts only", async () => {
    await features(true);
    await voiceSaved();
    await cutDump();
    await runVoice(voiceJobs()[0].ref_id);
    const rows = clipRows();
    const voiced = rows.find((c) => isSilentClip(c.speech))!;
    const talking = rows.find((c) => !isSilentClip(c.speech))!;
    const soon = new Date(Date.now() + 3600_000).toISOString();
    db.raw.exec(`UPDATE clips SET status = 'approved' WHERE id IN ('${voiced.id}', '${talking.id}');
      INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES ('pst_v_tt', '${voiced.id}', 'tiktok', '${soon}'), ('pst_v_yt', '${voiced.id}', 'youtube', '${soon}'), ('pst_t_tt', '${talking.id}', 'tiktok', '${soon}');`);
    await saveConnection(env, "buffer", "good-key-000000", "ok", {});
    await bufferSync(env, { force: true });
    const ids = all<{ id: string; buffer_post_id: string | null }>("SELECT id, buffer_post_id FROM posts ORDER BY id");
    expect(ids.every((p) => !!p.buffer_post_id)).toBe(true);
    const meta = Object.fromEntries(ids.map((p) => [p.id, fakePostMetadata(p.buffer_post_id!)]));
    expect(meta.pst_v_tt).toEqual({ tiktok: { isAiGenerated: true } });
    expect(meta.pst_v_yt).toMatchObject({ youtube: { isAiGenerated: true } });
    expect(meta.pst_t_tt).toBeUndefined();
  });
});
