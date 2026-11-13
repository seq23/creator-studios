// Dump: which videos (two cards, nothing preselected, a hint bubble on each), Surprise me or steer
// (chips), notes read back before Dump, and every request followed or said; Review: Change music
// and Try another version. Fake services, phone and desktop. The section 6 gate is opened on the
// local D1 and closed again afterwards.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-steer-seed";

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Morning routines","ctas":"Follow for more"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});
test.afterAll(() => {
  d1(
    `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%'; DELETE FROM music_tracks WHERE file_name LIKE 'steer-%';` +
      `UPDATE settings SET value = '{"looks_off":[],"captions":true,"end_card":true,"music":false,"editors":{"cut_from_source":"built-in","caption":"built-in","enhance":"built-in"}}' WHERE key = 'editing';`,
  );
});

function video(): Buffer {
  const b = Buffer.alloc(90_000);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  return b;
}

async function upload(page: Page) {
  await page.locator('input[type="file"]').first().setInputFiles({ name: "steer.mp4", mimeType: "video/mp4", buffer: video() });
  await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 20_000 });
}

async function runCut(request: APIRequestContext, ref: string) {
  let id = "";
  await expect
    .poll(async () => {
      const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; ref_id: string; status: string }[];
      id = jobs.find((j) => j.ref_id === ref && j.status === "dispatched")?.id ?? "";
      return id;
    })
    .not.toBe("");
  expect((await request.post(`/api/jobs/${id}/run-fake`, { data: {} })).ok()).toBe(true);
}

async function clipsOf(request: APIRequestContext, dumpId: string) {
  const body = (await (await request.get("/api/clips?tab=new&hidden=1&limit=100")).json()) as { groups: { dump: { id: string }; clips: { id: string; look: string | null; music_id: string | null; start_s: number; end_s: number; platforms: string[] }[] }[] };
  return body.groups.find((g) => g.dump.id === dumpId)?.clips ?? [];
}

test("which videos: new is picked for her; the other kinds sit under More options with a hint bubble on each; the button says which", async ({ page }) => {
  await page.goto("/dump");
  const fresh = page.getByRole("radio", { name: /New videos I just filmed/ });
  const old = page.getByRole("radio", { name: /Old posts to reuse/ });
  // Nothing to choose first: the cards are closed away, and the button only waits for a file.
  await expect(fresh).toBeHidden();
  await expect(page.locator("[data-dump-button]")).toBeDisabled();
  await expect(page.locator("[data-dump-button]")).toHaveText("Make my posts");
  await page.locator("[data-more-options] > summary").click();
  await expect(fresh).toHaveAttribute("aria-checked", "true");
  await expect(old).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText(/door [AB]/i)).toHaveCount(0);

  // the hint bubble: tap to open, "Got it" to close; keyboard works the same (it is a button)
  const hint = page.getByRole("button", { name: 'What does "Old posts to reuse" mean?' });
  await hint.click();
  await expect(hint).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#door-hint-recycle")).toContainText("videos you already posted");
  await page.locator("#door-hint-recycle").getByRole("button", { name: "Got it" }).click();
  await expect(page.locator("#door-hint-recycle")).toHaveCount(0);
  await page.getByRole("button", { name: 'What does "New videos I just filmed" mean?' }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#door-hint-new")).toContainText("footage you haven't posted");
  await page.keyboard.press("Enter");
  await expect(page.locator("#door-hint-new")).toHaveCount(0);

  await old.click();
  await expect(old).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-door-picked]")).toHaveText(/You picked: Old posts to reuse/);
  await upload(page);
  await expect(page.locator("[data-dump-button]")).toHaveText("Reuse 1 old post");
  await expect(page.locator("[data-door-picked]")).toBeVisible();
  await fresh.click();
  await expect(page.locator("[data-dump-button]")).toHaveText("Make my posts");
  await expect(page.locator("[data-dump-button]")).toBeEnabled();
});

