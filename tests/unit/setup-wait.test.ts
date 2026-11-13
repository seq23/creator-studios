// Nothing is held (owner, 13 Nov 2026; worker/lib/setupWait.ts selfSetup, routes/dumps.ts):
// an upload never waits for a locked profile or an approved brief. The studio locks its own first
// profile and puts its own brief to use; a later brief is used at once; uploads that were held
// before go on the next hourly run with no hand edit, each exactly once. Unlocking the profile
// never stops her clips (lib/profileInUse.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { sendDump, sendWaitingDumps } from "@worker/routes/dumps";
import { ensureFirstResearch, selfSetup } from "@worker/lib/setupWait";
import { researchJob } from "@worker/jobs/research";
import { cutJob, type CutSpec } from "@worker/jobs/cut";

const SECTIONS = '{"who":"We design gardens: Garden design","voice":"warm","ctas":"Message us.","themes":"Patios"}';

/** A studio with no setup done: one unlocked profile draft, no brief, one dump with 3 uploaded videos. */
async function fresh() {
  const h = await harness();
  h.db.raw.exec(`DELETE FROM research_briefs; DELETE FROM brand_profile;
    INSERT INTO brand_profile (sections, locked) VALUES ('${SECTIONS}', 0);`);
  await h.dumpWith("dmp_w", [
    { id: "ast_1", name: "a.mp4", mime: "video/mp4" },
    { id: "ast_2", name: "b.mp4", mime: "video/mp4" },
    { id: "ast_3", name: "c.mp4", mime: "video/mp4" },
  ]);
  h.db.raw.exec("UPDATE dumps SET status = 'uploading' WHERE id = 'dmp_w'");
  const cutJobs = () => h.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'cut' AND ref_id = 'dmp_w'").n;
  const researchJobs = () => h.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'research'").n;
  const dump = (id = "dmp_w") => h.one<{ status: string; waiting_setup_at: string | null }>("SELECT status, waiting_setup_at FROM dumps WHERE id = ?", id);
  /** A brief left as a draft by the old flow (written, never approved). */
  const draftLands = () => h.db.raw.exec("UPDATE jobs SET status = 'done' WHERE type = 'research'; INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft');");
  return { ...h, cutJobs, researchJobs, dump, draftLands };
}

const brief = (h: Awaited<ReturnType<typeof fresh>>) => h.db.raw.prepare("SELECT version, status FROM research_briefs ORDER BY version").all() as { version: number; status: string }[];
const profile = (h: Awaited<ReturnType<typeof fresh>>) => h.one<{ locked: number; locked_at: string | null }>("SELECT locked, locked_at FROM brand_profile ORDER BY version DESC LIMIT 1");

/** The research job the lock started comes back with its brief (the practice run's own result). */
async function researchLands(h: Awaited<ReturnType<typeof fresh>>) {
  const job = h.one<{ id: string }>("SELECT id FROM jobs WHERE type = 'research'");
  await researchJob.applyResult(h.env, job.id, null, await researchJob.fakeRun!(h.env, job.id, null, {}));
}

describe("an upload never waits for a locked profile or an approved brief", () => {
  it("goes at once: the studio locks its own first profile, and the research starts by itself", async () => {
    const h = await fresh();
    const r = await h.call("POST", "/api/dumps/dmp_w/dump");
    expect(r.status).toBe(200);
    expect(h.dump()).toEqual({ status: "cutting", waiting_setup_at: null });
    expect(h.cutJobs()).toBe(1);
    expect(profile(h).locked).toBe(1);
    expect(profile(h).locked_at).toBeTruthy();
    expect(h.researchJobs()).toBe(1);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'profile.self_locked'").n).toBe(1);
    // The cut reads the profile the studio just put to use.
    const job = h.one<{ id: string }>("SELECT id FROM jobs WHERE type = 'cut' AND ref_id = 'dmp_w'");
    expect(((await cutJob.buildSpec(h.env, job.id, "dmp_w")) as CutSpec).brand_profile).toMatchObject({ voice: "warm" });
  });

  it("goes even with no profile at all and no brief: nothing is held", async () => {
    const h = await fresh();
    h.db.raw.exec("DELETE FROM brand_profile");
    expect((await h.call("POST", "/api/dumps/dmp_w/dump")).status).toBe(200);
    expect(h.cutJobs()).toBe(1);
  });

  it("a profile too thin to use is not locked by the studio, and the upload still goes", async () => {
    const h = await fresh();
    h.db.raw.exec(`UPDATE brand_profile SET sections = '{"who":"A garden studio"}'`);
    expect((await h.call("POST", "/api/dumps/dmp_w/dump")).status).toBe(200);
    expect(profile(h).locked).toBe(0);
    expect(h.cutJobs()).toBe(1);
  });

  it("a profile she unlocked to edit is left alone: the version she locked last stays in use", async () => {
    const h = await fresh();
    const locked = (await h.call("POST", "/api/brain/profile/lock")).json.version as number;
    await h.call("POST", "/api/brain/profile/unlock");
    await h.call("PATCH", "/api/brain/profile", { sections: { voice: "brand new words" } });
    expect((await selfSetup(h.env, { lockProfile: true })).profile).toBeNull();
    const brain = await h.call("GET", "/api/brain");
    expect(brain.json.profile.locked).toBe(false);
    expect(brain.json.inUse.version).toBe(locked);
  });
});

