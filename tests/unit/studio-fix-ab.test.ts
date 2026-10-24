// Studio fix A+B combined (23 Oct 2026): the clip engine (jobs/**, Builder A) and the Worker
// (worker/**, Builder B) were built apart against one contract. These are the cross-side pins: a
// real engine result flows through the Worker; scores are 0..100 integers end to end; a clip with
// no words yet is stored, never approved or posted, and gets its words from the words pass; the
// caption goes out exactly as the engine wrote it with only the link swapped; the engine's voice
// script is spoken first and cleaned by the engine's own rules; a grid made of the clip's own shots
// re-renders with its hero ending, the caption's call to action and the studio's logo; stored
// scores move to 0..100 once, and the jobs rebuild keeps every row.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import fixtureJson from "./fixtures/cut-result.sample.json";
import { harness } from "./helpers/studio-fix-env";
import { cutJob, type CutResultClip, type RerenderSpec } from "@worker/jobs/cut";
import { POSTABLE_CLIP_SQL } from "@worker/domain/sourceCheck";
import { finishWords, parseDraft, practiceDraft, wordsPass, WORDS_PER_RUN, WORDS_RED_AFTER } from "@worker/lib/wordsPass";
import { draftScript } from "@worker/lib/autoVoice";
import { clipPostText } from "@worker/lib/postText";
import { postText } from "@shared/postText";
import { fitScript } from "@worker/domain/autoVoice";
import { cleanScript, clipTypeLabel, composeCaption, ctaLine, ctaPhrase, ctaTurnFor, isReasoning } from "@shared/clipWords";
import { setSetting } from "@worker/lib/db";
import { cleanGridLayout } from "@worker/domain/looks";

const fixture = fixtureJson as unknown as { dump_id: string; assets: { id: string }[]; result: { clips: CutResultClip[] } & Record<string, unknown> };
const FAILURE = "1. **Analyze the Request:** * **Format:** a 20 second voice over * **Tone:** warm";
const RULES = { cta_phrases: ["Book your date", "Request a quote", "Get in touch with us"], cta_link: "https://example.com/request", ai_note: "all" as const, place_words: ["Riverside"] };

async function studio() {
  const h = await harness();
  await setSetting(h.env.DB, "studio_rules", { ...RULES, bar: 70, clip_target: { min: 8, max: 15 }, prices: false, logo_r2_key: "brand/logo/logo_0001" });
  return h;
}

describe("a real engine result through the Worker", () => {
  it("every clip is stored with an integer 0..100 score, its reasons and type; under the studio's bar it is hidden with its reason", async () => {
    const h = await studio();
    const dumpId = fixture.dump_id;
    await h.dumpWith(dumpId, fixture.assets.map((a) => ({ id: a.id, name: "wide.mp4", mime: "video/mp4" })));
    for (const c of fixture.result.clips) await h.r2.FILES.put(c.r2_key, new Uint8Array(10));
    await h.cut(dumpId, fixture.result);
    const rows = h.all<{ id: string; score: number; hidden: number; hidden_reason: string | null; clip_type: string; score_reasons: string }>("SELECT id, score, hidden, hidden_reason, clip_type, score_reasons FROM clips WHERE dump_id = ? ORDER BY id", dumpId);
    expect(rows).toHaveLength(fixture.result.clips.length);
    for (const r of rows) {
      const src = fixture.result.clips.find((c) => c.id === r.id)!;
      expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, `${r.id}: ${r.score}`).toBe(true);
      expect(r.score).toBe(src.score);
      expect(r.clip_type).toBe(src.clip_type);
      expect(JSON.parse(r.score_reasons).length).toBeGreaterThan(0);
      expect(!!r.hidden).toBe(r.score < 70);
      if (r.score < 70) expect(r.hidden_reason).toMatch(new RegExp(`^it scored ${r.score}, under this studio's bar of 70: `));
    }
    // Review shows the same number, 0..100, and the type's label from the library.
    const list = await h.call("GET", "/api/clips?tab=new&hidden=1");
    const cards = list.json.groups.flatMap((g: { clips: { id: string; score_100: number; clip_type_label: string }[] }) => g.clips);
    for (const c of cards) {
      expect(c.score_100).toBe(rows.find((r) => r.id === c.id)!.score);
      expect(c.clip_type_label).toBe(clipTypeLabel(fixture.result.clips[0].clip_type));
    }
  });
});

