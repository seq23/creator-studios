// Editors (docs/EDITORS.md): who edits each job, her own edit from CapCut coming back, and the
// connected editors' whole life on fakes: Dump → editor → poll → the cut job's import → clips;
// every failure falls back to the built-in editor with the editor's light saying why.
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env, Vars } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { buildMp4 } from "./helpers/mp4-build";
import {
  API_EDITORS,
  CHOOSABLE,
  DEFAULT_EDITOR_CHOICE,
  EDITORS,
  HANDOFF,
  checkEdit,
  cleanEditorChoice,
  editorChoiceFromStored,
  editorName,
  editorsFor,
  effectiveEditor,
  recipeForLength,
  type ApiEditorId,
} from "@worker/domain/editors";
import { parseMoov, probeR2 } from "@worker/lib/mp4";
import { FakeEditor, classifyEditorError } from "@worker/services/editors";
import { failRow, pollEditorJobs, startDumpCut, startHandback, EDITOR_GIVE_UP_MS } from "@worker/lib/editorJobs";
import { cutJob, parseCutRef, FAKE_MP4_B64 } from "@worker/jobs/cut";
import { parseReplaced } from "@worker/jobs/cut_import";
import { jobStorageScope, mayRead, mayWrite } from "@worker/lib/jobStorage";
import { saveConnection } from "@worker/lib/connections";
import { getSetting, setSetting } from "@worker/lib/db";
import { unb64 } from "@worker/lib/crypto";
import { clips as clipsRoute } from "@worker/routes/clips";
import { media } from "@worker/routes/media";
import { editing } from "@worker/routes/editing";
import { connections } from "@worker/routes/connections";
import { ownerCookie } from "./helpers/owner-session";


describe("the catalogue", () => {
  it("five connected editors, each doing at least one job; every choosable job has an editor; templates stay built-in", () => {
    expect(EDITORS.map((e) => e.id)).toEqual([...API_EDITORS]);
    for (const e of EDITORS) expect(e.capabilities.length, e.id).toBeGreaterThan(0);
    for (const cap of CHOOSABLE) expect(editorsFor(cap).length, cap).toBeGreaterThan(0);
    expect(EDITORS.some((e) => (e.capabilities as string[]).includes("templates"))).toBe(false);
    expect(Object.keys(HANDOFF)).toEqual(["capcut", "inshot", "other"]);
    expect(HANDOFF.capcut.row).toBe("CapCut: no key needed. Send a clip to CapCut from Review and upload your edit back. Use it instead of the built-in editor whenever you like.");
    expect(editorName("capcut")).toBe("CapCut");
    expect(editorName("opusclip")).toBe("Opus Clip");
    expect(editorName("nope")).toBeNull();
  });
});

describe("Who edits", () => {
  const connected = new Set<ApiEditorId>(["opusclip", "submagic"]);
  it("built-in by default; a stored pick only for an editor that does that job", () => {
    expect(editorChoiceFromStored(undefined)).toEqual(DEFAULT_EDITOR_CHOICE);
    expect(editorChoiceFromStored({ cut_from_source: "submagic", caption: "submagic", enhance: "ghost" })).toEqual({ cut_from_source: "built-in", caption: "submagic", enhance: "built-in" });
  });
  it("her pick is refused, in words, for an editor that can't do the job or isn't connected", () => {
    expect(cleanEditorChoice({ cut_from_source: "opusclip" }, DEFAULT_EDITOR_CHOICE, connected)).toEqual({ choice: { ...DEFAULT_EDITOR_CHOICE, cut_from_source: "opusclip" } });
    expect(cleanEditorChoice({ caption: "opusclip" }, DEFAULT_EDITOR_CHOICE, connected)).toEqual({ error: "That editor can't do captions." });
    expect(cleanEditorChoice({ cut_from_source: "vizard" }, DEFAULT_EDITOR_CHOICE, connected)).toEqual({ error: "Connect Vizard on the Connect screen first." });
    expect(cleanEditorChoice({ enhance: "built-in" }, { ...DEFAULT_EDITOR_CHOICE, enhance: "submagic" }, connected)).toEqual({ choice: DEFAULT_EDITOR_CHOICE });
  });
  it("a picked editor that is no longer connected hands the job back to the built-in editor", () => {
    const choice = { ...DEFAULT_EDITOR_CHOICE, cut_from_source: "opusclip" as const, caption: "klap" as const };
    expect(effectiveEditor(choice, "cut_from_source", connected)).toBe("opusclip");
    expect(effectiveEditor(choice, "caption", connected)).toBe("built-in");
    expect(effectiveEditor(choice, "enhance", connected)).toBe("built-in");
  });
});

