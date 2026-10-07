// Looks (fake services), phone and desktop: a dump's clips come back in several Looks, each clip
// shows its Look, "Change look" queues a re-render of just that clip (the old version stays until
// the new one is ready), a grid Look lets her pick each cell and the voice, and Settings > Editing
// switches persist. The section 6 gate is opened on the local D1 and closed again afterwards.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-looks-seed";

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Morning routines","ctas":"Follow for more"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});

test.afterAll(() => {
  d1(
    `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%';` +
      `UPDATE settings SET value = '{"looks_off":[],"captions":true,"end_card":true,"music":false,"editors":{"cut_from_source":"built-in","caption":"built-in","enhance":"built-in"}}' WHERE key = 'editing'; DELETE FROM music_tracks;`,
  );
});

interface Clip {
  id: string;
  look: string | null;
  look_name: string | null;
  layout: { cells: { kind: string; clip_id?: string; zoom?: number }[]; voice: number } | null;
  pending_look: string | null;
  media_url: string;
  hidden: boolean;
}

async function readyDump(request: APIRequestContext, clips = 12): Promise<string> {
  const { id } = await (await request.post("/api/dumps", { data: { door: "new", notes: "e2e looks" } })).json();
  const bytes = Buffer.alloc(64_000);
  for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  const start = await request.post("/api/uploads/start", {
    data: { kind: "video", parentId: id, fileName: "looks.mp4", size: bytes.length, mimeType: "video/mp4", contentHash: `e2e-looks-${Date.now()}-${Math.random()}` },
  });
  const up = await start.json();
  const part = await request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: bytes });
  expect((await request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } })).ok()).toBe(true);
  const dumped = await request.post(`/api/dumps/${id}/dump`);
  expect(dumped.ok(), await dumped.text()).toBe(true);
  const { jobId } = await dumped.json();
  expect((await request.post(`/api/jobs/${jobId}/run-fake`, { data: { clips } })).ok()).toBe(true);
  return id;
}

async function clipsOf(request: APIRequestContext, dumpId: string): Promise<Clip[]> {
  const body = (await (await request.get("/api/clips?tab=new&hidden=1&limit=100")).json()) as { groups: { dump: { id: string }; clips: Clip[] }[] };
  return body.groups.find((g) => g.dump.id === dumpId)?.clips ?? [];
}

/** The re-render job a Change look started (cut job whose ref is "<dump>/<clip>"), run by the fake runner. */
async function runRerender(request: APIRequestContext, dumpId: string, clipId: string) {
  const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; type: string; ref_id: string; status: string }[];
  const job = jobs.find((j) => j.type === "cut" && j.ref_id === `${dumpId}/${clipId}` && j.status === "dispatched");
  expect(job, "a re-render job was queued").toBeTruthy();
  const ran = await request.post(`/api/jobs/${job!.id}/run-fake`, { data: {} });
  expect(ran.ok(), await ran.text()).toBe(true);
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => {
    const els = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>(".modal"))];
    return els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName);
  });
  expect(over).toEqual([]);
}

test("a dump's clips come back in several Looks and each clip shows its Look", async ({ page }) => {
  const dumpId = await readyDump(page.request);
  const clips = await clipsOf(page.request, dumpId);
  expect(clips).toHaveLength(12);
  const looks = new Set(clips.map((c) => c.look));
  expect(looks.size, "12 clips, all 12 looks in the mix").toBe(12);
  for (const c of clips.filter((x) => x.look && ["split", "side_by_side", "grid_four", "grid_six", "grid_eight", "hero_strip"].includes(x.look))) expect(c.layout?.cells.length).toBeGreaterThanOrEqual(2);

  await page.goto("/review");
  const cards = page.locator(`[data-dump-id="${dumpId}"] article.clip-card`);
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  for (let i = 0; i < n; i++) await expect(cards.nth(i).locator(".look-chip")).toContainText("Look: ");
});

test("Change look re-renders just that clip; the old version plays until the new one is ready", async ({ page }) => {
  const dumpId = await readyDump(page.request, 6);
  const [clip] = (await clipsOf(page.request, dumpId)).filter((c) => !c.hidden);
  const target = clip.look === "cinematic" ? "karaoke" : "cinematic";
  const targetName = target === "cinematic" ? "Cinematic" : "Karaoke captions";
  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${clip.id}"]`);
  await card.getByRole("button", { name: "Change look" }).click();
  const dialog = page.getByRole("dialog", { name: "Change look" });
  await expect(dialog.locator("[data-look-option]")).toHaveCount(12);
  await expect(dialog.locator(`[data-look-option="${clip.look}"]`)).toContainText("Now");
  // every look shows its preview picture, and the picture is really there
  const thumb = await dialog.locator(`[data-look-option="${target}"] img`).getAttribute("src");
  expect((await page.request.get(thumb!)).headers()["content-type"]).toContain("image/webp");
  await noSideScroll(page);
  await dialog.locator(`[data-look-option="${target}"]`).click();
  await expect(page.locator(".toast").first()).toContainText("Re-rendering, about a minute");
  await expect(card.locator(".look-pending")).toContainText(`Re-rendering as ${targetName}`);
  await expect(card.getByRole("button", { name: "Change look" })).toBeDisabled();
  // the old version is still what plays
  const before = (await clipsOf(page.request, dumpId)).find((c) => c.id === clip.id)!;
  expect(before).toMatchObject({ look: clip.look, pending_look: target, media_url: clip.media_url });

  await runRerender(page.request, dumpId, clip.id);
  const after = (await clipsOf(page.request, dumpId)).find((c) => c.id === clip.id)!;
  expect(after).toMatchObject({ look: target, pending_look: null });
  expect(after.media_url).toBe(`${clip.media_url}?v=1`);
  expect((await page.request.get(after.media_url)).status()).toBe(200);
  await page.reload();
  await expect(card.locator(".look-chip")).toContainText(`Look: ${targetName}`);
  await expect(card.locator(".look-pending")).toHaveCount(0);
});

