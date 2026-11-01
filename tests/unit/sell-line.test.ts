// Owner, 1 Nov 2026 (Porch & Party Studio, 28 clips in Review): the AI voice said "User Safety:
// safe." and the rest sold nothing ("i thought she was supposed to be selling pnp services!!!").
// Pins the guard where every voice-over script is built (worker/lib/autoVoice.ts draftScript) and
// swept (redoBadVoiceOvers): a model's verdict, a shot line, a stage direction or a stub is never
// spoken; a business studio's line names the service the clip shows and ends on its call to action.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { voiceScriptProblem, serviceForClip, lineKey, plainStarter } from "@shared/sellLine";

let reply = "User Safety: safe.";
vi.mock("@worker/services/openrouter", async (orig) => ({
  ...(await orig<object>()),
  getLlm: async () => ({ complete: async () => ({ ok: true, text: reply }) }),
}));
vi.mock("@worker/services/github", async (orig) => ({
  ...(await orig<object>()),
  dispatchJob: async () => ({ dispatched: true }),
}));

const { clipForScript, draftScript, redoBadVoiceOvers, voiceAllInDump } = await import("@worker/lib/autoVoice");

// Porch & Party Studio's real profile lines (services and what each looks like).
const LOOKS = [
  "Celebration room decor: a bedroom or room dressed for a birthday, anniversary or surprise, with balloon clouds and garlands, foil letters and numbers, banners, rose-petal paths, candle hearts and paper lanterns; before is the same room plain, bare or empty",
  "Holiday porches: a front porch and door dressed for the season with wreaths, garland, lanterns, pumpkins or trees; before is the plain, bare porch",
  "Grazing tables: a long table or board covered with fruit, cheese, crackers and sweets, styled from above",
  "Game rentals: lawn and party games such as giant Jenga, cornhole and connect four, set up for guests",
].join("\n");
const CTAS = ["Book your date", "Request a quote", "Get in touch with us"];
const SERVICES = ["Celebration room decor", "Holiday porches", "Grazing tables", "Game rentals"];

let db: ReturnType<typeof sqliteD1>;
let env: Env;

beforeEach(() => {
  db = sqliteD1();
  reply = "User Safety: safe.";
  env = {
    DB: db.DB, FILES: memoryR2().FILES, FAKE_SERVICES: "0", PUBLIC_BASE_URL: "http://localhost",
    SPONSOR_KIND: "event", APP_NAME: "Porch & Party Studio", OWNER_NAME: "",
    STUDIO_RULES: JSON.stringify({ cta_phrases: CTAS, cta_link: "https://example.com/request", ai_note: "all", place_words: ["Memphis", "Germantown"], prices: false }),
  } as unknown as Env;
  const profile = JSON.stringify({ voice: "Warm and upbeat", service_looks: LOOKS, ctas: "Message us." });
  db.raw.exec(`INSERT INTO brand_profile (sections, locked) VALUES ('${profile.replace(/'/g, "''")}', 1);
    INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_p', 'new', '', 'ready');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_p', 'dmp_p', 'a.jpg', 'image/jpeg', 'raw/dmp_p/ast', 'uploaded');
    INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, score, r2_key, status, speech, on_screen, service)
      VALUES ('clp_porch0000001', 'ast_p', 'dmp_p', 0, 5, 'montage', 'Pumpkin lights guide you inside', 'Fall porch', 70, 'clips/a.mp4', 'draft', 0, 'A front door decorated with pumpkins and wreaths', 'Celebration room decor'),
             ('clp_room00000001', 'ast_p', 'dmp_p', 0, 5, 'montage', 'Floral magic blooms in this space', 'Birthday room', 70, 'clips/b.mp4', 'draft', 0, 'A decorated room with a large number and balloons', 'Celebration room decor');`);
});

const endsOnCta = (s: string) => CTAS.some((c) => s.toLowerCase().endsWith(`${c.toLowerCase()}.`));