describe("her edit, back from CapCut", () => {
  it("a tall video within every ticked platform's limit is accepted", () => {
    expect(checkEdit({ width: 1080, height: 1920, duration_s: 42 }, ["tiktok", "instagram", "youtube"], "CapCut")).toEqual({ ok: true });
    expect(checkEdit({ width: 720, height: 1280, duration_s: 170 }, ["tiktok", "youtube"], "CapCut")).toEqual({ ok: true });
  });
  it("says what to change in the app when it's not 9:16, too short, too long for a platform, or unreadable", () => {
    expect(checkEdit({ width: 1920, height: 1080, duration_s: 30 }, ["tiktok"], "CapCut")).toEqual({ ok: false, error: "Your edit is 1920×1080, not a tall 9:16 video. In CapCut set the ratio to 9:16, export again and upload it." });
    expect(checkEdit({ width: 1080, height: 1350, duration_s: 30 }, ["tiktok"], "InShot").ok).toBe(false);
    expect(checkEdit({ width: 1080, height: 1920, duration_s: 2 }, ["tiktok"], "CapCut")).toEqual({ ok: false, error: "Your edit is only 2 s. Clips need at least 3 seconds." });
    expect(checkEdit({ width: 1080, height: 1920, duration_s: 125 }, ["tiktok", "instagram"], "CapCut")).toEqual({
      ok: false,
      error: "Instagram takes up to 1 min 30 s; your edit is 2 min 5 s. Trim it in CapCut, or untick Instagram on this clip first.",
    });
    expect(checkEdit({ width: 1080, height: 1920, duration_s: 200 }, ["youtube"], "CapCut").ok).toBe(false);
    expect(checkEdit(null, ["tiktok"], "CapCut")).toEqual({ ok: false, error: "We couldn't read that video. Export it again from CapCut as an MP4 and upload it." });
  });
  it("another editor's clip gets the recipe its length fits", () => {
    expect([recipeForLength(20), recipeForLength(50), recipeForLength(80)]).toEqual(["talking_head", "hook_first", "story"]);
  });
});

