// "It listens" (owner, 13 Nov 2026), the Worker side:
//   - a rejected post deleted for good still teaches the studio (its reason and words stay on the row);
//   - "Wrong words" is not a no: the post stays in New, its words are written again, and the line
//     she turned down is remembered;
//   - when no AI model could look at her videos nothing generic is made: the upload waits, she reads
//     one plain line, it is tried again by itself, and after MODEL_WAIT_TRIES it stops for her helper.
// The parser, the line said back and the plain summary are in tests/unit/steer.test.ts.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers/studio-fix-env";
import { cutJob, MODEL_GAVE_UP_LINE, MODEL_WAIT_LINE, MODEL_WAIT_TRIES, plainFailure, retryWaitingCuts } from "@worker/jobs/cut";
import { loadMemory } from "@worker/domain/studioMemory";
import { dispatchJob } from "@worker/services/github";
import { REJECT_REASONS, WRONG_WORDS } from "@shared/constants";

async function cutDump(id = "dmp_l") {
  const h = await harness();
  await h.dumpWith(id, [{ id: `ast_${id}`, name: "a.mp4", mime: "video/mp4" }]);
  await h.cut(id);
  const clips = h.all<{ id: string; hook_text: string; number: number }>("SELECT id, hook_text, number FROM clips WHERE dump_id = ? AND style_of IS NULL ORDER BY number", id);
  return { h, clips };
}

describe("delete for good never erases what was learned", () => {
  it("a rejected post, then deleted from the bin: its reason and its words still reach the next cut", async () => {
    const { h, clips } = await cutDump();
    const [a, b, c] = clips;
    expect((await h.call("POST", `/api/clips/${a!.id}/reject`, { reason: "too long" })).status).toBe(200);
    expect((await h.call("POST", `/api/clips/${b!.id}/reject`, {})).status).toBe(200); // a no with no reason
    const before = await loadMemory(h.env);
    expect(before.turned_down_hooks).toEqual(expect.arrayContaining([a!.hook_text.slice(0, 80), b!.hook_text.slice(0, 80)]));
    const decided = h.one<{ reviewed_at: string }>("SELECT reviewed_at FROM clips WHERE id = ?", a!.id).reviewed_at;

    expect((await h.call("DELETE", `/api/clips/${a!.id}`)).status).toBe(200);
    expect((await h.call("DELETE", `/api/clips/${b!.id}`)).status).toBe(200);
    // a post deleted without ever being rejected is not a rated no
    expect((await h.call("DELETE", `/api/clips/${c!.id}`)).status).toBe(200);

    const rows = h.all<{ id: string; status: string; reject_reason: string | null; reviewed_at: string }>("SELECT id, status, reject_reason, reviewed_at FROM clips WHERE id IN (?, ?, ?)", a!.id, b!.id, c!.id);
    expect(rows.find((r) => r.id === a!.id)).toMatchObject({ status: "deleted", reject_reason: "too long", reviewed_at: decided });
    expect(rows.find((r) => r.id === b!.id)).toMatchObject({ status: "deleted", reject_reason: "other" });
    expect(rows.find((r) => r.id === c!.id)).toMatchObject({ status: "deleted", reject_reason: null });

    const after = await loadMemory(h.env);
    expect(after.turned_down_hooks).toEqual(before.turned_down_hooks);
    expect(after.reject_reasons).toEqual(expect.arrayContaining(["too long", "other"]));
    expect(after.rejection.reviewed).toBe(before.rejection.reviewed);
    expect(after.turned_down_hooks).not.toContain(c!.hook_text.slice(0, 80));
    // and it travels in the next cut's instructions
    const spec = (await cutJob.buildSpec(h.env, "job_next", "dmp_l")) as { memory: { turned_down_hooks: string[] } };
    expect(spec.memory.turned_down_hooks).toContain(a!.hook_text.slice(0, 80));
  });
});

describe("\"Wrong words\" rewrites the words instead of rejecting", () => {
  it("is one of the reasons she can pick", () => {
    expect(REJECT_REASONS).toContain(WRONG_WORDS);
  });
  it("the post stays in New with its words being written again, and the old line is remembered as turned down", async () => {
    const { h, clips } = await cutDump("dmp_w");
    const target = clips[0]!;
    expect(target.hook_text.trim()).not.toBe("");
    const r = await h.call("POST", `/api/clips/${target.id}/reject`, { reason: WRONG_WORDS });
    expect(r.status).toBe(200);
    expect(r.json.rewriting).toBe(true);
    const row = h.one<{ status: string; reject_reason: string | null; hook_text: string; words_pending: number }>("SELECT status, reject_reason, hook_text, words_pending FROM clips WHERE id = ?", target.id);
    expect(row.status).toBe("draft");
    expect(row.reject_reason).toBeNull();
    // new words, or waiting for them: never the line she said no to
    expect(row.hook_text).not.toBe(target.hook_text);
    // the others are untouched
    expect(h.one<{ hook_text: string }>("SELECT hook_text FROM clips WHERE id = ?", clips[1]!.id).hook_text).toBe(clips[1]!.hook_text);
    // an operator action on the existing rewrite path, by her, not the host developer
    const ev = h.one<{ actor: string; detail: string }>("SELECT actor, detail FROM events WHERE kind = 'dump.rewrite_words' AND ref_id = 'dmp_w'");
    expect(ev.actor).toBe("owner@example.com");
    expect(JSON.parse(ev.detail)).toMatchObject({ cleared: 1, by: "wrong words" });
    const m = await loadMemory(h.env);
    expect(m.turned_down_hooks[0]).toBe(target.hook_text.slice(0, 80));
    expect(m.reject_reasons).toContain("wrong words");
    // it is not a rejection: the rate that switches the studio to "careful" does not move
    expect(m.rejection.reviewed).toBe(0);
  });
  it("several at once: each is rewritten, none is rejected", async () => {
    const { h, clips } = await cutDump("dmp_w2");
    const ids = clips.slice(0, 2).map((c) => c.id);
    const r = await h.call("POST", "/api/clips/bulk", { action: "reject", ids, reason: WRONG_WORDS });
    expect(r.json).toMatchObject({ done: 2, rewriting: 2 });
    expect(h.all("SELECT id FROM clips WHERE dump_id = 'dmp_w2' AND status = 'rejected'")).toEqual([]);
  });
  it("any other reason is still a plain no", async () => {
    const { h, clips } = await cutDump("dmp_w3");
    await h.call("POST", `/api/clips/${clips[0]!.id}/reject`, { reason: "bad hook" });
    expect(h.one<{ status: string; reject_reason: string }>("SELECT status, reject_reason FROM clips WHERE id = ?", clips[0]!.id)).toEqual({ status: "rejected", reject_reason: "bad hook" });
  });
});

