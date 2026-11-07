// P&P captions v3 (owner, 7 Nov 2026): "people can see the rose petals and candles and dont need u to
// say it". The words pass refuses a hook, on-screen beat or caption that narrates the picture (fed back
// to the model as the reason), writes 2-4 short on-screen beats, and keeps no voice script while
// Automatic voice overs is off. A re-render burns the beats (worker/jobs/cut.ts parseBeats ->
// jobs/looks.py build_ass; jobs/tests/test_text_beats.py).
import { describe, expect, it } from "vitest";
import { narratesPicture } from "@shared/clipWords";
import { draftWords, parseDraft } from "@worker/lib/wordsPass";
import { parseBeats } from "@worker/jobs/cut";

const RULES = { cta_phrases: ["Check your date", "Tell us your date", "Request a quote"], cta_link: "https://example.com/request", ai_note: "all" as const, place_words: ["Memphis", "Germantown"] };
const SHOT = "A bedroom with a wooden floor and a bed. · A close-up of a gold balloon. · Red rose petals and white candles on a wooden floor.";
const none = () => [] as string[];

describe("never narrate the picture", () => {
  it("refuses the lines she rejected: they name what the viewer already sees", () => {
    expect(narratesPicture("Gold balloons float above rose petals and candlelight.", SHOT).length).toBeGreaterThanOrEqual(2);
    expect(narratesPicture("Gold balloon shines on rose petal path", SHOT).length).toBeGreaterThanOrEqual(2);
    expect(narratesPicture("Rose petals welcome you home", "A floor decorated with rose petals and lights").length).toBeGreaterThanOrEqual(2);
  });
  it("lets through lines that add what the video cannot show: who it is for, the ease, the occasion, the town", () => {
    for (const t of ["POV: they think you did all this", "You filled out one form", "We set up at home or at the hotel in Memphis.", "Her birthday. She has no idea.", "Skip the restaurant this anniversary"]) expect(narratesPicture(t, SHOT), t).toEqual([]);
    expect(narratesPicture("Christmas is 7 weeks out. Your porch?", "A front door decorated with Christmas-themed wreaths and garlands.")).toEqual([]);
  });
  it("no shot list, nothing to compare: never a refusal", () => {
    expect(narratesPicture("Gold balloons and rose petals", null)).toEqual([]);
  });
});

describe("the words pass writes beats and, with voice overs off, no voice", () => {
  const clip = { number: 1, uses_ai_images: true, on_screen: SHOT, seconds: 10.5 };
  const good = { hook: "POV: they think you did all this", beats: ["You filled out one form", "You take all the credit"], caption: "They walk in and think you spent all day on this. You spent five minutes on a form.", hashtags: ["#MemphisDecorator"], voice: "You walk in and it is waiting for you. We set it all up." };

  it("keeps the beats, and the voice script only when voice overs are on", () => {
    const off = draftWords(good, RULES, { ...clip, voiced: false }, none);
    expect(off.why).toBeNull();
    expect(off.words!.text_beats).toEqual(["You filled out one form", "You take all the credit"]);
    expect(off.words!.voice_script).toBeNull();
    const on = draftWords(good, RULES, { ...clip, voiced: true }, none);
    expect(on.words!.voice_script).toBeTruthy();
  });
  it("a hook, beat or caption that narrates the picture is refused with the reason", () => {
    for (const bad of [{ ...good, hook: "Gold balloon shines on rose petal path" }, { ...good, beats: ["Rose petals and candles"] }, { ...good, caption: "Gold balloons float above rose petals and candlelight." }]) {
      const d = draftWords(bad, RULES, clip, none);
      expect(d.words).toBeNull();
      expect(d.why).toMatch(/already on screen/);
    }
  });
  it("a beat over six words is refused", () => {
    expect(draftWords({ ...good, beats: ["This beat has far too many words in it"] }, RULES, clip, none).why).toMatch(/too long/);
  });
  it("beats come through the model's JSON, and only strings reach the renderer", () => {
    expect(parseDraft(JSON.stringify(good))!.beats).toEqual(good.beats);
    expect(parseBeats(JSON.stringify(["One", " ", 2, "Three", "Four", "Five"]))).toEqual(["One", "2", "Three", "Four"]);
    expect(parseBeats("not json")).toEqual([]);
    expect(parseBeats(null)).toEqual([]);
  });
});

