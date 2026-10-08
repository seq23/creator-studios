// Setup "Test key" (worker/services/keychecks.ts): a key the vendor refuses says so plainly, and
// only a busy or broken vendor says "try again in a minute". Found live on sample1, 7 Oct 2026: a
// fake Resend key got "Resend answered 400. Try again in a minute." (Resend answers a malformed key
// with 400), so she would have waited and retried a key that can never work.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@worker/env";
import { checkFirecrawl, checkHunter, checkMetaApp, checkResend, checkYouTubeKey, vendorStatusError } from "@worker/services/keychecks";

const env = { FAKE_SERVICES: "0", PUBLIC_BASE_URL: "https://sample1studio.example" } as unknown as Env;
const answer = (status: number, body = "{}") => vi.stubGlobal("fetch", async () => new Response(body, { status }));
afterEach(() => vi.unstubAllGlobals());

describe("one sentence per vendor answer", () => {
  it("400, 401 and 403 are a refused key; 429 and 5xx are worth a retry; anything else points at the key", () => {
    for (const s of [400, 401, 403]) expect(vendorStatusError("Resend", s)).toBe("Resend says this key is not valid.");
    expect(vendorStatusError("Resend", 429)).toBe("Resend is busy right now. Try again in a minute.");
    expect(vendorStatusError("Resend", 503)).toBe("Resend did not answer properly (503). Try again in a minute.");
    expect(vendorStatusError("Resend", 404)).toBe("Resend answered 404. Check the key and try again.");
    for (const s of [400, 401, 403, 404]) expect(vendorStatusError("X", s)).not.toMatch(/minute/);
  });
});

describe("each Test key probe uses it", () => {
  it("Resend: a malformed key (400) is not valid, never 'try again in a minute'", async () => {
    answer(400, JSON.stringify({ name: "validation_error", message: "API key is invalid" }));
    expect(await checkResend(env, "re_FAKE")).toEqual({ ok: false, error: "Resend says this key is not valid.", meta: {} });
  });
  it("Resend: a send-only key is still accepted (401 restricted_api_key)", async () => {
    answer(401, JSON.stringify({ name: "restricted_api_key" }));
    expect((await checkResend(env, "re_send_only")).ok).toBe(true);
  });
  it("Resend down: try again", async () => {
    answer(502);
    expect((await checkResend(env, "re_x")).error).toMatch(/Try again in a minute/);
  });
  it("Firecrawl, Hunter: 403 is a refused key too", async () => {
    answer(403);
    expect((await checkFirecrawl(env, "fc")).error).toBe("Firecrawl says this key is not valid.");
    expect((await checkHunter(env, "h")).error).toBe("Hunter says this key is not valid.");
  });
  it("YouTube key with an unknown 4xx and Meta with a 5xx get the right sentence", async () => {
    answer(404, "{}");
    expect((await checkYouTubeKey(env, "AIza")).error).toBe("Google answered 404. Check the key and try again.");
    answer(500);
    expect((await checkMetaApp(env, "1", "s")).error).toBe("Meta did not answer properly (500). Try again in a minute.");
  });
});
