// Review (section 9), phone and desktop: a real dump goes through the fake cutter into Review,
// then she approves, rejects with a reason, deletes with a confirm, edits a caption, and finds the
// hidden clips. The section 6 gate (locked profile + approved brief) is opened by writing to the
// same local D1 the e2e server uses, and closed again afterwards so other specs see a fresh gate.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-review-seed";

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Morning routines","ctas":"Follow for more"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});

test.afterAll(() => {
  d1(`DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%';`);
});

interface Clip {
  id: string;
  score: number;
  hidden: boolean;
  hook_text: string;
  hook_alt: string | null;
  caption: string;
  platforms: string[];
  paid_partnership: boolean;
  media_url: string;
  cover_url: string | null;
  status: string;
  reject_reason: string | null;
}

/** Create a dump, upload one small video, press Dump, run the fake cutter. Returns the dump id. */
async function readyDump(request: APIRequestContext, clips = 10, fake: Record<string, unknown> = {}): Promise<string> {
  const { id } = await (await request.post("/api/dumps", { data: { door: "new", notes: "e2e review" } })).json();
  const bytes = Buffer.alloc(64_000);
  for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  const start = await request.post("/api/uploads/start", {
    data: { kind: "video", parentId: id, fileName: "review.mp4", size: bytes.length, mimeType: "video/mp4", contentHash: `e2e-${Date.now()}-${Math.random()}` },
  });
  expect(start.ok()).toBe(true);
  const up = await start.json();
  const part = await request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: bytes });
  expect(part.ok()).toBe(true);
  expect((await request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } })).ok()).toBe(true);
  const dumped = await request.post(`/api/dumps/${id}/dump`);
  expect(dumped.ok(), await dumped.text()).toBe(true);
  const { jobId } = await dumped.json();
  const ran = await request.post(`/api/jobs/${jobId}/run-fake`, { data: { clips, ...fake } });
  expect(ran.ok(), await ran.text()).toBe(true);
  return id;
}

async function clipsOf(request: APIRequestContext, dumpId: string, tab = "new", hidden = true): Promise<Clip[]> {
  const res = await request.get(`/api/clips?tab=${tab}&limit=100${hidden ? "&hidden=1" : ""}`);
  const body = (await res.json()) as { groups: { dump: { id: string }; clips: Clip[] }[] };
  return body.groups.find((g) => g.dump.id === dumpId)?.clips ?? [];
}

/** Phone first: nothing on the page or in an open dialog may scroll sideways. */
async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => {
    const els = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>(".modal"))];
    return els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName);
  });
  expect(over).toEqual([]);
}

function group(page: Page, dumpId: string) {
  return page.locator(`[data-dump-id="${dumpId}"]`);
}

test("a cut dump lands in Review grouped, best first, with a player and cover", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const all = await clipsOf(page.request, dumpId);
  expect(all).toHaveLength(10);
  expect(all.map((c) => c.score)).toEqual([...all.map((c) => c.score)].sort((a, b) => b - a));
  const visible = all.filter((c) => !c.hidden);
  expect(visible.length).toBe(8);

  const dump = await (await page.request.get(`/api/dumps/${dumpId}`)).json();
  expect(dump.dump).toMatchObject({ status: "ready", clips_made: 10 });

  await page.goto("/review");
  const cards = group(page, dumpId).locator("article.clip-card");
  await expect(cards).toHaveCount(8);
  await expect(cards.first()).toContainText(visible[0].hook_text);
  const video = cards.first().locator("video");
  await expect(video).toHaveAttribute("src", visible[0].media_url);
  await expect(video).toHaveAttribute("playsinline", "");

  const media = await page.request.get(visible[0].media_url);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toContain("video/mp4");
  expect((await media.body()).subarray(4, 8).toString()).toBe("ftyp");
  const cover = await page.request.get(visible[0].cover_url!);
  expect(cover.headers()["content-type"]).toContain("image/jpeg");
  await expect(page.getByRole("link", { name: "Help for this screen" })).toHaveAttribute("href", "/help/review-and-approve-clips");
  await noSideScroll(page);
});

