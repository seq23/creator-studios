// Clip numbers and versions (studio fix, 23 Oct 2026): "Oct 22 · Clip 5", stable per dump, never
// renumbered or reused, 5b/5c for new versions of the same clip, on cards, emails and the Calendar,
// and found by number in search. Earlier versions are kept to compare; Keep this one swaps back.
import { describe, expect, it } from "vitest";
import { clipCode, clipLabel, clipTag, parseClipSearch, versionLetter } from "@shared/clipNumber";
import { numberClips } from "@worker/jobs/cut";
import { harness } from "./helpers/studio-fix-env";

describe("the pure rules", () => {
  it("letters, codes, labels and tags", () => {
    expect([1, 2, 3, 26, 40].map(versionLetter)).toEqual(["", "b", "c", "z", "z"]);
    expect(clipCode(5)).toBe("5");
    expect(clipCode(5, 3)).toBe("5c");
    expect(clipCode(null)).toBe("");
    expect(clipLabel("2026-10-22T15:00:00.000Z", 5, 2, "America/Chicago")).toBe("Oct 22 · Clip 5b");
    // Late at night in UTC is still the audience's day.
    expect(clipLabel("2026-10-23T03:00:00.000Z", 1, 1, "America/Chicago")).toBe("Oct 22 · Clip 1");
    expect(clipTag("2026-10-22T15:00:00.000Z", 5, 2, "America/Chicago")).toBe("clip-1022-5b");
  });
  it("search words that are a clip number", () => {
    expect(parseClipSearch("5")).toEqual({ n: 5, version: null });
    expect(parseClipSearch("Clip 12")).toEqual({ n: 12, version: null });
    expect(parseClipSearch("#7")).toEqual({ n: 7, version: null });
    expect(parseClipSearch("5b")).toEqual({ n: 5, version: 2 });
    expect(parseClipSearch("clip 5c")).toEqual({ n: 5, version: 3 });
    expect(parseClipSearch("5 tips")).toBeNull();
    expect(parseClipSearch("0")).toBeNull();
  });
  it("styles share their clip's number; distinct clips count up from the dump's sequence", () => {
    const m = numberClips([{ id: "a", style_of: null }, { id: "b", style_of: "a" }, { id: "c", style_of: null }], 7);
    expect([...m.entries()]).toEqual([["a", 8], ["c", 9], ["b", 8]]);
  });
});