test("one line is always said back before Dump; what can't be used or done is said; one-tap fixes change it", async ({ page }) => {
  await page.goto("/dump");
  const plan = page.locator("[data-understood] [data-plan]");
  // with no note at all
  await expect(plan).toHaveText("I'll make a mix of posts.");
  await page.getByLabel("Anything I should know? (optional)").fill("2x4 grid, no music, fast. Also a 3x3 grid please. make a carousel");
  await expect(plan).toContainText("Grid of eight");
  await expect(plan).toContainText("no music");
  await expect(plan).toContainText("quick cuts");
  const u = page.locator("[data-understood]");
  await expect(u.locator("[data-not-followed]")).toContainText("a 3 by 3 grid, because that grid doesn't exist");
  // a part it could not use is said back in her own words, never dropped
  await expect(u.locator("[data-leftover]")).toHaveText("I couldn’t use this part: “make a carousel”");
  // one-tap fixes
  const fixes = page.getByRole("group", { name: "Quick changes" });
  await expect(fixes.getByRole("button")).toHaveText(["Fewer", "More", "Just one", "No words on screen", "Instagram only"]);
  await fixes.getByRole("button", { name: "Just one" }).click();
  await expect(plan).toContainText("I'll make 1 post:");
  await expect(fixes.getByRole("button", { name: "Just one" })).toHaveAttribute("aria-pressed", "true");
  await fixes.getByRole("button", { name: "Instagram only" }).click();
  await expect(plan).toContainText("Instagram only");
  await fixes.getByRole("button", { name: "No words on screen" }).click();
  await expect(plan).toContainText("no words on screen");
  // what she types wins over the earlier tap
  await page.getByLabel("Anything I should know? (optional)").fill("3 posts, no music");
  await expect(plan).toHaveText("I'll make 3 posts: no music, no words on screen, Instagram only.");
  // every fix is a 44 px target on a phone
  for (const b of await fixes.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("steered by chips and a note: the clips follow, the dump says what it could not do", async ({ page }) => {
  await page.goto("/dump");
  await page.locator("[data-more-options] > summary").click(); // new is picked for her; this opens the cutting choices
  await upload(page);
  const look = page.getByRole("group", { name: "Look", exact: true });
  await look.getByRole("button", { name: "Grid of four" }).click();
  await expect(look.getByRole("button", { name: "Look: surprise me" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("group", { name: "How many" }).getByRole("button", { name: "5 clips" }).click();
  await page.getByRole("group", { name: "Clip length" }).getByRole("button", { name: /Short/ }).click();
  await page.getByRole("group", { name: "Platforms" }).getByRole("button", { name: "TikTok" }).click();
  await page.getByRole("group", { name: "Pace" }).getByRole("button", { name: "Fast" }).click();
  await page.getByLabel("Anything I should know? (optional)").fill("keep it calm. 3x3 grid");
  await expect(page.locator("[data-plan]")).toHaveText("I'll make 5 posts: short (under 20 seconds), calm, Grid of four, TikTok only.");
  // her note and her tap disagree: said before the cut, and her note wins
  await expect(page.locator("[data-clash]")).toHaveText("You tapped one thing for the pace and wrote another. I'll go with what you wrote.");
  const res = page.waitForResponse((r) => /\/api\/dumps\/[^/]+\/dump$/.test(r.url()));
  await page.locator("[data-dump-button]").click();
  expect((await res).ok()).toBe(true);
  const dumpId = new URL(page.url()).pathname.split("/").pop()!;
  await runCut(page.request, dumpId);
  const clips = await clipsOf(page.request, dumpId);
  expect(clips).toHaveLength(5);
  expect(clips.every((c) => c.look === "grid_four" && c.end_s - c.start_s <= 21 && JSON.stringify(c.platforms) === '["tiktok"]')).toBe(true);
  await page.reload();
  await expect(page.locator("[data-not-followed]")).toContainText("a 3 by 3 grid");
  // the clash was said before the cut; it is not repeated afterwards
  await expect(page.locator("[data-not-followed]")).not.toContainText("tapped");
  // what was made, as kinds of post in her words: never a list of looks
  await expect(page.locator("[data-tried]")).toHaveText(/^\s*5 posts: \d .*\.$/);
  await expect(page.locator("[data-tried]")).not.toContainText(/look|grid/i);
});

test("Surprise me: varied looks and one plain line on what was made", async ({ page }) => {
  await page.goto("/dump");
  await page.locator("[data-more-options] > summary").click(); // new is picked for her; this opens the cutting choices
  await upload(page);
  await expect(page.getByRole("button", { name: "Surprise me", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-dump-button]").click();
  await expect(page.locator(".toast").first()).toContainText("Got it");
  const dumpId = new URL(page.url()).pathname.split("/").pop()!;
  await runCut(page.request, dumpId);
  const clips = await clipsOf(page.request, dumpId);
  expect(new Set(clips.map((c) => c.look)).size).toBeGreaterThanOrEqual(Math.min(clips.length, 5));
  await page.reload();
  await expect(page.locator("[data-tried]")).toHaveText(/^\s*\d+ posts: \d .*\.$/);
});

test("Review: Change music and Try another version re-render just that clip", async ({ page }) => {
  // a song of her own
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(3000)]);
  const start = await page.request.post("/api/uploads/start", { data: { kind: "music", fileName: "steer-song.wav", size: wav.length, mimeType: "audio/wav" } });
  const up = await start.json();
  const part = await page.request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: wav });
  await page.request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } });
  expect((await page.request.post("/api/editing/music", { data: { id: up.id, key: up.key, fileName: "steer-song.wav" } })).ok()).toBe(true);

  const { id: dumpId } = await (await page.request.post("/api/dumps", { data: { door: "new", notes: "" } })).json();
  const s2 = await page.request.post("/api/uploads/start", { data: { kind: "video", parentId: dumpId, fileName: "r.mp4", size: 90_000, mimeType: "video/mp4", contentHash: `steer-${Date.now()}-${Math.random()}` } });
  const u2 = await s2.json();
  const p2 = await page.request.put(`/api/uploads/${u2.id}/parts/1?key=${encodeURIComponent(u2.key)}&uploadId=${encodeURIComponent(u2.uploadId)}`, { data: video() });
  await page.request.post(`/api/uploads/${u2.id}/complete`, { data: { key: u2.key, uploadId: u2.uploadId, parts: [await p2.json()] } });
  await page.request.patch(`/api/dumps/${dumpId}`, { data: { steer: { music: "none", count: 3 } } });
  await page.request.post(`/api/dumps/${dumpId}/dump`);
  await runCut(page.request, dumpId);
  const [clip] = await clipsOf(page.request, dumpId);
  expect(clip.music_id).toBeNull();

  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${clip.id}"]`);
  await card.getByRole("button", { name: "Change music" }).click();
  await page.getByRole("dialog", { name: "Change music" }).getByRole("button", { name: "steer-song.wav" }).click();
  await expect(page.locator(".toast").first()).toContainText("Changing the music");
  await runCut(page.request, `${dumpId}/${clip.id}`);
  let after = (await clipsOf(page.request, dumpId)).find((c) => c.id === clip.id)!;
  expect(after.music_id).toBe(up.id);
  expect(after.look).toBe(clip.look);

  await page.reload();
  // Try another version opens its notes box (#21); with no notes it is a different look.
  await card.getByRole("button", { name: "Try another version" }).click();
  await page.getByRole("dialog", { name: "Try another version" }).getByRole("button", { name: "Make another version" }).click();
  await expect(page.locator(".toast").first()).toContainText("Trying another version");
  await runCut(page.request, `${dumpId}/${clip.id}`);
  after = (await clipsOf(page.request, dumpId)).find((c) => c.id === clip.id)!;
  expect(after.look).not.toBe(clip.look);
});