describe("a voice over is a line that sells, never a model's label", () => {
  it("the scripts spoken on 1 Nov 2026 are all refused; a selling line passes", () => {
    const sell = { service: "Celebration room decor", business: "Porch and Party", cta: "Request a quote" };
    for (const bad of ["User Safety: safe.", "safe", "0.0–3.9 s · a close look · Yellow balloons float by.", "0.0–1.2 s: A barista swirls milk, art.", "0.0–1.2: Milk swirls into art.", "A warm, upbeat friend speaking plainly, describing the scene.", "a short spoken voice-over, plain sentences.", "Request a quote.", ""]) {
      expect(voiceScriptProblem(bad, sell), bad).not.toBeNull();
      expect(voiceScriptProblem(bad, null), bad).not.toBeNull();
    }
    expect(voiceScriptProblem("Walk in to candlelit love. Request a quote.", sell)).toBe("no_service");
    expect(voiceScriptProblem("Balloons and candles. Celebration room decor in Memphis.", sell)).toBe("no_cta");
    expect(voiceScriptProblem("Balloons and candles. Celebration room decor in Memphis. Request a quote.", sell)).toBeNull();
    expect(voiceScriptProblem("Candles and roses. Celebration room decor in Memphis. Book now. Request a quote.", sell)).toBe("no_cta");
  });

  it("the service comes from the profile's own words for what the clip shows", () => {
    expect(serviceForClip(SERVICES, LOOKS, "A front door decorated with pumpkins and wreaths", "Celebration room decor")).toBe("Holiday porches");
    expect(serviceForClip(SERVICES, LOOKS, "A decorated room with a large number and balloons", "Celebration room decor")).toBe("Celebration room decor");
  });

  it("a model that answers with its safety verdict never reaches the voice: the line sells the service and ends on the CTA", async () => {
    const porch = await draftScript(env, (await clipForScript(env, "clp_porch0000001"))!);
    expect(porch.toLowerCase()).not.toContain("safe");
    expect(porch).toMatch(/Holiday porches/i);
    expect(endsOnCta(porch)).toBe(true);
    expect(porch.split(/\s+/).length).toBeLessThanOrEqual(9);
    reply = "Balloons and a big gold number fill the room. Check prices at example.com.";
    const room = await draftScript(env, (await clipForScript(env, "clp_room00000001"))!);
    expect(room).toMatch(/celebration room decor/i);
    expect(room.toLowerCase()).not.toContain("price");
    expect(endsOnCta(room)).toBe(true);
    // A model's own call to action is dropped: the studio's CTA is said once, at the end.
    reply = "Candles and roses on the floor. Book now.";
    const once = await draftScript(env, (await clipForScript(env, "clp_room00000001"))!);
    expect(once.toLowerCase()).not.toContain("book now");
    expect(endsOnCta(once)).toBe(true);
  });

  it("the hourly sweep redoes a waiting clip's below-par voice over, never her own words", async () => {
    db.raw.exec(`INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, mix_status) VALUES
      ('nar_bad', 'User Safety: safe.', 'clp_porch0000001', 'ready', 'built-in', 1, 1, 'ready'),
      ('nar_hers', 'User Safety: safe.', 'clp_room00000001', 'ready', 'built-in', 0, 1, 'ready');`);
    const r = await redoBadVoiceOvers(env);
    expect(r).toEqual({ checked: 1, bad: 1, redone: 1 });
    const rows = db.raw.prepare("SELECT clip_id, script, auto FROM narrations ORDER BY clip_id").all() as { clip_id: string; script: string; auto: number }[];
    const porch = rows.find((x) => x.clip_id === "clp_porch0000001")!;
    expect(porch.script).toMatch(/Holiday porches/i);
    expect(endsOnCta(porch.script)).toBe(true);
    expect(rows.find((x) => x.clip_id === "clp_room00000001")!.script).toBe("User Safety: safe.");
  });

  it("one line on several waiting clips is redone until each clip has its own", async () => {
    const same = "Celebration room decor in Memphis. Book your date.";
    // One CTA, so both lines pass every other check and only the repeat is below par.
    env = { ...env, STUDIO_RULES: JSON.stringify({ ...JSON.parse(env.STUDIO_RULES as string), cta_phrases: ["Book your date"] }) } as Env;
    db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, score, r2_key, status, speech, on_screen, service)
      VALUES ('clp_room00000002', 'ast_p', 'dmp_p', 0, 5, 'montage', 'Balloons for her birthday', 'Birthday', 70, 'clips/c.mp4', 'draft', 0, 'A room with balloons', 'Celebration room decor');
      INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, mix_status) VALUES
      ('nar_1', '${same}', 'clp_room00000001', 'ready', 'built-in', 1, 1, 'ready'),
      ('nar_2', '${same}', 'clp_room00000002', 'ready', 'built-in', 1, 1, 'ready');`);
    const r = await redoBadVoiceOvers(env);
    expect(r.bad).toBe(1);
    const scripts = (db.raw.prepare("SELECT script FROM narrations").all() as { script: string }[]).map((x) => x.script);
    expect(new Set(scripts).size).toBe(scripts.length);
    for (const s of scripts) expect(endsOnCta(s)).toBe(true);
  });

  // Made-up clips shaped like Porch & Party Studio's real ones (1 Nov 2026): one dump of porch doors,
  // bedroom setups and tables, every clip stored as "Celebration room decor".
  const PNP_CLIPS: [string, string][] = [
    ["A front door decorated with pumpkins and wreaths", "Holiday porches"],
    ["A decorated front door with garland and lights", "Holiday porches"],
    ["A front door decorated with Christmas-themed wreaths and garlands.", "Holiday porches"],
    ["Pumpkins lining the porch steps by the front door", "Holiday porches"],
    ["A bed with rose petals and candles in a heart shape.", "Celebration room decor"],
    ["A bedroom with a Happy Birthday sign and rose petals", "Celebration room decor"],
    ["A long board of fruit, cheese and crackers", "Grazing tables"],
    ["Giant Jenga and cornhole set up on the lawn", "Game rentals"],
  ];
  const addClips = (rows: [string, string][], secs = 5) =>
    rows.forEach(([what], i) =>
      db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, score, r2_key, status, speech, on_screen, service)
        VALUES ('clp_mix${String(i).padStart(9, "0")}', 'ast_p', 'dmp_p', 0, ${secs}, 'montage', 'A look', 'A look', 70, 'clips/m${i}.mp4', 'draft', 0, '${what.replace(/'/g, "''")}', 'Celebration room decor')`),
    );

  it("each clip sells the service it shows, whatever one label the shot sheet stored", () => {
    for (const [what, want] of PNP_CLIPS) expect(serviceForClip(SERVICES, LOOKS, what, "Celebration room decor"), what).toBe(want);
  });

  it("a short clip keeps the model's short selling line, not the plain starter", async () => {
    // A first sentence too long for 5 s used to drop the whole answer (the starter was spoken instead).
    reply = "Pumpkins and wreaths greet every single guest at your front door tonight. Pumpkin porches, done right.";
    const line = await draftScript(env, (await clipForScript(env, "clp_porch0000001"))!);
    expect(line, line).toMatch(/^Pumpkin porches, done right\. /);
    expect(endsOnCta(line)).toBe(true);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(9);
  });

  it("with no usable AI, short clips still each get their own line naming the service and a town", async () => {
    addClips([...PNP_CLIPS, ...PNP_CLIPS, ...PNP_CLIPS]); // 24 clips, 3 of each look, plus the two in beforeEach
    const r = await voiceAllInDump(env, "dmp_p");
    expect(r.clips).toBe(26);
    const rows = db.raw.prepare("SELECT n.script, c.on_screen FROM narrations n JOIN clips c ON c.id = n.clip_id").all() as { script: string; on_screen: string }[];
    expect(rows.length).toBe(26);
    expect(new Set(rows.map((x) => lineKey(x.script))).size).toBe(rows.length);
    for (const x of rows) {
      const want = PNP_CLIPS.find(([w]) => w === x.on_screen)?.[1];
      if (want) expect(x.script.toLowerCase(), x.on_screen).toContain(want.toLowerCase());
      expect(x.script, x.script).toMatch(/Memphis|Germantown/);
      expect(endsOnCta(x.script)).toBe(true);
      expect(voiceScriptProblem(x.script, null)).toBeNull();
    }
  });

  it("repeats across six clips are all redone in one run, each to its own line", async () => {
    addClips(PNP_CLIPS.slice(0, 6));
    const lines = ["Holiday porches by Porch and Party. Book your date.", "Celebration room decor in Memphis. Book your date.", "Holiday porches, done for you. Request a quote."];
    for (let i = 0; i < 6; i++)
      db.raw.exec(`INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, mix_status) VALUES ('nar_d${i}', '${lines[i % 3]}', 'clp_mix${String(i).padStart(9, "0")}', 'ready', 'built-in', 1, 1, 'ready')`);
    const r = await redoBadVoiceOvers(env);
    expect(r.bad).toBeGreaterThanOrEqual(3);
    expect(r.redone).toBe(r.bad);
    const scripts = (db.raw.prepare("SELECT script FROM narrations").all() as { script: string }[]).map((x) => x.script);
    expect(scripts.length).toBe(6);
    expect(new Set(scripts.map(lineKey)).size).toBe(6);
  });
});

