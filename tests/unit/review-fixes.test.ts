// Review after the studio fix (23 Oct 2026): the engine's score (0..100) with its reasons, the bar
// from the studio's settings with the reason shown when a clip is hidden, styles as options of one
// clip (never counted as clips), words still being written, and the one-tap fixes that re-plan a
// clip through Try another version with keys the engine reads.
import { describe, expect, it } from "vitest";
import { FIX_KEYS, FIXES, cleanFixes, fixWords } from "@shared/fixes";
import { cutJob, groupStyles, parseCutResult, underBarReason, type AgainSpec } from "@worker/jobs/cut";
import { harness } from "./helpers/studio-fix-env";

const clip = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  asset_id: "ast_s",
  start_s: 0,
  end_s: 20,
  recipe: "montage",
  hook_text: "Look",
  caption: "Body\n\nBook: https://example.com/request\n\n#a\n\n—\nMade with AI",
  hashtags: ["a"],
  platforms: ["tiktok"],
  score: 80,
  r2_key: `clips/dmp_s/${id}.mp4`,
  cover_r2_key: null,
  parts: [[0, 20]],
  ...extra,
});
const ctx = { dumpId: "dmp_s", allowed: new Map([["ast_s", ["tiktok" as const]], ["ast_t", ["tiktok" as const]]]), rawKeys: new Set<string>(), bar: 70 };

describe("the engine's result fields", () => {
  it("0..100 score with reasons; under the studio's bar it is hidden with the reason", () => {
    const r = parseCutResult({ clips: [clip("clp_aaaaaaaa01", { score: 48, score_reasons: ["ends on a blurry shot"], clip_type: "POV walk-in reveal" })] }, ctx);
    expect(r.clips[0]).toMatchObject({ score: 48, hidden: true, clip_type: "POV walk-in reveal", score_reasons: ["ends on a blurry shot"] });
    expect(Number.isInteger(r.clips[0].score)).toBe(true);
    expect(r.clips[0].hidden_reason).toBe(underBarReason(48, 70, ["ends on a blurry shot"]));
    expect(r.clips[0].hidden_reason).toBe("it scored 48, under this studio's bar of 70: ends on a blurry shot");
    // At the bar it shows; the engine's own reason wins when it gives one.
    expect(parseCutResult({ clips: [clip("clp_aaaaaaaa02", { score: 70, score_reasons: [] })] }, ctx).clips[0].hidden).toBe(false);
    expect(parseCutResult({ clips: [clip("clp_aaaaaaaa03", { score: 30, score_reasons: [], hidden_reason: "re-cut once, still too shaky" })] }, ctx).clips[0].hidden_reason).toBe("re-cut once, still too shaky");
  });
  it("files_used only from this dump; hero, AI pictures, event, words pending kept", () => {
    const r = parseCutResult({ clips: [clip("clp_aaaaaaaa04", { files_used: ["ast_s", "ast_t", "ast_other"], hero_asset_id: "ast_t", uses_ai_images: true, event_group: "sat", words_pending: true })] }, ctx);
    expect(r.clips[0]).toMatchObject({ files_used: ["ast_s", "ast_t"], hero_asset_id: "ast_t", uses_ai_images: true, event_group: "sat", words_pending: true });
    expect(parseCutResult({ clips: [clip("clp_aaaaaaaa05", { hero_asset_id: "ast_other" })] }, ctx).clips[0]).toMatchObject({ hero_asset_id: null, files_used: ["ast_s"] });
  });
  it("styles: the same cut in another look is a style of the better one, named or not", () => {
    const r = parseCutResult(
      {
        clips: [
          clip("clp_bbbbbbbb01", { score: 75, look: "clean" }),
          clip("clp_bbbbbbbb02", { score: 90, look: "bold" }),
          clip("clp_bbbbbbbb03", { score: 85, parts: [[30, 50]], start_s: 30, end_s: 50 }),
          clip("clp_bbbbbbbb04", { score: 60, parts: [[60, 80]], start_s: 60, end_s: 80, style_of: "clp_bbbbbbbb03" }),
          clip("clp_bbbbbbbb05", { score: 88, parts: [[90, 110]], start_s: 90, end_s: 110, style_of: "clp_nothere01" }),
        ],
      },
      ctx,
    );
    const by = Object.fromEntries(r.clips.map((c) => [c.id, c.style_of]));
    expect(by).toEqual({ clp_bbbbbbbb01: "clp_bbbbbbbb02", clp_bbbbbbbb02: null, clp_bbbbbbbb03: null, clp_bbbbbbbb04: "clp_bbbbbbbb03", clp_bbbbbbbb05: null });
    expect(groupStyles([])).toEqual([]);
  });
});