describe("reading an MP4 / MOV header in the Worker", () => {
  it("reads the fake player's real MP4, made by ffmpeg (90x160, 2 s)", async () => {
    const r2 = memoryR2();
    await r2.FILES.put("clips/d/fake.mp4", unb64(FAKE_MP4_B64));
    expect(await probeR2(r2.FILES, "clips/d/fake.mp4")).toEqual({ width: 90, height: 160, duration_s: 2 });
  });
  it("size, rotation and length from built headers: version 0 and 1, moov first or last", () => {
    const moovOf = (b: Uint8Array) => b.subarray(b.findIndex((_, i) => b[i + 4] === 0x6d && b[i + 5] === 0x6f && b[i + 6] === 0x6f && b[i + 7] === 0x76 && i > 0));
    expect(parseMoov(moovOf(buildMp4({ width: 1080, height: 1920, duration_s: 42.5 })))).toEqual({ width: 1080, height: 1920, duration_s: 42.5 });
    expect(parseMoov(moovOf(buildMp4({ width: 1920, height: 1080, duration_s: 12, rotate90: true })))).toEqual({ width: 1080, height: 1920, duration_s: 12 });
    expect(parseMoov(moovOf(buildMp4({ width: 720, height: 1280, duration_s: 61.25, version1: true, timescale: 600 })))).toEqual({ width: 720, height: 1280, duration_s: 61.25 });
    expect(parseMoov(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))).toBeNull();
  });
  it("walks R2 to the moov, even after a big mdat, with small range reads", async () => {
    const r2 = memoryR2();
    await r2.FILES.put("edits/clp_a/upl_1", buildMp4({ width: 1080, height: 1920, duration_s: 33, moovLast: true, mdatBytes: 200_000 }));
    expect(await probeR2(r2.FILES, "edits/clp_a/upl_1")).toEqual({ width: 1080, height: 1920, duration_s: 33 });
    await r2.FILES.put("edits/clp_a/junk", new Uint8Array(5000).fill(3));
    expect(await probeR2(r2.FILES, "edits/clp_a/junk")).toBeNull();
    expect(await probeR2(r2.FILES, "edits/missing")).toBeNull();
  });
});

describe("connected editors: fakes and failure shapes", () => {
  it("classifies refusals: 401/403 key, 402 or a credits message, 429 busy", () => {
    expect(classifyEditorError(401, "")).toBe("auth");
    expect(classifyEditorError(403, "forbidden")).toBe("auth");
    expect(classifyEditorError(402, "")).toBe("credits");
    expect(classifyEditorError(400, "Insufficient credits for this video")).toBe("credits");
    expect(classifyEditorError(429, "")).toBe("busy");
    expect(classifyEditorError(500, "boom")).toBe("other");
  });
  it("the fake answers like a vendor: account, submit, a finished cut with three clips", async () => {
    const f = new FakeEditor("opusclip", "good-123");
    expect(await f.account()).toMatchObject({ ok: true, credits_left: 240, credits_total: 300 });
    expect(await new FakeEditor("opusclip", "good-low-1").account()).toMatchObject({ ok: true, credits_left: 3 });
    expect(await new FakeEditor("opusclip", "bad").account()).toEqual({ ok: false, failure: "auth", status: 401 });
    const s = await f.submit("https://x.example/media/source/t", "cut_from_source", "t");
    expect(s.ok).toBe(true);
    const p = await f.poll((s as { projectId: string }).projectId, "cut_from_source", {});
    expect(p).toMatchObject({ ok: true, state: "done" });
    expect((p as { outputs: unknown[] }).outputs).toHaveLength(3);
    expect(await new FakeEditor("opusclip", "good-credits-1").submit("https://x", "cut_from_source", "t")).toEqual({ ok: false, failure: "credits", status: 402 });
  });
});

