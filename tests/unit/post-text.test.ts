// What a clip's post says (studio fix, 23 Oct 2026): the owner's exact caption layout, the "—" line
// before "Made with AI", and the per-platform tracking link swapped in for the studio's link.
import { describe, expect, it } from "vitest";
import { AI_NOTE_TAIL, isFinalCaption, postText, swapLink, trackedLink } from "@shared/postText";
import { clipPostText } from "@worker/lib/postText";
import { harness } from "./helpers/studio-fix-env";

const LINK = "https://example.com/request";
const FINAL = "Fresh from Saturday.\n\nRequest a quote: https://example.com/request\n\n#garden #springfield\n\n—\nMade with AI";

describe("the caption layout, exactly", () => {
  it("pins the owner's layout string: body, blank line, CTA + link, blank line, hashtags, blank line, —, Made with AI", () => {
    expect(AI_NOTE_TAIL).toBe("\n\n—\nMade with AI");
    expect(isFinalCaption(FINAL)).toBe(true);
    const out = postText({ caption: FINAL, hashtags: "#garden #springfield", aiMade: true, link: LINK, source: "instagram", campaign: "Sample1", tag: "clip-1022-5" });
    expect(out).toBe(
      "Fresh from Saturday.\n\nRequest a quote: https://example.com/request?utm_source=instagram&utm_medium=social&utm_campaign=sample1&utm_content=clip-1022-5\n\n#garden #springfield\n\n—\nMade with AI",
    );
    // The final caption already carries its hashtags: never twice.
    expect(out.match(/#garden/g)).toHaveLength(1);
  });
  it("an older caption keeps its shape, and Made with AI is added after the — line once", () => {
    expect(postText({ caption: "Hi", hashtags: "#a", aiMade: false, link: "", source: "tiktok", campaign: "s", tag: "clip" })).toBe("Hi\n\n#a");
    expect(postText({ caption: "Hi", hashtags: "#a", aiMade: true, link: "", source: "tiktok", campaign: "s", tag: "clip" })).toBe("Hi\n\n#a\n\n—\nMade with AI");
    expect(postText({ caption: FINAL, hashtags: "", aiMade: true, link: "", source: "tiktok", campaign: "s", tag: "clip" }).match(/Made with AI/g)).toHaveLength(1);
  });
});

describe("tracking links per platform", () => {
  it("every platform gets its own source; old utm tags are replaced; the campaign is the studio slug", () => {
    for (const s of ["tiktok", "instagram", "facebook", "pinterest", "youtube"] as const) {
      const u = new URL(trackedLink(`${LINK}?utm_source=old&ref=x`, s, "Sample1", "clip-1022-5b"));
      expect(u.searchParams.get("utm_source")).toBe(s);
      expect(u.searchParams.get("utm_medium")).toBe("social");
      expect(u.searchParams.get("utm_campaign")).toBe("sample1");
      expect(u.searchParams.get("utm_content")).toBe("clip-1022-5b");
      expect(u.searchParams.get("ref")).toBe("x");
    }
  });
  it("swaps the link where it stands, with or without a trailing slash, and leaves longer paths alone", () => {
    expect(swapLink("Go: https://example.com/request.", LINK, "T")).toBe("Go: T.");
    expect(swapLink("Go: https://example.com/request/ now", LINK, "T")).toBe("Go: T now");
    expect(swapLink("See https://example.com/request-form", LINK, "T")).toBe("See https://example.com/request-form");
    expect(swapLink("no link", "", "T")).toBe("no link");
  });
});

describe("clipPostText reads the studio's rules", () => {
  it("ai_note all labels every clip; ai_images only clips with an AI picture or voice; the tag carries the clip number", async () => {
    const all = await harness({ STUDIO_RULES: JSON.stringify({ cta_link: LINK, ai_note: "all" }) });
    const row = { caption: "Hi\n\nBook: https://example.com/request", hashtags: "#a", ai_voice: 0, uses_ai_images: 0, number: 5, version: 2, dump_created_at: "2026-10-22T15:00:00.000Z" };
    const a = await clipPostText(all.env, row, "tiktok");
    expect(a.aiMade).toBe(true);
    expect(a.text).toMatch(/—\nMade with AI$/);
    expect(a.link).toBe(`${LINK}?utm_source=tiktok&utm_medium=social&utm_campaign=sample9&utm_content=clip-1022-5b`);
    expect(a.text).toContain(a.link!);
    const some = await harness({ STUDIO_RULES: JSON.stringify({ cta_link: LINK, ai_note: "ai_images" }) });
    expect((await clipPostText(some.env, row, "tiktok")).aiMade).toBe(false);
    expect((await clipPostText(some.env, { ...row, uses_ai_images: 1 }, "tiktok")).aiMade).toBe(true);
    expect((await clipPostText(some.env, { ...row, ai_voice: 1 }, "tiktok")).aiMade).toBe(true);
  });
});
