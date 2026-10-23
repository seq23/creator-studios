// Setup runs by itself (worker/lib/setupWait.ts, routes/dumps.ts sendDump/sendWaitingDumps):
// a Dump the setup gate refuses is kept as "waiting for setup" with her files saved; locking the
// Brand Profile starts the research; approving the brief sends every waiting dump through the Dump
// button's own path, exactly once. Unlocking the profile never stops her clips (lib/profileInUse.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { sendDump, sendWaitingDumps } from "@worker/routes/dumps";
import { ensureFirstResearch } from "@worker/lib/setupWait";
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
  /** The research job finished: a draft brief is waiting for her approval. */
  const draftLands = () => h.db.raw.exec("UPDATE jobs SET status = 'done' WHERE type = 'research'; INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft');");
  return { ...h, cutJobs, researchJobs, dump, draftLands };
}

describe("a Dump refused by setup waits, with a plain checklist", () => {
  it("marks the dump waiting and says what is left, with a link and a tick per step", async () => {
    const h = await fresh();
    const r = await h.call("POST", "/api/dumps/dmp_w/dump");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Your 3 videos are saved. Two quick steps first, then your clips start by themselves:");
    expect(r.json.setup.files).toBe(3);
    expect(r.json.setup.steps.map((s: { key: string; done: boolean; href: string }) => [s.key, s.done, s.href])).toEqual([
      ["profile", false, "/brain"],
      ["brief", false, "/research"],
    ]);
    expect(h.dump()).toMatchObject({ status: "uploading" });
    expect(h.dump().waiting_setup_at).toBeTruthy();
    expect(h.cutJobs()).toBe(0);
    // The dump card says what it is waiting for instead of looking stuck.
    const list = await h.call("GET", "/api/dumps");
    expect(list.json.items[0].waiting_for.map((s: { key: string }) => s.key)).toEqual(["profile", "brief"]);
  });

  it("ticks the profile once locked, and says only one step is left", async () => {
    const h = await fresh();
    expect((await h.call("POST", "/api/brain/profile/lock")).status).toBe(200);
    const r = await h.call("POST", "/api/dumps/dmp_w/dump");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Your 3 videos are saved. One quick step first, then your clips start by themselves:");
    expect(r.json.setup.steps.map((s: { done: boolean }) => s.done)).toEqual([true, false]);
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
  it("starts nothing when a draft is already waiting or a brief is approved", async () => {
    const h = await fresh();
    h.db.raw.exec("INSERT INTO research_briefs (body, status) VALUES ('{}', 'draft')");
    expect((await h.call("POST", "/api/brain/profile/lock")).json.researchStarted).toBe(false);
    expect(h.researchJobs()).toBe(0);
  });
});

describe("approving the brief sends every waiting dump, exactly once", () => {
  it("auto-sends the waiting dump through the Dump button's path", async () => {
    const h = await fresh();
    await h.call("POST", "/api/dumps/dmp_w/dump");
    await h.call("POST", "/api/brain/profile/lock");
    h.draftLands();
    const r = await h.call("POST", "/api/research/approve");
    expect(r.json).toMatchObject({ ok: true, sent: 1 });
    expect(h.dump()).toEqual({ status: "cutting", waiting_setup_at: null });
    expect(h.cutJobs()).toBe(1);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'dump.sent' AND ref_id = 'dmp_w'").n).toBe(1);
  });

  it("never sends a dump twice: again, the Dump button after it, and a race all leave one cut job", async () => {
    const h = await fresh();
    await h.call("POST", "/api/dumps/dmp_w/dump");
    await h.call("POST", "/api/brain/profile/lock");
    h.draftLands();
    // The button and the automatic send at the same moment.
    const [auto, button] = await Promise.all([sendWaitingDumps(h.env, null), sendDump(h.env, "dmp_w", null, true)]);
    expect(auto).toEqual([]); // the gate is still closed: the brief is a draft
    expect(button.ok).toBe(false);
    expect(h.cutJobs()).toBe(0);
    await h.call("POST", "/api/research/approve");
    expect(h.cutJobs()).toBe(1);
    expect(await sendWaitingDumps(h.env, null)).toEqual([]);
    expect((await h.call("POST", "/api/dumps/dmp_w/dump")).json.error).toBe("This dump was already sent.");
    expect(h.cutJobs()).toBe(1);
  });

  it("two sends racing once the gate is open still cut once", async () => {
    const h = await fresh();
    await h.call("POST", "/api/dumps/dmp_w/dump");
    await h.call("POST", "/api/brain/profile/lock");
    h.draftLands();
    h.db.raw.exec("UPDATE research_briefs SET status = 'approved'");
    const [a, b, c] = await Promise.all([sendWaitingDumps(h.env, null), sendWaitingDumps(h.env, null), sendDump(h.env, "dmp_w", null, false)]);
    expect(a.length + b.length + (c.ok ? 1 : 0)).toBe(1);
    expect(h.cutJobs()).toBe(1);
  });

  it("sends nothing when no dump is waiting", async () => {
    const h = await fresh();
    await h.call("POST", "/api/brain/profile/lock");
    h.draftLands();
    const r = await h.call("POST", "/api/research/approve");
    expect(r.json).toMatchObject({ ok: true, sent: 0 });
    expect(h.dump()).toEqual({ status: "uploading", waiting_setup_at: null });
    expect(h.cutJobs()).toBe(0);
  });
});

describe("unlocking the Brand Profile never stops her clips", () => {
  it("a Dump goes through while unlocked, and the cut reads the version locked last", async () => {
    const h = await fresh();
    const locked = (await h.call("POST", "/api/brain/profile/lock")).json.version as number;
    h.draftLands();
    await h.call("POST", "/api/research/approve");
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