describe("words pending: stored, never approved, never posted, written by the words pass", () => {
  const pending = (id: string): Partial<CutResultClip> & Record<string, unknown> => ({
    ...fixture.result.clips[0],
    id,
    asset_id: "ast_s",
    r2_key: `clips/dmp_s/${id}.mp4`,
    cover_r2_key: null,
    hook_text: "",
    hook_alt: null,
    caption: "",
    hashtags: [],
    score: 80,
    voice_script: null,
    words_pending: true,
    files_used: ["ast_s"],
    hero_asset_id: "ast_s",
    part_assets: null,
  });

  it("a clip with no words yet cannot be approved or posted; the words pass gives it the exact caption layout and it can", async () => {
    const h = await studio();
    await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
    await h.r2.FILES.put("clips/dmp_s/clp_wwwwwwww01.mp4", new Uint8Array(10));
    await h.cut("dmp_s", { clips: [pending("clp_wwwwwwww01")] });
    const row = () => h.one<{ words_pending: number; hook_text: string; caption: string; voice_script: string | null; status: string }>("SELECT words_pending, hook_text, caption, voice_script, status FROM clips WHERE id = 'clp_wwwwwwww01'");
    expect(row()).toMatchObject({ words_pending: 1, hook_text: "", caption: "" });
    expect((await h.call("POST", "/api/clips/clp_wwwwwwww01/approve")).status).toBe(409);
    // Even approved some other way (an older row), it never reaches the calendar or Buffer.
    h.db.raw.exec("UPDATE clips SET status = 'approved' WHERE id = 'clp_wwwwwwww01'");
    expect(h.all(`SELECT c.id FROM clips c WHERE ${POSTABLE_CLIP_SQL}`)).toHaveLength(0);
    const r = await wordsPass(h.env);
    expect(r).toMatchObject({ written: 1, waiting: 0, stuck: 0 });
    const done = row();
    expect(done.words_pending).toBe(0);
    expect(done.hook_text.length).toBeGreaterThan(0);
    // number 1 -> turn 0: "Book your date: <link>"; ai_note "all" -> the divider and the note.
    expect(done.caption).toMatch(/^[^\n]+\n\nBook your date: https:\/\/example\.com\/request\n\n#\S+[^\n]*\n\n—\nMade with AI$/);
    expect(isReasoning(done.caption)).toBe(false);
    expect(h.all(`SELECT c.id FROM clips c WHERE ${POSTABLE_CLIP_SQL}`)).toHaveLength(1);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = 'Clip words'").light).toBe("green");
  });

  it("never ships reasoning-shaped, empty or rule-breaking words; a day of failed tries turns the light red", async () => {
    const rules = RULES;
    const clip = { number: 2, uses_ai_images: false };
    const none = () => [] as string[];
    expect(finishWords({ hook: FAILURE, caption: "A real caption." }, rules, clip, none)).toBeNull();
    expect(finishWords({ hook: "Fresh porch", caption: FAILURE }, rules, clip, none)).toBeNull();
    expect(finishWords({ hook: "", caption: "Body." }, rules, clip, none)).toBeNull();
    expect(finishWords({ hook: "Fresh porch", caption: "Body." }, rules, clip, () => ["a price"])).toBeNull();
    expect(finishWords(parseDraft("no json here"), rules, clip, none)).toBeNull();
    const ok = finishWords({ hook: "Fresh porch", caption: "Set up by lunch. Book your date now!", hashtags: ["#porch"], voice: `Set up by lunch. ${FAILURE}` }, rules, clip, none)!;
    // Its own call to action is dropped from the body (the CTA line carries it once); clip 2 = turn 1; a "send this" line on turn 1.
    expect(ok.caption).toBe(composeCaption("Set up by lunch. Send this to someone who needs to see it.", ctaLine(rules, 1), ["#porch"], true));
    expect(ok.voice_script).toBeNull();

    const h = await harness({ FAKE_SERVICES: "0" } as never);
    await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
    h.db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status, words_pending, words_tries)
      VALUES ('clp_wwwwwwww02', 'ast_s', 'dmp_s', 0, 20, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_s/clp_wwwwwwww02.mp4', 'draft', 1, ${WORDS_RED_AFTER - 1})`);
    // No OpenRouter key and no Workers AI binding: nothing answers, the clip keeps waiting, the light says so.
    const r = await wordsPass(h.env);
    expect(r).toMatchObject({ written: 0, waiting: 1, stuck: 1 });
    expect(h.one<{ words_pending: number; caption: string }>("SELECT words_pending, caption FROM clips WHERE id = 'clp_wwwwwwww02'")).toEqual({ words_pending: 1, caption: "" });
    expect(h.one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'Clip words'")).toEqual({ light: "red", fix_guide: "review-and-approve-clips" });
    // Tried this hour: the next run within 50 minutes leaves it alone.
    expect((await wordsPass(h.env)).written).toBe(0);
    expect(h.one<{ words_tries: number }>("SELECT words_tries FROM clips WHERE id = 'clp_wwwwwwww02'").words_tries).toBe(WORDS_RED_AFTER);
  });

  it("a rejected clip never spends the free AI's tries; restored, it gets its words", async () => {
    const h = await studio();
    await h.dumpWith("dmp_r", [{ id: "ast_r", name: "a.mp4", mime: "video/mp4" }]);
    const ids = Array.from({ length: WORDS_PER_RUN + 1 }, (_, i) => `clp_rrrrrrrr${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) =>
      h.db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status, words_pending, created_at)
        VALUES ('${id}', 'ast_r', 'dmp_r', 0, 10, 'montage', '', '', '', '["tiktok"]', 80, 'clips/dmp_r/${id}.mp4', '${i < WORDS_PER_RUN ? "rejected" : "draft"}', 1, '2026-10-23T22:00:0${i % 10}.000Z')`),
    );
    // The oldest are rejected: the one New clip still gets its words in the first run.
    expect(await wordsPass(h.env)).toMatchObject({ written: 1, waiting: 0 });
    expect(h.one<{ words_pending: number }>(`SELECT words_pending FROM clips WHERE id = '${ids[WORDS_PER_RUN]}'`).words_pending).toBe(0);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE status = 'rejected' AND words_tries > 0").n).toBe(0);
    h.db.raw.exec(`UPDATE clips SET status = 'draft' WHERE id = '${ids[0]}'`);
    expect((await wordsPass(h.env)).written).toBe(1);
  });

  it("practice words name the kind of clip, never a stock line", () => {
    expect(practiceDraft({ number: 3, clip_type: "photo_slideshow" }).hook).toMatch(/^Photo slideshow/);
  });
});

describe("the caption goes out exactly as the engine wrote it", () => {
  it("only the link is swapped for its tracking version; hashtags are never added at post time", async () => {
    const caption = composeCaption("Porch set for fall in Riverside.", ctaLine(RULES, 0), ["#porch", "#fall"], false);
    expect(caption).toContain(RULES.cta_link);
    const out = postText({ caption, hashtags: "#extra #more", aiMade: false, link: RULES.cta_link, source: "instagram", campaign: "sample9", tag: "clip-1022-1", final: true });
    expect(out).toBe(caption.replace(RULES.cta_link, "https://example.com/request?utm_source=instagram&utm_medium=social&utm_campaign=sample9&utm_content=clip-1022-1"));
    expect(out).not.toContain("#extra");
    // Through the Worker: a clip with a clip type is final even when its caption has no hashtags block.
    const h = await studio();
    const bare = composeCaption("Porch set for fall.", ctaLine(RULES, 0), [], false);
    const r = await clipPostText(h.env, { caption: bare, hashtags: "#late", ai_voice: 0, clip_type: "payoff_first", number: 1, version: 1, dump_created_at: "2026-10-22T15:00:00.000Z" }, "tiktok");
    expect(r.text).not.toContain("#late");
    expect(r.text).toContain("utm_source=tiktok");
    // A voice over is AI-made: the note is added once, after the divider.
    const v = await clipPostText(h.env, { caption: bare, hashtags: "", ai_voice: 1, clip_type: "payoff_first", number: 1, version: 1, dump_created_at: "2026-10-22T15:00:00.000Z" }, "tiktok");
    expect(v.text.endsWith("\n\n—\nMade with AI")).toBe(true);
  });

  it("a voice never says a price, a hashtag, an emoji, the AI note or half a phrase (the real scripts of 24 Oct 2026), on both sides", () => {
    const real = [
      "Memphis arch $350 🌹 #PorchAndParty #MemphisDecor 901 Message us",
      "Walk in and feel the love 🕯️ Book your",
      "Sweet moments begin here—message us to book! Made with.",
      "Walk in to this. Soft lights and fresh blooms.",
      "Your table is set and the candles are lit for the whole family tonight in Germantown",
    ];
    const ts = real.map((t) => cleanScript(t, "", RULES.cta_phrases, 9));
    expect(ts).toEqual(["", "Walk in and feel the love.", "Sweet moments begin here—message us to book!", "Walk in to this. Soft lights and fresh blooms.", "Your table is set and the candles are lit."]);
    for (const t of ts) {
      expect(t).not.toMatch(/[$#@]|\d{3}|made with|\p{Extended_Pictographic}/iu);
      if (t) expect(t).toMatch(/[.!?]$/);
    }
    const py = execFileSync("python3", ["-c", ["import json,sys", "sys.path.insert(0,'jobs')", "import script_clean as SC", `real=json.loads(${JSON.stringify(JSON.stringify(real))})`, `print(json.dumps([SC.clean_script(t,'',${JSON.stringify(RULES.cta_phrases)},9) for t in real]))`].join("\n")], { encoding: "utf8" });
    expect(JSON.parse(py.trim().split("\n").pop()!)).toEqual(ts);
    expect(fitScript("Petals on the bed for your anniversary night with candles everywhere", 3)).toBe("Petals on the bed.");
  });

  it("the Worker's caption layout and words cleaning are the engine's, byte for byte", () => {
    const py = execFileSync(
      "python3",
      [
        "-c",
        [
          "import json,sys",
          "sys.path.insert(0,'jobs')",
          "import clipmaker as CM, script_clean as SC",
          "r={'cta_phrases':['Book your date','Request a quote','Get in touch with us'],'cta_link':'https://example.com/request'}",
          `f=${JSON.stringify(FAILURE)}`,
          "print(json.dumps({'cap':CM.compose_caption('Body here.',CM.cta_line(r,2),['#a','#b'],True),'turns':[CM.cta_phrase(r,k) for k in range(6)],'reason':SC.is_reasoning(f),'script':SC.clean_script('Look at this. Look at this. Book your date. Book your date today. Visit example.com now.','',r['cta_phrases'])}))",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    const want = JSON.parse(py.trim().split("\n").pop()!);
    expect(composeCaption("Body here.", ctaLine(RULES, 2), ["#a", "#b"], true)).toBe(want.cap);
    expect([0, 1, 2, 3, 4, 5].map((k) => ctaPhrase(RULES, k))).toEqual(want.turns);
    expect(isReasoning(FAILURE)).toBe(want.reason);
    expect(cleanScript("Look at this. Look at this. Book your date. Book your date today. Visit example.com now.", "", RULES.cta_phrases)).toBe(want.script);
  });
});

describe("voice over: the engine's script first, held to the engine's rules", () => {
  it("speaks a clean voice_script; never the Oct 22 failure string", async () => {
    const h = await studio();
    const base = { id: "clp_x", hook_text: "Fall porch", caption: "Fall porch.", start_s: 0, end_s: 20, speech: 0 };
    expect(await draftScript(h.env, { ...base, voice_script: "Pumpkins, lanterns and a welcome sign, set up by lunch." })).toBe("Pumpkins, lanterns and a welcome sign, set up by lunch.");
    const s = await draftScript(h.env, { ...base, voice_script: FAILURE });
    expect(s).not.toMatch(/Analyze|\*\*/);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("a grid made of the clip's own shots", () => {
  it("is stored as the engine sent it and re-renders with its hero ending, the caption's call to action and the logo", async () => {
    const h = await studio();
    await h.dumpWith("dmp_g", [
      { id: "ast_v1", name: "prep.mp4", mime: "video/mp4" },
      { id: "ast_v2", name: "final.mp4", mime: "video/mp4" },
    ]);
    const layout = {
      cells: [
        { kind: "part", asset_id: "ast_v1", start: 1, end: 4 },
        { kind: "part", asset_id: "ast_v2", start: 2, end: 5 },
      ],
      voice: 0,
      ending: { asset_id: "ast_v2", start: 10, end: 13 },
    };
    const caption = composeCaption("Prep to finished.", ctaLine(RULES, 2), ["#porch"], true);
    const id = "clp_gggggggg01";
    await h.r2.FILES.put(`clips/dmp_g/${id}.mp4`, new Uint8Array(10));
    await h.cut("dmp_g", { clips: [{ ...fixture.result.clips[0], id, asset_id: "ast_v1", r2_key: `clips/dmp_g/${id}.mp4`, cover_r2_key: null, look: "split", layout, caption, score: 88, files_used: ["ast_v1", "ast_v2"], hero_asset_id: "ast_v2", part_assets: null }] });
    const stored = JSON.parse(h.one<{ layout: string }>("SELECT layout FROM clips WHERE id = ?", id).layout);
    expect(stored).toEqual(layout);
    // A part from another dump is refused.
    expect(cleanGridLayout("split", layout, new Set(["ast_v1"]))).toBeNull();
    // Re-render it in the other two-cell grid: part cells and the ending come from the raw files.
    h.db.raw.exec(`UPDATE clips SET pending_look = 'side_by_side', pending_layout = '${JSON.stringify(layout)}' WHERE id = '${id}'`);
    const spec = (await cutJob.buildSpec(h.env, "job_rr", `dmp_g/${id}`)) as RerenderSpec;
    expect(spec.cells).toEqual([
      { src: "raw/dmp_g/ast_v1", start: 1, end: 4 },
      { src: "raw/dmp_g/ast_v2", start: 2, end: 5 },
    ]);
    expect(spec.ending).toEqual({ src: "raw/dmp_g/ast_v2", start: 10, end: 13 });
    expect(spec.cta_turn).toBe(2);
    expect(ctaTurnFor(caption, RULES)).toBe(2);
    expect(spec.studio_rules.cta_link).toBe(RULES.cta_link);
    expect(spec.branding.logo_r2_key).toBe("brand/logo/logo_0001");
    // Her new cell picks from Review keep the engine's hero ending.
    h.db.raw.exec(`UPDATE clips SET pending_look = NULL, pending_layout = NULL WHERE id = '${id}'`);
    const res = await h.call("POST", `/api/clips/${id}/look`, { look: "side_by_side", layout: { cells: [{ kind: "self" }, { kind: "part", asset_id: "ast_v2", start: 2, end: 5 }], voice: 1 } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(JSON.parse(h.one<{ pending_layout: string }>("SELECT pending_layout FROM clips WHERE id = ?", id).pending_layout).ending).toEqual(layout.ending);
  });
});

describe("migrations", () => {
  it("0028 moves every stored score to 0..100 once; 0027's jobs and emails rebuild keeps every row", () => {
    const db = new DatabaseSync(":memory:");
    const dir = path.resolve(__dirname, "../../migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const run = (pred: (f: string) => boolean) => {
      for (const f of files.filter(pred)) db.exec(readFileSync(path.join(dir, f), "utf8"));
    };
    run((f) => f < "0027");
    db.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_m', 'new', '', 'ready');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_m', 'dmp_m', 'm.mp4', 'video/mp4', 'raw/dmp_m/ast_m', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, platforms, score, r2_key, status) VALUES
        ('clp_m1', 'ast_m', 'dmp_m', 0, 20, 'montage', 'h', 'c', '', '[]', 0.752, 'clips/dmp_m/clp_m1.mp4', 'approved'),
        ('clp_m2', 'ast_m', 'dmp_m', 0, 20, 'montage', 'h', 'c', '', '[]', 1, 'clips/dmp_m/clp_m2.mp4', 'draft'),
        ('clp_m3', 'ast_m', 'dmp_m', 0, 20, 'montage', 'h', 'c', '', '[]', 0, 'clips/dmp_m/clp_m3.mp4', 'draft');
      INSERT INTO jobs (id, type, status, nonce) VALUES ('job_1', 'cut', 'done', 'n1'), ('job_2', 'photopack', 'failed', 'n2');
      INSERT INTO emails_sent (id, kind, to_email, subject) VALUES ('em_1', 'clips_ready', 'x@example.com', 's');`);
    run((f) => f >= "0027");
    expect(db.prepare("SELECT id, score FROM clips ORDER BY id").all()).toEqual([
      { id: "clp_m1", score: 75 },
      { id: "clp_m2", score: 100 },
      { id: "clp_m3", score: 0 },
    ]);
    expect(db.prepare("SELECT id, type, status, nonce FROM jobs ORDER BY id").all()).toEqual([
      { id: "job_1", type: "cut", status: "done", nonce: "n1" },
      { id: "job_2", type: "photopack", status: "failed", nonce: "n2" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM emails_sent").get()).toEqual({ n: 1 });
    // A new-scale score (above 1) is never scaled again.
    db.exec("UPDATE clips SET score = 75 WHERE id = 'clp_m1'");
    db.exec(readFileSync(path.join(dir, "0028_studio_fix_ab.sql"), "utf8").split("\n").filter((l) => l.startsWith("UPDATE")).join("\n"));
    expect(db.prepare("SELECT score FROM clips WHERE id = 'clp_m1'").get()).toEqual({ score: 75 });
    // The new job type is allowed.
    db.exec("INSERT INTO jobs (id, type, status, nonce) VALUES ('job_3', 'niche', 'queued', 'n3')");
  });
});