describe("Review: styles, words pending, one-tap fixes", () => {
  async function cutWith(h: Awaited<ReturnType<typeof harness>>, clips: Record<string, unknown>[]) {
    for (const c of clips) await h.r2.FILES.put(String(c.r2_key), new Uint8Array(10));
    await h.cut("dmp_s", { clips });
  }
  it("a style is an option inside its clip's card, never counted; picking it makes it the clip", async () => {
    const h = await harness();
    await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
    await cutWith(h, [clip("clp_cccccccc01", { score: 90, look: "clean" }), clip("clp_cccccccc02", { score: 80, look: "bold" }), clip("clp_cccccccc03", { score: 85, parts: [[30, 50]], start_s: 30, end_s: 50 })]);
    const list = await h.call("GET", "/api/clips?tab=new");
    const cards = list.json.groups[0].clips as { id: string; code: string; styles: { id: string }[]; score_100: number }[];
    expect(cards.map((c) => c.id)).toEqual(["clp_cccccccc01", "clp_cccccccc03"]);
    expect(cards[0].styles.map((s) => s.id)).toEqual(["clp_cccccccc02"]);
    expect(cards[0].score_100).toBe(90);
    expect(list.json.counts.new).toBe(2);
    expect(cards.map((c) => c.code)).toEqual(["1", "2"]);
    const mail = h.one<{ subject: string }>("SELECT subject FROM emails_sent WHERE kind = 'clips_ready' ORDER BY sent_at DESC LIMIT 1");
    expect(mail.subject).toMatch(/^2 clips ready/);
    const picked = await h.call("POST", "/api/clips/clp_cccccccc01/style", { style_id: "clp_cccccccc02" });
    expect(picked.status).toBe(200);
    expect(picked.json.clip).toMatchObject({ id: "clp_cccccccc02", code: "1" });
    expect(picked.json.clip.styles.map((s: { id: string }) => s.id)).toEqual(["clp_cccccccc01"]);
    // Rejecting the clip takes its styles with it.
    await h.call("POST", "/api/clips/clp_cccccccc02/reject", {});
    expect(h.one<{ status: string }>("SELECT status FROM clips WHERE id = 'clp_cccccccc01'").status).toBe("rejected");
  });
  it("words still being written: shown, and Approve waits", async () => {
    const h = await harness();
    await h.dumpWith("dmp_s", [{ id: "ast_s", name: "a.mp4", mime: "video/mp4" }]);
    await cutWith(h, [clip("clp_dddddddd01", { words_pending: true })]);
    const card = (await h.call("GET", "/api/clips?tab=new")).json.groups[0].clips[0];
    expect(card.words_pending).toBe(true);
    const r = await h.call("POST", "/api/clips/clp_dddddddd01/approve");
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/still being written/);
    h.db.raw.exec("UPDATE clips SET words_pending = 0 WHERE id = 'clp_dddddddd01'");
    expect((await h.call("POST", "/api/clips/clp_dddddddd01/approve")).status).toBe(200);
  });
  it("one-tap fixes reach the engine as keys and words; a photo ending may use any photo of the dump", async () => {
    expect(FIX_KEYS).toEqual(["end_on_finished", "less_blur", "different_opening", "shorter", "photo_ending"]);
    expect(cleanFixes(["shorter", "nope", "less_blur", "shorter"])).toEqual(["less_blur", "shorter"]);
    expect(fixWords(["shorter"], "keep the team")).toBe(`keep the team; ${FIXES.shorter.words}`);
    const h = await harness();
    await h.dumpWith("dmp_s", [
      { id: "ast_s", name: "a.mp4", mime: "video/mp4" },
      { id: "ast_ph", name: "after.jpg", mime: "image/jpeg", exif: 1 },
    ]);
    await cutWith(h, [clip("clp_eeeeeeee01")]);
    expect((await h.call("POST", "/api/clips/clp_eeeeeeee01/fix", { fixes: [] })).status).toBe(422);
    const r = await h.call("POST", "/api/clips/clp_eeeeeeee01/fix", { fixes: ["photo_ending", "less_blur"] });
    expect(r.status).toBe(200);
    const job = h.one<{ id: string; ref_id: string }>("SELECT id, ref_id FROM jobs WHERE type = 'cut' ORDER BY created_at DESC, rowid DESC LIMIT 1");
    expect(job.ref_id).toBe("dmp_s/clp_eeeeeeee01/again");
    const spec = (await cutJob.buildSpec(h.env, job.id, job.ref_id)) as AgainSpec;
    expect(spec.fixes).toEqual(["less_blur", "photo_ending"]);
    expect(spec.change_request).toBe(`${FIXES.less_blur.words}; ${FIXES.photo_ending.words}`);
    expect(spec.assets.map((a) => a.id).sort()).toEqual(["ast_ph", "ast_s"]);
    // The card remembers what was asked.
    await cutJob.applyResult(h.env, job.id, job.ref_id, await cutJob.fakeRun!(h.env, job.id, job.ref_id, {}));
    const card = (await h.call("GET", "/api/clips?tab=new")).json.groups[0].clips[0];
    expect(card).toMatchObject({ fixes: ["less_blur", "photo_ending"], code: "1b", versions: 1 });
    expect(card.score_reasons).toEqual(["fixed: less blur", "fixed: photo ending"]);
  });
});
