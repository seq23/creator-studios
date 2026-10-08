// 7 Oct 2026: on Hadiyah's studio (host-accounts) the Email card said "sent from your own Resend
// account" while the host's key sent it. A card the host's account runs says so; a client studio's
// wording (her own key, or practice) is unchanged.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { powersFor, SETUP_STEPS } from "@shared/setup";
import { HOST_KEY_SERVICES } from "@worker/lib/hostKeys";

const HOST_RUN = ["resend", ...Object.keys(HOST_KEY_SERVICES)];

describe("Setup cards the studio host's account runs", () => {
  it("covers Email, AI writing, Web research and Brand contacts (Rule 0)", () => {
    expect(HOST_RUN.sort()).toEqual(["firecrawl", "hunter", "openrouter", "resend"]);
  });
  it.each(HOST_RUN)("%s: provided by the studio host while the host's key runs it", (id) => {
    const step = SETUP_STEPS.find((s) => s.id === id)!;
    const shown = powersFor(step, "provided");
    expect(shown).toMatch(/provided by your studio host\.$/);
    expect(shown).not.toMatch(/your own/i);
  });
  it("no card claims her own account while provided", () => {
    for (const s of SETUP_STEPS) expect(powersFor(s, "provided"), s.id).not.toMatch(/your own \w+ account/i);
  });
  it("a client studio's wording is unchanged: her own key, or practice", () => {
    const resend = SETUP_STEPS.find((s) => s.id === "resend")!;
    for (const state of ["live", "practice", "error"]) expect(powersFor(resend, state)).toBe("Your alerts, weekly recap and “clips are ready” emails, sent from your own Resend account.");
  });
  it("the Setup screen shows the line through powersFor", () => {
    const src = readFileSync("app/pages/Setup.tsx", "utf8");
    expect(src).toContain("<p>{powersFor(step, status.state)}</p>");
    expect(src).not.toMatch(/\{step\.powers\}/);
  });
});
