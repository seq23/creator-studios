// Someone else's video (watermark check, #20) never leaves the dashboard through the media kit
// or a pitch. Phase 0 live test, 26 Sep 2026: the calendar held those clips, but the kit's clip
// picker, "Pick my best clips", the public kit and pitch emails still offered them (each read
// "approved" clips on its own). All of them now use the calendar's rule, POSTABLE_CLIP_SQL.
import { expect, test } from "@playwright/test";
import { sql } from "./helpers";
import { clearDemo, seedDemo } from "./demo";

const HELD = "held_clip_e2e_00001";
const TOKEN = "heldtokene2exxxxxxxxxxxxxxxxxxxxxxxxxxxx";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  seedDemo();
  sql(
    "INSERT INTO dumps (id, door, status, clips_made) VALUES ('held_dump_e2e', 'recycle', 'ready', 1);" +
      "INSERT INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_status, source_owner, source_note) VALUES ('held_ast_e2e', 'held_dump_e2e', 'x.mp4', 'video/mp4', 1, 'raw/held_dump_e2e/held_ast_e2e', 'uploaded', 'other', 'Looks like someone else''s video');" +
      `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, score, r2_key, media_token, status) VALUES ('${HELD}', 'held_ast_e2e', 'held_dump_e2e', 0, 20, 'recycle', 'Not her video', 'x', 0.999, 'clips/held_dump_e2e/${HELD}.mp4', '${TOKEN}', 'approved');`,
  );
});
test.afterAll(() => {
  sql(`DELETE FROM deal_emails; DELETE FROM clips WHERE id = '${HELD}'; DELETE FROM assets WHERE id = 'held_ast_e2e'; DELETE FROM dumps WHERE id = 'held_dump_e2e';`);
  clearDemo();
});

test("held clips stay out of the kit picker, Pick my best clips, the public kit and pitches", async ({ page }) => {
  const api = page.request;
  // the kit editor's clip list
  const kit = (await (await api.get("/api/mediakit")).json()) as { clips: { id: string }[]; draft: Record<string, unknown> & { showcase: string[] } };
  expect(kit.clips.length, "her own approved clips are offered").toBeGreaterThan(0);
  expect(kit.clips.map((c) => c.id)).not.toContain(HELD);
  // "Pick my best clips" (the held clip has the top score)
  expect((await api.post("/api/mediakit/fix", { data: { action: "auto_showcase" } })).ok()).toBe(true);
  const picked = (await (await api.get("/api/mediakit")).json()) as { draft: { showcase: string[] } };
  expect(picked.draft.showcase).not.toContain(HELD);
  // she cannot put it in by hand either
  expect((await api.patch("/api/mediakit", { data: { draft: { ...picked.draft, showcase: [HELD, ...picked.draft.showcase] } } })).status()).toBe(422);
  // and a draft that already held it (picked before the video was flagged) never shows it once published
  sql(`UPDATE media_kit SET draft = json_set(draft, '$.showcase', json('["${HELD}"]')) WHERE id = 1`);
  expect((await api.post("/api/mediakit/publish")).ok()).toBe(true);
  const pub = await (await api.get("/api/public/kit/studio?preview=1")).text();
  expect(pub).not.toContain(TOKEN);
  expect(pub).not.toContain(HELD);
  // a pitch links two clips: never this one
  const pitch = await api.post("/api/deals/brands/demo_brand_1/pitch");
  expect(pitch.ok(), await pitch.text()).toBe(true);
  const bodies = sql<{ body: string }>("SELECT body FROM deal_emails").map((r) => r.body).join("\n");
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies).not.toContain(TOKEN);
});