describe("through the real cut, Review and Calendar", () => {
  it("numbers 1..n in a dump, never reused after Start over; the email names them", async () => {
    const h = await harness();
    await h.dumpWith("dmp_n1", [{ id: "ast_n1", name: "a.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_n1", undefined, 4);
    const first = h.all<{ number: number }>("SELECT number FROM clips WHERE dump_id = 'dmp_n1' ORDER BY number").map((r) => r.number);
    expect(first).toEqual([1, 2, 3, 4]);
    const mail = h.one<{ subject: string }>("SELECT subject FROM emails_sent WHERE kind = 'clips_ready' ORDER BY sent_at DESC LIMIT 1");
    expect(mail.subject).toMatch(/4 clips ready/);
    // Reject clip 2, start over: the new clips continue at 5, 2 is never handed out again.
    const two = h.one<{ id: string }>("SELECT id FROM clips WHERE dump_id = 'dmp_n1' AND number = 2");
    await h.call("POST", `/api/clips/${two.id}/reject`, { reason: "bad cut" });
    await h.cut("dmp_n1", undefined, 3);
    const after = h.all<{ number: number; status: string }>("SELECT number, status FROM clips WHERE dump_id = 'dmp_n1' ORDER BY number");
    expect(after).toEqual([{ number: 2, status: "rejected" }, { number: 5, status: "draft" }, { number: 6, status: "draft" }, { number: 7, status: "draft" }]);
    expect(h.one<{ clip_seq: number }>("SELECT clip_seq FROM dumps WHERE id = 'dmp_n1'").clip_seq).toBe(7);
  });

  it("each dump has its own sequence; cards carry the label; search finds a clip by number", async () => {
    const h = await harness();
    await h.dumpWith("dmp_a", [{ id: "ast_a", name: "a.mp4", mime: "video/mp4" }]);
    await h.dumpWith("dmp_b", [{ id: "ast_b", name: "b.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_a", undefined, 3);
    await h.cut("dmp_b", undefined, 3);
    const list = await h.call("GET", "/api/clips?tab=new&q=clip%202");
    const found = list.json.groups.flatMap((g: { clips: { code: string; label: string; dump_id: string }[] }) => g.clips);
    expect(found.map((c: { code: string }) => c.code)).toEqual(["2", "2"]);
    expect(found[0].label).toBe("Oct 22 · Clip 2");
    expect(list.json.total).toBe(2);
  });

  it("Try another version keeps the number, takes the next letter, keeps the old one to compare; Keep this one swaps back", async () => {
    const h = await harness();
    await h.dumpWith("dmp_v", [{ id: "ast_v", name: "a.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_v", undefined, 3);
    const clip = h.one<{ id: string; r2_key: string; number: number }>("SELECT id, r2_key, number FROM clips WHERE dump_id = 'dmp_v' AND number = 1");
    const runAgain = async () => {
      const job = h.one<{ id: string; ref_id: string }>("SELECT id, ref_id FROM jobs WHERE type = 'cut' ORDER BY created_at DESC, rowid DESC LIMIT 1");
      const { cutJob } = await import("@worker/jobs/cut");
      await cutJob.applyResult(h.env, job.id, job.ref_id, await cutJob.fakeRun!(h.env, job.id, job.ref_id, {}));
    };
    expect((await h.call("POST", `/api/clips/${clip.id}/another`, { notes: "shorter" })).status).toBe(200);
    await runAgain();
    expect((await h.call("POST", `/api/clips/${clip.id}/another`, { notes: "end on the finished room" })).status).toBe(200);
    await runAgain();
    const now = h.one<{ number: number; version: number; r2_key: string }>("SELECT number, version, r2_key FROM clips WHERE id = ?", clip.id);
    expect(now).toMatchObject({ number: 1, version: 3 });
    const v = await h.call("GET", `/api/clips/${clip.id}/versions`);
    expect(v.json.versions.map((x: { code: string }) => x.code)).toEqual(["1b", "1"]);
    // Each kept version plays on her screens.
    const media = await h.request("GET", v.json.versions[1].media_url);
    expect(media.status).toBe(200);
    // Search "1c" finds the current one; "1b" finds nothing (it is a kept version, not the clip).
    expect((await h.call("GET", "/api/clips?tab=new&q=1c")).json.total).toBe(1);
    // Keep the very first one: it comes back as "1", and 1c is kept to compare.
    const kept = await h.call("POST", `/api/clips/${clip.id}/versions/${v.json.versions[1].id}/keep`);
    expect(kept.status).toBe(200);
    expect(kept.json.clip).toMatchObject({ code: "1", version: 1 });
    expect(kept.json.clip.media_url).toMatch(/\?v=/);
    expect(h.one<{ r2_key: string }>("SELECT r2_key FROM clips WHERE id = ?", clip.id).r2_key).toBe(clip.r2_key);
    const left = (await h.call("GET", `/api/clips/${clip.id}/versions`)).json.versions.map((x: { code: string }) => x.code);
    expect(left).toEqual(["1c", "1b"]);
    // Another try never reuses a letter: it is 1d.
    expect((await h.call("POST", `/api/clips/${clip.id}/another`, { notes: "less blur" })).status).toBe(200);
    await runAgain();
    expect(h.one<{ version: number }>("SELECT version FROM clips WHERE id = ?", clip.id).version).toBe(4);
  });

  it("the Calendar shows the clip label", async () => {
    const h = await harness();
    await h.dumpWith("dmp_c", [{ id: "ast_c", name: "a.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_c", undefined, 2);
    const c1 = h.one<{ id: string }>("SELECT id FROM clips WHERE dump_id = 'dmp_c' AND number = 1");
    await h.call("POST", `/api/clips/${c1.id}/approve`);
    const pool = await h.call("GET", "/api/posts/pool");
    expect((pool.json as unknown as { clip_label: string }[])[0].clip_label).toBe("Oct 22 · Clip 1");
    h.db.raw.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES ('pst_1', ?, 'tiktok', '2026-11-02T20:00:00.000Z', 'planned')").run(c1.id);
    const week = await h.call("GET", "/api/posts?from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z");
    expect((week.json as unknown as { clip_label: string }[])[0].clip_label).toBe("Oct 22 · Clip 1");
  });
});
