// Studio settings (studio fix, 23 Oct 2026): the call to action, Made with AI, clips per dump, the
// review bar, local words, prices and the end-card logo, per studio. Pins the owner's rulings for
// Porch & Party exactly, a neutral fallback for the others, that the cut spec carries them
// (spec.studio_rules, spec.niche_playbook, exif_camera per asset), and that Settings changes them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanLink, cleanRules, FALLBACK_CTA, RULES_DEFAULT, rulesProblem, studioRules } from "@shared/studioRules";
import { cutJob, type CutSpec } from "@worker/jobs/cut";
// @ts-expect-error plain .mjs module
import { envBlock } from "../../scripts/studio.mjs";
import { harness } from "./helpers/studio-fix-env";

const ROOT = path.resolve(__dirname, "..", "..");
const reg = (slug: string) => JSON.parse(readFileSync(path.join(ROOT, "studios", `${slug}.json`), "utf8")) as Record<string, any>;
const varOf = (slug: string) => (envBlock(reg(slug), JSON.parse(readFileSync(path.join(ROOT, "studios", "themes.json"), "utf8"))) as { vars: Record<string, string> }).vars.STUDIO_RULES;

describe("Porch & Party's rules, exactly as the owner ruled", () => {
  it("phrases, the one request link, Made with AI on every clip, 15–30 clips, bar 70, four towns, no prices", () => {
    const r = studioRules(varOf("sample1"), null);
    expect(r.cta_phrases).toEqual(["Book your date", "Request a quote", "Get in touch with us"]);
    expect(r.cta_link).toBe("https://porchandparty901.com/request");
    expect(r.ai_note).toBe("all");
    expect(r.clip_target).toEqual({ min: 15, max: 30 });
    expect(r.bar).toBe(70);
    expect(r.place_words).toEqual(["Memphis", "Germantown", "Collierville", "Bartlett"]);
    expect(r.prices).toBe(false);
  });
  it("every real studio has its own rules; the others fall back to a neutral call to action with no link", () => {
    for (const slug of ["hadiyah", "sheila", "mercedes", "sample2", "sample3"]) {
      expect(reg(slug).studioRules, slug).toBeTruthy();
      const r = studioRules(varOf(slug), null);
      expect(r).toMatchObject({ cta_phrases: [FALLBACK_CTA], cta_link: "", ai_note: "ai_images", bar: 70, prices: false });
      // No other studio carries Porch & Party's link or towns.
      expect(varOf(slug)).not.toMatch(/porchandparty|Memphis/i);
    }
  });
  it("the generated wrangler.jsonc carries each studio's rules (no _why notes)", () => {
    const w = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
    expect(w).toContain(`"STUDIO_RULES": ${JSON.stringify(varOf("sample1"))}`);
    expect(varOf("sample1")).not.toContain("_why");
  });
  it("code stays business-neutral: no studio's words in the shared rules", () => {
    const src = readFileSync(path.join(ROOT, "shared", "studioRules.ts"), "utf8");
    expect(src).not.toMatch(/porch|party|memphis|quote/i);
  });
});

