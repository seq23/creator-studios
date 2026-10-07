// The help centre as a non-technical creator uses it (owner, 26 Sep 2026: "the help section has
// the same screenshot — it needs an overhaul"). Every guide in the index is a short numbered
// walk-through with one picture per step that the screenshot job can take, and search answers
// the questions she would actually type. The pictures themselves are checked by the validator
// help-pictures; the screenshot job (tests/e2e/help-screenshots.spec.ts) fails a step whose
// target is not on screen.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import index from "../../help/index.json";
import { parseGuide, SCREEN_ROUTES } from "../../app/lib/markdown";
import { searchGuides, visibleGuides } from "../../app/lib/guides";
import { FakeLlm } from "@worker/services/openrouter";

const guides = (index.guides as { slug: string; screen: string }[]).map((g) => ({ ...g, parsed: parseGuide(readFileSync(path.resolve("help/guides", `${g.slug}.md`), "utf8")) }));

describe("every help guide", () => {
  it("exists (Rule 0)", () => expect(guides.length).toBeGreaterThanOrEqual(60));
  it.each(guides.map((g) => [g.slug, g] as const))("%s: 3 to 8 short steps, each with its own picture of that step", (slug, g) => {
    expect(g.parsed.steps.length).toBeGreaterThanOrEqual(3);
    expect(g.parsed.steps.length).toBeLessThanOrEqual(8);
    expect(SCREEN_ROUTES[g.screen], `${slug}: screen`).toBeTruthy();
    expect(g.parsed.meta.last_checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    g.parsed.steps.forEach((s, i) => {
      const where = `${slug} step ${i + 1}`;
      const look = /^\/looks\/[a-z_]+\.webp$/.test(s.image ?? "");
      if (!look) expect(s.image, where).toBe(`/help/screenshots/${slug}-${i + 1}.png`);
      if (!look) expect(!!s.mock || !!s.target, `${where}: a target on screen or a mock frame`).toBe(true);
      expect(s.route, where).not.toBe("external");
      expect(s.blocks.length, `${where}: says what to do`).toBeGreaterThan(0);
      // plain words: one short paragraph a step
      const words = s.blocks.map((b) => (b.kind === "p" ? b.inline.map((x) => x.v).join("") : "")).join(" ").split(/\s+/).length;
      expect(words, `${where}: keep it short`).toBeLessThanOrEqual(60);
    });
  });
});

describe("the guides describe the product as it is", () => {
  const text = (slug: string) => guides.find((g) => g.slug === slug)!.parsed.text;
  it("sign-ins for stats are optional extras, never required", () => {
    for (const slug of ["connect-meta", "connect-google", "reconnect-meta", "reconnect-google"]) expect(text(slug), slug).toMatch(/optional|never need|keep working without/);
    expect(text("connect-stats")).toContain("never need a google or instagram sign-in");
  });
  it("the login guide is for the test copy only, and production hides it", () => {
    expect(text("log-in")).toContain("does not ask you to log in");
    expect(visibleGuides("open").map((g) => g.slug)).not.toContain("log-in");
    expect(visibleGuides("code").map((g) => g.slug)).toContain("log-in");
  });
  it("every feature the dashboard has today has a guide", () => {
    const slugs = new Set(guides.map((g) => g.slug));
    for (const s of ["record-your-voice", "make-a-voice-over", "connect-elevenlabs", "read-your-stats", "update-instagram-numbers", "upload-your-tiktok-export", "looks-and-styles", "grid-looks", "edit-in-capcut", "connect-an-editor", "media-kit", "find-brands", "pitch-a-brand", "reply-to-a-brand-offer", "set-your-rates", "negotiate-a-rate", "deal-memo", "invoice-a-brand", "get-listed", "connect-firecrawl", "connect-hunter", "connect-buffer", "someone-elses-video", "how-posting-works", "move-or-remove-a-post", "review-and-approve-clips", "health-lights", "settings-and-switches", "steer-a-dump", "try-another-version"]) expect(slugs, s).toContain(s);
  });
});

describe("Help search answers the way she asks", () => {
  const top = (q: string) => searchGuides(q, "open").slice(0, 3).map((g) => g.slug);
  it.each([
    ["how do I post", "how-posting-works"],
    ["why is my light red", "health-lights"],
    ["how do I get paid by brands", "invoice-a-brand"],
    ["record my voice", "record-your-voice"],
    ["how much should I charge", "set-your-rates"],
    ["my post failed", "a-post-failed"],
    ["instagram numbers", "update-instagram-numbers"],
    ["tiktok export", "upload-your-tiktok-export"],
    ["change the look", "looks-and-styles"],
    ["capcut", "edit-in-capcut"],
    ["a brand emailed me", "reply-to-a-brand-offer"],
    ["find sponsors", "find-brands"],
    ["someone else's video", "someone-elses-video"],
    ["turn off voice overs", "settings-and-switches"],
    ["surprise me", "steer-a-dump"],
    ["change the music", "try-another-version"],
  ])("“%s” finds %s near the top", (q, slug) => {
    expect(top(q)).toContain(slug);
  });
  it("puts the best match first", () => {
    expect(searchGuides("how do I post", "open")[0].slug).toBe("how-posting-works");
    expect(searchGuides("why is my light red", "open")[0].slug).toBe("health-lights");
  });
  it("never returns nothing for a question some guide answers, and nothing for filler alone", () => {
    expect(searchGuides("please how do I upload my videos", "open").length).toBeGreaterThan(0);
    expect(searchGuides("", "open")).toEqual([]);
  });
});

describe("the AI writer's fake has the refused-key shape", () => {
  it("refuses a bad key like the real one, so the reconnect guide pictures a real refusal", async () => {
    expect(await new FakeLlm("bad-key").checkKey()).toEqual({ ok: false, error: "OpenRouter says this key is not valid." });
    expect(await new FakeLlm("good-key").checkKey()).toEqual({ ok: true, error: null });
  });
});