describe("Review: Add a final photo (owner, 7 Nov 2026: it must END on the finished product)", () => {
  it("stores the photo in the clip's folder, makes the clip again, and the re-render ends on it; Remove takes it off", async () => {
    const { harness } = await import("./helpers/studio-fix-env");
    const { cutJob } = await import("@worker/jobs/cut");
    const h = await harness();
    await h.dumpWith("dmp_fp", [{ id: "ast_fp", name: "a.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_fp", undefined, 2);
    const clip = h.one<{ id: string }>("SELECT id FROM clips WHERE dump_id = 'dmp_fp' ORDER BY number LIMIT 1");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const res = await h.request("POST", `/api/clips/${clip.id}/final-photo`, jpeg, { "content-type": "image/jpeg" });
    expect(res.status).toBe(200);
    const row = h.one<{ final_photo_key: string; pending_look: string | null; rerender_job_id: string | null }>("SELECT final_photo_key, pending_look, rerender_job_id FROM clips WHERE id = ?", clip.id);
    expect(row.final_photo_key).toMatch(new RegExp(`^clips/dmp_fp/${clip.id}-final-[a-z0-9]+\\.jpg$`));
    expect(await h.r2.FILES.get(row.final_photo_key)).not.toBeNull();
    expect(row.pending_look).toBeTruthy();
    const spec = (await cutJob.buildSpec(h.env, "job_fp", `dmp_fp/${clip.id}`)) as { final_photo_key: string | null };
    expect(spec.final_photo_key).toBe(row.final_photo_key);
    // Shown on the card, so Review offers Remove instead of Add.
    const list = await h.call("GET", "/api/clips?tab=new");
    const card = list.json.groups.flatMap((g: { clips: { id: string; final_photo: boolean }[] }) => g.clips).find((x: { id: string }) => x.id === clip.id);
    expect(card.final_photo).toBe(true);
    h.db.raw.exec(`UPDATE clips SET rerender_job_id = NULL, pending_look = NULL WHERE id = '${clip.id}'`);
    expect((await h.call("DELETE", `/api/clips/${clip.id}/final-photo`)).status).toBe(200);
    expect(h.one<{ final_photo_key: string | null }>("SELECT final_photo_key FROM clips WHERE id = ?", clip.id).final_photo_key).toBeNull();
  });
  it("refuses what is not a photo, an empty file, or a clip that is gone", async () => {
    const { harness } = await import("./helpers/studio-fix-env");
    const h = await harness();
    await h.dumpWith("dmp_fq", [{ id: "ast_fq", name: "a.mp4", mime: "video/mp4" }]);
    await h.cut("dmp_fq", undefined, 1);
    const clip = h.one<{ id: string }>("SELECT id FROM clips WHERE dump_id = 'dmp_fq' LIMIT 1");
    expect((await h.request("POST", `/api/clips/${clip.id}/final-photo`, new Uint8Array([1, 2]), { "content-type": "application/pdf" })).status).toBe(422);
    expect((await h.request("POST", `/api/clips/${clip.id}/final-photo`, new Uint8Array([]), { "content-type": "image/png" })).status).toBe(422);
    expect((await h.request("POST", `/api/clips/clp_nothere1234/final-photo`, new Uint8Array([1]), { "content-type": "image/png" })).status).toBe(404);
    expect(h.one<{ final_photo_key: string | null }>("SELECT final_photo_key FROM clips WHERE id = ?", clip.id).final_photo_key).toBeNull();
  });
});

describe("no Pinterest for Porch & Party (owner, 7 Nov 2026: \"its too local\")", () => {
  it("P&P's photo posts never plan a pin, and Setup and the practice banner leave Pinterest out; a studio that pins keeps it", async () => {
    const { readFileSync } = await import("node:fs");
    const { parsePhotoPosts } = await import("@shared/photoPosts");
    const { unusedServices } = await import("@worker/lib/practice");
    const { planPack } = await import("@worker/domain/photoPosts");
    const reg = JSON.parse(readFileSync(`${process.cwd()}/studios/sample1.json`, "utf8"));
    const PHOTO_POSTS = JSON.stringify(reg.photoPosts);
    const cfg = parsePhotoPosts(PHOTO_POSTS);
    expect(cfg.on).toBe(true);
    expect(cfg.platforms).not.toContain("pinterest");
    expect(unusedServices({ PHOTO_POSTS }).has("pinterest")).toBe(true);
    const plan = planPack(Date.parse("2026-11-07T12:00:00.000Z"), cfg, "America/Chicago", ["reel", "carousel", "before_after"], new Set());
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some((p) => p.platform === "pinterest")).toBe(false);
    const pins = JSON.stringify({ ...reg.photoPosts, platforms: ["facebook", "pinterest"] });
    expect(unusedServices({ PHOTO_POSTS: pins }).has("pinterest")).toBe(false);
  });
  it("Setup lists no Pinterest card for a studio that does not pin", async () => {
    const { harness } = await import("./helpers/studio-fix-env");
    const { setupView } = await import("@worker/routes/setup");
    const off = await harness({ PHOTO_POSTS: JSON.stringify({ on: true, platforms: ["facebook", "instagram", "tiktok"] }) } as never);
    expect((await setupView(off.env, true)).steps.map((s) => s.id)).not.toContain("pinterest");
    const on = await harness({ PHOTO_POSTS: JSON.stringify({ on: true, platforms: ["facebook", "pinterest"] }) } as never);
    expect((await setupView(on.env, true)).steps.map((s) => s.id)).toContain("pinterest");
  });
});