test("approve one, reject one with a reason, change her mind from the Rejected tab", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const [first, second] = await clipsOf(page.request, dumpId, "new", false);
  await page.goto("/review");
  const g = group(page, dumpId);

  await g.locator(`[data-clip-id="${first.id}"]`).getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".toast").first()).toContainText("Approved");
  await expect(g.locator(`[data-clip-id="${first.id}"]`)).toHaveCount(0);

  await g.locator(`[data-clip-id="${second.id}"]`).getByRole("button", { name: "Reject" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Too long" }).click();
  await expect(g.locator(`[data-clip-id="${second.id}"]`)).toHaveCount(0);

  await page.getByRole("tab", { name: /Rejected/ }).click();
  const rejected = page.locator(`[data-clip-id="${second.id}"]`);
  await expect(rejected).toContainText("Reason: too long");
  await expect(rejected).toContainText("Removed for good on");
  await rejected.getByRole("button", { name: "Approve" }).click();
  await expect(rejected).toHaveCount(0);

  const approved = await clipsOf(page.request, dumpId, "approved");
  expect(approved.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
  expect(approved.find((c) => c.id === second.id)?.reject_reason).toBeNull();
});

test("select several and reject them together with a reason", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const [a, b] = await clipsOf(page.request, dumpId, "new", false);
  await page.goto("/review");
  const g = group(page, dumpId);
  await g.locator(`[data-clip-id="${a.id}"]`).getByLabel("Select this clip").check();
  await g.locator(`[data-clip-id="${b.id}"]`).getByLabel("Select this clip").check();
  const bar = page.getByRole("region", { name: "Selected clips" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Reject" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Bad hook" }).click();
  await expect(page.locator(".toast").first()).toContainText("2 clips rejected");
  const rejected = await clipsOf(page.request, dumpId, "rejected");
  expect(rejected.map((c) => [c.id, c.reject_reason]).sort()).toEqual([[a.id, "bad hook"], [b.id, "bad hook"]].sort());
});

