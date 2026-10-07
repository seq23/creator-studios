// Logs in once per run and saves the session cookie. The login rate limit (5 codes per
// 15 minutes per email) is a real control; tests share one session instead of loosening it.
import { test as setup } from "@playwright/test";
import { login } from "./helpers";

export const STORAGE = "test-results/.auth/owner.json";

setup("log in as the owner", async ({ page }) => {
  await login(page);
  await page.context().storageState({ path: STORAGE });
});
