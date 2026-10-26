// Follow-on V (owner, 23 Oct 2026). Pins: with no recording the stock voice af_heart speaks and the
// Sound screen says so, switching to her own voice by itself once a consented recording exists; the
// script follows the clip's shots in order and never reads the caption back; her notes for the voice
// reach the script writer. The on-screen words' timing and placement are pinned in
// jobs/tests/test_vo_words.py; the wiring in the `vo-words-wired` validator.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { DEFAULT_STOCK_VOICE, SOUND_DEFAULT, STOCK_VOICES, soundSettings, voiceInUse, voiceInUseLine, voiceReadyFor, type SoundSettings } from "@shared/sound";
import { autoVoiceState, voiceFor } from "@worker/domain/autoVoice";
import { NO_RECORDING_HINT } from "@shared/autoVoice";
import { cleanShotList, cleanVoiceNotes, shotLines, shotScript, shotsOf } from "@shared/voiceShots";

const prompts: { system: string; user: string }[] = [];
let reply = "Fabric goes down first. Then every pin, one by one. And the dress is done.";
vi.mock("@worker/services/openrouter", async (orig) => ({
  ...(await orig<object>()),
  getLlm: async () => ({
    complete: async (p: { system: string; user: string }) => {
      prompts.push({ system: p.system, user: p.user });
      return { ok: true, text: reply };
    },
  }),
}));

const { clipForScript, draftScript, stockVoice, voiceReady } = await import("@worker/lib/autoVoice");

const ROOT = path.resolve(__dirname, "..", "..");
let db: ReturnType<typeof sqliteD1>;
let env: Env;

const SHOTS = [
  { t0: 0, t1: 2.4, stage: "prep", what: "fabric laid out on the table" },
  { t0: 2.4, t1: 6.0, stage: "process", what: "pins going into the hem" },
  { t0: 6.0, t1: 9.5, stage: "hero", what: "the finished dress on the form" },
];

beforeEach(() => {
  db = sqliteD1();
  prompts.length = 0;
  reply = "Fabric goes down first. Then every pin, one by one. And the dress is done.";
  env = { DB: db.DB, FILES: memoryR2().FILES, FAKE_SERVICES: "0", PUBLIC_BASE_URL: "http://localhost" } as unknown as Env;
  db.raw.exec(`INSERT INTO dumps (id, door, notes, status, voice_notes) VALUES ('dmp_v', 'new', '', 'ready', 'Baby shower in Germantown');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_v', 'dmp_v', 'a.mp4', 'video/mp4', 'raw/dmp_v/ast', 'uploaded');
    INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, score, r2_key, status, speech, shot_list)
      VALUES ('clp_v00000000001', 'ast_v', 'dmp_v', 0, 9.5, 'montage', 'One dress, one afternoon', 'Sewing the hem for a client this week', 70, 'clips/dmp_v/a.mp4', 'draft', 0, '${JSON.stringify(SHOTS)}');`);
});

describe("no recording yet: the stock voice af_heart, then hers by itself", () => {
  it("the plain default is her own voice, spoken by af_heart until she records it", () => {
    expect(DEFAULT_STOCK_VOICE).toBe("af_heart");
    expect(SOUND_DEFAULT).toEqual({ camera: "keep", voice_source: "mine", stock_voice: "af_heart" });
    expect(voiceInUse(SOUND_DEFAULT, false)).toEqual({ speaks: "stock", stock_voice: "af_heart", why: "no_recording_yet" });
    expect(voiceInUse(SOUND_DEFAULT, true)).toEqual({ speaks: "mine", stock_voice: null, why: "recorded" });
    expect(voiceInUse({ ...SOUND_DEFAULT, voice_source: "stock", stock_voice: "af_bella" }, true)).toEqual({ speaks: "stock", stock_voice: "af_bella", why: "picked_stock" });
  });

  it("the Sound screen says which voice and why, in plain words", () => {
    expect(voiceInUseLine(voiceInUse(SOUND_DEFAULT, false))).toBe("Voice overs use a studio voice (Voice 1) because you have not recorded your voice yet. Once you record it, your own voice takes over by itself.");
    expect(voiceInUseLine(voiceInUse(SOUND_DEFAULT, true))).toBe("Voice overs use your own recorded voice.");
    expect(voiceInUseLine(voiceInUse({ ...SOUND_DEFAULT, voice_source: "stock", stock_voice: "af_bella" }, false))).toBe("Voice overs use the studio voice you picked (Voice 2).");
    const card = readFileSync(path.join(ROOT, "app", "components", "SoundSettings.tsx"), "utf8");
    expect(card).toContain("data-voice-in-use={inUse.why}");
  });

  it("Porch & Party keeps af_heart as its picked stock voice", () => {
    const reg = JSON.parse(readFileSync(path.join(ROOT, "studios", "sample1.json"), "utf8")) as { sound: unknown };
    const s = soundSettings(JSON.stringify(reg.sound), null);
    expect(voiceInUse(s, false)).toEqual({ speaks: "stock", stock_voice: "af_heart", why: "picked_stock" });
    expect(voiceInUse(s, true).stock_voice).toBe("af_heart");
  });

  it("voice overs never wait on a recording: every sound setting, recorded or not, is ready and the switch reads on", () => {
    // The e2e auto-voice spec went red for 4 nights (24-26 Oct 2026) still asserting the old quiet
    // "needs_voice"; this pins the new truth in the check gate, for every sound setting there is.
    let examined = 0;
    for (const voice_source of ["mine", "stock"] as const)
      for (const { id } of STOCK_VOICES)
        for (const hasSample of [false, true]) {
          const sound: SoundSettings = { ...SOUND_DEFAULT, voice_source, stock_voice: id };
          const ready = voiceReadyFor(voiceInUse(sound, hasSample));
          expect(ready, `${voice_source}/${id}/${hasSample}`).toBe(true);
          expect(autoVoiceState(true, ready)).toBe("on");
          expect(voiceFor(undefined, true, ready)).toBe("quiet");
          examined++;
        }
    expect(examined).toBeGreaterThanOrEqual(4); // hard-fail on an empty voice list
    expect(NO_RECORDING_HINT).not.toMatch(/nothing is made|no voice overs are made/i);
    for (const page of ["app/pages/Settings.tsx", "app/pages/Voice.tsx"]) {
      const src = readFileSync(path.join(ROOT, page), "utf8");
      expect(src, page).toContain("NO_RECORDING_HINT");
      expect(src, page).not.toContain('data-auto-voice="needs_voice"');
    }
  });

  it("the Worker: ready with no recording (af_heart), her voice once a consented sample exists", async () => {
    expect(await voiceReady(env)).toBe(true);
    expect(await stockVoice(env)).toBe("af_heart");
    db.raw.exec("UPDATE voice SET sample_r2_key = 'voice/sample/s', consent_at = NULL WHERE id = 1");
    expect(await stockVoice(env)).toBe("af_heart"); // a recording without consent is not hers to use
    db.raw.exec("UPDATE voice SET consent_at = '2026-10-23T00:00:00Z' WHERE id = 1");
    expect(await stockVoice(env)).toBeNull();
    expect(await voiceReady(env)).toBe(true);
  });
});

