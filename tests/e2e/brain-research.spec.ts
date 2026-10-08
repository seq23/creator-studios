// Phases 2, 3 and 8 end to end with fake services, on phone and desktop:
//   Client Brain: upload a .md doc → fake extract → draft profile → edit → lock
//   Research: refresh → fake research → claims with labels and source links → approve
//   Gate (section 6): Dump is refused before, and goes through after, lock + approve
//   Stats: fake Instagram sign-in, TikTok export import, sync, the expired-token failure shape
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql } from "./helpers";

const MD = `# Sample Creator — notes\nShort how-tos, tips and behind the scenes for beginners and returning fans.\nGoal: post every week and land brand partners that fit.\n`;

const TIKTOK_CSV = `Video title,Video link,Post time,Total likes,Total comments,Total shares,Total views,Average watch time
"Yacht day, white party",https://www.tiktok.com/@samplec11/video/7412345678901234567,2026-08-02 19:05:00,1.2K,48,31,"18,400",11.5
Gala arrivals,https://www.tiktok.com/@samplec11/video/7412345678901234999,2026-08-09 20:10:00,640,12,9,9100,9
Wellness talk,https://www.tiktok.com/@samplec11/video/7412345678901235111,2026-08-16 15:00:00,210,30,4,3300,14
`;

async function runFake(api: APIRequestContext, jobId: string, options: Record<string, unknown> = {}) {
  const r = await api.post(`/api/jobs/${jobId}/run-fake`, { data: options });
  expect(r.ok(), await r.text()).toBe(true);
}

/** A dump with one uploaded (random) video, through the real chunked upload routes. */
async function dumpWithVideo(api: APIRequestContext): Promise<string> {
  const { id } = (await (await api.post("/api/dumps", { data: { door: "new", notes: "gate test" } })).json()) as { id: string };
  const bytes = randomBytes(150_000);
  const start = (await (await api.post("/api/uploads/start", { data: { kind: "video", parentId: id, fileName: "gate.mp4", size: bytes.length, mimeType: "video/mp4" } })).json()) as { id: string; key: string; uploadId: string };
  const part = await (await api.put(`/api/uploads/${start.id}/parts/1?key=${encodeURIComponent(start.key)}&uploadId=${encodeURIComponent(start.uploadId)}`, { data: bytes })).json();
  const done = await api.post(`/api/uploads/${start.id}/complete`, { data: { key: start.key, uploadId: start.uploadId, parts: [part] } });
  expect(done.ok()).toBe(true);
  return id;
}

// Leave the database as the other specs expect to find it: the smoke spec wants Dump refused on
// "Brand Profile" (profile unlocked); the calendar spec wants launch posting slots, which only
// holds while no brief is approved; the deals spec computes marketplace eligibility from the
// newest TikTok account_stats row, so the rows the import and the fake sync write here must go.
// There is no un-approve route (approval is a one-way action for her), so the local D1 is
// cleared directly.
test.afterEach(async ({ page }) => {
  await page.request.post("/api/brain/profile/unlock");
  sql(["DELETE FROM research_briefs", "DELETE FROM account_stats", "DELETE FROM platform_videos", "DELETE FROM metrics", "DELETE FROM settings WHERE key IN ('learned_slots','learned_slots_at','youtube_public','youtube_channel','youtube_channel_typed','instagram_public','instagram_manual','instagram_reminder','instagram_handle_typed')"].join("; "));
});

