// Editors (fake services), phone and desktop: CapCut and InShot rows need no key and say how to use
// them; a connected editor (Opus Clip) is checked, picked under Who edits and cuts a dump through
// the same import the built-in cutter's clips go through; "Edit in CapCut" sends a clip out and
// takes her edit back, refusing a landscape one in words. Everything is put back afterwards.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql as d1 } from "./helpers";
import { buildMp4 } from "../unit/helpers/mp4-build";

const SEED = "e2e-editors-seed";

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Morning routines","ctas":"Follow for more"}', 1, '2026-09-25T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-25T00:00:00Z');`,
  );
});

test.afterAll(() => {
  d1(
    `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%';` +
      `UPDATE connections SET status = 'disconnected', secret_enc = NULL WHERE service IN ('opusclip', 'vizard', 'klap', 'submagic', 'descript');` +
      `UPDATE settings SET value = '{"looks_off":[],"captions":true,"end_card":true,"music":false,"editors":{"cut_from_source":"built-in","caption":"built-in","enhance":"built-in"}}' WHERE key = 'editing';`,
  );
});

async function uploadedDump(request: APIRequestContext): Promise<string> {
  const { id } = await (await request.post("/api/dumps", { data: { door: "new", notes: "e2e editors" } })).json();
  const bytes = Buffer.alloc(64_000, 5);
  const start = await request.post("/api/uploads/start", {
    data: { kind: "video", parentId: id, fileName: "editors.mp4", size: bytes.length, mimeType: "video/mp4", contentHash: `e2e-editors-${Date.now()}-${Math.random()}` },
  });
  const up = await start.json();
  const part = await request.put(`/api/uploads/${up.id}/parts/1?key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}`, { data: bytes });
  expect((await request.post(`/api/uploads/${up.id}/complete`, { data: { key: up.key, uploadId: up.uploadId, parts: [await part.json()] } })).ok()).toBe(true);
  return id;
}

async function jobFor(request: APIRequestContext, ref: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; ref_id: string; status: string }[];
      id = jobs.find((j) => j.ref_id === ref && j.status === "dispatched")?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

test("Connect: CapCut and InShot are ready with no key; an editor's key is checked, shown and removable", async ({ page }) => {
  await page.goto("/settings/connections");
  const capcut = page.locator('[data-handoff="capcut"]');
  await expect(capcut).toContainText("CapCut: no key needed. Send a clip to CapCut from Review and upload your edit back.");
  await expect(capcut).toContainText("Ready");
  await expect(page.locator('[data-handoff="inshot"]')).toContainText("Ready");

  const box = page.getByRole("textbox", { name: "Editor · Opus Clip key" });
  const card = page.locator(".card", { has: box });
  await box.fill("nope-not-a-key-123");
  await card.getByRole("button", { name: "Check key" }).click();
  await expect(page.locator(".toast.bad")).toContainText("Opus Clip says this key is not valid.");
  await box.fill("good-opus-key-123");
  await card.getByRole("button", { name: "Check key" }).click();
  await expect(page.locator(".toast", { hasText: "Opus Clip connected. Pick it under Settings → Editing → Who edits." })).toBeVisible();
  const connected = page.locator(".card", { hasText: "Opus Clip" }).filter({ has: page.getByRole("button", { name: "Disconnect" }) });
  await expect(connected).toContainText("Connected");
  await expect(connected).toContainText("credits left this month");
});

