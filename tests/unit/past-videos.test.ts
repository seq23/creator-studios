// Learn from my past videos (owner's plan, 23 Oct 2026): her old FINISHED videos upload apart from
// footage and are never cut; the pastvideos job's section lands in a NEW unlocked profile version
// (a locked one is never changed underneath her), survives a redraft from docs, and every AI step
// that writes for her clips reads it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { jobStorageScope, mayRead } from "@worker/lib/jobStorage";
import { pastVideosJob, PAST_READ_KEY } from "@worker/jobs/pastvideos";
import { cutJob, type CutSpec } from "@worker/jobs/cut";
import { keepVideoFeel, emptySections } from "@worker/domain/profile";
import { feelLine } from "@shared/videoFeel";
import { getSetting } from "@worker/lib/db";

const FEEL = "Hooks and first 2 seconds: The finished result first.\nPacing and cut length: Quick: a cut about every 2 seconds.";

async function uploadPast(h: Awaited<ReturnType<typeof harness>>, name: string) {
  const bytes = new Uint8Array(400).fill(7);
  const start = await h.call("POST", "/api/uploads/start", { kind: "past_video", fileName: name, size: bytes.length, mimeType: "video/mp4" });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  const part = await h.request("PUT", `/api/uploads/${start.json.id}/parts/1?key=${encodeURIComponent(start.json.key)}&uploadId=${encodeURIComponent(start.json.uploadId)}`, bytes, { "content-type": "application/octet-stream" });
  expect((await h.call("POST", `/api/uploads/${start.json.id}/complete`, { key: start.json.key, uploadId: start.json.uploadId, parts: [await part.json()] })).status).toBe(200);
  return start.json as { id: string; key: string };
}

describe("past videos are kept apart from footage and never cut", () => {
  it("upload to pastvideos/, never into a dump; the cutter may not read them, the watcher may not read footage", async () => {
    const h = await harness();
    const up = await uploadPast(h, "old-hit.mp4");
    expect(up.key).toBe(`pastvideos/${up.id}`);
    expect(h.one<{ upload_status: string }>("SELECT upload_status FROM past_videos WHERE id = ?", up.id).upload_status).toBe("uploaded");
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM assets").n).toBe(0);
    expect(mayRead(jobStorageScope("cut", "job_c", "dmp_abcdef"), up.key)).toBe(false);
    expect(mayRead(jobStorageScope("cut", "job_c", "dmp_abcdef/clp_abcdef"), up.key)).toBe(false);
    expect(mayRead(jobStorageScope("pastvideos", "job_p", null), up.key)).toBe(true);
    expect(mayRead(jobStorageScope("pastvideos", "job_p", null), "raw/dmp_abcdef/ast_1")).toBe(false);
  });

  it("asks for 3 before watching, starts one job, and refuses an 11th video", async () => {
    const h = await harness();
    await uploadPast(h, "a.mp4");
    await uploadPast(h, "b.mp4");
    const early = await h.call("POST", "/api/brain/past-videos/read");
    expect(early.status).toBe(409);
    expect(early.json.error).toBe("Add at least 3 of your past videos first (you have 2).");
    await uploadPast(h, "c.mp4");
    const r = await h.call("POST", "/api/brain/past-videos/read");
    expect(r.status).toBe(200);
    expect((await h.call("POST", "/api/brain/past-videos/read")).json).toMatchObject({ already: true, jobId: r.json.jobId });
    const spec = (await pastVideosJob.buildSpec(h.env, r.json.jobId, null)) as { videos: { r2_key: string }[] };
    expect(spec.videos.map((v) => v.r2_key.split("/")[0])).toEqual(["pastvideos", "pastvideos", "pastvideos"]);
    for (let i = 0; i < 7; i++) await uploadPast(h, `more-${i}.mp4`);
    const eleventh = await h.call("POST", "/api/uploads/start", { kind: "past_video", fileName: "x.mp4", size: 10, mimeType: "video/mp4" });
    expect(eleventh.status).toBe(409);
  });
});

