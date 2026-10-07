import { defineConfig, devices } from "@playwright/test";

// Drives the built app through `wrangler dev` with fake services. A `setup` project logs in
// once and shares the session; `phone` (390×844, the priority for Dump and Review) and
// `desktop` run every spec. The help-screenshots spec reuses the same server.
// This suite runs the server in code mode (the email-code login, as on staging). The no-login
// production mode has its own server and config: playwright.open.config.ts (npm run e2e:open).
const STORAGE = "test-results/.auth/owner.json";
// The help screenshots (every guide step, phone and desktop) are their own job: `npm run
// help:screenshots` sets HELP_SHOTS=1 (e2e.yml job help-screenshots, job-help_screenshots.yml).
// The rest of the suite leaves them out so it stays fast.
const HELP = process.env.HELP_SHOTS ? [] : [/help-screenshots\.spec\.ts/];
const PORT = Number(process.env.E2E_PORT ?? 8787); // E2E_PORT lets parallel worktrees each run the suite

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bash tests/e2e/serve.sh",
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false, // serve.sh resets the local database; a running server would hold the old one
    timeout: 120_000,
    env: {
      E2E_PORT: String(PORT),
      SESSION_SECRET: process.env.SESSION_SECRET ?? "dev-session-secret",
      SECRETS_KEY: process.env.SECRETS_KEY ?? "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
      JOB_SHARED_SECRET: process.env.JOB_SHARED_SECRET ?? "dev-job-shared-secret",
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium", storageState: STORAGE }, dependencies: ["setup"], testIgnore: [/auth\.setup\.ts/, /open-mode\.spec\.ts/, ...HELP] },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 820 }, storageState: STORAGE }, dependencies: ["setup"], testIgnore: [/auth\.setup\.ts/, /open-mode\.spec\.ts/, ...HELP] },
  ],
});
