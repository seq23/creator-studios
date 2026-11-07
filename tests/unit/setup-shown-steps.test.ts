import { describe, expect, it } from "vitest";
import { SETUP_STEPS, shownSteps, type SetupView } from "@shared/setup";

describe("Setup draws only the steps the server sent", () => {
  it("a step the server left out (an unused service) is skipped, never read as undefined", () => {
    const sent = SETUP_STEPS.slice(1).map((s) => ({ id: s.id, state: "practice" as const, shown: {}, last_error: null }));
    const view = { steps: sent, redirects: { google: "", meta: "" }, job_secret: null } as unknown as SetupView;
    const out = shownSteps(view);
    expect(out.length).toBe(SETUP_STEPS.length - 1);
    expect(out.every((o) => o.status && o.status.id === o.step.id)).toBe(true);
    expect(out.some((o) => o.step.id === SETUP_STEPS[0].id)).toBe(false);
  });
});
