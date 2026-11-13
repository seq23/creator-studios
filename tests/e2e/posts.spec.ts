// The Posts overhaul, phase 1 (owner's rulings, 13 Nov 2026), on a phone and a desktop against
// wrangler dev with the fakes: a real dump through the fake cutter and a real photo set through the
// fake photo maker, so every post has a picture and a file. Then: one list with reels AND photo
// posts, open each kind in the sheet (watch, read the whole caption, change the words, close and
// land where she was), the same numbers on Home, the Calendar and Settings, and the Rejected bin
// (bring back, delete for good with the question asked on the page, empty the bin).
// PROOF_DIR=<folder> also saves a picture of each step at phone width.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql } from "./helpers";

const SEED = "e2e-posts-seed";
const PROOF = process.env.PROOF_DIR;
let dumpId = "";
let packId = "";
const errors: string[] = [];

test.describe.configure({ mode: "serial" });

async function shot(page: Page, name: string, isMobile: boolean) {
  if (!PROOF || !isMobile) return;
  mkdirSync(PROOF, { recursive: true });
  await page.screenshot({ path: path.join(PROOF, `${name}.png`) });
}

/** Anything the browser console calls an error, or a page crash, fails the spec. */
function watch(page: Page) {
  page.on("console", (m) => (m.type() === "error" ? errors.push(`${m.text()} @ ${m.location().url}`) : undefined));
  page.on("pageerror", (e) => errors.push(String(e)));
  // The bin asks on the page: a browser pop-up anywhere here is a defect.
  page.on("dialog", (d) => {
    errors.push(`browser dialog: ${d.message()}`);
    void d.dismiss();
  });
}

async function upload(request: APIRequestContext, kind: "video" | "photo", parentId: string, fileName: string, mimeType: string, bytes: Buffer) {
  const start = await request.post("/api/uploads/start", { data: { kind, parentId, fileName, size: bytes.length, mimeType, contentHash: `e2e-${Date.now()}-${Math.random()}` } });
  expect(start.ok(), await start.text()).toBe(true);
  const up = await start.json();
  const part = await request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: bytes });
  expect(part.ok()).toBe(true);
  expect((await request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } })).ok()).toBe(true);
}

/** A real dump through the fake cutter: clips with a playable file and a cover. */
async function readyDump(request: APIRequestContext): Promise<string> {
  const { id } = await (await request.post("/api/dumps", { data: { door: "new", notes: "e2e posts" } })).json();
  const bytes = Buffer.alloc(64_000);
  for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  await upload(request, "video", id, "posts.mp4", "video/mp4", bytes);
  const dumped = await request.post(`/api/dumps/${id}/dump`);
  expect(dumped.ok(), await dumped.text()).toBe(true);
  const ran = await request.post(`/api/jobs/${(await dumped.json()).jobId}/run-fake`, { data: { clips: 6 } });
  expect(ran.ok(), await ran.text()).toBe(true);
  return id;
}

