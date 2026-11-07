// The niche brief (owner, 7 Nov 2026): "do it once each time a new user to each studio gets ready to
// dump / upload photos". Research runs ONCE, at a new user's first dump, and never again; while it
// runs the dump waits with a calm line and goes by itself; a failed run is a named stop that blocks
// every writer (never generic copy); an existing studio runs nothing; Porch & Party reads its seeded
// brief. worker/lib/nicheBrief.ts.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { BRIEF_WAITING, briefState, currentBrief, writerGate } from "@worker/lib/nicheBrief";
import { wordsPass } from "@worker/lib/wordsPass";
import { makePack } from "@worker/lib/photoPosts";
import type { Env } from "@worker/env";

async function uploadingDump(h: Awaited<ReturnType<typeof harness>>, id: string) {
  h.db.raw.exec(`INSERT INTO dumps (id, door, notes, status, created_at) VALUES ('${id}', 'new', '', 'uploading', '2026-11-07T15:00:00.000Z')`);
  h.db.raw.prepare("INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES (?, ?, 'a.mp4', 'video/mp4', ?, 'uploaded')").run(`ast_${id}`, id, `raw/${id}/a`);
  await h.r2.FILES.put(`raw/${id}/a`, new Uint8Array(100).fill(1), { httpMetadata: { contentType: "video/mp4" } });
}
const briefJobs = (h: Awaited<ReturnType<typeof harness>>) => h.all<{ id: string }>("SELECT id FROM jobs WHERE type = 'niche' AND ref_id LIKE 'brief/%'");

describe("research runs once, at a new user's first upload, and never again", () => {
  it("the first dump waits with the calm line, the brief comes in, the dump goes by itself; a second dump starts nothing", async () => {
    const h = await harness({}, { brief: false });
    expect((await briefState(h.env)).state).toBe("none");
    await uploadingDump(h, "dmp_first");
    const first = await h.call("POST", "/api/dumps/dmp_first/dump");
    expect(first.status).toBe(409);
    expect(first.json.error).toBe(BRIEF_WAITING);
    expect(briefJobs(h)).toHaveLength(1);
    // Tapping Dump again while it researches starts nothing new.
    expect((await h.call("POST", "/api/dumps/dmp_first/dump")).json.error).toBe(BRIEF_WAITING);
    expect(briefJobs(h)).toHaveLength(1);
    // The research answers (the job's callback): the brief is stored and the waiting dump goes by itself.
    const job = h.one<{ id: string; ref_id: string }>("SELECT id, ref_id FROM jobs WHERE type = 'niche' AND ref_id LIKE 'brief/%'");
    const { nicheJob } = await import("@worker/jobs/niche");
    await nicheJob.applyResult(h.env as Env, job.id, job.ref_id, await nicheJob.fakeRun!(h.env as Env, job.id, job.ref_id, {}));
    const s = await briefState(h.env);
    expect(s.state).toBe("ready");
    expect(h.one<{ status: string }>("SELECT status FROM dumps WHERE id = 'dmp_first'").status).not.toBe("uploading");
    // Every later dump and photo pack: no research, ever again.
    await uploadingDump(h, "dmp_second");
    const second = await h.call("POST", "/api/dumps/dmp_second/dump");
    expect(second.status).toBe(200);
    expect(briefJobs(h)).toHaveLength(1);
    expect(h.all("SELECT id FROM niche_briefs")).toHaveLength(1);
  });

  it("an existing studio (dumps before briefs) runs nothing and writes as before; Porch & Party reads its seeded brief", async () => {
    const h = await harness({}, { brief: false });
    h.db.raw.exec("INSERT INTO dumps (id, door, notes, status, created_at) VALUES ('dmp_old', 'new', '', 'reviewed', '2026-10-01T15:00:00.000Z')");
    await uploadingDump(h, "dmp_new");
    expect((await h.call("POST", "/api/dumps/dmp_new/dump")).status).toBe(200);
    expect(briefJobs(h)).toHaveLength(0);
    expect(await writerGate(h.env)).toEqual({ ok: true, brief: null });
    const pnp = await harness({ STUDIO_SLUG: "sample1" } as never, { brief: false });
    const b = await currentBrief(pnp.env);
    expect(b?.competitors.length).toBeGreaterThanOrEqual(5);
    expect(b?.avoid.join(" ")).toMatch(/Pinterest/);
    expect(briefJobs(pnp)).toHaveLength(0);
  });
});