describe("the studio puts its own brief to use", () => {
  it("the first brief is in use the moment the research writes it; no approve step exists", async () => {
    const h = await fresh();
    await h.call("POST", "/api/brain/profile/lock");
    await researchLands(h);
    const rows = brief(h);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1].status).toBe("approved");
    expect(rows.filter((r) => r.status === "draft")).toEqual([]);
    expect((await h.call("POST", "/api/research/approve")).status).toBe(404);
  });

  it("a later brief replaces the one in use at once", async () => {
    const h = await fresh();
    h.db.raw.exec("INSERT INTO research_briefs (body, status, approved_at) VALUES ('{}', 'approved', '2026-10-01T00:00:00.000Z'); INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft');");
    const newest = brief(h)[1].version;
    expect((await selfSetup(h.env, { lockProfile: false })).brief).toBe(newest);
    expect(brief(h).map((b) => b.status)).toEqual(["superseded", "approved"]);
    // Nothing to do the second time.
    expect(await selfSetup(h.env, { lockProfile: false })).toEqual({ profile: null, brief: null });
  });

  it("she can change the brief in use, and the cut reads her change", async () => {
    const h = await fresh();
    await h.call("POST", "/api/brain/profile/lock");
    await researchLands(h);
    const got = await h.call("GET", "/api/research");
    expect(got.json.brief.status).toBe("approved");
    const body = structuredClone(got.json.brief.body);
    const r = await h.call("PATCH", "/api/research", { body });
    expect(r.status).toBe(200);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'brief.edited'").n).toBe(1);
    expect(brief(h).filter((b) => b.status === "approved").length).toBe(1);
  });
});

describe("a studio that was held before the change flows by itself (no hand edit, no migration)", () => {
  /** The old state: profile never locked, a draft brief nobody approved, an upload marked waiting. */
  async function held() {
    const h = await fresh();
    h.draftLands();
    h.db.raw.exec("UPDATE dumps SET waiting_setup_at = '2026-11-10T00:00:00.000Z' WHERE id = 'dmp_w'");
    return h;
  }

  it("the next hourly run locks the profile, uses the draft and sends the waiting upload, once", async () => {
    const h = await held();
    expect(await sendWaitingDumps(h.env, null)).toEqual(["dmp_w"]);
    expect(h.dump()).toEqual({ status: "cutting", waiting_setup_at: null });
    expect(brief(h).map((b) => b.status)).toEqual(["approved"]);
    expect(profile(h).locked).toBe(1);
    expect(h.cutJobs()).toBe(1);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'dump.sent' AND ref_id = 'dmp_w'").n).toBe(1);
    expect(await sendWaitingDumps(h.env, null)).toEqual([]);
    expect((await h.call("POST", "/api/dumps/dmp_w/dump")).json.error).toBe("This dump was already sent.");
    expect(h.cutJobs()).toBe(1);
  });

  it("an unapproved draft with nothing waiting (a later version on a working studio) is used on the next run", async () => {
    const h = await fresh();
    await h.call("POST", "/api/brain/profile/lock");
    h.db.raw.exec("INSERT INTO research_briefs (body, status, approved_at) VALUES ('{}', 'approved', '2026-10-01T00:00:00.000Z'); INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft');");
    expect(await sendWaitingDumps(h.env, null)).toEqual([]);
    expect(brief(h).map((b) => b.status)).toEqual(["superseded", "approved"]);
    expect(h.dump()).toEqual({ status: "uploading", waiting_setup_at: null });
    expect(h.cutJobs()).toBe(0);
  });

  it("the hourly run and the button racing still cut once", async () => {
    const h = await held();
    const [a, b, c] = await Promise.all([sendWaitingDumps(h.env, null), sendWaitingDumps(h.env, null), sendDump(h.env, "dmp_w", null, false)]);
    expect(a.length + b.length + (c.ok ? 1 : 0)).toBe(1);
    expect(h.cutJobs()).toBe(1);
  });
});

