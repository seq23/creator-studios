// "What's working in your niche" (studio fix, 23 Oct 2026): researched monthly ($0), stored in D1,
// handed to every cut, shown on the Brand page, and sent once as a short note through the studio's
// own email path (a studio with NOTIFY_EMAIL sends it only there).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanPlaybook, learnedLines, monthlyNicheRefresh, nicheDue, NICHE_EVERY_DAYS, summaryOf } from "@worker/lib/niche";
import { nicheJob, type NicheSpec } from "@worker/jobs/niche";
import { cutJob, type CutSpec } from "@worker/jobs/cut";
import { jobStorageScope } from "@worker/lib/jobStorage";
import { harness } from "./helpers/studio-fix-env";

const ROOT = path.resolve(__dirname, "..", "..");
const NOW = new Date("2026-11-01T12:00:00Z");

describe("pure rules", () => {
  it("only plain bounded strings are kept; nothing usable is null; a missing summary is made from the playbook", () => {
    expect(cleanPlaybook({ playbook: { formats: [], hooks: [] } })).toBeNull();
    const c = cleanPlaybook({ playbook: { formats: ["Reveal first", 5, ""], hooks: ["POV"], caption_tips: ["Name the town"] }, sources: 9 }, "2026-11-01")!;
    expect(c.playbook).toEqual({ updated_at: "2026-11-01", formats: ["Reveal first"], hooks: ["POV"], caption_tips: ["Name the town"] });
    expect(c.summary).toEqual(summaryOf(c.playbook));
    expect(c.sources).toBe(9);
  });
  it("monthly: waits for a locked profile, runs when a month has passed, retries a failure after a few days", () => {
    const base = { now: NOW, lastPlaybookAt: null, lastJob: null, profileLocked: true };
    expect(nicheDue({ ...base, profileLocked: false }).run).toBe(false);
    expect(nicheDue(base).run).toBe(true);
    expect(nicheDue({ ...base, lastPlaybookAt: "2026-10-20T00:00:00Z" }).run).toBe(false);
    expect(nicheDue({ ...base, lastPlaybookAt: new Date(NOW.getTime() - (NICHE_EVERY_DAYS + 1) * 86400_000).toISOString() }).run).toBe(true);
    expect(nicheDue({ ...base, lastJob: { status: "failed", created_at: "2026-10-31T00:00:00Z" } }).run).toBe(false);
    expect(nicheDue({ ...base, lastJob: { status: "failed", created_at: "2026-10-20T00:00:00Z" } }).run).toBe(true);
    expect(nicheDue({ ...base, lastJob: { status: "running", created_at: "2026-11-01T06:00:00Z" } }).run).toBe(false);
  });
  it("clip quality: the creator style is kept bounded (openings, lengths per type, pacing, on-screen words, captions) and told in plain words", () => {
    const c = cleanPlaybook({ playbook: { formats: ["Talking"], hooks: ["POV: …"], caption_tips: [], openings: ["Best moment first", 7], lengths: { talk_to_camera: [10, 45], pov_walk_in: [1, 400], "Bad Key": [5, 9] }, pacing: "  Quick  cuts ", on_screen_words: 7, caption_style: "Short and personal" } }, "2026-11-01")!;
    expect(c.playbook).toMatchObject({ openings: ["Best moment first"], lengths: { talk_to_camera: [10, 45] }, pacing: "Quick cuts", on_screen_words: 7, caption_style: "Short and personal" });
    expect(Object.keys(c.playbook.lengths!)).toEqual(["talk_to_camera"]);
    expect(cleanPlaybook({ playbook: { formats: ["x"], on_screen_words: 99 } })!.playbook.on_screen_words).toBeUndefined();
    const lines = learnedLines(c.playbook);
    expect(lines).toEqual([
      "How the best ones open: Best moment first",
      "Hooks that work: “POV: …”",
      "How long: talking clips 10 to 45 seconds",
      "Pacing: Quick cuts",
      "On-screen words: 7 or fewer",
      "Captions: Short and personal",
    ]);
    expect(learnedLines(null)).toEqual([]);
  });
  it("refreshed whenever the Brand Profile changes, not only monthly", () => {
    const base = { now: NOW, lastPlaybookAt: "2026-10-31T00:00:00Z", lastJob: null, profileLocked: true };
    expect(nicheDue({ ...base, profileVersion: 3, playbookVersion: 3 }).run).toBe(false);
    expect(nicheDue({ ...base, profileVersion: 4, playbookVersion: 3 }).run).toBe(true);
    expect(nicheDue({ ...base, profileVersion: 4, playbookVersion: null }).run).toBe(true);
    expect(nicheDue({ ...base, profileVersion: 4, playbookVersion: 3, lastJob: { status: "running", created_at: "2026-11-01T06:00:00Z" } }).run).toBe(false);
    expect(nicheDue({ ...base, profileVersion: 4, playbookVersion: 3, lastJob: { status: "failed", created_at: "2026-11-01T06:00:00Z" } }).run).toBe(false);
  });
  it("the job reads no storage at all", () => {
    expect(jobStorageScope("niche", "job_n", null)).toEqual({ read: ["jobs/job_n/"], write: ["jobs/job_n/"] });
  });
  it("the Python job's self-test passes (queries from the profile, the baseline when no model answers, a model answer wins)", () => {
    const out = execFileSync("python3", [path.join(ROOT, "jobs", "niche_research.py"), "--selftest"], { encoding: "utf8" });
    expect(out).toContain('"niche.selftest", "ok": true');
  });
});

