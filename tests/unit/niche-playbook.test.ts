// "What's working in your niche" (studio fix, 23 Oct 2026): researched monthly ($0), stored in D1,
// handed to every cut, shown on the Brand page, and sent once as a short note through the studio's
// own email path (a studio with NOTIFY_EMAIL sends it only there).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanPlaybook, monthlyNicheRefresh, nicheDue, NICHE_EVERY_DAYS, summaryOf } from "@worker/lib/niche";
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
  });
  it("nothing usable: nothing stored, a yellow light, the last playbook stays", async () => {
    const h = await harness();
    await nicheJob.applyResult(h.env, "job_x", null, { playbook: {} });
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM niche_playbooks").n).toBe(0);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = ?", "What's working in your niche").light).toBe("yellow");
  });
});
