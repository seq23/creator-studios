// The full-video door, phone and desktop, fake services: a third card on Dump ("A full video for
// YouTube"), one video, the size and free space shown before Dump, the Dump button names it; the
// fake job returns one Review item with three thumbnails, chapters and tags; she picks a
// thumbnail and who can see it, edits the title, approves; cut-only buttons aren't on its card.
// The section 6 gate is opened on the local D1 and closed again afterwards.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-youtube-full-seed";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","ctas":"Subscribe"}', 1, '2026-09-26T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-26T00:00:00Z');`,
  );
});
test.afterAll(() => {
  d1(
    `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%';` +
      `DELETE FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE full_video = 1); UPDATE clips SET status = 'deleted' WHERE full_video = 1;`,
  );
});

function video(): Buffer {
  const b = Buffer.alloc(120_000);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  return b;
}

async function runJob(request: APIRequestContext, ref: string) {
  let id = "";
  await expect
    .poll(async () => {
      const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; ref_id: string; status: string; type: string }[];
      id = jobs.find((j) => j.ref_id === ref && j.status === "dispatched")?.id ?? "";
      return id;
    })
    .not.toBe("");
  const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; type: string }[];
  expect(jobs.find((j) => j.id === id)?.type).toBe("fullvideo"); // its own job: never the cutter
  expect((await request.post(`/api/jobs/${id}/run-fake`, { data: {} })).ok()).toBe(true);
}

test("Dump: the third card, one video, size and free space, then Review: thumbnails, privacy, edit, approve", async ({ page }) => {
  await page.goto("/dump");
  const card = page.getByRole("radio", { name: /A full video for YouTube/ });
  await expect(card).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: 'What does "A full video for YouTube" mean?' }).click();
  await expect(page.locator("#door-hint-youtube")).toContainText("no cutting, no vertical crop");
  await page.locator("#door-hint-youtube").getByRole("button", { name: "Got it" }).click();
  await card.click();
  await expect(page.locator("[data-door-picked]")).toHaveText(/You picked: A full video for YouTube/);
  await expect(page.getByText("one video, landscape or any shape · it goes up whole")).toBeVisible();
  // no cutting controls on this door
  await expect(page.getByRole("group", { name: "Look" })).toHaveCount(0);

  await page.locator('input[type="file"]').first().setInputFiles({ name: "kitchen-tour.mp4", mimeType: "video/mp4", buffer: video() });
  await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-space-line]")).toHaveText(/^This video: 1 MB · free space left: [\d.]+ (GB|MB) of 10 GB$/);
  const button = page.locator("[data-dump-button]");
  await expect(button).toHaveText("Dump 1 full video");
  const res = page.waitForResponse((r) => /\/api\/dumps\/[^/]+\/dump$/.test(r.url()));
  await button.click();
  expect((await res).ok()).toBe(true);
  const dumpId = new URL(page.url()).pathname.split("/").pop()!;
  await runJob(page.request, dumpId);

  await page.goto("/review");
  const item = page.locator('[data-clip-id] [data-full-video]').first().locator("xpath=ancestor::article");
  await expect(item.getByText("Full video for YouTube", { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: "Change look" })).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Add voice over" })).toHaveCount(0);
  const thumbs = item.getByRole("radiogroup", { name: "Pick a thumbnail" }).getByRole("radio");
  await expect(thumbs).toHaveCount(3);
  await expect(thumbs.nth(0)).toHaveAttribute("aria-checked", "true");
  await thumbs.nth(1).click();
  await expect(thumbs.nth(1)).toHaveAttribute("aria-checked", "true");
  const who = item.getByRole("radiogroup", { name: "Who can see it" });
  await expect(who.getByRole("radio", { name: "Public" })).toHaveAttribute("aria-checked", "true");
  await who.getByRole("radio", { name: "Unlisted" }).click();
  await expect(who.getByRole("radio", { name: "Unlisted" })).toHaveAttribute("aria-checked", "true");
  await item.locator("summary").click();
  await expect(item.locator("[data-chapters] li").first()).toContainText("0:00");

  await item.getByRole("button", { name: "Edit title, description, chapters & tags" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit your YouTube video" });
  await dialog.getByLabel("Title").fill("A brunch table for twelve");
  await dialog.getByLabel("Tags").fill("brunch, tablescape, hosting");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(item.locator(".fv-title")).toHaveText("A brunch table for twelve");

  await item.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".toast").first()).toContainText("Approved");
  const body = (await (await page.request.get("/api/clips?tab=approved&hidden=1&limit=100")).json()) as { groups: { dump: { id: string; door: string }; clips: { platforms: string[]; full_video: { privacy: string; thumb_pick: number; tags: string[] } }[] }[] };
  const g = body.groups.find((x) => x.dump.id === dumpId)!;
  expect(g.dump.door).toBe("youtube");
  expect(g.clips[0].platforms).toEqual(["youtube"]);
  expect(g.clips[0].full_video).toMatchObject({ privacy: "unlisted", thumb_pick: 1, tags: ["brunch", "tablescape", "hosting"] });
});
