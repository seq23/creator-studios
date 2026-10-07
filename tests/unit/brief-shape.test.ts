// Research Brief shape + truth rules (BUILD_PLAN.md section 6). The fake brief is what every
// screen and screenshot shows with FAKE_SERVICES=1, so it must pass the same checks a real
// job result must pass in researchJob.applyResult.
import { describe, expect, it } from "vitest";
import { PLATFORMS, LAUNCH_SLOTS } from "@shared/constants";
import type { BriefBody, BriefSource, Claim } from "@shared/types";
import { allClaims, BASELINE_SOURCES, briefCounts, claimLabel, enforceTruth, shapeProblems, sourceProblems, truthProblems, WEB_SKIPPED_SOURCE_ID } from "@worker/domain/brief";
import { buildFakeBrief } from "@worker/jobs/research_fake";

const TEN_B_URLS = [
  "https://buffer.com/resources/best-time-to-post-social-media/",
  "https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/",
  "https://sproutsocial.com/insights/best-times-to-post-on-tiktok/",
  "https://sproutsocial.com/insights/best-times-to-post-on-instagram/",
];

describe("fake brief", () => {
  const plain = buildFakeBrief({ stats: {}, uploads: [] });
  const full = buildFakeBrief({ stats: { instagram: { videos: 18 }, tiktok: { videos: 40 } }, uploads: [{ id: "upl_1", title: "Deep research.pdf" }] });

  it("matches the BriefBody shape exactly", () => {
    expect(shapeProblems(plain.body)).toEqual([]);
    expect(shapeProblems(full.body)).toEqual([]);
    expect(Object.keys(plain.body).sort()).toEqual(["audience", "best_times", "comparable_creators", "cut_styles", "hooks", "shot_list", "themes"]);
  });

  it("has 6–10 real sources including the four 10b timing studies", () => {
    for (const b of [plain, full]) {
      expect(sourceProblems(b.sources)).toEqual([]);
      const real = b.sources.filter((s) => s.id !== WEB_SKIPPED_SOURCE_ID);
      expect(real.length).toBeGreaterThanOrEqual(6);
      expect(real.length).toBeLessThanOrEqual(10);
      for (const url of TEN_B_URLS) expect(b.sources.map((s) => s.url)).toContain(url);
    }
  });

  it("obeys the truth rule: no claim stated as fact without a source", () => {
    expect(truthProblems(plain.body, plain.sources)).toEqual([]);
    expect(truthProblems(full.body, full.sources)).toEqual([]);
  });

  it("uses her stats and uploads as sources when she has them, and never marks web search as skipped (it is free now)", () => {
    const ids = full.sources.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["her_instagram", "her_tiktok", "up_upl_1"]));
    // Firecrawl is optional since 26 Sep 2026: no brief is ever built with the "skipped" marker.
    expect([...ids, ...plain.sources.map((s) => s.id)]).not.toContain(WEB_SKIPPED_SOURCE_ID);
    expect(ids).not.toContain("her_youtube");
    const usedUpload = allClaims(full.body).some((c) => c.claim.source_ids.includes("up_upl_1") && c.claim.basis === "upload");
    expect(usedUpload).toBe(true);
  });

  it("posting times are the 10b launch slots, each cited; TikTok weekends are marked uncertain", () => {
    for (const p of PLATFORMS) {
      expect(plain.body.best_times[p].map(({ day, hour, minute }) => ({ day, hour, minute }))).toEqual(LAUNCH_SLOTS[p]);
      for (const s of plain.body.best_times[p]) expect(s.claim.source_ids.length).toBeGreaterThan(0);
    }
    const weekend = plain.body.best_times.tiktok.filter((s) => s.day === 0 || s.day === 6);
    expect(weekend.length).toBeGreaterThan(0);
    for (const s of weekend) expect(claimLabel(s.claim, plain.sources)).toBe("uncertain");
  });

  it("names no individual creators without a web source", () => {
    for (const c of plain.body.comparable_creators) expect(claimLabel(c.why, plain.sources)).toBe("uncertain");
  });
});

