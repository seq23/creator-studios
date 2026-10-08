// Phase 11 (voice) and 12c (help center + tour), at phone and desktop sizes, with fake services
// and demo data (tests/e2e/seed-demo.sql). Brand deals and the media kit: mediakit-deals.spec.ts.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearDemo, seedDemo, setVoice, TOUR_OFF } from "./demo";
import { sql } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => seedDemo());
test.afterAll(async ({ playwright }, info) => {
  const ctx = await playwright.request.newContext({ baseURL: info.project.use.baseURL, storageState: "test-results/.auth/owner.json" });
  await setVoice(ctx, true).catch(() => undefined); // the base state: every feature on
  await ctx.dispose();
  clearDemo();
});

test.describe("voice", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TOUR_OFF);
  });

  test("never hidden; switch off still makes the voice overs she adds herself; consented sample, generate, listen, delete", async ({ page, isMobile }) => {
    const feature = async () => ((await (await page.request.get("/api/settings")).json()) as { features: { voice: boolean } }).features.voice;
    // the base state is on (nothing switched off); switch it off for this part
    expect(await feature()).toBe(true);
    await setVoice(page.request, false);
    // Off = only the voice overs she adds herself (owner, 26 Sep 2026): the switch never refuses one;
    // with no voice saved yet the refusal is about the voice, not the switch
    const off = await page.request.post("/api/voice/narrations", { data: { script: "Hello there, this is a test script." } });
    const offBody = (await off.json()) as { error?: string; fix_guide?: string };
    expect(offBody.error ?? "").not.toMatch(/is off|Switch it on/);
    expect((await (await page.request.get("/api/voice")).json()).auto).toBe("off");

    // still in the menu and still the full screen: the five steps, the switch, Make a narration
    await page.goto("/");
    if (isMobile) await page.locator(".tabbar [data-menu]").click();
    await expect(page.locator(isMobile ? ".more-sheet" : ".sidebar").getByRole("link", { name: "Voice overs", exact: true })).toBeVisible();
    await page.goto("/voice");
    for (let n = 1; n <= 5; n++) await expect(page.locator(`.voice-step[data-step="${n}"]`)).toBeVisible();
    const clips = page.locator(".clips-switch").getByLabel(/Automatic voice overs/);
    await expect(clips).not.toBeChecked();
    await expect(page.getByText(/Switch on/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Draft with AI" })).toBeEnabled();

    // the switch on the Voice screen persists, both ways, and Settings shows the same switch
    await clips.check();
    await expect.poll(feature).toBe(true);
    await clips.uncheck();
    await expect.poll(feature).toBe(false);
    await page.goto("/settings");
    await expect(page.locator("label.switch", { hasText: "Automatic voice overs" }).getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByText("On = clips with no talking get a voice over in your voice automatically; you can remove it in Review. Off = only the voice overs you add yourself.").first()).toBeVisible();
    await page.goto("/voice");
    await clips.check();
    await expect.poll(feature).toBe(true);
    await page.reload();
    await expect(clips).toBeChecked();
    // the five setup steps, the read-aloud script and the recorder are on the screen
    for (let n = 1; n <= 5; n++) await expect(page.locator(`.voice-step[data-step="${n}"]`)).toBeVisible();
    await expect(page.getByLabel("Script to read aloud")).toContainText("welcome in");
    await page.getByRole("button", { name: "Bigger text" }).click();
    await expect(page.locator(".voice-script.big")).toBeVisible();
    await page.getByRole("button", { name: "Hide script" }).click();
    await expect(page.getByLabel("Script to read aloud")).toHaveCount(0);
    await page.getByRole("button", { name: "Show script" }).click();
    await expect(page.getByRole("button", { name: "Record sample" })).toBeVisible();
    await expect(page.getByLabel("Upload a voice clip")).toHaveAttribute("accept", /\.m4a.*\.mp3.*\.wav.*\.aac.*\.caf.*\.webm/);

    // under a minute is not enough: a plain sentence, Save stays off even with consent ticked
    const save = page.getByRole("button", { name: "Save my voice" });
    await page.getByLabel("Upload a voice clip").setInputFiles({ name: "short.wav", mimeType: "audio/wav", buffer: wav(20) });
    await expect(page.getByTestId("sample-length")).toContainText("Your recording is 0:20. Record at least 1 minute");
    await page.getByLabel(/This is my own voice and I consent/).check();
    await expect(save).toBeDisabled();
    const short = await page.request.post("/api/voice/sample", { data: { upload_id: "upl_abcdef12", consent: true, duration_s: 20 } });
    expect(short.status()).toBe(422);

    await page.getByLabel("Upload a voice clip").setInputFiles({ name: "sample.wav", mimeType: "audio/wav", buffer: wav(61) });
    await expect(page.getByTestId("sample-length")).toContainText("Your recording is 1:01.");
    await page.getByLabel(/This is my own voice and I consent/).uncheck();
    await expect(save).toBeDisabled(); // consent first
    await page.getByLabel(/This is my own voice and I consent/).check();
    await save.click();
    await expect(page.getByText(/Voice ready · saved/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Draft with AI" }).click();
    await expect(page.getByLabel("Script")).toHaveValue(/Hi, it's Sample/);
    const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/voice/narrations") && r.request().method() === "POST"), page.getByRole("button", { name: "Generate" }).click()]);
    const { jobId, id } = (await res.json()) as { jobId: string; id: string };
    expect((await page.request.post(`/api/jobs/${jobId}/run-fake`, { data: {} })).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Play voice over")).toBeVisible();
    await expect(page.locator(".narration").first().locator(".engine-tag")).toHaveText("Built-in");
    const audio = await page.request.get(`/api/voice/narrations/${id}/audio`);
    expect(audio.status()).toBe(200);
    expect(audio.headers()["content-type"]).toContain("audio/wav");
    expect((await audio.body()).subarray(0, 4).toString()).toBe("RIFF");

    // attach it to a clip: the voice job mixes it in, the clip plays with it in Review (and Buffer
    // posts that same link)
    await page.locator(`[data-narration="${id}"]`).getByRole("button", { name: "Attach to clip" }).click();
    const [att] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/voice/narrations/${id}`) && r.request().method() === "PATCH"),
      page.getByRole("dialog").getByRole("button", { name: "Set a brunch table in 60 seconds" }).click(),
    ]);
    const attached = (await att.json()) as { mixing: boolean; jobId: string };
    expect(attached.mixing).toBe(true);
    await expect(page.locator(".toast").last()).toContainText("Adding it to the clip.");
    await expect(page.locator(`[data-narration="${id}"]`)).toContainText("Adding to your clip…");
    expect((await page.request.post(`/api/jobs/${attached.jobId}/run-fake`, { data: {} })).ok()).toBe(true);
    await page.reload();
    await expect(page.locator(`[data-narration="${id}"]`)).toContainText("In your clip · plays in Review");
    await page.goto("/review");
    await page.getByRole("tab", { name: /Approved/ }).click();
    const voiced = page.locator('[data-clip-id="demo_clip_1"]');
    // one she attached herself: no "added automatically", and the AI label is said before it posts
    await expect(voiced.locator('[data-voice-over="ready"]')).toHaveText("With your voice over · AI-labelled when it posts");
    await expect(voiced.getByLabel("Play this clip")).toHaveAttribute("src", new RegExp(`\\?v=${id}$`));
    const [demo] = sql<{ media_token: string }>("SELECT media_token FROM clips WHERE id = 'demo_clip_1'");
    expect((await page.request.get(`/media/${demo.media_token}`)).status()).toBe(200);
    await page.goto("/voice");

    await page.getByRole("button", { name: "Delete my voice" }).click();
    await page.getByRole("button", { name: "Yes, delete my voice" }).click();
    await expect(page.getByText(/Voice ready · saved/)).toHaveCount(0);
    const state = (await (await page.request.get("/api/voice")).json()) as { hasSample: boolean };
    expect(state.hasSample).toBe(false);
    await setVoice(page.request, true); // the base state: every feature on
  });
});

test.describe("help center", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TOUR_OFF);
  });

  test("a guide shows its steps, Back / Next, and Did this work? posts feedback", async ({ page }) => {
    await page.goto("/help/pitch-a-brand");
    await expect(page.getByRole("heading", { name: "Pitch a brand", level: 1 })).toBeVisible();
    await expect(page.getByText("Step 1 of 6")).toBeVisible();
    await expect(page.locator(".guide-screen-only .guide-shot")).toBeVisible();
    for (let i = 2; i <= 6; i++) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText(`Step ${i} of 6`)).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByText("Step 5 of 6")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    const [fb] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/help/feedback")), page.getByRole("button", { name: "Yes", exact: true }).click()]);
    expect(fb.status()).toBe(200);
    expect(fb.request().postDataJSON()).toMatchObject({ slug: "pitch-a-brand", worked: true });
    await expect(page.getByText("Great. You can close this guide.")).toBeVisible();
  });

  test("No opens the guide's fix-it guide", async ({ page }) => {
    await page.goto("/help/reply-to-a-brand-offer?step=5");
    await expect(page.getByText("Step 5 of 5")).toBeVisible();
    await page.getByRole("button", { name: "No, show me a fix" }).click();
    await expect(page).toHaveURL(/\/help\/negotiate-a-rate$/);
  });

  test("help home: search finds guides, and Getting Started ticks are remembered", async ({ page }) => {
    await page.goto("/help");
    await page.getByPlaceholder("What do you need help with?").fill("gmail");
    await expect(page.getByRole("region", { name: "Search results" }).getByText("Pitch a brand")).toBeVisible();
    await page.getByPlaceholder("What do you need help with?").fill("");
    await page.getByRole("button", { name: "Tick Log in" }).click();
    // The count is the checklist's own length (app/pages/Help.tsx CHECKLIST): "1 of 8" went stale
    // when Setup joined Getting started (#6).
    const steps = /export const CHECKLIST = \[([^\]]*)\]/.exec(readFileSync("app/pages/Help.tsx", "utf8"))![1].split(",").filter((x) => x.trim()).length;
    expect(steps).toBe(9);
    await expect(page.getByText(`1 of ${steps} done`)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Untick Log in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "A post failed" })).toBeVisible();
  });
});

test.describe("first-login tour", () => {
  test("shows once on Home, walks every stop of the current menu, and Replay the tour brings it back", async ({ page }) => {
    await page.goto("/");
    const tour = page.getByRole("dialog", { name: "Quick tour" });
    await expect(tour).toBeVisible();
    const stops = ["Dump", "Review", "Calendar", "Stats", "Voice overs", "Deals", "Media kit", "Help"];
    for (const [i, s] of stops.entries()) {
      await expect(tour.getByRole("heading", { name: s, exact: true })).toBeVisible();
      await expect(tour).toContainText(`${i + 1} of ${stops.length}`);
      await expect(tour.getByRole("link", { name: "Show me how" })).toHaveAttribute("href", /^\/help\/[a-z0-9-]+$/);
      await tour.getByRole("button", { name: i === stops.length - 1 ? "Done" : "Next" }).click();
    }
    await expect(tour).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: /^Hi / })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Quick tour" })).toHaveCount(0);

    await page.goto("/help");
    await page.getByRole("button", { name: "Replay the tour" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("dialog", { name: "Quick tour" })).toBeVisible();
    await page.getByRole("button", { name: "Skip tour" }).click();
    await expect(page.getByRole("dialog", { name: "Quick tour" })).toHaveCount(0);
  });
});

/** A short mono 16-bit WAV (a quiet tone) so the upload is a real audio file. */
function wav(seconds: number): Buffer {
  const rate = 16_000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 6000), 44 + i * 2);
  return b;
}
