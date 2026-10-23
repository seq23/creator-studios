// Studio fix (23 Oct 2026), phone and desktop: a dump of videos AND photos goes through the fake
// cutter; Review shows "Oct 22 · Clip 5", the score with its reason, one-tap fixes, a new version
// with its letter and Compare versions; What I dumped lists every file with its stage and the
// clips that used it; Settings > Your clips changes the call to action. Phone first: no sideways
// scroll, ← Back and ✕ Close everywhere.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-studio-fix-seed";

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Gardens","ctas":"Follow for more"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});
test.afterAll(() => {
  d1(`DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%'; DELETE FROM settings WHERE key = 'studio_rules';`);
});

const rand = (n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  return b;
};

async function upload(request: APIRequestContext, dumpId: string, name: string, mime: string, bytes: Buffer) {
  const start = await request.post("/api/uploads/start", { data: { kind: "video", parentId: dumpId, fileName: name, size: bytes.length, mimeType: mime, contentHash: `e2e-${Date.now()}-${Math.random()}` } });
  expect(start.ok(), await start.text()).toBe(true);
  const up = await start.json();
  const part = await request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: bytes });
  expect((await request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } })).ok()).toBe(true);
}

/** One video and one photo (no camera details: an AI picture) in one dump, cut by the fake engine. */
async function mixedDump(request: APIRequestContext): Promise<string> {
  const { id } = await (await request.post("/api/dumps", { data: { door: "new", notes: "e2e studio fix" } })).json();
  await upload(request, id, "studio-fix.mp4", "video/mp4", rand(64_000));
  await upload(request, id, "after-final.jpg", "image/jpeg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0]), rand(2000), Buffer.from([0xff, 0xd9])]));
  const dumped = await request.post(`/api/dumps/${id}/dump`);
  expect(dumped.ok(), await dumped.text()).toBe(true);
  const { jobId } = await dumped.json();
  expect((await request.post(`/api/jobs/${jobId}/run-fake`, { data: { clips: 4 } })).ok()).toBe(true);
  return id;
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>(".modal"))].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName));
  expect(over).toEqual([]);
}

test("Review: clip numbers, the score with its reason, a one-tap fix makes 1b, Compare versions keeps the best", async ({ page, request }) => {
  const dumpId = await mixedDump(request);
  await page.goto("/review");
  const group = page.locator(`[data-dump-id="${dumpId}"]`);
  const first = group.locator('[data-clip-code="1"]');
  await expect(first.locator("[data-clip-label]")).toHaveText(/ · Clip 1$/);
  await expect(first.locator("[data-score]")).toContainText("Score 92: ends on the finished result");
  // The dump's photo had no camera details: its clips say so.
  await expect(first.locator("[data-ai-picture]")).toBeVisible();
  await expect(group.locator("[data-files-link]")).toBeVisible();
  await noSideScroll(page);

  // One tap: "Less blur". The current clip stays until the new version is in.
  await first.getByRole("button", { name: "Less blur" }).click();
  await expect(page.getByText(/Making clip 1 again: less blur/)).toBeVisible();
  const job = (await (await request.get("/api/clips?tab=new&q=1&limit=50")).json()) as { groups: { dump: { id: string }; clips: { id: string }[] }[] };
  const clipId = job.groups.find((g) => g.dump.id === dumpId)!.clips[0].id;
  const jobId = d1<{ id: string }>(`SELECT id FROM jobs WHERE type = 'cut' AND ref_id = '${dumpId}/${clipId}/again' ORDER BY created_at DESC LIMIT 1;`)[0]?.id ?? "";
  expect(jobId).not.toBe("");
  expect((await request.post(`/api/jobs/${jobId}/run-fake`, { data: {} })).ok()).toBe(true);
  await page.reload();
  const again = page.locator(`[data-dump-id="${dumpId}"] [data-clip-code="1b"]`);
  await expect(again.locator("[data-clip-label]")).toHaveText(/ · Clip 1b$/);
  await expect(again.locator("[data-score]")).toContainText("fixed: less blur");

  // Compare versions: play either, keep the first one back.
  await again.locator("[data-compare]").click();
  const modal = page.getByRole("dialog");
  await expect(modal.locator("video")).toHaveCount(2);
  await noSideScroll(page);
  await modal.getByRole("button", { name: "Keep this one (1)" }).click();
  await expect(page.locator(`[data-dump-id="${dumpId}"] [data-clip-code="1"]`)).toBeVisible();

  // Search by number.
  await page.getByRole("searchbox", { name: /Search by clip number/ }).fill("1b");
  await expect(page.locator(`[data-dump-id="${dumpId}"] [data-clip-code]`)).toHaveCount(0);
});

test("What I dumped: every file with its stage, the clips that used it, ← Back and ✕ Close", async ({ page, request }) => {
  const dumpId = await mixedDump(request);
  await page.goto(`/dump/${dumpId}/files`);
  await expect(page.locator("[data-files-summary]")).toContainText("2 files: 1 video, 1 photo");
  const rows = page.locator("[data-file-id]");
  await expect(rows).toHaveCount(2);
  const photo = rows.nth(1);
  await expect(photo.locator("[data-role]")).toContainText("Best finished shot (ends clips)");
  await expect(photo.locator("[data-used-by]")).toContainText("Clip 1 (ends on it)");
  await expect(photo).toContainText("treated as an AI picture");
  await noSideScroll(page);
  await photo.getByRole("button", { name: /Tap to view photo/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "✕ Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("[data-back]").click();
  await expect(page).toHaveURL(new RegExp(`/dump/${dumpId}$`));
});

test("Settings > Your clips: the call to action and its link, Made with AI, clips per dump, the bar", async ({ page }) => {
  await page.goto("/settings#your-clips");
  const card = page.locator("[data-clip-rules]");
  await expect(card.getByLabel("What each clip asks people to do")).toHaveValue("Request a quote\nBook your date");
  await card.getByLabel("Where they go: your link").fill("not a link");
  await card.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText(/does not look right/)).toBeVisible();
  await card.getByLabel("Where they go: your link").fill("https://example.com/book");
  await card.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Saved. New clips use it.").first()).toBeVisible();
  await card.getByRole("radio", { name: "Every clip" }).click();
  await expect(card.getByRole("radio", { name: "Every clip" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByText("Review bar: 70 out of 100")).toBeVisible();
  await noSideScroll(page);
});

test("Dump: new footage takes videos and photos together, full quality", async ({ page }) => {
  await page.goto("/dump");
  await page.getByRole("radio", { name: /New videos/ }).click();
  await expect(page.locator("[data-primary]")).toHaveText("Choose videos and photos");
  await expect(page.getByText("full quality, never shrunk")).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "clip.mp4", mimeType: "video/mp4", buffer: rand(200_000) },
    { name: "finished.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([Buffer.from([0xff, 0xd8]), rand(5000)]) },
  ]);
  await expect(page.getByText("Uploaded")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText(/2 files/)).toBeVisible();
});
