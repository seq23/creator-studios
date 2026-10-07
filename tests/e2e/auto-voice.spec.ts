// Automatic voice overs (owner, 26 Sep 2026), phone and desktop, fake services: with the switch on
// and her voice saved, a dump's clips with no talking come back voiced (one voice job run for the
// dump), a clip where she talks does not; Review says so and offers Remove and Redo, and Redo opens
// "Edit the script" to re-voice and re-mix just that clip. On with no voice saved: the switch says
// "Record your voice first", nothing fails. The section 6 gate and the voice sample are set on the
// local D1 and put back afterwards.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql as d1 } from "./helpers";

const SEED = "e2e-auto-voice-seed";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  d1(
    `INSERT INTO brand_profile (sections, locked, locked_at, source) VALUES ('{"who":"${SEED}","themes":"Tablescapes","ctas":"Follow for more"}', 1, '2026-09-26T00:00:00Z', 'edited');` +
      `INSERT INTO research_briefs (body, status, approved_at) VALUES ('{"seed":"${SEED}","hooks":[],"shot_list":[]}', 'approved', '2026-09-26T00:00:00Z');`,
  );
});
test.afterAll(() => {
  d1(
    `DELETE FROM brand_profile WHERE sections LIKE '%${SEED}%'; DELETE FROM research_briefs WHERE body LIKE '%${SEED}%';` +
      `DELETE FROM narrations WHERE batch IS NOT NULL; UPDATE voice SET sample_r2_key = NULL, consent_at = NULL WHERE id = 1;`,
  );
});

function video(): Buffer {
  const b = Buffer.alloc(90_000);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  return b;
}

async function runJob(request: APIRequestContext, ref: (r: string) => boolean) {
  let id = "";
  await expect
    .poll(async () => {
      const jobs = (await (await request.get("/api/jobs")).json()) as { id: string; ref_id: string; status: string }[];
      id = jobs.find((j) => ref(j.ref_id ?? "") && j.status === "dispatched")?.id ?? "";
      return id;
    })
    .not.toBe("");
  expect((await request.post(`/api/jobs/${id}/run-fake`, { data: {} })).ok()).toBe(true);
}

async function dumpOf(request: APIRequestContext): Promise<string> {
  const { id: dumpId } = await (await request.post("/api/dumps", { data: { door: "new", notes: "" } })).json();
  const s = await request.post("/api/uploads/start", { data: { kind: "video", parentId: dumpId, fileName: "av.mp4", size: 90_000, mimeType: "video/mp4", contentHash: `av-${Date.now()}-${Math.random()}` } });
  const u = await s.json();
  const p = await request.put(`/api/uploads/${u.id}/parts/1?key=${encodeURIComponent(u.key)}&uploadId=${encodeURIComponent(u.uploadId)}`, { data: video() });
  await request.post(`/api/uploads/${u.id}/complete`, { data: { key: u.key, uploadId: u.uploadId, parts: [await p.json()] } });
  await request.patch(`/api/dumps/${dumpId}`, { data: { steer: { count: 5 } } });
  expect((await request.post(`/api/dumps/${dumpId}/dump`)).ok()).toBe(true);
  await runJob(request, (r) => r === dumpId);
  return dumpId;
}

type Clip = { id: string; recipe: string; voice_over: string | null; voice_auto: boolean; voice_script: string | null };
async function clipsOf(request: APIRequestContext, dumpId: string): Promise<Clip[]> {
  const body = (await (await request.get("/api/clips?tab=new&hidden=1&limit=100")).json()) as { groups: { dump: { id: string }; clips: Clip[] }[] };
  return body.groups.find((g) => g.dump.id === dumpId)?.clips ?? [];
}

test("on, no voice saved yet: the switch says Record your voice first; a dump makes no voice overs and nothing fails", async ({ page }) => {
  d1("UPDATE voice SET sample_r2_key = NULL, consent_at = NULL WHERE id = 1");
  expect((await (await page.request.get("/api/voice")).json()).auto).toBe("needs_voice");
  await page.goto("/settings");
  const hint = page.locator('[data-auto-voice="needs_voice"]');
  await expect(hint).toContainText("Record your voice first");
  await expect(hint.getByRole("link", { name: "Record your voice first" })).toHaveAttribute("href", "/voice#voice-steps");
  await page.goto("/voice");
  await expect(page.locator('[data-auto-voice="needs_voice"]')).toContainText("nothing is wrong");

  const since = new Date().toISOString();
  const dumpId = await dumpOf(page.request);
  expect((await clipsOf(page.request, dumpId)).every((c) => c.voice_over === null)).toBe(true);
  const voiceJobs = ((await (await page.request.get("/api/jobs")).json()) as { type: string; ref_id: string; created_at: string }[]).filter((j) => j.type === "voice" && j.ref_id?.startsWith("auto/") && j.created_at >= since);
  expect(voiceJobs).toHaveLength(0);
  const health = (await (await page.request.get("/api/settings/health")).json()) as { name: string; light: string }[];
  expect(health.find((h) => h.name === "Voice")?.light ?? "none").not.toBe("red");
});