describe("locking the Brand Profile starts the research", () => {
  it("starts one research job when no brief exists and none is running", async () => {
    const h = await fresh();
    const r = await h.call("POST", "/api/brain/profile/lock");
    expect(r.json).toMatchObject({ ok: true, researchStarted: true, sent: 0 });
    expect(h.researchJobs()).toBe(1);
    // Locking again while it runs never starts a second one.
    await h.call("POST", "/api/brain/profile/unlock");
    await h.call("POST", "/api/brain/profile/lock");
    expect(h.researchJobs()).toBe(1);
  });
  it("starts nothing when a brief is already there", async () => {
    const h = await fresh();
    h.db.raw.exec("INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft')");
    expect((await h.call("POST", "/api/brain/profile/lock")).json.researchStarted).toBe(false);
    expect(h.researchJobs()).toBe(0);
  });
});

describe("unlocking the Brand Profile never stops her clips", () => {
  it("a Dump goes through while unlocked, and the cut reads the version locked last", async () => {
    const h = await fresh();
    const locked = (await h.call("POST", "/api/brain/profile/lock")).json.version as number;
    h.draftLands();
    expect((await h.call("POST", "/api/brain/profile/unlock")).status).toBe(200);
    // She edits while unlocked: a newer, unlocked version exists.
    expect((await h.call("PATCH", "/api/brain/profile", { sections: { voice: "brand new words" } })).status).toBe(200);
    const brain = await h.call("GET", "/api/brain");
    expect(brain.json.profile.locked).toBe(false);
    expect(brain.json.inUse.version).toBe(locked);
    expect(brain.json.profile.version).toBeGreaterThan(locked);
    expect(brain.json.inUse.locked_at).toBeTruthy();

    const r = await h.call("POST", "/api/dumps/dmp_w/dump");
    expect(r.status).toBe(200);
    expect(h.cutJobs()).toBe(1);
    const job = h.one<{ id: string }>("SELECT id FROM jobs WHERE type = 'cut' AND ref_id = 'dmp_w'");
    const spec = (await cutJob.buildSpec(h.env, job.id, "dmp_w")) as CutSpec;
    expect(spec.brand_profile).toMatchObject({ voice: "warm", ctas: "Message us." });

    // Locking again switches every AI step to the new version.
    await h.call("POST", "/api/brain/profile/lock");
    const spec2 = (await cutJob.buildSpec(h.env, job.id, "dmp_w")) as CutSpec;
    expect(spec2.brand_profile?.voice).toBe("brand new words");
  });

  it("no Worker code reads the profile by `locked = 1` alone (it would go empty on unlock)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /brand_profile\s+WHERE\s+locked\s*=\s*1/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("worker");
    expect(hits).toEqual([]);
  });
});

describe("the backfill: a profile locked before locking started the research", () => {
  it("starts the research once, then never again the same day", async () => {
    const h = await fresh();
    h.db.raw.exec(`UPDATE brand_profile SET locked = 1, locked_at = '2026-10-23T23:28:40.000Z'`);
    expect(await ensureFirstResearch(h.env)).toBe(true);
    expect(h.researchJobs()).toBe(1);
    h.db.raw.exec("UPDATE jobs SET status = 'failed' WHERE type = 'research'");
    expect(await ensureFirstResearch(h.env)).toBe(false);
    expect(h.researchJobs()).toBe(1);
  });
  it("does nothing when she already pressed Refresh, or a brief exists, or nothing is locked", async () => {
    const h = await fresh();
    expect(await ensureFirstResearch(h.env)).toBe(false);
    h.db.raw.exec(`UPDATE brand_profile SET locked = 1, locked_at = '2026-10-23T23:28:40.000Z'`);
    expect((await h.call("POST", "/api/research/refresh")).status).toBe(200);
    expect(await ensureFirstResearch(h.env)).toBe(false);
    expect(h.researchJobs()).toBe(1);
  });
});