describe("the script follows the shots", () => {
  it("a stored shot list is kept in order, cleaned; older clips pair parts with what is on screen", () => {
    expect(cleanShotList(JSON.stringify(SHOTS))).toEqual(SHOTS);
    expect(cleanShotList([{ t0: 2, t1: 1, stage: "x", what: "backwards" }, { t0: "a" }])).toBeNull();
    expect(shotsOf({ parts: "[[10,12],[20,23.5]]", on_screen: "a bare porch · the porch dressed", start_s: 0, end_s: 5.5 })).toEqual([
      { t0: 0, t1: 2, stage: "", what: "a bare porch" },
      { t0: 2, t1: 5.5, stage: "", what: "the porch dressed" },
    ]);
    expect(shotsOf({ on_screen: "a porch", start_s: 3, end_s: 9 })).toEqual([{ t0: 0, t1: 6, stage: "", what: "a porch" }]);
  });

  it("the writer gets timed lines in stage order; the starter walks the shots and never says the caption", () => {
    expect(shotLines(SHOTS)).toBe("0.0–2.4 s · getting ready · fabric laid out on the table\n2.4–6.0 s · the work · pins going into the hem\n6.0–9.5 s · the finished result · the finished dress on the form");
    const s = shotScript(SHOTS, "One dress, one afternoon…", "Book a fitting");
    expect(s).toBe("One dress, one afternoon. First, fabric laid out on the table. Then pins going into the hem. And here it is: the finished dress on the form. Book a fitting.");
  });

  it("draftScript sends the shots and her notes for the voice to the writer, never the caption as a line to say", async () => {
    const clip = await clipForScript(env, "clp_v00000000001");
    expect(clip?.voice_notes).toBe("Baby shower in Germantown");
    const script = await draftScript(env, clip!);
    expect(script).toBe("Fabric goes down first. Then every pin, one by one. And the dress is done.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].user).toContain("Shots, in order:\n0.0–2.4 s · getting ready · fabric laid out on the table");
    expect(prompts[0].user).toContain("Notes for the voice from her (use them; they never override what the shots show): Baby shower in Germantown");
    expect(prompts[0].user).toContain("Caption (do not repeat it):");
    expect(prompts[0].system).toContain("following the shots in order and in time");
  });

  it("her notes win over the engine's own script; without notes the engine's script is spoken", async () => {
    db.raw.exec("UPDATE clips SET voice_script = 'The hem takes the longest part of the day. Worth it every time.' WHERE id = 'clp_v00000000001'");
    expect(await draftScript(env, (await clipForScript(env, "clp_v00000000001"))!)).toBe(reply);
    expect(prompts).toHaveLength(1);
    db.raw.exec("UPDATE dumps SET voice_notes = NULL WHERE id = 'dmp_v'");
    expect(await draftScript(env, (await clipForScript(env, "clp_v00000000001"))!)).toBe("The hem takes the longest part of the day. Worth it every time.");
    expect(prompts).toHaveLength(1);
  });

  it("a writer that reads the caption back has that sentence dropped; the AI busy falls back to the shots", async () => {
    reply = "Sewing the hem for a client this week. Pins go in one by one.";
    const s = await draftScript(env, (await clipForScript(env, "clp_v00000000001"))!);
    expect(s.toLowerCase()).not.toContain("sewing the hem for a client this week");
    expect(s).toContain("Pins go in one by one.");
    reply = "";
    const starter = await draftScript(env, (await clipForScript(env, "clp_v00000000001"))!);
    expect(starter).toContain("First, fabric laid out on the table.");
    expect(starter.toLowerCase()).not.toContain("sewing the hem");
  });

  it("notes for the voice are one plain line, at most 400 characters", () => {
    expect(cleanVoiceNotes("  Baby shower\nin   Germantown ")).toBe("Baby shower in Germantown");
    expect(cleanVoiceNotes("x".repeat(900))).toHaveLength(400);
    expect(cleanVoiceNotes(42)).toBe("");
  });
});