describe("the old plain no-AI line is redone with a real selling line", () => {
  it("only a line of service, business and filler with no town counts as plain", () => {
    const sell = (service: string, cta: string) => ({ service, business: "Porch and Party", cta });
    const towns = ["Memphis", "Germantown"];
    for (const [line, svc, cta] of [
      ["Holiday porches, done for you. Book your date.", "Holiday porches", "Book your date"],
      ["Celebration room decor, made easy. Request a quote.", "Celebration room decor", "Request a quote"],
      ["Holiday porches by Porch and Party. Book your date.", "Holiday porches", "Book your date"],
    ])
      expect(plainStarter(line, sell(svc, cta), towns), line).toBe(true);
    for (const [line, svc, cta] of [
      ["Celebration room decor in Memphis. Book your date.", "Celebration room decor", "Book your date"],
      ["Pumpkins and wreaths on your porch. Book your date.", "Holiday porches", "Book your date"],
      ["Wreaths and greenery: holiday porches. Book your date.", "Holiday porches", "Book your date"],
    ])
      expect(plainStarter(line, sell(svc, cta), towns), line).toBe(false);
    expect(plainStarter("Holiday porches, done for you. Book your date.", sell("Holiday porches", "Book your date"), [])).toBe(false);
  });

  it("the hourly sweep swaps a waiting clip's plain line for the AI's short one", async () => {
    reply = "Wreaths and pumpkins: holiday porches, ready.";
    db.raw.exec(`INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, mix_status) VALUES
      ('nar_plain', 'Holiday porches, done for you. Request a quote.', 'clp_porch0000001', 'ready', 'built-in', 1, 1, 'ready')`);
    const r = await redoBadVoiceOvers(env);
    expect(r).toEqual({ checked: 1, bad: 1, redone: 1 });
    const script = (db.raw.prepare("SELECT script FROM narrations").get() as { script: string }).script;
    expect(script).toMatch(/^Wreaths and pumpkins: holiday porches, ready\. /);
    expect(endsOnCta(script)).toBe(true);
  });
});