describe("no model answered: nothing generic, the upload waits and is tried again", () => {
  async function waiting() {
    const h = await harness();
    await h.dumpWith("dmp_m", [{ id: "ast_m", name: "a.mp4", mime: "video/mp4" }]);
    const job = await dispatchJob(h.env, "cut", "dmp_m");
    await cutJob.onFailure(h.env, job.jobId!, "dmp_m", "NoModelYet");
    h.db.raw.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.jobId);
    return h;
  }
  const dump = (h: Awaited<ReturnType<typeof harness>>) => h.one<{ status: string; error_summary: string | null }>("SELECT status, error_summary FROM dumps WHERE id = 'dmp_m'");

  it("she reads one plain line, the upload is not failed, and no posts were made", async () => {
    const h = await waiting();
    expect(dump(h)).toEqual({ status: "queued", error_summary: "Your posts are taking longer than usual. Nothing is needed from you." });
    expect(MODEL_WAIT_LINE).toBe(dump(h).error_summary);
    expect(h.all("SELECT id FROM clips WHERE dump_id = 'dmp_m'")).toEqual([]);
    // a named stop someone sees: a yellow light for the helper with the fix guide
    expect(h.one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'Posts waiting for the AI'")).toEqual({ light: "yellow", fix_guide: "connect-openrouter" });
    // the screen gets the line while it waits
    const got = await h.call("GET", "/api/dumps/dmp_m");
    expect(got.json.dump).toMatchObject({ status: "queued", error_summary: MODEL_WAIT_LINE });
  });
  it("the hourly lane sends it again, once; while that try is out it is not sent twice", async () => {
    const h = await waiting();
    const jobs = () => h.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'cut' AND ref_id = 'dmp_m'").n;
    expect(jobs()).toBe(1);
    expect(await retryWaitingCuts(h.env)).toBe(1);
    expect(jobs()).toBe(2);
    expect(await retryWaitingCuts(h.env)).toBe(0);
    expect(jobs()).toBe(2);
  });
  it("when a model answers on a later try the posts land and the wait is over", async () => {
    const h = await waiting();
    await retryWaitingCuts(h.env);
    const job = h.one<{ id: string }>("SELECT id FROM jobs WHERE type = 'cut' AND ref_id = 'dmp_m' ORDER BY created_at DESC, rowid DESC LIMIT 1");
    await cutJob.applyResult(h.env, job.id, "dmp_m", await cutJob.fakeRun!(h.env, job.id, "dmp_m", { clips: 3 }));
    expect(dump(h)).toEqual({ status: "ready", error_summary: null });
    h.db.raw.prepare("UPDATE jobs SET status = 'done' WHERE ref_id = 'dmp_m'").run();
    expect(await retryWaitingCuts(h.env)).toBe(0);
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = 'Posts waiting for the AI'").light).toBe("green");
  });
  it(`after ${MODEL_WAIT_TRIES} tries it stops for her helper in plain words, with a red light; it never loops forever`, async () => {
    const h = await waiting();
    for (let i = 1; i < MODEL_WAIT_TRIES; i++) await cutJob.onFailure(h.env, `job_try${i}`, "dmp_m", "NoModelYet: no model could look at the videos");
    expect(dump(h).status).toBe("queued");
    await cutJob.onFailure(h.env, "job_last", "dmp_m", "NoModelYet");
    expect(dump(h)).toEqual({ status: "failed", error_summary: MODEL_GAVE_UP_LINE });
    expect(h.one<{ light: string }>("SELECT light FROM health WHERE name = 'Posts waiting for the AI'").light).toBe("red");
    expect(await retryWaitingCuts(h.env)).toBe(0);
  });
  it("any other failure still fails at once, and too-short videos say what to add", async () => {
    const h = await harness();
    await h.dumpWith("dmp_m", [{ id: "ast_m", name: "a.mp4", mime: "video/mp4" }]);
    await cutJob.onFailure(h.env, "job_x", "dmp_m", "TooShort");
    expect(dump(h)).toEqual({ status: "failed", error_summary: "These videos are too short for a reel. Add videos of 8 seconds or more." });
    expect(plainFailure("NoUsableMoments")).toMatch(/couldn't find any usable moments/);
  });
});