describe("How my videos feel lands in the Brand Profile without touching a locked one", () => {
  it("a locked profile stays exactly as it was; the section goes into a new unlocked draft, and the clips keep the locked one", async () => {
    const h = await harness();
    h.db.raw.exec("UPDATE brand_profile SET locked_at = '2026-10-20T10:00:00.000Z'");
    const before = h.one<{ version: number; sections: string }>("SELECT version, sections FROM brand_profile WHERE locked = 1");
    await uploadPast(h, "a.mp4");
    await pastVideosJob.applyResult(h.env, "job_x", null, { section: FEEL, videos: 3, by: "rules" });
    expect(h.one<{ sections: string; locked: number }>("SELECT sections, locked FROM brand_profile WHERE version = ?", before.version)).toEqual({ sections: before.sections, locked: 1 });
    const brain = await h.call("GET", "/api/brain");
    expect(brain.json.profile).toMatchObject({ locked: false });
    expect(brain.json.profile.sections.video_feel).toBe(FEEL);
    expect(brain.json.profile.sections.voice).toBe("warm");
    expect(brain.json.inUse.version).toBe(before.version);
    expect(brain.json.pastVideos.read).toMatchObject({ videos: 3, by: "rules", version: brain.json.profile.version, lockedInUse: true });
    // The cut reads the locked one until she locks the new draft; then it reads the section.
    await h.dumpWith("dmp_feel", [{ id: "ast_f", name: "f.mp4", mime: "video/mp4" }]);
    const job = await h.cut("dmp_feel");
    expect(((await cutJob.buildSpec(h.env, job, "dmp_feel")) as CutSpec).brand_profile?.video_feel ?? "").toBe("");
    expect((await h.call("POST", "/api/brain/profile/lock")).status).toBe(200);
    expect(((await cutJob.buildSpec(h.env, job, "dmp_feel")) as CutSpec).brand_profile?.video_feel).toBe(FEEL);
  });

  it("with an unlocked profile the section joins the newest version as a new draft she can edit", async () => {
    const h = await harness();
    h.db.raw.exec("UPDATE brand_profile SET locked = 0");
    await pastVideosJob.applyResult(h.env, "job_y", null, { section: `  ${FEEL}\n\n`, videos: 4, by: "ai" });
    const read = await getSetting<{ lockedInUse: boolean }>(h.env.DB, PAST_READ_KEY, { lockedInUse: true });
    expect(read.lockedInUse).toBe(false);
    expect((await h.call("PATCH", "/api/brain/profile", { sections: { video_feel: "Pacing: slow, long takes." } })).status).toBe(200);
    expect((await h.call("GET", "/api/brain")).json.profile.sections.video_feel).toBe("Pacing: slow, long takes.");
  });

  it("an empty section is refused (the job failed quietly), and a redraft from docs keeps the section", async () => {
    const h = await harness();
    await expect(pastVideosJob.applyResult(h.env, "job_z", null, { section: "  " })).rejects.toThrow();
    const next = keepVideoFeel({ ...emptySections(), who: "new" }, { video_feel: FEEL });
    expect(next).toMatchObject({ who: "new", video_feel: FEEL });
    expect(keepVideoFeel({ ...emptySections(), video_feel: "" }, null).video_feel).toBe("");
  });
});

describe("every AI step that writes for her clips reads it", () => {
  it("the Worker's caption and voice prompts, and the job's copy prompts", () => {
    expect(feelLine({ video_feel: FEEL })).toContain("The finished result first.; Pacing and cut length");
    expect(feelLine({ video_feel: "" })).toBe("");
    expect(readFileSync("worker/lib/wordsPass.ts", "utf8")).toMatch(/\$\{feelLine\(profile\)\}/);
    expect(readFileSync("worker/lib/autoVoice.ts", "utf8")).toMatch(/\$\{feelLine\(profile\)\}/);
    expect(readFileSync("jobs/plan.py", "utf8")).toMatch(/"how_her_videos_feel": prof\.get\("video_feel", ""\)/);
    // The neutral copy prompt keeps "How my videos feel" (calls to action now go through voice_context, opt-in),
    // and every hook writer in the cut reads it through voice_context, where it LEADS the niche research.
    expect(readFileSync("jobs/cut.py", "utf8")).toMatch(/"off_limits", "video_feel"\)/);
    expect(readFileSync("jobs/cut.py", "utf8")).toMatch(/"how_her_videos_feel": feel, "what_leads": "how_her_videos_feel leads; the niche research only supports it"/);
  });
});