describe("cut refs and storage for imports", () => {
  it("a dump import and a clip import are their own refs", () => {
    expect(parseCutRef("dmp_ab12/import")).toEqual({ dumpId: "dmp_ab12", clipId: null, import: true });
    expect(parseCutRef("dmp_ab12/clp_aaaaaaaaaaaa/import")).toEqual({ dumpId: "dmp_ab12", clipId: "clp_aaaaaaaaaaaa", import: true });
    expect(parseCutRef("dmp_ab12/clp_aaaaaaaaaaaa")).toEqual({ dumpId: "dmp_ab12", clipId: "clp_aaaaaaaaaaaa", import: false });
    expect(parseCutRef("dmp_ab12/import/clp_aaaaaaaaaaaa")).toBeNull();
  });
  it("an import reads only her uploaded edit for that clip and writes only its dump's folder", () => {
    const s = jobStorageScope("cut", "j", "dmp_ab12/clp_aaaaaaaaaaaa/import");
    expect(mayRead(s, "edits/clp_aaaaaaaaaaaa/upl_1")).toBe(true);
    expect(mayRead(s, "edits/clp_bbbbbbbbbbbb/upl_1")).toBe(false);
    expect(mayRead(s, "raw/dmp_ab12/ast_1")).toBe(false);
    expect(mayWrite(s, "clips/dmp_ab12/clp_aaaaaaaaaaaa-v1.mp4")).toBe(true);
    expect(mayWrite(s, "clips/dmp_other/x.mp4")).toBe(false);
    const d = jobStorageScope("cut", "j", "dmp_ab12/import");
    expect(d.read).toEqual(["jobs/j/"]);
    expect(mayWrite(d, "clips/dmp_ab12/clp_cccccccccccc.mp4")).toBe(true);
  });
  it("the replacement answer must be for its clip and measured", () => {
    const exp = { clipId: "clp_aaaaaaaaaaaa", mp4: "clips/d/clp_aaaaaaaaaaaa-v1.mp4", jpg: "clips/d/clp_aaaaaaaaaaaa-v1.jpg" };
    const good = { replaced: { clip_id: exp.clipId, r2_key: exp.mp4, cover_r2_key: exp.jpg, width: 1080, height: 1920, duration_s: 20 } };
    expect(parseReplaced(good, exp)).toEqual({ width: 1080, height: 1920, duration_s: 20 });
    expect(() => parseReplaced({ replaced: { ...good.replaced, r2_key: "clips/x/y.mp4" } }, exp)).toThrow();
    expect(() => parseReplaced({ replaced: { ...good.replaced, width: 0 } }, exp)).toThrow();
  });
});

// ---------------------------------------------------------------- the whole life, on fakes, against the real schema

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.route("/api/clips", clipsRoute);
app.route("/api/editing", editing);
app.route("/api/connections", connections);
app.route("/media", media);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as T[];
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${path}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

