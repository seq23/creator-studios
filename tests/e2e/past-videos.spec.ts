// Learn from my past videos (Client Brain → My past videos), phone and laptop: three finished videos
// in, Watch my videos, the fake job's "How my videos feel" lands as a new draft next to her locked
// profile with a calm note asking her to lock it; locking makes it the one the clips use.
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql } from "./helpers";

async function runFake(api: APIRequestContext, jobId: string) {
  const r = await api.post(`/api/jobs/${jobId}/run-fake`, { data: {} });
  expect(r.ok(), await r.text()).toBe(true);
}

// Leave the studio as the other specs expect it: profile unlocked with no lock history, no past videos.
test.afterEach(async ({ page }) => {
  await page.request.post("/api/brain/profile/unlock");
  sql(["UPDATE brand_profile SET locked = 0, locked_at = NULL", "DELETE FROM past_videos", "DELETE FROM settings WHERE key = 'past_videos_read'", "DELETE FROM jobs WHERE type IN ('research', 'pastvideos')"].join("; "));
});

test("past videos: choose three, watch them, read How my videos feel, lock it", async ({ page }) => {
  const api = page.request;
  // A locked profile in use (as she would have after setup).
  expect((await api.patch("/api/brain/profile", { data: { sections: { who: "Demo creator", voice: "Warm", themes: "Routines", ctas: "Follow for more", video_feel: "" } } })).ok()).toBe(true);
  expect((await api.post("/api/brain/profile/lock")).ok()).toBe(true);

  await page.goto("/brain");
  const box = page.locator("[data-past-videos]");
  await expect(box.getByRole("heading", { name: "My past videos" })).toBeVisible();
  await expect(box).toContainText("They are never cut into clips.");
  await expect(box.getByRole("button", { name: "Watch my videos" })).toHaveCount(0);
  await box.locator('input[type="file"]').setInputFiles([1, 2, 3].map((n) => ({ name: `past-${n}.mp4`, mimeType: "video/mp4", buffer: randomBytes(120_000) })));
  await expect(box.locator("[data-past-video]")).toHaveCount(3);
  await expect(box.getByRole("button", { name: "Add more past videos (3 of 10)" })).toBeVisible();

  const readCall = page.waitForResponse((r) => r.url().endsWith("/api/brain/past-videos/read"));
  await box.getByRole("button", { name: "Watch my videos" }).click();
  const { jobId } = (await (await readCall).json()) as { jobId: string };
  await expect(box.locator('[data-past-status="running"]')).toContainText("Watching your videos");
  await expect(box.getByRole("button", { name: /^Remove / }).first()).toBeDisabled();
  await runFake(api, jobId);
  await page.reload();

  await expect(box.locator('[data-past-status="done"]')).toContainText("Watched 3 videos");
  const feel = page.getByLabel("How my videos feel");
  await expect(feel).toHaveValue(/^Hooks and first 2 seconds: /);
  await expect(feel).toBeEnabled(); // a new draft she can edit before locking
  await expect(page.locator("[data-feel-note]")).toContainText("press Lock profile so your clips use it");
  await expect(page.locator("[data-feel-note]")).toContainText("Until then they keep using the version you locked on");
  // The cut still reads the locked one, without the section, until she locks.
  const inUse = sql<{ sections: string }>("SELECT sections FROM brand_profile WHERE locked = 1")[0];
  expect(JSON.parse(inUse.sections).video_feel ?? "").toBe("");

  await page.getByRole("button", { name: "Lock profile" }).click();
  await expect(page.locator(".pill", { hasText: "Locked" })).toBeVisible();
  await expect(page.locator("[data-feel-note]")).toHaveCount(0);
  expect(JSON.parse(sql<{ sections: string }>("SELECT sections FROM brand_profile WHERE locked = 1")[0].sections).video_feel).toMatch(/^Hooks and first 2 seconds: /);
});