/** A real photo set through the fake photo maker: a moving photo and a photo set, planned on their days. */
async function readyPack(request: APIRequestContext): Promise<string> {
  const { id } = await (await request.post("/api/photos/packs", { data: { note: "Front porch dressed for fall" } })).json();
  await upload(request, "photo", id, "porch.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  const made = await request.post(`/api/photos/packs/${id}/make`);
  expect(made.ok(), await made.text()).toBe(true);
  const job = sql<{ id: string; status: string }>(`SELECT id, status FROM jobs WHERE type = 'photopack' AND ref_id = '${id}' ORDER BY created_at DESC LIMIT 1`)[0];
  if (job && job.status !== "done") expect((await request.post(`/api/jobs/${job.id}/run-fake`, { data: {} })).ok()).toBe(true);
  await expect.poll(() => sql<{ n: number }>(`SELECT COUNT(*) AS n FROM social_posts WHERE pack_id = '${id}'`)[0].n).toBeGreaterThan(0);
  return id;
}

const clipIds = (status: string) => sql<{ id: string }>(`SELECT id FROM clips WHERE dump_id = '${dumpId}' AND status = '${status}' AND style_of IS NULL ORDER BY score DESC`).map((r) => r.id);

function cleanUp() {
  sql(
    [
      "DELETE FROM posts",
      "DELETE FROM social_posts",
      "DELETE FROM pack_items",
      "DELETE FROM pack_photos",
      "DELETE FROM photo_packs",
      `DELETE FROM clips WHERE dump_id IN (SELECT id FROM dumps WHERE notes = 'e2e posts')`,
      `DELETE FROM assets WHERE dump_id IN (SELECT id FROM dumps WHERE notes = 'e2e posts')`,
      `DELETE FROM dumps WHERE notes = 'e2e posts'`,
      `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'`,
      `DELETE FROM research_briefs WHERE body LIKE '%${SEED}%'`,
      "DELETE FROM emails_sent WHERE kind = 'heads_up'",
    ].join("; "),
  );
}

test.beforeAll(() => {
  cleanUp();
  sql(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Porches","ctas":"Book a date"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});
// Leave the database as this spec found it (the other specs start from the base state).
test.afterAll(() => cleanUp());

test.beforeEach(({ page }) => watch(page));
test.afterEach(() => {
  const seen = errors.splice(0);
  expect(seen, "browser console errors").toEqual([]);
});

test("one list of every upcoming post, reels and photo posts; the same numbers on Home, the Calendar and Settings", async ({ page, isMobile }) => {
  cleanUp();
  sql(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Porches","ctas":"Book a date"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
  expect((await page.request.patch("/api/settings", { data: { weekly_caps: { tiktok: 10, instagram: 7, youtube: 5 } } })).ok()).toBe(true);
  dumpId = await readyDump(page.request);
  const drafts = clipIds("draft");
  expect(drafts.length).toBeGreaterThanOrEqual(4);
  for (const id of drafts.slice(0, 2)) expect((await page.request.post(`/api/clips/${id}/approve`)).ok()).toBe(true);
  expect((await page.request.post("/api/posts/plan", { data: {} })).ok()).toBe(true);
  packId = await readyPack(page.request);
  // One photo post waits on a connection that was never made.
  const waiting = sql<{ id: string }>(`SELECT id FROM social_posts WHERE pack_id = '${packId}' AND platform = 'facebook' AND item_kind = 'carousel' LIMIT 1`)[0];
  if (waiting) sql(`UPDATE social_posts SET status = 'waiting', error = 'connect:facebook' WHERE id = '${waiting.id}'`);

  await page.goto("/calendar");
  const list = page.locator("[data-posts-list]");
  await expect(list.locator('.post-row[data-kind="reel"]').first()).toBeVisible();
  await expect(list.locator('.post-row[data-kind="moving_photo"]').first()).toBeVisible();
  // Every row: a kind in plain words, a time and a platform, a headline, and Open.
  const row = list.locator('.post-row[data-kind="reel"]').first();
  await expect(row.locator(".post-chip")).toHaveText("Reel");
  await expect(row).toContainText(/\d{1,2}:\d{2} (AM|PM) · (TikTok|Instagram|YouTube)/);
  await expect(row.getByRole("button", { name: /^Open/ })).toBeVisible();
  await expect(list.locator('.post-row[data-kind="moving_photo"] .post-chip').first()).toHaveText("Moving photo");
  await expect(list.locator(".posts-day-name").first()).toHaveText(/^(Today, )?(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}$/);
  // Plain words: no posting-service name, no clip numbers, no ids.
  await expect(list).not.toContainText(/Buffer|Clip \d|clp_|spo_|pst_|runway/i);
  if (waiting) {
    const group = page.locator('[data-blocked="connect:facebook"]');
    await expect(group).toContainText("Waiting on Facebook (1)");
    await expect(group).toContainText("Facebook is not connected yet. It goes out once it is.");
    await expect(group.getByRole("link", { name: "Connect ›" })).toHaveAttribute("href", "/settings/connections");
  }
  // Every tap target on the list is at least 44 px tall.
  for (const b of await list.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, "02-posts-list-reels-and-photo-posts", isMobile);

  // Line 1, then the same numbers on Home and on the Settings line.
  const line = (await page.locator("[data-posts-line] strong").innerText()).trim();
  const coming = Number(/^(\d+) posts? coming · planned through /.exec(line)?.[1]);
  const upcoming = (await (await page.request.get("/api/posts/upcoming")).json()) as { posts: unknown[] };
  expect(upcoming.posts.length).toBe(coming); // the number counts exactly the posts in the list
  const fromApi = (await (await page.request.get("/api/posts/summary")).json()).summary as { postedThisWeek: number; toGo: number };
  expect(fromApi.toGo).toBe(coming);
  await page.evaluate(() => localStorage.setItem("ss-tour-done", "1")); // the first-login tour would cover the tile
  await page.goto("/");
  // Home's This week line: the same two numbers in the same words as Settings, and a 44px way to Posts.
  await expect(page.locator('[data-count="to-go"]')).toHaveText(`${coming} still to go out`);
  await expect(page.locator('[data-count="posted"]')).toHaveText(`${fromApi.postedThisWeek} posted`);
  const toGo = page.locator("[data-this-week] a");
  await expect(toGo).toHaveAttribute("href", "/calendar");
  expect((await toGo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toGo.evaluate((e) => e.scrollIntoView({ block: "center" })); // the picture shows the line, clear of the bottom bar
  await shot(page, "08-home-same-numbers", isMobile);
  await page.goto("/settings");
  await expect(page.locator('[data-count="to-go"]')).toHaveText(`${coming} still to go out`);
  await expect(page.locator('[data-count="posted"]')).toHaveText(`${fromApi.postedThisWeek} posted`);
  await expect(page.locator("body")).not.toContainText("unique clips");
  await page.locator('[data-count="to-go"]').scrollIntoViewIfNeeded();
  await shot(page, "09-settings-same-numbers", isMobile);

  // Week and month are a tap away; nothing scrolls sideways on a phone.
  await page.goto("/calendar");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Week" }).click();
  await expect(page.locator(".cal-week")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("open a post of each kind: watch it, read the whole caption, change the words, close and land where she was", async ({ page, isMobile }) => {
  await page.goto("/calendar");
  const list = page.locator("[data-posts-list]");
  const reel = list.locator('.post-row[data-kind="reel"]').last();
  await reel.getByRole("button", { name: /^Open/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const before = await page.evaluate(() => window.scrollY); // where the list was when she opened it
  expect(before).toBeGreaterThan(0);
  await expect(sheet.locator("video")).toHaveAttribute("src", /^\/media\//);
  await expect(sheet.locator("video")).toHaveAttribute("controls", "");
  const src = await sheet.locator("video").getAttribute("src");
  expect((await page.request.get(src!)).headers()["content-type"]).toContain("video/mp4");
  await expect(sheet).toContainText(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM) · (TikTok|Instagram|YouTube)/);
  await expect(sheet.locator("[data-post-caption]")).not.toBeEmpty();
  await shot(page, "03-open-a-reel", isMobile);

  await sheet.getByRole("button", { name: "Change the words" }).click();
  await sheet.getByLabel("The words that post").fill("Porch ready before the in-laws pull in.\n\nBook your date this week.");
  await shot(page, "04-reel-change-the-words", isMobile);
  await sheet.getByRole("button", { name: "Save the words" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Saved. This is what will post." }).first()).toBeVisible();
  await expect(sheet.locator("[data-post-caption]")).toContainText("Porch ready before the in-laws pull in.");
  await expect(sheet.locator("[data-post-caption]")).toContainText("Book your date this week.");
  // Everything she could do before is in the sheet.
  await expect(sheet.getByLabel("Move to another day")).toBeVisible();
  await expect(sheet.getByLabel("Swap for a different post")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Take it off the calendar" })).toBeVisible();
  expect(await sheet.locator(".modal, .post-sheet").evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  // Escape closes, and the list is exactly where she left it.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
  await expect(reel).toContainText("Porch ready before the in-laws pull in.");

  // A photo post: its video, its caption, the same sheet; "✕ Close" closes.
  const photo = list.locator('.post-row[data-kind="moving_photo"]').first();
  await photo.getByRole("button", { name: /^Open/ }).click();
  await expect(sheet.locator("video")).toHaveAttribute("src", /^\/media\/p\//);
  await expect(sheet.locator(".post-chip")).toHaveText("Moving photo");
  await shot(page, "05-open-a-photo-post", isMobile);
  await sheet.getByRole("button", { name: "Change the words" }).click();
  await sheet.getByLabel("The words that post").fill("The porch, dressed for fall. Dates are open.");
  await sheet.getByRole("button", { name: "Save the words" }).click();
  // Word for word as it will post: her words, and the "Made with AI" note where the platform shows it as words.
  await expect(sheet.locator("[data-post-caption]")).toHaveText(/^The porch, dressed for fall\. Dates are open\.(\s+Made with AI)?$/);
  await expect(sheet.getByLabel("Move to another day")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Skip this post (it will not go out)" })).toBeVisible();
  await expect(sheet.getByLabel("Swap for a different post")).toHaveCount(0);
  await shot(page, "06-photo-post-words-saved", isMobile);
  await sheet.getByRole("button", { name: "✕ Close" }).last().click();
  await expect(sheet).toHaveCount(0);

  // A photo set shows its photos.
  const set = list.locator('.post-row[data-kind="photo"], .post-row[data-kind="photo_set"]').first();
  if (await set.count()) {
    await set.getByRole("button", { name: /^Open/ }).click();
    await expect(sheet.locator(".post-photos img").first()).toBeVisible();
    await shot(page, "07-open-a-photo-set", isMobile);
    await page.keyboard.press("Escape");
  }
});

test("the Rejected bin: reject, bring back, delete for good (asked on the page), empty the bin", async ({ page, isMobile }) => {
  // She says no to a reel in Review and skips a photo post from its sheet.
  const [first, second] = clipIds("draft");
  expect((await page.request.post(`/api/clips/${first}/reject`, { data: { reason: "bad hook" } })).ok()).toBe(true);
  await page.goto("/calendar");
  await page.locator('[data-posts-list] .post-row[data-kind="moving_photo"]').first().getByRole("button", { name: /^Open/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Skip this post (it will not go out)" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Skipped. That post will not go out. It waits in the Rejected bin." }).first()).toBeVisible();
  const link = page.locator("[data-bin-link]");
  await expect(link).toHaveText("Rejected bin (2) ›");
  await shot(page, "10-posts-with-bin-link", isMobile);
  await link.click();
  await expect(page).toHaveURL(/\/calendar\/bin$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rejected bin · 2 posts");
  await expect(page.locator("body")).toContainText("Posts you said no to wait here until you bring them back or delete them. Nothing in the bin is ever posted.");
  const reelRow = page.locator(`[data-bin-id="${first}"]`);
  await expect(reelRow.locator(".post-chip")).toHaveText("Reel");
  await expect(reelRow).toContainText(/Rejected (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}/);
  // The bin holds a post until she deletes it: no clear date anywhere on the page.
  await expect(page.locator(".page")).not.toContainText(/clear/i);
  await shot(page, "11-rejected-bin", isMobile);

  // Bring back: the reel waits for her OK again.
  await reelRow.getByRole("button", { name: "Bring back ›" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Brought back. It is waiting for your OK in New posts to look at." }).first()).toBeVisible();
  await expect(reelRow).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rejected bin · 1 post");
  expect(clipIds("draft")).toContain(first);
  await shot(page, "12-brought-back", isMobile);

  // Reject it again, then delete it for good: the question is asked on the page, and Keep it keeps it.
  expect((await page.request.post(`/api/clips/${first}/reject`, { data: {} })).ok()).toBe(true);
  const media = sql<{ media_token: string }>(`SELECT media_token FROM clips WHERE id = '${first}'`)[0].media_token;
  expect((await page.request.get(`/media/${media}`)).status()).toBe(200);
  await page.reload();
  await reelRow.getByRole("button", { name: "Delete for good" }).click();
  const ask = reelRow.getByRole("group", { name: "Delete this post for good?" });
  await expect(ask).toContainText("Delete this post for good?");
  await expect(ask).toContainText("It cannot be brought back. Your original photos and videos are kept.");
  await shot(page, "13-delete-for-good-asks-on-the-page", isMobile);
  await ask.getByRole("button", { name: "Keep it" }).click();
  await expect(ask).toHaveCount(0);
  await expect(reelRow).toBeVisible();
  expect(sql<{ status: string }>(`SELECT status FROM clips WHERE id = '${first}'`)[0].status).toBe("rejected");
  await reelRow.getByRole("button", { name: "Delete for good" }).click();
  await ask.getByRole("button", { name: "Yes, delete for good" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Deleted for good. Your original photos and videos are kept." }).first()).toBeVisible();
  await expect(reelRow).toHaveCount(0);
  // The made file is gone; her original upload is still there.
  expect((await page.request.get(`/media/${media}`)).status()).toBe(404);
  expect(sql<{ status: string; raw: string | null; up: string }>(`SELECT c.status, a.raw_deleted_at AS raw, a.upload_status AS up FROM clips c JOIN assets a ON a.id = c.asset_id WHERE c.id = '${first}'`)[0]).toEqual({ status: "deleted", raw: null, up: "uploaded" });
  await shot(page, "14-deleted-for-good", isMobile);

  // Empty the whole bin: apart at the bottom, says how many, asked on the page.
  expect((await page.request.post(`/api/clips/${second}/reject`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rejected bin · 2 posts");
  await page.getByRole("button", { name: "Empty the whole bin" }).click();
  const all = page.getByRole("group", { name: "Empty the whole bin?" });
  await expect(all).toContainText("Delete all 2 posts in the bin for good?");
  await expect(all).toContainText("They cannot be brought back. Your original photos and videos are kept.");
  await shot(page, "15-empty-the-bin-asks", isMobile);
  await all.getByRole("button", { name: "Yes, delete all 2 for good" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Deleted 2 posts for good." }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "The bin is empty" })).toBeVisible();
  expect(sql<{ n: number }>(`SELECT COUNT(*) AS n FROM pack_photos WHERE pack_id = '${packId}' AND upload_status = 'uploaded'`)[0].n).toBe(1); // her photo is kept
  await shot(page, "16-bin-empty", isMobile);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Back to Posts, and Review's Rejected tab leads to the same bin.
  await page.getByRole("link", { name: "← Back to Posts" }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator("[data-bin-link]")).toHaveText("Rejected bin (0) ›");
  await page.goto("/review?tab=rejected");
  await expect(page.locator("[data-bin-pointer]").getByRole("link", { name: "Rejected bin ›" })).toHaveAttribute("href", "/calendar/bin");
});
