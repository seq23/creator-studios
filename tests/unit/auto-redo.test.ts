// The studio redoes held clips on its own (owner's standing rule, 23 Oct 2026: "if its not up to par
// or something is broken it should re do those clips"): shared/holdCauses.ts decides, worker/lib/autoRedo.ts
// runs hourly in every studio. Pinned here:
//   - every reason the engine and the Worker write maps to a cause, and every cause carries its check
//     version with a history line per version (the "fixed in build" marker);
//   - a held clip is redone as a genuinely different version (other moments, other look, the cause's fixes);
//   - a newer check version redoes clips held under the older one, with a fresh allowance;
//   - never a clip she approved/rejected, one on the Calendar, her own edit, a style, or one past the cap;
//   - no loops, no emails; every hidden clip says why; work found and nothing started is a yellow light.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { HOLD_CAUSES, HOLD_CAUSE_KEYS, MAX_AUTO_REDOS, RULES_WORDS, GAVE_UP_NOTE, holdCause, redoDecision, type HeldClip } from "@shared/holdCauses";
import { autoRedoSweep, MAX_PER_SWEEP, REDO_LIGHT } from "@worker/lib/autoRedo";
import { cutJob, parseCutResult, RULES_HIDDEN, underBarReason, type AgainSpec } from "@worker/jobs/cut";
import { harness } from "./helpers/studio-fix-env";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const held = (extra: Partial<HeldClip> = {}): HeldClip => ({
  hidden: 1, status: "draft", style_of: null, edited_with: null, clip_type: "finished_walkthrough", hidden_reason: "it scored 48, under this studio's bar of 70",
  pending_look: null, rerender_job_id: null, hold_cause: null, hold_check: null, auto_redo_check: null, auto_redo_count: 0, in_posts: 0, raw_cleared: 0, not_hers: 0, ...extra,
});