describe("through the real schema", () => {
  it("daily lane starts it, the result is stored, the cut carries it, the Brand page shows it, one note is sent", async () => {
    const h = await harness({ NOTIFY_EMAIL: "host@example.com" } as never);
    const first = await monthlyNicheRefresh(h.env, NOW);
    expect(first.dispatched).toBe(true);
    const job = h.one<{ id: string; type: string }>("SELECT id, type FROM jobs WHERE type = 'niche'");
    const spec = (await nicheJob.buildSpec(h.env, job.id, null)) as NicheSpec;
    expect(spec.services).toEqual(["Garden design", "Patio planting"]);
    expect(spec.profile.who).toMatch(/gardens/);
    await nicheJob.applyResult(h.env, job.id, null, await nicheJob.fakeRun!(h.env, job.id, null, {}));
    // Not twice in a month.
    expect((await monthlyNicheRefresh(h.env, new Date())).dispatched).toBe(false);
    const view = await h.call("GET", "/api/brain/niche");
    expect(view.json.summary.length).toBe(3);
    expect(view.json.playbook.formats.length).toBeGreaterThan(0);
    await h.dumpWith("dmp_np", [{ id: "ast_np", name: "a.mp4", mime: "video/mp4" }]);
    const cut = (await cutJob.buildSpec(h.env, "job_np", "dmp_np")) as CutSpec;
    expect(cut.niche_playbook?.hooks).toEqual(view.json.playbook.hooks);
    const mails = h.all<{ kind: string; to_email: string }>("SELECT kind, to_email FROM emails_sent WHERE kind = 'niche_note'");
    expect(mails).toEqual([{ kind: "niche_note", to_email: "host@example.com" }]);
    expect(h.one<{ emailed_at: string | null }>("SELECT emailed_at FROM niche_playbooks").emailed_at).not.toBeNull();
    // Stored for the profile version it was researched for; the Brand Profile changes -> redone at once, no second note.
    const v = h.one<{ version: number }>("SELECT version FROM brand_profile WHERE locked = 1").version;
    expect(h.one<{ profile_version: number | null }>("SELECT profile_version FROM niche_playbooks").profile_version).toBe(v);
    h.db.raw.exec(`UPDATE jobs SET status = 'done' WHERE type = 'niche'`);
    h.db.raw.exec(`UPDATE brand_profile SET locked = 0`);
    h.db.raw.exec(`INSERT INTO brand_profile (sections, locked, locked_at, source) SELECT sections, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'edited' FROM brand_profile WHERE version = ${v}`);
    const again = await monthlyNicheRefresh(h.env, new Date());
    expect(again.dispatched).toBe(true);
    const job2 = h.one<{ id: string }>("SELECT id FROM jobs WHERE type = 'niche' AND status != 'done'");
    await nicheJob.applyResult(h.env, job2.id, null, await nicheJob.fakeRun!(h.env, job2.id, null, {}));
    expect(h.all("SELECT kind FROM emails_sent WHERE kind = 'niche_note'")).toHaveLength(1);
    expect((await h.call("GET", "/api/brain/niche")).json).toMatchObject({ leads: "niche" });
  });
  it("the spec says whether a call to action was chosen (opt-in) and whether this is a creator", async () => {
    const h = await harness();
    const spec = (await nicheJob.buildSpec(h.env, "job_c", null)) as NicheSpec;
    expect(typeof spec.has_cta).toBe("boolean");
    expect(spec.creator).toBe(false);
  });
  it("nothing usable: nothing stored, a yellow light, the last playbook stays", async () => {
    const h = await harness();
    await nicheJob.applyResult(h.env, "job_x", null, { playbook: {} });
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM niche_playbooks").n).toBe(0);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = ?", "What's working in your niche").light).toBe("yellow");
  });
});