describe("cleaning: anything odd keeps what was there", () => {
  it("links must be https; empty clears; junk refused", () => {
    expect(cleanLink("https://example.com/request")).toBe("https://example.com/request");
    expect(cleanLink("")).toBe("");
    expect(cleanLink("http://example.com")).toBeNull();
    expect(cleanLink("javascript:alert(1)")).toBeNull();
    expect(cleanLink("https://exa mple.com")).toBeNull();
  });
  it("phrases one per line, deduped and bounded; an empty list is the fallback", () => {
    const r = cleanRules({ cta_phrases: "Book now\nbook now\n  Call us  " }, RULES_DEFAULT);
    expect(r.cta_phrases).toEqual(["Book now", "Call us"]);
    expect(cleanRules({ cta_phrases: [] }, r).cta_phrases).toEqual([FALLBACK_CTA]);
  });
  it("clip target and bar refuse nonsense in plain words", () => {
    expect(rulesProblem({ clip_target: { min: 30, max: 15 } })).toMatch(/smallest first/);
    expect(rulesProblem({ bar: 140 })).toMatch(/0 to 100/);
    expect(rulesProblem({ cta_link: "porchandparty" })).toMatch(/https:\/\//);
    expect(rulesProblem({ bar: 60, clip_target: { min: 5, max: 9 } })).toBeNull();
    expect(cleanRules({ bar: 140, clip_target: { min: 30, max: 15 } }, RULES_DEFAULT)).toMatchObject({ bar: 70, clip_target: RULES_DEFAULT.clip_target });
  });
  it("a malformed registry var keeps the plain defaults", () => {
    expect(studioRules("{nope", null)).toEqual(RULES_DEFAULT);
  });
});

describe("the cut spec carries the rules, the playbook and each file's camera", () => {
  it("studio_rules, clip target from the studio (not the calendar), bar, exif_camera per asset", async () => {
    const h = await harness({ STUDIO_RULES: varOf("sample1") });
    await h.dumpWith("dmp_r1", [
      { id: "ast_v1", name: "IMG_0001.MOV", mime: "video/quicktime" },
      { id: "ast_p1", name: "after-final.jpg", mime: "image/jpeg", exif: 1 },
      { id: "ast_p2", name: "reimagined.png", mime: "image/png", exif: 0 },
    ]);
    const spec = (await cutJob.buildSpec(h.env, "job_r1", "dmp_r1")) as CutSpec;
    expect(spec.studio_rules).toEqual(studioRules(varOf("sample1"), null));
    expect(spec.target_clips).toEqual({ min: 15, max: 30 });
    expect(spec.quality_bar).toBe(0.7);
    expect(spec.niche_playbook).toBeNull();
    const by = Object.fromEntries(spec.assets.map((a) => [a.id, a]));
    expect(by.ast_v1).toMatchObject({ exif_camera: true, file_name: "IMG_0001.MOV" });
    expect(by.ast_p1).toMatchObject({ exif_camera: true, file_name: "after-final.jpg" });
    expect(by.ast_p2.exif_camera).toBe(false);
  });
  it("Settings → Your clips changes them; the owner's link is checked; the spec follows", async () => {
    const h = await harness({ STUDIO_RULES: varOf("hadiyah") });
    const got = await h.call("GET", "/api/settings/rules");
    expect(got.json.rules.cta_phrases).toEqual([FALLBACK_CTA]);
    expect((await h.call("PATCH", "/api/settings/rules", { cta_link: "not a link" })).status).toBe(422);
    const saved = await h.call("PATCH", "/api/settings/rules", { cta_phrases: ["Shop the look"], cta_link: "https://example.com/shop", clip_target: { min: 4, max: 9 }, bar: 60, ai_note: "all", place_words: "Atlanta, Decatur" });
    expect(saved.status).toBe(200);
    expect(saved.json.rules).toMatchObject({ cta_phrases: ["Shop the look"], cta_link: "https://example.com/shop", clip_target: { min: 4, max: 9 }, bar: 60, ai_note: "all", place_words: ["Atlanta", "Decatur"] });
    // The registry default is shown next to it so she can go back.
    expect(saved.json.defaults.cta_link).toBe("");
    await h.dumpWith("dmp_r2", [{ id: "ast_v2", name: "a.mp4", mime: "video/mp4" }]);
    const spec = (await cutJob.buildSpec(h.env, "job_r2", "dmp_r2")) as CutSpec;
    expect(spec.target_clips).toEqual({ min: 4, max: 9 });
    expect(spec.studio_rules.cta_link).toBe("https://example.com/shop");
    // Her "how many" chip still wins for one dump.
    h.db.raw.exec(`UPDATE dumps SET steer = '{"count":3}' WHERE id = 'dmp_r2'`);
    expect(((await cutJob.buildSpec(h.env, "job_r3", "dmp_r2")) as CutSpec).target_clips).toEqual({ min: 3, max: 3 });
  });
  it("the end-card logo: uploaded under brand/logo/, saved only once it is really there, readable by the cut job", async () => {
    const h = await harness();
    const start = await h.call("POST", "/api/uploads/start", { kind: "logo", fileName: "logo.png", size: 2000, mimeType: "image/png" });
    expect(start.status).toBe(200);
    expect(start.json.key).toMatch(/^brand\/logo\/upl_/);
    expect((await h.call("PATCH", "/api/settings/rules", { logo_r2_key: start.json.key })).status).toBe(422); // not finished yet
    await h.r2.FILES.put(start.json.key, new Uint8Array(2000));
    const saved = await h.call("PATCH", "/api/settings/rules", { logo_r2_key: start.json.key });
    expect(saved.json.rules.logo_r2_key).toBe(start.json.key);
    const { jobStorageScope } = await import("@worker/lib/jobStorage");
    expect(jobStorageScope("cut", "job_x", "dmp_x").read).toContain("brand/logo/");
  });
});
