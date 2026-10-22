// Client Brain doc rows stay readable in a narrow column (22 Oct 2026, seen live at 1200 px: the
// file name showed as "P" and "3 KB · Oct 22" stacked one word per line). At 1200 and 390 wide:
// the name has a real width and sits on one line, the meta sits on one line, and the status pill
// sits beside the name or wraps below it, never squeezing it.
import { expect, test, type APIRequestContext } from "@playwright/test";

const NAME = "Porch-and-Party-brand-guide-with-a-long-name.md";

async function uploadDoc(api: APIRequestContext): Promise<string> {
  const bytes = Buffer.from("# Brand guide\nWarm, friendly, Memphis porches.\n".repeat(60));
  const start = (await (await api.post("/api/uploads/start", { data: { kind: "brand_doc", parentId: null, fileName: NAME, size: bytes.length, mimeType: "text/markdown" } })).json()) as { id: string; key: string; uploadId: string };
  const part = await (await api.put(`/api/uploads/${start.id}/parts/1?key=${encodeURIComponent(start.key)}&uploadId=${encodeURIComponent(start.uploadId)}`, { data: bytes })).json();
  const done = await api.post(`/api/uploads/${start.id}/complete`, { data: { key: start.key, uploadId: start.uploadId, parts: [part] } });
  expect(done.ok(), await done.text()).toBe(true);
  return start.id;
}

test("a brand doc row keeps its name and meta readable at 1200 and 390 wide", async ({ page }) => {
  const id = await uploadDoc(page.request);
  try {
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/brain");
      const row = page.locator(".brain-doc", { hasText: "Porch-and-Party" }).first();
      await expect(row).toBeVisible();
      const title = row.locator(".title");
      const meta = row.locator(".meta");
      const tb = (await title.boundingBox())!;
      const mb = (await meta.boundingBox())!;
      const lh = await meta.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5);
      const tlh = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5);
      expect(tb.width, `${width}: name width`).toBeGreaterThanOrEqual(150);
      expect(tb.height, `${width}: name on one line`).toBeLessThanOrEqual(tlh * 1.2);
      expect(mb.height, `${width}: meta on one line`).toBeLessThanOrEqual(lh * 1.2);
      // The pill never overlaps the name: beside it, or wrapped below it.
      const pb = (await row.locator(".pill").first().boundingBox())!;
      const beside = pb.x >= tb.x + tb.width - 1;
      const below = pb.y >= tb.y + tb.height - 1;
      expect(beside || below, `${width}: pill beside or below the name`).toBe(true);
    }
  } finally {
    await page.request.delete(`/api/brain/docs/${id}`);
  }
});