describe("a sentence that stops mid-thought is never spoken (Mercedes, 1 Nov 2026)", () => {
  it("unfinished lines are refused; finished ones pass", () => {
    for (const bad of [
      "This is the one move I make each morning—it turns an ordinary pour into something that feels.",
      "There are moments — like watching steamed milk spiral into a rose — that feel like.",
      "The barista pours steamed milk slowly, shaping.",
      "Morning coffee with my favourite people and",
      "Morning coffee with my favourite people and the.",
    ])
      expect(voiceScriptProblem(bad, null), bad).toBe("unfinished");
    for (const good of ["The second the vinyl spins, the day feels right.", "And there it is—art in your cup, brewed with love.", "Come on in and watch this."])
      expect(voiceScriptProblem(good, null), good).toBeNull();
  });

  it("a creator studio's cut-off line is redone, finished and with no call to action she never chose", async () => {
    env = { ...env, SPONSOR_KIND: "creator", APP_NAME: "Mercedes Studio", STUDIO_RULES: JSON.stringify({ cta_phrases: [], ai_note: "all", place_words: [], prices: false }) } as unknown as Env;
    db.raw.exec("UPDATE brand_profile SET sections = '{\"voice\":\"Warm\"}'");
    reply = "Steamed milk swirls into a rose, slow and steady.";
    db.raw.exec(`INSERT INTO narrations (id, script, clip_id, status, engine, auto, ai_generated, mix_status) VALUES
      ('nar_cut', 'This is the one move I make each morning—it turns an ordinary pour into something that feels.', 'clp_room00000001', 'ready', 'built-in', 1, 1, 'ready')`);
    const r = await redoBadVoiceOvers(env);
    expect(r).toEqual({ checked: 1, bad: 1, redone: 1 });
    const script = (db.raw.prepare("SELECT script FROM narrations").get() as { script: string }).script;
    expect(voiceScriptProblem(script, null)).toBeNull();
    expect(script).not.toMatch(/book|request|get in touch|message us|follow/i);
  });
});