describe("truth rule checker", () => {
  const sources: BriefSource[] = [...BASELINE_SOURCES, { id: "her_profile", url: null, title: "Profile", kind: "her_data" }];
  const empty = (): BriefBody => ({ audience: [], themes: [], hooks: [], cut_styles: [], best_times: { tiktok: [], instagram: [], youtube: [] }, comparable_creators: [], shot_list: [] });
  const c = (text: string, source_ids: string[], confidence: Claim["confidence"] = "solid", basis: Claim["basis"] = "web"): Claim => ({ text, source_ids, basis, confidence });

  it("flags a solid claim with no sources, and one citing a source that does not exist", () => {
    const b = empty();
    b.hooks.push(c("Uncited fact", []));
    b.audience.push(c("Ghost source", ["nope"]));
    b.shot_list.push(c("Fine", ["her_profile"], "solid", "her_data"));
    b.cut_styles.push(c("Weak and uncited is allowed", [], "uncertain"));
    const problems = truthProblems(b, sources);
    expect(problems).toEqual(["audience[0]: stated as fact with no source", "audience[0]: cites unknown source nope", "hooks[0]: stated as fact with no source"]);
  });

  it("the web-skipped marker never counts as a citation", () => {
    const b = empty();
    b.audience.push(c("Cites only the marker", [WEB_SKIPPED_SOURCE_ID]));
    expect(truthProblems(b, [...sources, { id: WEB_SKIPPED_SOURCE_ID, url: null, title: "skipped", kind: "web" }]).length).toBeGreaterThan(0);
  });

  it("enforceTruth drops unknown citations and downgrades uncited claims, never upgrades", () => {
    const b = empty();
    b.hooks.push(c("Uncited fact", []));
    b.audience.push(c("Mixed", ["nope", "b_buffer_all"]));
    b.themes.push({ title: "T", claims: [c("Unsure but cited", ["her_profile"], "uncertain", "her_data")] });
    b.best_times.tiktok.push({ day: 1, hour: 15, minute: 0, claim: c("Ghost", ["ghost"]) });
    const fixed = enforceTruth(b, sources);
    expect(fixed.hooks[0].confidence).toBe("uncertain");
    expect(fixed.audience[0]).toEqual(c("Mixed", ["b_buffer_all"]));
    expect(fixed.themes[0].claims[0].confidence).toBe("uncertain");
    expect(fixed.best_times.tiktok[0].claim).toEqual(c("Ghost", [], "uncertain"));
    expect(truthProblems(fixed, sources)).toEqual([]);
    expect(b.hooks[0].confidence).toBe("solid"); // pure: input untouched
  });

  it("labels: uncertain wins over basis; a solid cited claim shows its basis", () => {
    expect(claimLabel(c("x", ["her_profile"], "solid", "her_data"), sources)).toBe("her_data");
    expect(claimLabel(c("x", ["b_buffer_all"], "solid", "web"), sources)).toBe("web");
    expect(claimLabel(c("x", ["b_buffer_all"], "uncertain", "web"), sources)).toBe("uncertain");
    expect(claimLabel(c("x", [], "solid", "web"), sources)).toBe("uncertain");
  });

  it("shape check refuses a malformed brief", () => {
    expect(shapeProblems(null)).not.toEqual([]);
    const bad = { ...empty(), best_times: { tiktok: [{ day: 9, hour: 25, minute: 0, claim: c("x", []) }], instagram: [], youtube: [] } };
    expect(shapeProblems(bad).join()).toMatch(/best_times.tiktok\[0\]/);
    expect(shapeProblems({ ...empty(), hooks: [{ text: "x", source_ids: [], basis: "rumor", confidence: "solid" }] }).join()).toMatch(/hooks\[0\]/);
    expect(shapeProblems({ ...empty(), comparable_creators: [{ handle: "@x", platform: "myspace", why: c("x", []) }] }).join()).toMatch(/comparable_creators\[0\]/);
    expect(sourceProblems([{ id: "a", url: null, title: "A", kind: "web" }, { id: "a", url: null, title: "B", kind: "web" }]).join()).toMatch(/repeats/);
  });

  it("counts claims, uncertain claims and real sources", () => {
    const b = empty();
    b.hooks.push(c("a", ["her_profile"]), c("b", []));
    expect(briefCounts(b, [...sources, { id: WEB_SKIPPED_SOURCE_ID, url: null, title: "s", kind: "web" }])).toEqual({ claims: 2, uncertain: 1, sources: sources.length });
  });
});