describe("the cut's writers read the brief", () => {
  it("its openings lead the playbook's hooks and its patterns and never-words join the caption tips", async () => {
    const { withBrief } = await import("@worker/jobs/cut");
    const { cleanBrief } = await import("@shared/nicheBrief");
    const { READY_BRIEF } = await import("./helpers/niche-brief");
    const b = cleanBrief(JSON.parse(READY_BRIEF))!;
    const p = withBrief({ updated_at: "x", formats: ["Reveal"], hooks: ["Old hook"], caption_tips: ["Old tip"] }, b)!;
    expect(p.hooks.slice(0, 3)).toEqual(b.hooks);
    expect(p.hooks).toContain("Old hook");
    expect(p.caption_tips).toContain("Never: Describing what is on screen");
    expect(withBrief(null, null)).toBeNull();
  });
});

describe("a failed research run blocks the writers (never generic copy)", () => {
  it("no words, no photo captions, no dump; the named stop shows with Try again, which runs it once more", async () => {
    const h = await harness({}, { brief: false });
    h.db.raw.exec(`INSERT INTO niche_briefs (id, user_email, status, error, origin, created_at, updated_at) VALUES ('nbr_x', 'owner@example.com', 'failed', 'The free research found 2 real accounts in this niche (5 are needed). Nothing is written for your studio until it works. Tap Try again.', 'research', '2026-11-07T15:00:00.000Z', '2026-11-07T15:00:00.000Z')`);
    // A clip waiting for its words stays waiting: nothing written.
    h.db.raw.exec(`INSERT INTO dumps (id, door, notes, status, created_at) VALUES ('dmp_w', 'new', '', 'ready', '2026-11-07T15:00:00.000Z');
      INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('ast_w', 'dmp_w', 'a.mp4', 'video/mp4', 'raw/dmp_w/a', 'uploaded');
      INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, r2_key, status, words_pending, number) VALUES ('clp_w0000001', 'ast_w', 'dmp_w', 0, 5, 'montage', 'clips/dmp_w/w.mp4', 'draft', 1, 1);`);
    const r = await wordsPass(h.env);
    expect(r.written).toBe(0);
    expect(h.one<{ words_pending: number; caption: string }>("SELECT words_pending, caption FROM clips WHERE id = 'clp_w0000001'")).toEqual({ words_pending: 1, caption: "" });
    // Photo posts: refused with the named stop, no captions written.
    h.db.raw.exec("INSERT INTO photo_packs (id, note, status) VALUES ('pck_w', 'A room', 'uploading'); INSERT INTO pack_photos (id, pack_id, role, file_name, mime_type, r2_key, upload_status) VALUES ('pph_w', 'pck_w', 'main', 'a.jpg', 'image/jpeg', 'photos/a', 'uploaded');");
    const made = await makePack(h.env, "pck_w", async () => ({ dispatched: true, error: null }));
    expect(made.ok).toBe(false);
    expect(made.error).toMatch(/Try again/);
    expect(h.one<{ captions: string | null; status: string }>("SELECT captions, status FROM photo_packs WHERE id = 'pck_w'")).toEqual({ captions: "[]", status: "uploading" });
    // A dump: the named stop with its guide, the dump keeps waiting.
    await uploadingDump(h, "dmp_f");
    const d = await h.call("POST", "/api/dumps/dmp_f/dump");
    expect(d.status).toBe(409);
    expect(d.json).toMatchObject({ error: expect.stringMatching(/Try again/), fix_guide: "niche-brief" });
    // The studio says so, with Try again; Try again runs it once more.
    expect((await briefState(h.env)).state).toBe("failed");
    expect(briefJobs(h)).toHaveLength(0);
    const { retryBrief } = await import("@worker/lib/nicheBrief");
    expect(await retryBrief(h.env as Env, "owner@example.com")).toMatchObject({ ok: true });
    expect(briefJobs(h)).toHaveLength(1);
    expect((await retryBrief(h.env as Env, "owner@example.com")).ok).toBe(false); // already running: no second run
  });
});