describe("hold causes: every reason has a cause, every cause a check version", () => {
  it("each of the critic's reason words (jobs/critic.py REASON_WORDS) maps to its cause", () => {
    const src = read("jobs/critic.py");
    const block = /REASON_WORDS = \{([\s\S]*?)\n\}/.exec(src)![1];
    const pairs = [...block.matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
    expect(pairs.length).toBe(5);
    // "unprotected" (a blur that could not run) is a privacy hold in its own words; every other key is its own cause.
    for (const [key, words] of pairs) expect(holdCause(words)).toBe(key === "unprotected" ? "privacy" : key);
  });
  it("the Worker's and the engine's under-bar words and the rules words map too; anything else is not guessed", () => {
    expect(RULES_WORDS).toBe(RULES_HIDDEN);
    expect(holdCause(RULES_HIDDEN)).toBe("rules");
    expect(holdCause(underBarReason(48, 70, ["ends on a blurry shot"]))).toBe("under_bar");
    // jobs/cut.py writes "scored {sc}/100, under your bar of {bar}: …"
    expect(read("jobs/cut.py")).toMatch(/f"scored \{sc\}\/100, under your bar of \{bar\}/);
    expect(holdCause("scored 52/100, under your bar of 70: ends on a blurry shot")).toBe("under_bar");
    expect(holdCause(`it scored 40, under this studio's bar of 70 ${GAVE_UP_NOTE}`)).toBe("under_bar");
    // Clip quality: jobs/cut.py writes "too short: {n} s, and this kind of clip needs at least {lo} s".
    expect(read("jobs/cut.py")).toMatch(/m\.hidden_reason = f"too short: \{clip_seconds\(m\):\.0f\} s, and this kind of clip needs at least/);
    expect(holdCause("too short: 3 s, and this kind of clip needs at least 8 s")).toBe("too_short");
    expect(HOLD_CAUSES.too_short.redoOnHold).toBe(true);
    expect(holdCause("someone asked to hide it")).toBeNull();
    expect(holdCause(null)).toBeNull();
  });
  it("each cause's check version has its history line (the build marker); the cap is 2", () => {
    expect(HOLD_CAUSE_KEYS.sort()).toEqual(["before_as_finished", "noise_captions", "privacy", "rules", "text_mismatch", "too_short", "under_bar"]);
    for (const k of HOLD_CAUSE_KEYS) {
      const c = HOLD_CAUSES[k];
      expect(c.history.length, k).toBe(c.check);
      expect(c.history.map((h) => h.check), k).toEqual(c.history.map((_, i) => i + 1));
    }
    expect(MAX_AUTO_REDOS).toBe(2);
    // The face check is a safety hold: only a newer check redoes it.
    expect(HOLD_CAUSES.privacy.redoOnHold).toBe(false);
  });
});

describe("redoDecision: who is redone, and why not", () => {
  it("an under-bar clip is redone with its fixes; the second try reaches further", () => {
    const one = redoDecision(held());
    expect(one).toMatchObject({ redo: true, cause: "under_bar", attempt: 1, fixedSince: false });
    const two = redoDecision(held({ auto_redo_check: 1, auto_redo_count: 1 }));
    expect(two).toMatchObject({ redo: true, attempt: 2 });
    if (two.redo && one.redo) {
      expect(two.fixes).toEqual(expect.arrayContaining([...one.fixes, "different_opening", "shorter"]));
      expect(two.fixes.length).toBeGreaterThan(one.fixes.length);
    }
  });
  it("never: approved/rejected, on the Calendar, her own edit or an import, a style, in flight, past the cap, cleared, someone else's", () => {
    const cases: Partial<HeldClip>[] = [
      { hidden: 0 }, { status: "approved" }, { status: "rejected" }, { in_posts: 1 }, { edited_with: "capcut" }, { clip_type: "imported" },
      { style_of: "clp_x" }, { pending_look: "clean" }, { rerender_job_id: "job_1" }, { auto_redo_check: 1, auto_redo_count: 2 },
      { raw_cleared: 1 }, { not_hers: 1 }, { hidden_reason: "nothing we know" },
    ];
    for (const c of cases) {
      const d = redoDecision(held(c));
      expect(d.redo, JSON.stringify(c)).toBe(false);
      if (!d.redo) expect(d.why.length, JSON.stringify(c)).toBeGreaterThan(5);
    }
  });
  it("a privacy hold waits for a newer check; held under an older check version it is redone with a fresh allowance", () => {
    const words = "a face, house number or name may be showing";
    expect(redoDecision(held({ hidden_reason: words, hold_cause: "privacy", hold_check: HOLD_CAUSES.privacy.check })).redo).toBe(false);
    // 23 Oct 2026, check 2 (the blur that failed on small house-number boxes): a clip held under check 1 is redone.
    expect(HOLD_CAUSES.privacy.check).toBe(2);
    expect(redoDecision(held({ hidden_reason: words, hold_cause: "privacy", hold_check: 1 }))).toMatchObject({ redo: true, cause: "privacy", fixedSince: true });
    expect(redoDecision(held({ hidden_reason: "a house number or face could not be blurred, so it is held for a look", hold_check: 1 }))).toMatchObject({ redo: true, cause: "privacy" });
    // A build that fixes the check is check + 1: the clip held under 1 is redone, its old count does not carry.
    const now = HOLD_CAUSES.privacy.check;
    const asIfFixed = { ...HOLD_CAUSES.privacy, check: now + 1 };
    (HOLD_CAUSES as Record<string, unknown>).privacy = asIfFixed;
    try {
      const d = redoDecision(held({ hidden_reason: words, hold_cause: "privacy", hold_check: now, auto_redo_check: now, auto_redo_count: 2 }));
      expect(d).toMatchObject({ redo: true, cause: "privacy", check: now + 1, attempt: 1, fixedSince: true });
      expect(redoDecision(held({ hidden_reason: words, hold_cause: "privacy", hold_check: now + 1 })).redo).toBe(false);
    } finally {
      (HOLD_CAUSES as Record<string, unknown>).privacy = { ...asIfFixed, check: now };
    }
  });
});

const clip = (id: string, extra: Record<string, unknown> = {}) => ({
  id, asset_id: "ast_s", start_s: 0, end_s: 20, recipe: "montage", hook_text: "Look", caption: "Body\n\n#a", hashtags: ["a"], platforms: ["tiktok"],
  score: 80, score_reasons: ["sharp"], r2_key: `clips/dmp_s/${id}.mp4`, cover_r2_key: null, parts: [[0, 20]], look: "clean", ...extra,
});

async function studio(extra = {}) {
  const h = await harness(extra);
  await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
  const list = [
    clip("clp_redo000001", { score: 48, score_reasons: ["ends on a blurry shot"], start_s: 10, end_s: 30, parts: [[10, 30]] }), // under the bar
    clip("clp_redo000002", { score: 40, start_s: 40, end_s: 60, parts: [[40, 60]] }), // under the bar, she approves it
    clip("clp_redo000003", { score: 30, start_s: 70, end_s: 90, parts: [[70, 90]] }), // under the bar, her own edit
    clip("clp_redo000004", { score: 90, start_s: 100, end_s: 120, parts: [[100, 120]] }), // shown
  ];
  for (const c of list) await h.r2.FILES.put(String(c.r2_key), new Uint8Array(10));
  await h.cut("dmp_s", { clips: list });
  h.db.raw.exec("UPDATE clips SET status = 'approved' WHERE id = 'clp_redo000002'; UPDATE clips SET edited_with = 'capcut' WHERE id = 'clp_redo000003';");
  return h;
}
const againJobs = (h: Awaited<ReturnType<typeof harness>>) => h.all<{ id: string; ref_id: string }>("SELECT id, ref_id FROM jobs WHERE type = 'cut' AND ref_id LIKE '%/again' ORDER BY rowid");

describe("the hourly sweep redoes held clips on its own", () => {
  it("redoes only the eligible held clip, as a different moment and look, and it comes back in Review; no email", async () => {
    const h = await studio();
    const emailsBefore = h.one<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent").n;
    const r = await autoRedoSweep(h.env);
    expect(r).toMatchObject({ held: 2, started: 1 }); // the approved one is not held: she decided
    const jobs = againJobs(h);
    expect(jobs.map((j) => j.ref_id)).toEqual(["dmp_s/clp_redo000001/again"]);
    const spec = (await cutJob.buildSpec(h.env, jobs[0].id, jobs[0].ref_id)) as AgainSpec;
    expect(spec.avoid_windows).toEqual([{ asset_id: "ast_s", start: 10, end: 30 }]);
    expect(spec.rotation).not.toContain("clean");
    expect(spec.fixes).toEqual(expect.arrayContaining([...HOLD_CAUSES.under_bar.fixes]));
    // The approved clip and her own edit were never touched.
    expect(h.one<{ again_notes: string | null }>("SELECT again_notes FROM clips WHERE id = 'clp_redo000002'").again_notes).toBeNull();
    expect(h.one<{ again_notes: string | null }>("SELECT again_notes FROM clips WHERE id = 'clp_redo000003'").again_notes).toBeNull();
    // The redo lands: a fresh version (the fake scores 76, over the bar of 70).
    await cutJob.applyResult(h.env, jobs[0].id, jobs[0].ref_id, await cutJob.fakeRun!(h.env, jobs[0].id, jobs[0].ref_id, {}));
    const after = h.one<{ hidden: number; start_s: number; auto_redo_count: number }>("SELECT hidden, start_s, auto_redo_count FROM clips WHERE id = 'clp_redo000001'");
    expect(after).toMatchObject({ hidden: 0, auto_redo_count: 1 });
    expect(after.start_s).toBeGreaterThanOrEqual(30); // away from the moment it had
    const r2 = await autoRedoSweep(h.env);
    expect(r2).toMatchObject({ back: 1, started: 0 });
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent").n).toBe(emailsBefore);
    expect(h.one<{ note: string; light: string }>("SELECT note, light FROM health WHERE name = ?", REDO_LIGHT)).toMatchObject({ light: "green" });
  });

  it("no loops: at most MAX_AUTO_REDOS per clip per check version, then the reason says it was tried", async () => {
    const h = await studio();
    for (let i = 0; i < 6; i++) {
      await autoRedoSweep(h.env);
      // Each redo comes back still under the bar.
      const j = h.one<{ rerender_job_id: string | null }>("SELECT rerender_job_id FROM clips WHERE id = 'clp_redo000001'");
      if (j.rerender_job_id) h.db.raw.prepare("UPDATE clips SET rerender_job_id = NULL, pending_look = NULL, hidden = 1, hidden_reason = ? WHERE id = 'clp_redo000001'").run(underBarReason(50, 70, []));
    }
    expect(againJobs(h).length).toBe(MAX_AUTO_REDOS);
    const c = h.one<{ auto_redo_count: number; hidden_reason: string }>("SELECT auto_redo_count, hidden_reason FROM clips WHERE id = 'clp_redo000001'");
    expect(c.auto_redo_count).toBe(MAX_AUTO_REDOS);
    expect(c.hidden_reason.split(GAVE_UP_NOTE).length).toBe(2); // said once, not every hour
  });

  it("never more than MAX_PER_SWEEP at once; a hidden clip with no reason gets one in plain words", async () => {
    const h = await harness();
    await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
    const list = Array.from({ length: 5 }, (_, i) => clip(`clp_many00000${i}`, { score: 40, start_s: i * 25, end_s: i * 25 + 20, parts: [[i * 25, i * 25 + 20]] }));
    for (const c of list) await h.r2.FILES.put(String(c.r2_key), new Uint8Array(10));
    await h.cut("dmp_s", { clips: list });
    h.db.raw.exec("UPDATE clips SET hidden_reason = NULL WHERE id = 'clp_many000004'");
    expect((await autoRedoSweep(h.env)).started).toBe(MAX_PER_SWEEP);
    expect(h.one<{ hidden_reason: string }>("SELECT hidden_reason FROM clips WHERE id = 'clp_many000004'").hidden_reason).toBe("it scored 40, under this studio's bar of 70");
  });

  it("a clip she approves while its redo runs keeps the version she approved", async () => {
    const h = await studio();
    await autoRedoSweep(h.env);
    const [job] = againJobs(h);
    const before = h.one<{ r2_key: string }>("SELECT r2_key FROM clips WHERE id = 'clp_redo000001'").r2_key;
    const result = await cutJob.fakeRun!(h.env, job.id, job.ref_id, {});
    h.db.raw.exec("UPDATE clips SET status = 'approved' WHERE id = 'clp_redo000001'");
    await cutJob.applyResult(h.env, job.id, job.ref_id, result);
    expect(h.one<{ r2_key: string; auto_redo_job_id: string | null }>("SELECT r2_key, auto_redo_job_id FROM clips WHERE id = 'clp_redo000001'")).toEqual({ r2_key: before, auto_redo_job_id: null });
  });

  it("a studio with autoRedoFrom leaves clips made before it alone (unless a newer check fixed them); later ones are redone", async () => {
    const h = await studio({ AUTO_REDO_FROM: "2026-10-24T03:45:00.000Z" });
    h.db.raw.exec("UPDATE clips SET created_at = '2026-10-23T12:00:00.000Z'");
    const r = await autoRedoSweep(h.env);
    expect(r.started).toBe(0);
    expect(againJobs(h).length).toBe(0);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = ?", REDO_LIGHT).light).toBe("green");
    h.db.raw.exec("UPDATE clips SET created_at = '2026-10-24T05:00:00.000Z' WHERE id = 'clp_redo000001'");
    expect((await autoRedoSweep(h.env)).started).toBe(1);
    // The registry knob reaches the Worker, and only the studio that sets it.
    expect(read("scripts/studio.mjs")).toMatch(/AUTO_REDO_FROM: s\.autoRedoFrom \?\? ""/);
    const froms = readdirSync(path.join(root, "studios")).filter((f) => f.endsWith(".json") && f !== "themes.json").filter((f) => JSON.parse(read(`studios/${f}`)).autoRedoFrom);
    expect(froms).toEqual(["mercedes.json"]);
  });

  it("Rule 0: held clips found and nothing could start is a yellow light with the reason", async () => {
    const h = await studio({ FAKE_SERVICES: "0" });
    const r = await autoRedoSweep(h.env);
    expect(r.started).toBe(0);
    expect(r.blocked).toMatch(/token/);
    const light = h.one<{ light: string; note: string }>("SELECT light, note FROM health WHERE name = ?", REDO_LIGHT);
    expect(light.light).toBe("yellow");
    expect(light.note).toMatch(/could not be redone: .*token/);
    expect(h.one<{ pending_look: string | null }>("SELECT pending_look FROM clips WHERE id = 'clp_redo000001'").pending_look).toBeNull();
  });
});

describe("every studio, every hour", () => {
  it("each studio has a review bar (re-cut once, then hidden, then the studio's own redo)", () => {
    const files = readdirSync(path.join(root, "studios")).filter((f) => f.endsWith(".json") && f !== "themes.json");
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const bar = JSON.parse(read(`studios/${f}`)).studioRules?.bar;
      expect(Number.isInteger(bar) && bar > 0 && bar <= 100, f).toBe(true);
    }
  });
  it("the hourly lane runs the sweep", () => {
    expect(read("worker/crons/index.ts")).toMatch(/lane === "buffer-sync"[\s\S]*await autoRedoSweep\(env\)/);
  });
  it("an under-bar clip on the older 0..1 scale says why too", () => {
    const r = parseCutResult({ clips: [clip("clp_oldscale01", { score: 0.4, score_reasons: undefined })] }, { dumpId: "dmp_s", allowed: new Map([["ast_s", ["tiktok" as const]]]), rawKeys: new Set<string>(), bar: 70 });
    expect(r.clips[0].hidden).toBe(true);
    expect(holdCause(r.clips[0].hidden_reason)).toBe("under_bar");
  });
});