test("on, voice saved: clips with no talking come back voiced; Review offers Remove and Redo with Edit the script", async ({ page }) => {
  d1("UPDATE voice SET sample_r2_key = 'voice/sample/e2e-auto', consent_at = '2026-09-26T00:00:00Z' WHERE id = 1");
  expect((await (await page.request.get("/api/voice")).json()).auto).toBe("on");
  const dumpId = await dumpOf(page.request);
  await runJob(page.request, (r) => r.startsWith("auto/")); // ONE run for the whole dump
  const clips = await clipsOf(page.request, dumpId);
  const voiced = clips.filter((c) => c.voice_over === "ready");
  const talking = clips.filter((c) => c.voice_over === null);
  expect(voiced.length).toBeGreaterThan(0);
  expect(talking.length).toBeGreaterThan(0);
  expect(voiced.every((c) => c.recipe === "montage" && c.voice_auto && (c.voice_script ?? "").length > 10)).toBe(true); // montage = the fake's clips with no talking
  expect(talking.every((c) => c.recipe !== "montage")).toBe(true);

  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${voiced[0].id}"]`);
  await expect(card.locator('[data-voice-over="ready"]')).toHaveText("With your voice over · added automatically · AI-labelled when it posts");
  await expect(page.locator(`[data-clip-id="${talking[0].id}"]`).locator("[data-voice-over]")).toHaveCount(0);
  await expect(page.locator(`[data-clip-id="${talking[0].id}"]`).getByRole("button", { name: "Remove voice over" })).toHaveCount(0);

  // Redo → Edit the script: her words, re-voiced and re-mixed
  await card.getByRole("button", { name: "Redo voice over" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit the script" });
  const box = dialog.getByLabel("Voice over script");
  await expect(box).toHaveValue(voiced[0].voice_script!);
  await box.fill("word ".repeat(80).trim());
  await dialog.getByRole("button", { name: "Re-voice and re-mix" }).click();
  await expect(page.locator(".toast.bad").first()).toContainText("Shorten it a little");
  const mine = "Three candles and a runner. That is the whole trick.";
  await box.fill(mine);
  await expect(dialog.locator("[data-word-count]")).toContainText("10 of about");
  await dialog.getByRole("button", { name: "Re-voice and re-mix" }).click();
  await expect(page.locator(".toast").last()).toContainText("Making the voice over in your voice");
  await expect(card.locator('[data-voice-over="mixing"]')).toBeVisible();
  await runJob(page.request, (r) => r.startsWith("auto/"));
  const after = (await clipsOf(page.request, dumpId)).find((c) => c.id === voiced[0].id)!;
  expect(after).toMatchObject({ voice_over: "ready", voice_script: mine });

  // Remove: the clip plays with its own sound again
  await page.reload();
  await card.getByRole("button", { name: "Remove voice over" }).click();
  await expect(page.locator(".toast").last()).toContainText("Voice over removed");
  await expect(card.locator("[data-voice-over]")).toHaveCount(0);
  expect((await clipsOf(page.request, dumpId)).find((c) => c.id === voiced[0].id)!.voice_over).toBeNull();
});

test("Dump: the Voice over chip (not all or none) and Review: Add voice over on any clip", async ({ page }) => {
  d1("UPDATE voice SET sample_r2_key = 'voice/sample/e2e-auto', consent_at = '2026-09-26T00:00:00Z' WHERE id = 1");
  await page.goto("/dump");
  const group = page.getByRole("group", { name: "Voice over" });
  await expect(group.getByRole("button", { name: "On quiet clips (your setting)" })).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: "None for this dump" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-voice-hint]")).toContainText("clips where you talk never do");
  await group.getByRole("button", { name: "Let me pick in Review" }).click();
  await expect(group.getByRole("button", { name: "Let me pick in Review" })).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: /On quiet clips/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-voice-hint]")).toContainText("tap Add voice over on any clip in Review");
  // a note says it too, and is read back before Dump
  await page.getByLabel("Notes for this dump").fill("no voice over on this one");
  await expect(page.locator("[data-understood]")).toContainText("Voice over: none for this dump");

  // "Let me pick in Review": the dump makes none; Add voice over on one clip makes just that one
  const since = new Date().toISOString();
  const { id: dumpId } = await (await page.request.post("/api/dumps", { data: { door: "new", notes: "" } })).json();
  const s = await page.request.post("/api/uploads/start", { data: { kind: "video", parentId: dumpId, fileName: "pick.mp4", size: 90_000, mimeType: "video/mp4", contentHash: `pick-${Date.now()}-${Math.random()}` } });
  const u = await s.json();
  const p = await page.request.put(`/api/uploads/${u.id}/parts/1?key=${encodeURIComponent(u.key)}&uploadId=${encodeURIComponent(u.uploadId)}`, { data: video() });
  await page.request.post(`/api/uploads/${u.id}/complete`, { data: { key: u.key, uploadId: u.uploadId, parts: [await p.json()] } });
  await page.request.patch(`/api/dumps/${dumpId}`, { data: { steer: { count: 5, voice: "pick" } } });
  expect((await page.request.post(`/api/dumps/${dumpId}/dump`)).ok()).toBe(true);
  await runJob(page.request, (r) => r === dumpId);
  const clips = await clipsOf(page.request, dumpId);
  expect(clips.every((c) => c.voice_over === null)).toBe(true);
  const autoJobs = ((await (await page.request.get("/api/jobs")).json()) as { type: string; ref_id: string; created_at: string }[]).filter((j) => j.type === "voice" && j.created_at >= since);
  expect(autoJobs).toHaveLength(0);

  await page.goto("/review");
  const card = page.locator(`[data-clip-id="${clips[0].id}"]`);
  await card.getByRole("button", { name: "Add voice over" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit the script" });
  await expect(dialog.getByLabel("Voice over script")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Voice it and mix it in" }).click();
  await expect(card.locator('[data-voice-over="mixing"]')).toBeVisible();
  await runJob(page.request, (r) => r.startsWith("auto/"));
  const after = (await clipsOf(page.request, dumpId)).find((c) => c.id === clips[0].id)!;
  expect(after).toMatchObject({ voice_over: "ready", voice_auto: false });
  await page.reload();
  await expect(card.locator('[data-voice-over="ready"]')).toHaveText("With your voice over · AI-labelled when it posts");
});