test("Who edits: every editor listed, only connected ones pickable; a dump then goes to Opus Clip and comes back as clips", async ({ page }) => {
  // connect Opus Clip (the previous test may have run in the other project)
  expect((await page.request.post("/api/connections/opusclip/key", { data: { key: "good-opus-key-123" } })).ok()).toBe(true);
  await page.goto("/settings");
  const row = page.locator('[data-editor-row="cut_from_source"]');
  const select = row.getByRole("combobox");
  await expect(select).toHaveValue("built-in");
  await expect(select.locator("option", { hasText: "Vizard (connect it first)" })).toBeDisabled();
  await select.selectOption("opusclip");
  await expect(page.locator(".toast").first()).toContainText("Saved");
  await page.reload();
  await expect(page.locator('[data-editor-row="cut_from_source"]').getByRole("combobox")).toHaveValue("opusclip");
  await expect(page.locator('[data-editor-row="templates"]')).toContainText("Built-in (free)");

  const dumpId = await uploadedDump(page.request);
  const sent = await page.request.post(`/api/dumps/${dumpId}/dump`);
  expect(sent.ok(), await sent.text()).toBe(true);
  expect(await sent.json()).toMatchObject({ editor: "opusclip", jobId: null });
  // Dump asks Opus Clip how it is doing while it is open; the fake is done at once
  const summary = (await (await page.request.get(`/api/dumps/${dumpId}`)).json()) as { dump: { progress: { step: string } | null } };
  expect(summary.dump.progress?.step).toMatch(/Opus Clip is cutting your videos|Bringing your clips back from Opus Clip/);
  await page.request.get("/api/dumps");
  const importJob = await jobFor(page.request, `${dumpId}/import`);
  expect((await page.request.post(`/api/jobs/${importJob}/run-fake`, { data: {} })).ok()).toBe(true);
  const list = (await (await page.request.get("/api/clips?tab=new&hidden=1&limit=100")).json()) as { groups: { dump: { id: string }; clips: { edited_with: string; edited_with_name: string }[] }[] };
  const clips = list.groups.find((g) => g.dump.id === dumpId)?.clips ?? [];
  expect(clips).toHaveLength(3);
  expect(clips.every((c) => c.edited_with === "opusclip" && c.edited_with_name === "Opus Clip")).toBe(true);
  await page.goto("/review");
  await expect(page.locator(`[data-dump-id="${dumpId}"] [data-edited-with="opusclip"]`).first()).toContainText("Edited in Opus Clip");

  // back to the built-in cutter
  await page.goto("/settings");
  await page.locator('[data-editor-row="cut_from_source"]').getByRole("combobox").selectOption("built-in");
  await expect(page.locator(".toast").first()).toContainText("built-in editor");
});

test("Edit in CapCut: save or share the clip, upload the edit back; a landscape edit is refused in words", async ({ page }) => {
  // a built-in dump to edit (the fake cutter)
  const dumpId = await uploadedDump(page.request);
  const sent = await page.request.post(`/api/dumps/${dumpId}/dump`);
  const { jobId } = await sent.json();
  expect((await page.request.post(`/api/jobs/${jobId}/run-fake`, { data: { clips: 3 } })).ok()).toBe(true);
  const list = (await (await page.request.get("/api/clips?tab=new&limit=100")).json()) as { groups: { dump: { id: string }; clips: { id: string; media_url: string }[] }[] };
  const clip = list.groups.find((g) => g.dump.id === dumpId)!.clips[0];
  const download = await page.request.get(`${clip.media_url}${clip.media_url.includes("?") ? "&" : "?"}download=1`);
  expect(download.headers()["content-disposition"]).toContain("attachment");

  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${clip.id}"]`);
  await card.getByRole("button", { name: "Edit in CapCut" }).click();
  const sheet = page.getByRole("dialog", { name: "Edit in CapCut" });
  await expect(sheet.getByRole("link", { name: "Save the clip" })).toHaveAttribute("href", /download=1/);
  await expect(sheet).toContainText("Keep the ratio 9:16");

  await sheet.locator("#edit-file").setInputFiles({ name: "capcut-export.mp4", mimeType: "video/mp4", buffer: Buffer.from(buildMp4({ width: 1920, height: 1080, duration_s: 20 })) });
  await expect(sheet.locator("[data-handoff-error]")).toContainText("Your edit is 1920×1080, not a tall 9:16 video. In CapCut set the ratio to 9:16");

  await sheet.locator("#edit-file").setInputFiles({ name: "capcut-export-2.mp4", mimeType: "video/mp4", buffer: Buffer.from(buildMp4({ width: 1080, height: 1920, duration_s: 20 })) });
  await expect(page.locator(".toast").first()).toContainText("Finishing your edit from CapCut, about a minute");
  await expect(card.locator(".look-pending")).toContainText("Finishing your edit from CapCut");
  const importJob = await jobFor(page.request, `${dumpId}/${clip.id}/import`);
  expect((await page.request.post(`/api/jobs/${importJob}/run-fake`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(card.locator('[data-edited-with="capcut"]')).toContainText("Edited in CapCut");
  await expect(card.locator("video")).toHaveAttribute("src", /\?v=1/);
});