test("edit a caption, swap to the other hook, untick a platform, mark a paid partnership", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const [clip] = await clipsOf(page.request, dumpId, "new", false);
  await page.goto("/review");
  const card = group(page, dumpId).locator(`[data-clip-id="${clip.id}"]`);
  await card.getByRole("button", { name: "Edit caption & hook" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Caption", { exact: true }).fill("My own words for this one");
  await noSideScroll(page);
  await dialog.getByRole("button", { name: /Use the other hook/ }).click();
  await expect(dialog.getByLabel("On-screen hook")).toHaveValue(clip.hook_alt!);
  await dialog.getByLabel("YouTube Shorts").uncheck();
  await dialog.getByText("Paid partnership", { exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast").first()).toContainText("Saved");

  await expect(card).toContainText("My own words for this one #ad");
  await expect(card).toContainText(clip.hook_alt!);
  await expect(card.locator(".pill", { hasText: "Paid partnership" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Post to YouTube" })).toHaveAttribute("aria-pressed", "false");
  // every platform chip is a full 44 px tap target
  for (const name of ["Post to TikTok", "Post to Instagram", "Post to YouTube"]) expect((await card.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const [saved] = (await clipsOf(page.request, dumpId)).filter((c) => c.id === clip.id);
  expect(saved).toMatchObject({ caption: "My own words for this one #ad", hook_text: clip.hook_alt, hook_alt: clip.hook_text, paid_partnership: true, platforms: ["tiktok", "instagram"] });

  // A platform chip on the card is a one-tap untick too; the last one cannot be removed.
  await card.getByRole("button", { name: "Post to Instagram" }).click();
  await expect(card.getByRole("button", { name: "Post to Instagram" })).toHaveAttribute("aria-pressed", "false");
  await card.getByRole("button", { name: "Post to TikTok" }).click();
  await expect(page.locator(".toast.bad")).toContainText("at least one platform");
  await expect(card.getByRole("button", { name: "Post to TikTok" })).toHaveAttribute("aria-pressed", "true");
});

test("reopening Edit right after Save shows the saved values, so a second Save keeps them", async ({ page }) => {
  // Phase 0 live test, 25 Sep 2026: reopening within ~0.5 s showed the pre-save values while the
  // list reloaded, and a second Save put the old ones back (paid partnership reverted once).
  const dumpId = await readyDump(page.request);
  const [clip] = await clipsOf(page.request, dumpId, "new", false);
  await page.goto("/review");
  const card = group(page, dumpId).locator(`[data-clip-id="${clip.id}"]`);
  // hold the list reload back, so the reopen happens before it could have finished
  await page.route("**/api/clips?*", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await card.getByRole("button", { name: "Edit caption & hook" }).click();
  let dialog = page.getByRole("dialog", { name: "Edit this clip" });
  await dialog.getByLabel("Caption", { exact: true }).fill("Saved words, first save");
  await dialog.getByText("Paid partnership", { exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await card.getByRole("button", { name: "Edit caption & hook" }).click();
  dialog = page.getByRole("dialog", { name: "Edit this clip" });
  await expect(dialog.getByLabel("Caption", { exact: true })).toHaveValue("Saved words, first save");
  await expect(dialog.getByRole("checkbox", { name: /Paid partnership/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/clips?*");
  const [saved] = (await clipsOf(page.request, dumpId)).filter((c) => c.id === clip.id);
  expect(saved).toMatchObject({ caption: "Saved words, first save #ad", paid_partnership: true });
});

test("delete asks to confirm, then removes the file for good", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const [clip] = await clipsOf(page.request, dumpId, "new", false);
  await page.goto("/review");
  const card = group(page, dumpId).locator(`[data-clip-id="${clip.id}"]`);

  await card.getByRole("button", { name: "Delete this clip" }).click();
  await page.getByRole("dialog", { name: "Delete this clip for good?" }).getByRole("button", { name: "Keep it" }).click();
  await expect(card).toBeVisible();
  expect((await page.request.get(clip.media_url)).status()).toBe(200);

  await card.getByRole("button", { name: "Delete this clip" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete for good" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".toast").first()).toContainText("Deleted for good");
  expect((await page.request.get(clip.media_url)).status()).toBe(404);
  expect((await page.request.get(clip.cover_url!)).status()).toBe(404);
  for (const tab of ["new", "approved", "rejected"]) expect((await clipsOf(page.request, dumpId, tab)).some((c) => c.id === clip.id)).toBe(false);
});

test("clips under the quality bar are hidden until she asks", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  await page.goto("/review");
  const cards = group(page, dumpId).locator("article.clip-card");
  await expect(cards).toHaveCount(8);
  await expect(group(page, dumpId).getByText("Under the quality bar")).toHaveCount(0);
  await page.getByText(/Show hidden \(under the quality bar\)/).click();
  await expect(cards).toHaveCount(10);
  await expect(group(page, dumpId).getByText("Under the quality bar")).toHaveCount(2);
});

test("approve all clears New and marks the dump reviewed", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  // Review shows a page at a time (day 358): "Approve all N" when every waiting clip is on screen,
  // "Approve these N" when more are waiting, so the button never approves clips she has not seen.
  const waiting = ((await (await page.request.get("/api/clips?tab=new")).json()) as { total: number }).total;
  await page.goto("/review");
  await expect(group(page, dumpId).locator("article.clip-card")).toHaveCount(8);
  await expect(page.locator("[data-primary]")).toHaveCount(1);
  const shown = Math.min(12, waiting);
  const name = waiting > 12 ? `Approve these ${shown}` : `Approve all ${shown}`;
  await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("data-primary", "true");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".toast").first()).toContainText("approved");
  await expect(group(page, dumpId)).toHaveCount(0);
  if (waiting <= 12) await expect(page.getByRole("heading", { name: "All caught up" })).toBeVisible();
  else await expect(page.locator("[data-count]")).toHaveText(`Showing ${Math.min(12, waiting - 12)} of ${waiting - 12} clips`);
  const dump = await (await page.request.get(`/api/dumps/${dumpId}`)).json();
  expect(dump.dump.status).toBe("reviewed");
  expect(await clipsOf(page.request, dumpId, "approved")).toHaveLength(8);
  // The hidden two are still waiting, untouched.
  expect((await clipsOf(page.request, dumpId, "new")).filter((c) => c.hidden)).toHaveLength(2);
});

// Phase 0 live test, 25 Sep 2026: another creator's downloaded TikToks (watermark "TikTok
// @texasgardenfairyx") went through to Review and nothing held them back from the calendar.
test("someone else's watermark holds the clips off the calendar until she taps This is my video", async ({ page }) => {
  const dumpId = await readyDump(page.request, 3, { source_marks: [{ platform: "tiktok", handles: ["someone.else_99"] }] });
  const ids = (await clipsOf(page.request, dumpId, "new", true)).map((c) => c.id);
  expect((await page.request.post("/api/clips/bulk", { data: { action: "approve", ids } })).ok()).toBe(true);
  const inList = (xs: { id: string }[]) => ids.filter((id) => xs.some((x) => x.id === id));
  const onCalendar = () => d1<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE clip_id IN ('${ids.join("','")}') AND status IN ('planned','in_buffer','posted')`)[0]!.n;

  await page.goto("/review?tab=approved");
  await page.getByRole("tab", { name: /Approved/ }).click();
  const note = group(page, dumpId).locator("[data-held-note]");
  await expect(note).toContainText("Looks like someone else's video");
  await expect(note).toContainText("@someone.else_99");
  await expect(note.getByRole("link", { name: "Why?" })).toHaveAttribute("href", "/help/someone-elses-video");

  // Held: not in the pool, not planned by Fill, refused by a manual add.
  expect(inList(await (await page.request.get("/api/posts/pool")).json())).toEqual([]);
  expect((await page.request.post("/api/posts/plan", { data: { weeks: 2 } })).ok()).toBe(true);
  expect(onCalendar()).toBe(0);
  const manual = await page.request.post("/api/posts", { data: { clip_id: ids[0], platform: "tiktok", scheduled_at: new Date(Date.now() + 3 * 86400_000).toISOString() } });
  expect(manual.status()).toBe(409);
  expect(await manual.json()).toMatchObject({ fix_guide: "someone-elses-video" });

  // One tap: hers now, so it may go on the calendar.
  await group(page, dumpId).getByRole("button", { name: "This is my video" }).click();
  await expect(page.locator(".toast").filter({ hasText: "can go on your calendar" })).toBeVisible();
  await expect(group(page, dumpId).locator("[data-held-note]")).toHaveCount(0);
  expect(inList(await (await page.request.get("/api/posts/pool")).json()).length).toBe(ids.length);

  // leave the calendar as the other specs expect it
  d1(`DELETE FROM posts WHERE clip_id IN ('${ids.join("','")}'); UPDATE clips SET status = 'rejected', reject_reason = 'e2e' WHERE id IN ('${ids.join("','")}')`);
});
