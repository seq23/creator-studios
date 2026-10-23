// The plain line (studio intelligence layer 7) and the grounded voice-over words (layer 4).
import { describe, expect, it } from "vitest";
import { cleanLooksLike, cleanOverride, clipLine, plainLine } from "@shared/looksLike";
import { groundScript, mentionsAutomation } from "@shared/grounded";

describe("plain line", () => {
  it("says the service, the shape and the camera sound", () => {
    expect(plainLine({ service: "romantic room setups", shape: "transformation", camera: "off", sure: true })).toBe("Looks like: romantic room setups · before and after · camera sound off");
    expect(plainLine({ service: "silk press", shape: "walkthrough", camera: "on", sure: true })).toBe("Looks like: silk press · walk-through · camera sound on");
  });
  it("never names a service it is not sure about", () => {
    expect(plainLine({ service: "silk press", shape: "montage", camera: "on", sure: false })).toBe("Not sure what this shows");
    expect(plainLine(null)).toBe("Not sure what this shows");
    expect(plainLine(cleanLooksLike({ service: "", shape: "transformation", sure: true }))).toBe("Not sure what this shows");
  });
  it("a clip's own line follows its own sound", () => {
    expect(clipLine({ service: "Ceramic coating", shape: "walkthrough", muted: true })).toBe("Looks like: Ceramic coating · walk-through · camera sound off");
    expect(clipLine({ service: null, shape: "montage", muted: false })).toBe("Not sure what this shows");
  });
  it("Change accepts only the profile's services, Not sure, and the four shapes", () => {
    const svc = ["Money tips", "Career advice"];
    expect(cleanOverride({ service: "money TIPS", shape: "talking" }, svc)).toEqual({ service: "Money tips", shape: "talking" });
    expect(cleanOverride({ service: "something else", shape: "dance" }, svc)).toEqual({});
    expect(cleanOverride({ service: "unsure" }, svc)).toEqual({ service: "unsure" });
  });
});

describe("voice-over scripts are grounded", () => {
  it("never mention automation", () => {
    expect(mentionsAutomation("With a voice over, added automatically.")).toBe("automatically");
    expect(groundScript("Walk in to this. This video was made by the studio. Message us to book.", { hasAfter: true, hasBefore: true })).toBe("Walk in to this. Message us to book.");
  });
  it("never claim a finished result, or a before, the picture does not show", () => {
    expect(groundScript("The big reveal is here. Look at the light.", { hasAfter: false, hasBefore: false })).toBe("Look at the light.");
    expect(groundScript("It started empty. Now look.", { hasAfter: true, hasBefore: false })).toBe("Now look.");
    expect(groundScript("It started empty. Now the big reveal.", { hasAfter: true, hasBefore: true })).toBe("It started empty. Now the big reveal.");
  });
});
