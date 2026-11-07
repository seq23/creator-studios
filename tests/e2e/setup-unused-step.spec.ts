import { expect, test } from "@playwright/test";

// 7 Nov 2026: Porch & Party's Setup page went blank in production once Pinterest was left out of the
// server's step list (an unused service); the page read `.state` of the missing step. A step the
// server leaves out is simply not drawn.
test("Setup still draws when the server leaves a step out (an unused service)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/setup", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.steps = j.steps.slice(1);
    await route.fulfill({ response: r, json: j });
  });
  await page.goto("/setup");
  await expect(page.locator(".setup-steps > li").first()).toBeVisible();
  await expect(page.locator(".setup-progress")).toContainText("set up");
  expect(errors).toEqual([]);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(wide).toBe(false);
});