test("a grid Look: pick what a cell shows and whose sound plays, with a live preview", async ({ page }) => {
  const dumpId = await readyDump(page.request, 6);
  const [clip] = (await clipsOf(page.request, dumpId)).filter((c) => !c.hidden && c.look !== "grid_four");
  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${clip.id}"]`);
  await card.getByRole("button", { name: "Change look" }).click();
  await page.getByRole("dialog").locator('[data-look-option="grid_four"]').click();
  const picker = page.getByRole("dialog", { name: /Grid of four/ });
  const mosaic = picker.getByTestId("mosaic");
  await expect(mosaic.locator("[data-cell]")).toHaveCount(4);
  await expect(mosaic.locator("[data-cell]").first()).toHaveAccessibleName(/Cell 1: This clip, plays its sound/);
  await noSideScroll(page);

  // cell 4 → this clip, closer; the preview says so at once
  await mosaic.locator('[data-cell="3"]').click();
  await picker.getByRole("button", { name: "Closer 1.7×" }).click();
  await expect(mosaic.locator('[data-cell="3"]')).toHaveAccessibleName(/Cell 4: This clip, closer \(1\.7×\)/);
  // cell 2 plays the sound
  await mosaic.locator('[data-cell="1"]').click();
  await picker.getByRole("button", { name: "Play sound from this cell" }).click();
  await expect(mosaic.locator('[data-cell="1"]')).toHaveAccessibleName(/plays its sound/);
  // taking this clip out of every cell is not allowed
  await mosaic.locator('[data-cell="0"]').click();
  await picker.getByRole("button", { name: "Closer 2.1×" }).click();
  await expect(picker.getByRole("button", { name: "Make it in this look" })).toBeDisabled();
  await picker.getByRole("button", { name: "This clip", exact: true }).click();
  await picker.getByRole("button", { name: "Make it in this look" }).click();
  await expect(page.locator(".toast").first()).toContainText("Re-rendering");

  const pending = d1<{ pending_layout: string }>(`SELECT pending_layout FROM clips WHERE id = '${clip.id}'`)[0];
  const layout = JSON.parse(pending.pending_layout);
  expect(layout.voice).toBe(1);
  expect(layout.cells[0]).toEqual({ kind: "self" });
  expect(layout.cells[3]).toEqual({ kind: "zoom", zoom: 1.7 });

  await runRerender(page.request, dumpId, clip.id);
  const after = (await clipsOf(page.request, dumpId)).find((c) => c.id === clip.id)!;
  expect(after.look).toBe("grid_four");
  expect(after.layout).toEqual(layout);
});

test("Settings > Editing: looks in the mix, captions, end card and music persist", async ({ page }) => {
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "Editing" });
  await expect(card.locator("[data-editing-look]")).toHaveCount(12);
  // defaults: every look on, captions and end card on, music off (no songs yet)
  for (const cb of await card.locator("[data-editing-look] input").all()) await expect(cb).toBeChecked();
  await expect(card.getByRole("checkbox", { name: /Captions/ })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: /End card/ })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: /Music bed/ })).not.toBeChecked();

  await card.getByLabel("Use the Grid of eight look").click();
  await expect(page.locator(".toast").first()).toContainText("Saved");
  await expect(card.getByLabel("Use the Grid of eight look")).not.toBeChecked();
  await card.getByRole("checkbox", { name: /End card/ }).click();
  await expect(card.getByRole("checkbox", { name: /End card/ })).not.toBeChecked();
  // music needs a song first, and says so
  await card.getByRole("checkbox", { name: /Music bed/ }).click();
  await expect(page.locator(".toast.bad")).toContainText("Add a song under My music first");
  await page.reload();
  await expect(card.getByLabel("Use the Grid of eight look")).not.toBeChecked();
  await expect(card.getByRole("checkbox", { name: /End card/ })).not.toBeChecked();
  const saved = (await (await page.request.get("/api/editing")).json()) as { editing: { looks: string[]; end_card: boolean } };
  expect(saved.editing.looks).not.toContain("grid_eight");
  expect(saved.editing.end_card).toBe(false);

  // a dump now rotates through the looks left on
  const dumpId = await readyDump(page.request, 12);
  expect((await clipsOf(page.request, dumpId)).some((c) => c.look === "grid_eight")).toBe(false);

  // her own song: the bed switches on; removing the last song switches it off
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(2000)]);
  await card.locator("#music-file").setInputFiles({ name: "my-song.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page.locator(".toast").first()).toContainText("music bed is on");
  await expect(card.locator("[data-music-track]")).toContainText("my-song.wav");
  await expect(card.getByRole("checkbox", { name: /Music bed/ })).toBeChecked();
  await card.locator("[data-music-track]").getByRole("button", { name: "Remove" }).click();
  await expect(card.locator("[data-music-track]")).toHaveCount(0);
  await expect(card.getByRole("checkbox", { name: /Music bed/ })).not.toBeChecked();

  await card.getByLabel("Use the Grid of eight look").click();
  await expect(card.getByLabel("Use the Grid of eight look")).toBeChecked();
  await card.getByRole("checkbox", { name: /End card/ }).click();
  await expect(card.getByRole("checkbox", { name: /End card/ })).toBeChecked();
  await noSideScroll(page);
});
