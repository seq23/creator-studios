// /privacy and /terms are public (Google's Branding page needs both before the Connect YouTube
// sign-in can be published) and linked in the footer of every screen: the login card (no
// session), the desktop sidebar and the phone Menu sheet (signed in).
import { expect, test } from "@playwright/test";
import { TOUR_OFF } from "./demo";

test.describe("privacy and terms", () => {
  test("readable with no session, and the login card links them", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "https://myaccount.google.com/permissions" }).first()).toBeVisible();
    await expect(page.getByLabel("Your email")).toHaveCount(0);
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
    await page.goto("/");
    await expect(page.getByLabel("Your email")).toBeVisible();
    await page.locator(".login-card").getByRole("link", { name: "Privacy" }).click();
    await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
    await ctx.close();
  });

  test("signed in: the footer links open the pages (sidebar on desktop, Menu on a phone)", async ({ page, isMobile }) => {
    await page.addInitScript(TOUR_OFF);
    await page.goto("/");
    if (isMobile) await page.getByRole("button", { name: "Menu" }).click();
    const scope = isMobile ? page.locator("#more-sheet") : page.locator(".sidebar-foot");
    await expect(scope.getByRole("link", { name: "Terms" })).toBeVisible();
    await scope.getByRole("link", { name: "Privacy" }).click();
    await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
  });
});