async function seedDump(status = "cutting") {
  db.raw.exec(`INSERT INTO dumps (id, door, notes, status) VALUES ('dmp_t1', 'new', '', '${status}');
    INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_t1', 'dmp_t1', 'a.mp4', 'video/mp4', 'raw/dmp_t1/ast_t1', 'uploaded');`);
  await r2.FILES.put("raw/dmp_t1/ast_t1", new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
}
async function connect(editor: ApiEditorId, key: string) {
  await saveConnection(env, editor, key, "ok", {});
}
async function pick(choice: Record<string, string>) {
  const stored = await getSetting<Record<string, unknown>>(env.DB, "editing", {});
  await setSetting(env.DB, "editing", { ...stored, editors: { ...DEFAULT_EDITOR_CHOICE, ...choice } });
}
async function runJob(ref: string, options: Record<string, unknown> = {}) {
  const job = one<{ id: string } | undefined>("SELECT id FROM jobs WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1", ref);
  expect(job, `a job for ${ref}`).toBeTruthy();
  const result = await cutJob.fakeRun!(env, job!.id, ref, options);
  await cutJob.applyResult(env, job!.id, ref, result);
}

beforeEach(async () => {
  db = sqliteD1();
  r2 = memoryR2();
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
});

describe("a dump cut by a connected editor", () => {
  it("built-in when nothing is picked; the picked, connected editor otherwise", async () => {
    await seedDump();
    expect(await startDumpCut(env, "dmp_t1", BASE_URL)).toMatchObject({ dispatched: true, editor: "built-in" });
    await connect("opusclip", "good-key-1");
    await pick({ cut_from_source: "opusclip" });
    expect(await startDumpCut(env, "dmp_t1", BASE_URL)).toMatchObject({ dispatched: true, editor: "opusclip", jobId: null });
    const row = one<{ status: string; source_token: string; project_id: string }>("SELECT status, source_token, project_id FROM editor_jobs WHERE dump_id = 'dmp_t1'");
    expect(row.status).toBe("submitted");
    expect(row.project_id).toMatch(/^fake_opusclip_cut_from_source_/);
    // the editor fetches the video by its private link, only while the job waits for it
    const res = await app.request(`${BASE_URL}/media/source/${row.source_token}`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it("poll → import → clips marked as the editor's, through the same checks; the link dies", async () => {
    await seedDump();
    await connect("opusclip", "good-key-1");
    await pick({ cut_from_source: "opusclip" });
    await startDumpCut(env, "dmp_t1", BASE_URL);
    const token = one<{ source_token: string }>("SELECT source_token FROM editor_jobs").source_token;
    expect(await pollEditorJobs(env)).toEqual({ polled: 1, imported: 1, fellBack: 0 });
    expect(one<{ status: string }>("SELECT status FROM editor_jobs").status).toBe("importing");
    expect((await app.request(`${BASE_URL}/media/source/${token}`, {}, env)).status).toBe(404);
    await runJob("dmp_t1/import");
    const got = all<{ edited_with: string; look: string | null; recipe: string; r2_key: string }>("SELECT edited_with, look, recipe, r2_key FROM clips WHERE dump_id = 'dmp_t1'");
    expect(got).toHaveLength(3);
    expect(got.every((c) => c.edited_with === "opusclip" && c.look === null && c.r2_key.startsWith("clips/dmp_t1/"))).toBe(true);
    expect(got.map((c) => c.recipe).sort()).toEqual(["hook_first", "talking_head", "talking_head"]);
    expect(one<{ status: string }>("SELECT status FROM dumps WHERE id = 'dmp_t1'").status).toBe("ready");
    expect(one<{ status: string }>("SELECT status FROM editor_jobs").status).toBe("done");
  });

  it("a refused key at submit: the built-in cutter runs at once, the connection and light go red", async () => {
    await seedDump();
    await connect("vizard", "bad-key-1");
    await pick({ cut_from_source: "vizard" });
    const r = await startDumpCut(env, "dmp_t1", BASE_URL);
    expect(r).toMatchObject({ dispatched: true, editor: "built-in" });
    expect(r.jobId).toBeTruthy();
    expect(one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'vizard'")).toEqual({ light: "red", fix_guide: "reconnect-vizard" });
    expect(one<{ status: string }>("SELECT status FROM connections WHERE service = 'vizard'").status).toBe("error");
  });

  it("the editor fails, or takes over 3 hours: the built-in cutter takes the dump, the light goes yellow", async () => {
    await seedDump();
    await connect("klap", "good-fail-1");
    await pick({ cut_from_source: "klap" });
    await startDumpCut(env, "dmp_t1", BASE_URL);
    expect(await pollEditorJobs(env)).toMatchObject({ fellBack: 1 });
    expect(one<{ ref_id: string } | undefined>("SELECT ref_id FROM jobs WHERE ref_id = 'dmp_t1'")).toBeTruthy();
    expect(one<{ light: string; note: string }>("SELECT light, note FROM health WHERE name = 'klap'")).toMatchObject({ light: "yellow", note: expect.stringMatching(/built-in editor cut the dump instead/) });

    db = sqliteD1();
    r2 = memoryR2();
    env = { ...env, DB: db.DB, FILES: r2.FILES };
    await seedDump();
    await connect("klap", "good-slow-1");
    await pick({ cut_from_source: "klap" });
    await startDumpCut(env, "dmp_t1", BASE_URL);
    expect(await pollEditorJobs(env, { now: Date.now() + EDITOR_GIVE_UP_MS + 60_000 })).toMatchObject({ fellBack: 1 });
    expect(one<{ status: string; error: string }>("SELECT status, error FROM editor_jobs")).toEqual({ status: "failed", error: "gave up after 3 hours" });
  });

  it("an editor that is disconnected after its pick is simply not used", async () => {
    await seedDump();
    await connect("opusclip", "good-key-1");
    await pick({ cut_from_source: "opusclip" });
    db.raw.exec("UPDATE connections SET status = 'disconnected', secret_enc = NULL WHERE service = 'opusclip'");
    expect(await startDumpCut(env, "dmp_t1", BASE_URL)).toMatchObject({ editor: "built-in" });
    expect(all("SELECT id FROM editor_jobs")).toHaveLength(0);
  });
});

async function seedClip(platforms = '["tiktok","instagram","youtube"]') {
  await seedDump("ready");
  db.raw.exec(`INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, platforms, score, r2_key, cover_r2_key, media_token, status, look)
    VALUES ('clp_aaaaaaaaaaaa', 'ast_t1', 'dmp_t1', 0, 30, 'talking_head', 'Hook', '${platforms}', 0.8, 'clips/dmp_t1/clp_aaaaaaaaaaaa.mp4', 'clips/dmp_t1/clp_aaaaaaaaaaaa.jpg', '${"m".repeat(40)}', 'draft', 'clean')`);
  await r2.FILES.put("clips/dmp_t1/clp_aaaaaaaaaaaa.mp4", new Uint8Array(10));
  await r2.FILES.put("clips/dmp_t1/clp_aaaaaaaaaaaa.jpg", new Uint8Array(10));
}

describe("Replace with my edit (CapCut hand-back)", () => {
  it("a good edit: header checked, finished by the import, swapped in, marked Edited in CapCut, old files gone", async () => {
    await seedClip();
    db.raw.exec("INSERT INTO narrations (id, script, status, r2_key, clip_id, mixed_r2_key, mix_status) VALUES ('nar_h1', 'hi', 'ready', 'voice/narrations/nar_h1.wav', 'clp_aaaaaaaaaaaa', 'voice/mixed/nar_h1.mp4', 'ready')");
    await r2.FILES.put("edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", buildMp4({ width: 1080, height: 1920, duration_s: 28 }));
    const r = await call("POST", "/api/clips/clp_aaaaaaaaaaaa/replace", { id: "upl_abcdefgh12", key: "edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", app: "capcut" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.clip as { editing_note: string }).editing_note).toBe("Finishing your edit from CapCut, about a minute");
    await runJob("dmp_t1/clp_aaaaaaaaaaaa/import");
    const c = one<{ r2_key: string; edited_with: string; look: string | null; media_version: number }>("SELECT r2_key, edited_with, look, media_version FROM clips WHERE id = 'clp_aaaaaaaaaaaa'");
    expect(c).toEqual({ r2_key: "clips/dmp_t1/clp_aaaaaaaaaaaa-v1.mp4", edited_with: "capcut", look: null, media_version: 1 });
    expect(r2.objects.has("clips/dmp_t1/clp_aaaaaaaaaaaa.mp4")).toBe(false);
    expect(r2.objects.has("edits/clp_aaaaaaaaaaaa/upl_abcdefgh12")).toBe(false);
    // her voice over was mixed into the old file: it is mixed into her edit again
    expect(one<{ mix_status: string; mixed_r2_key: string | null }>("SELECT mix_status, mixed_r2_key FROM narrations")).toEqual({ mix_status: "mixing", mixed_r2_key: null });
    const list = await call("GET", "/api/clips?tab=new&hidden=1");
    const view = (list.json.groups as { clips: { edited_with_name: string; editing_note: string | null; media_url: string }[] }[])[0].clips[0];
    expect(view).toMatchObject({ edited_with_name: "CapCut", editing_note: null });
    expect(view.media_url).toMatch(/\?v=1$/);
  });

  it("a landscape or too-long edit is refused at once with what to do; the clip is unchanged", async () => {
    await seedClip();
    await r2.FILES.put("edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", buildMp4({ width: 1920, height: 1080, duration_s: 28 }));
    const wide = await call("POST", "/api/clips/clp_aaaaaaaaaaaa/replace", { id: "upl_abcdefgh12", key: "edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", app: "capcut" });
    expect(wide).toMatchObject({ status: 422, json: { error: expect.stringMatching(/not a tall 9:16 video/), fix_guide: "edit-in-capcut" } });
    expect(r2.objects.has("edits/clp_aaaaaaaaaaaa/upl_abcdefgh12")).toBe(false);
    await r2.FILES.put("edits/clp_aaaaaaaaaaaa/upl_abcdefgh13", buildMp4({ width: 1080, height: 1920, duration_s: 120 }));
    const long = await call("POST", "/api/clips/clp_aaaaaaaaaaaa/replace", { id: "upl_abcdefgh13", key: "edits/clp_aaaaaaaaaaaa/upl_abcdefgh13", app: "inshot" });
    expect(long.json.error).toMatch(/Instagram takes up to 1 min 30 s; your edit is 2 min\. Trim it in InShot/);
    expect(one<{ r2_key: string }>("SELECT r2_key FROM clips WHERE id = 'clp_aaaaaaaaaaaa'").r2_key).toBe("clips/dmp_t1/clp_aaaaaaaaaaaa.mp4");
    expect(all("SELECT id FROM editor_jobs")).toHaveLength(0);
  });

  it("the job measures again: a file the header lied about is refused and the clip keeps its file", async () => {
    await seedClip();
    await r2.FILES.put("edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", buildMp4({ width: 1080, height: 1920, duration_s: 28 }));
    await call("POST", "/api/clips/clp_aaaaaaaaaaaa/replace", { id: "upl_abcdefgh12", key: "edits/clp_aaaaaaaaaaaa/upl_abcdefgh12", app: "capcut" });
    await runJob("dmp_t1/clp_aaaaaaaaaaaa/import", { measured: { width: 1920, height: 1080, duration_s: 28 } });
    const c = one<{ r2_key: string; rerender_error: string; edited_with: string | null }>("SELECT r2_key, rerender_error, edited_with FROM clips WHERE id = 'clp_aaaaaaaaaaaa'");
    expect(c.r2_key).toBe("clips/dmp_t1/clp_aaaaaaaaaaaa.mp4");
    expect(c.edited_with).toBeNull();
    expect(c.rerender_error).toMatch(/not a tall 9:16 video.*The clip is unchanged\./);
    expect(r2.objects.has("clips/dmp_t1/clp_aaaaaaaaaaaa-v1.mp4")).toBe(false);
  });

  it("one edit at a time per clip, and never another clip's upload", async () => {
    await seedClip();
    expect((await startHandback(env, { id: "clp_aaaaaaaaaaaa", dump_id: "dmp_t1" }, "capcut", "edits/clp_aaaaaaaaaaaa/upl_1")).ok).toBe(true);
    expect(await startHandback(env, { id: "clp_aaaaaaaaaaaa", dump_id: "dmp_t1" }, "capcut", "edits/clp_aaaaaaaaaaaa/upl_2")).toEqual({ ok: false, error: "This clip is already being finished. It will be ready in about a minute." });
    const other = await call("POST", "/api/clips/clp_aaaaaaaaaaaa/replace", { id: "upl_abcdefgh12", key: "edits/clp_bbbbbbbbbbbb/upl_abcdefgh12", app: "capcut" });
    expect(other.status).toBe(400);
  });
});

describe("captions and polish by a connected editor", () => {
  it("captions: the built-in render leaves words off, the editor adds them, polish follows; a failure puts the built-in captions back", async () => {
    await seedClip();
    await connect("submagic", "good-key-1");
    await connect("descript", "good-key-1");
    await pick({ caption: "submagic", enhance: "descript" });
    const { queueClipEditors } = await import("@worker/lib/editorJobs");
    expect(await queueClipEditors(env, ["clp_aaaaaaaaaaaa"], BASE_URL)).toBe(1);
    expect(one<{ editor: string; capability: string }>("SELECT editor, capability FROM editor_jobs")).toEqual({ editor: "submagic", capability: "caption" });
    await pollEditorJobs(env);
    await runJob("dmp_t1/clp_aaaaaaaaaaaa/import");
    expect(one<{ edited_with: string }>("SELECT edited_with FROM clips").edited_with).toBe("submagic");
    // polish is next, by Descript
    expect(all<{ editor: string; status: string }>("SELECT editor, status FROM editor_jobs WHERE capability = 'enhance'")).toEqual([{ editor: "descript", status: "submitted" }]);
    expect(one<{ status: string }>("SELECT status FROM editor_jobs WHERE capability = 'caption'").status).toBe("done");

    // a failed caption job: the clip is re-rendered in its look with the built-in captions on, once
    db.raw.exec("UPDATE clips SET look = 'clean', edited_with = NULL");
    const row = { id: "edj_x", editor: "submagic", capability: "caption" as const, dump_id: "dmp_t1", clip_id: "clp_aaaaaaaaaaaa" };
    db.raw.exec("INSERT INTO editor_jobs (id, editor, capability, dump_id, clip_id, status) VALUES ('edj_x', 'submagic', 'caption', 'dmp_t1', 'clp_aaaaaaaaaaaa', 'submitted')");
    await failRow(env, row, "editor failed", "failed");
    const c = one<{ pending_look: string; rerender_error: string }>("SELECT pending_look, rerender_error FROM clips");
    expect(c.pending_look).toBe("clean");
    expect(c.rerender_error).toMatch(/Submagic couldn't add captions/);
    const spec = (await cutJob.buildSpec(env, "job_x", "dmp_t1/clp_aaaaaaaaaaaa")) as { look: { captions: string } };
    expect(spec.look.captions).not.toBe("none");
    expect(await queueClipEditors(env, ["clp_aaaaaaaaaaaa"], BASE_URL, "caption")).toBe(0);
  });
});

describe("Settings and Connect", () => {
  it("Who edits lists every editor for each job, connected or not; picks only connected ones", async () => {
    await connect("opusclip", "good-key-1");
    const v = await call("GET", "/api/editing");
    const rows = v.json.editors as { capability: string; choice: string; effective: string; options: { id: string; connected: boolean }[] }[];
    expect(rows.map((r) => r.capability)).toEqual(["cut_from_source", "caption", "enhance"]);
    expect(rows[0].options.map((o) => [o.id, o.connected])).toEqual([["built-in", true], ["opusclip", true], ["vizard", false], ["klap", false]]);
    expect((await call("PATCH", "/api/editing", { editors: { cut_from_source: "vizard" } })).json.error).toBe("Connect Vizard on the Connect screen first.");
    const ok = await call("PATCH", "/api/editing", { editors: { cut_from_source: "opusclip" } });
    expect((ok.json.editors as { choice: string }[])[0].choice).toBe("opusclip");
    // the rest of the editing settings are kept
    expect((await getSetting<{ looks_off: unknown }>(env.DB, "editing", { looks_off: null })).looks_off).toEqual([]);
  });

  it("Check key for an editor: a good key connects with a green light, low credits yellow, a bad key the guide", async () => {
    const good = await call("POST", "/api/connections/opusclip/key", { key: "good-key-12345" });
    expect(good.status).toBe(200);
    expect(good.json.note).toMatch(/Pick it under Settings → Editing → Who edits/);
    expect(one<{ light: string }>("SELECT light FROM health WHERE name = 'opusclip'").light).toBe("green");
    await call("POST", "/api/connections/submagic/key", { key: "good-low-12345" });
    expect(one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'submagic'")).toEqual({ light: "yellow", fix_guide: "reconnect-submagic" });
    const bad = await call("POST", "/api/connections/descript/key", { key: "nope-12345678" });
    expect(bad).toMatchObject({ status: 422, json: { error: "Descript says this key is not valid.", fix_guide: "connect-descript" } });
  });
});