test("brain → research → the cutting gate opens only after lock + approve", async ({ page }) => {
  const api = page.request;

  // Gate closed: no locked profile yet, so Dump is refused with a plain sentence + fix guide.
  const dumpId = await dumpWithVideo(api);
  const refused = await api.post(`/api/dumps/${dumpId}/dump`);
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Brand Profile"), fix_guide: "upload-brand-docs" });

  // ---- Client Brain: upload → read → draft → edit → lock
  await page.goto("/brain");
  await expect(page.getByRole("heading", { name: "Client Brain" })).toBeVisible();
  const extractCall = page.waitForResponse((r) => r.url().endsWith("/api/brain/extract") && r.request().method() === "POST");
  await page.locator('input[type="file"]').setInputFiles({ name: "brand-notes.md", mimeType: "", buffer: Buffer.from(MD) });
  const extract = (await (await extractCall).json()) as { jobId: string | null; docs: number };
  expect(extract.docs).toBeGreaterThanOrEqual(1);
  await expect(page.getByLabel("Brand docs").getByText("Reading text…").first()).toBeVisible();
  await runFake(api, extract.jobId!);
  await page.reload();
  await expect(page.getByLabel("Brand docs").getByText(/^Read · \d+ words$/).first()).toBeVisible();
  // The fake reads the real Markdown: the character count is the file's.
  const brain = (await (await api.get("/api/brain")).json()) as { docs: { file_name: string; char_count: number; extract_status: string }[] };
  expect(brain.docs.find((d) => d.file_name === "brand-notes.md" && d.extract_status === "done")?.char_count).toBe(MD.length);

  await page.getByRole("button", { name: /Draft my profile|Redraft profile from all docs/ }).click();
  await expect(page.locator(".toast").filter({ hasText: "New draft ready." })).toBeVisible();
  await expect(page.getByText(/· v\d+ · drafted/)).toBeVisible();
  await expect(page.getByLabel("Who she is")).toHaveValue(/Sample Creator makes short, practical videos/);
  const ctas = page.getByLabel("Calls to action");
  await ctas.fill(`${await ctas.inputValue()}\n• "Save the date for the fall gala."`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Saved as a new version." })).toBeVisible();
  await expect(page.getByText(/· v\d+ · edited/)).toBeVisible();
  await page.getByRole("button", { name: "Lock profile" }).click();
  await expect(page.locator(".pill", { hasText: "Locked" })).toBeVisible();
  await expect(page.getByLabel("Calls to action")).toBeDisabled();
  await expect(page.getByLabel("Calls to action")).toHaveValue(/fall gala/);

  // ---- Research: refresh → fake job → cited brief → approve
  await page.goto("/research");
  const refreshCall = page.waitForResponse((r) => r.url().endsWith("/api/research/refresh"));
  await page.getByRole("button", { name: "Refresh research" }).click();
  const { jobId } = (await (await refreshCall).json()) as { jobId: string };
  await runFake(api, jobId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Posting times" })).toBeVisible();
  await expect(page.locator('.rs-claim[data-label="web"] a[href^="https://buffer.com/"]').first()).toBeVisible();
  await expect(page.locator('.rs-claim[data-label="her_data"]').first()).toBeVisible();
  await expect(page.locator('.rs-claim[data-label="uncertain"]').first()).toContainText("Uncertain");
  // Truth rule on the page: nothing labelled as fact lacks a source.
  const factsWithoutSource = await page.locator('.rs-claim:not([data-label="uncertain"])').filter({ hasText: "No source yet" }).count();
  expect(factsWithoutSource).toBe(0);
  // The header's "N claims marked uncertain" counts exactly the Uncertain pills on the page.
  const shownUncertain = await page.locator('.rs-claim[data-label="uncertain"]').count();
  await expect(page.locator(".rs-legend .hint")).toContainText(`${shownUncertain} claim${shownUncertain === 1 ? "" : "s"} marked uncertain`);
  await page.getByRole("button", { name: "Approve brief" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Approved" })).toBeVisible();
  await expect(page.getByText(/^Approved v\d+/)).toBeVisible();

  // ---- Gate open: the same dump now goes through to cutting.
  const sent = await api.post(`/api/dumps/${dumpId}/dump`);
  expect(sent.status(), await sent.text()).toBe(200);
  expect(await sent.json()).toMatchObject({ ok: true, jobId: expect.stringMatching(/^job_/) });
});

test("stats: Instagram sign-in, TikTok export, sync, and an expired token turns the light red", async ({ page }) => {
  const api = page.request;

  // Fake OAuth: start connects at once and lands back on Connections.
  await page.goto("/api/oauth/meta/start");
  await expect(page).toHaveURL(/\/settings\/connections\?connected=meta/);
  await expect(page.getByText("Instagram stats connected.")).toBeVisible();
  await expect(page.getByText(/@practice.account/)).toBeVisible();

  // TikTok: the Connect row sends her to Stats; the export imports three videos.
  await page.getByRole("link", { name: "Upload TikTok export" }).click();
  await expect(page).toHaveURL(/\/stats$/);
  await page.locator('input[type="file"]').setInputFiles({ name: "Content.csv", mimeType: "text/csv", buffer: Buffer.from(TIKTOK_CSV) });
  await expect(page.locator(".toast").filter({ hasText: "Imported 3 TikTok videos." })).toBeVisible();
  await expect(page.getByText("Yacht day, white party")).toBeVisible();

  // A file that is not a TikTok export is refused with the fix guide.
  const bad = await api.post("/api/stats/tiktok-import", { data: { csv: "name,email\nx,y\n" } });
  expect(bad.status()).toBe(422);
  expect(await bad.json()).toMatchObject({ fix_guide: "upload-your-tiktok-export" });

  // Update numbers → fake metrics job → Instagram numbers and her own learned times. The screen
  // says "Update numbers", never "sync" (plain words, DESIGN.md Microcopy).
  const syncCall = page.waitForResponse((r) => r.url().endsWith("/api/stats/sync"));
  await expect(page.getByRole("button", { name: /sync/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Update numbers", exact: true }).click();
  const { jobId } = (await (await syncCall).json()) as { jobId: string };
  await runFake(api, jobId);
  await page.reload();
  await expect(page.getByText("4,820")).toBeVisible();
  const stats = (await (await api.get("/api/stats")).json()) as { learnedSlots: Record<string, unknown[]>; learning: Record<string, { ready: boolean }> };
  expect(stats.learning.instagram.ready).toBe(true);
  expect(stats.learnedSlots.instagram).toHaveLength(7);
  await expect(page.locator(".list-row", { hasText: "Instagram" }).locator(".pill", { hasText: "Your times" })).toBeVisible();

  // Failure shape: Instagram says the token expired → red light, plain sentence, reconnect guide.
  const again = (await (await api.post("/api/stats/sync")).json()) as { jobId: string };
  await runFake(api, again.jobId, { fail: "meta" });
  // every light (Home shows the worst few: HOME_CAPS.health), and Home's first light is this red one
  const lights = (await (await api.get("/api/settings/health")).json()) as { name: string; light: string; fix_guide: string | null }[];
  expect(lights.find((h) => h.name === "Instagram stats")).toMatchObject({ light: "red", fix_guide: "reconnect-meta" });
  const home = (await (await api.get("/api/home")).json()) as { health: { items: { name: string; light: string }[]; total: number } };
  expect(home.health.items[0]).toMatchObject({ light: "red" });
  expect(home.health.total).toBeGreaterThanOrEqual(home.health.items.length);
  await page.goto("/settings/connections");
  await expect(page.getByText("Instagram needs you to reconnect.")).toBeVisible();
  // Reconnect puts it right.
  await page.locator(".list-row", { hasText: "Instagram needs you to reconnect." }).getByRole("link", { name: "Reconnect" }).click();
  await expect(page.getByText("Instagram stats connected.")).toBeVisible();
});

test("stats with no sign-in: YouTube public numbers, Instagram numbers form, TikTok zip export", async ({ page }) => {
  const fixture = (f: string) => readFileSync(path.join(process.cwd(), "tests", "unit", "fixtures", f));
  await page.goto("/stats");

  // The sign-ins stay on the screen, labelled optional, with the plain warning sentence.
  await expect(page.getByRole("heading", { name: "Extra detail (optional)" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect with Google \(optional\)|Google connected/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect with Instagram \(optional\)|Instagram connected/ })).toBeVisible();
  await expect(page.getByText(/may show a warning page until the app is approved/)).toBeVisible();

  // YouTube: public numbers, no sign-in; the channel typed once.
  await page.getByLabel("Different channel? Paste its @name or link").fill("@samplechannel");
  await page.getByRole("button", { name: "Use this channel" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Channel saved." })).toBeVisible();
  await expect(page.getByText(/1,260 subscribers/)).toBeVisible();
  await expect(page.locator('[data-source="youtube"]')).toContainText("Public numbers, no sign-in");

  // Instagram: the 3-step guide and the form; her numbers show at once.
  await expect(page.getByText("Professional dashboard", { exact: true })).toBeVisible();
  await page.getByLabel("Followers").fill("2,345");
  await page.getByLabel("Average reach or views").fill("1500");
  await page.getByRole("button", { name: "Save my numbers" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Instagram numbers saved." })).toBeVisible();
  await expect(page.locator(".card", { hasText: "Instagram" }).getByText("2,345", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Remind me monthly" }).click();
  await expect(page.getByRole("button", { name: "Monthly reminder on" })).toBeVisible();

  // TikTok: the zip TikTok Studio hands her imports; a real Excel file gets the Excel message.
  await page.locator('input[type="file"]').setInputFiles({ name: "Content_samplec11.zip", mimeType: "application/zip", buffer: fixture("tiktok-content.zip") });
  await expect(page.locator(".toast").filter({ hasText: "Imported 3 TikTok videos." })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "export.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: fixture("tiktok-export.xlsx") });
  await expect(page.locator(".toast").filter({ hasText: "That is an Excel file." })).toBeVisible();

  // Update numbers never needs a sign-in.
  const r = await page.request.post("/api/stats/sync");
  expect(r.status()).toBe(200);
  const synced = (await r.json()) as { ok: boolean; youtube: { state: string }; jobId: string | null };
  expect(synced).toMatchObject({ ok: true, youtube: { state: "ok" } });
  // A sign-in left connected by the spec before this one adds its job: finish it, so the next
  // project finds no update still running.
  if (synced.jobId) await runFake(page.request, synced.jobId);
});

test("Client Brain, Research, Stats and Connections fit the screen with no sideways scroll", async ({ page }) => {
  for (const path of ["/brain", "/research", "/stats", "/settings/connections"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Help for this screen" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${test.info().project.name}${path.replace(/\//g, "_")}.png`, fullPage: true });
  }
});
