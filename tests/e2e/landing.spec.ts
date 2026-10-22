// Sample 3's one-page landing (studio brief: a preview-only build, studios/sample3.json ->
// `landing`). The dev server's own registry entry carries no landing block (nothing else should
// change), so this mocks GET /api/studio to answer as sample3 would and exercises the real page
// against it: the hero, steps and facts render, the button jumps to the sign-in card, the real
// email-code login still works, and Privacy/Terms are reachable. A separate test proves a studio
// with no landing block (the real dev server, unmocked) still shows today's plain card.
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "./helpers";

const PREVIEW_DIR = path.join(process.cwd(), "docs", "preview");
mkdirSync(PREVIEW_DIR, { recursive: true });

const reg = JSON.parse(readFileSync(path.join(process.cwd(), "studios", "sample3.json"), "utf8"));
const STUDIO_RESPONSE = {
  slug: "sample3",
  appName: reg.appName,
  ownerName: "",
  wordmark: { name: reg.appName },
  chrome: null,
  landing: reg.landing,
};

test.describe("sample3 landing", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.afterEach(() => {
    sql("DELETE FROM login_codes WHERE email = 'owner@studio.example'");
  });

  test("hero, steps and facts show logged out; the button jumps to sign in; login still works; Privacy/Terms reachable", async ({ page }, testInfo) => {
    await page.route("**/api/studio", (route) => route.fulfill({ json: STUDIO_RESPONSE }));
    await page.goto("/");

    await expect(page.getByRole("heading", { name: reg.landing.heading, level: 1 })).toBeVisible();
    await expect(page.getByText(reg.landing.sub)).toBeVisible();
    for (const step of reg.landing.steps) {
      await expect(page.getByRole("heading", { name: step.title, level: 2 })).toBeVisible();
      await expect(page.getByText(step.body)).toBeVisible();
    }
    for (const fact of reg.landing.facts) await expect(page.getByText(fact, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: reg.landing.signInHeading })).toBeVisible();

    // Nothing is hidden behind the button: the sign-in card is already on the page before it is clicked.
    await expect(page.getByLabel("Your email")).toBeVisible();
    // The preview for the PR: the whole page, logged out, before any interaction (phone and desktop projects).
    await page.screenshot({ path: path.join(PREVIEW_DIR, `landing-sample3-${testInfo.project.name === "phone" ? "phone" : "desktop"}.png`), fullPage: true });

    await page.getByRole("link", { name: reg.landing.cta }).click();
    await expect(page.locator("#signin")).toBeInViewport();

    await page.getByLabel("Your email").fill("owner@studio.example");
    await page.getByRole("button", { name: "Email me a code" }).click();
    const code = await page.locator(".notice strong").textContent();
    await page.getByLabel("The code from your email").fill(code!.trim());
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("heading", { name: /^Hi / })).toBeVisible();
  });

  test("Privacy and Terms are reachable from the landing page", async ({ page }) => {
    await page.route("**/api/studio", (route) => route.fulfill({ json: STUDIO_RESPONSE }));
    await page.goto("/");
    await page.locator(".login-card").getByRole("link", { name: "Privacy" }).click();
    await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
    await page.goto("/");
    await page.locator(".login-card").getByRole("link", { name: "Terms" }).click();
    await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
  });

  test("a studio with no landing block (the real dev server) shows today's plain card, nothing added", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".landing-hero")).toHaveCount(0);
    await expect(page.getByLabel("Your email")).toBeVisible();
  });
});
