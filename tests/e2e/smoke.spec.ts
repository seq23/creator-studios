import { expect, test } from "@playwright/test";
import { sql } from "./helpers";

test.describe("login", () => {
  // These tests exercise the login flow itself, so they start without the shared session.
  test.use({ storageState: { cookies: [], origins: [] } });

  // Codes are capped at 5 per email per 15 minutes (worker/routes/auth.ts). The setup project
  // and both device projects each request one, so a second run of the suite on the same
  // database would hit the cap and see no code. Each test puts back the codes it asked for
  // (used ones count too; sessions are cookies and are not touched).
  test.afterEach(() => {
    sql("DELETE FROM login_codes WHERE email = 'owner@studio.example'");
  });

  test("the login page shows the brand and asks for an email", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your Studio" })).toBeVisible();
    await expect(page.getByLabel("Your email")).toBeVisible();
  });

  test("a code from the email logs her in", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Your email").fill("owner@studio.example");
    await page.getByRole("button", { name: "Email me a code" }).click();
    const code = await page.locator(".notice strong").textContent();
    await page.getByLabel("The code from your email").fill(code!.trim());
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("heading", { name: /^Hi / })).toBeVisible();
  });

  test("an unknown email gets the same answer and no code", async ({ page }) => {
    const res = await page.request.post("/api/auth/request", { data: { email: "stranger@example.com" } });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });
});

test.describe("home and dump", () => {
  test("home shows runway, this week, waiting, health, your voice, and the big Dump button", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Runway")).toBeVisible();
    // the optional voice is always there, quietly: one line and a link, never a primary or a badge
    const voice = page.locator(".home-voice");
    await expect(voice).toContainText("Your voice overs");
    await expect(voice).toContainText("Optional: record your voice so your clips can have voice overs in it");
    await expect(voice.getByRole("link", { name: /Set up in 5 steps/ })).toHaveAttribute("href", "/voice");
    await expect(voice.locator(".badge, [data-primary], .dot.red")).toHaveCount(0);
    await expect(page.getByText("This week")).toBeVisible();
    await expect(page.getByText("Waiting for you")).toBeVisible();
    await expect(page.getByRole("link", { name: "+ Dump videos" })).toBeVisible();
    // one next step per screen: the Dump link is the only primary action
    await expect(page.locator("[data-primary]")).toHaveCount(1);
    await expect(page.locator("[data-primary]")).toHaveText("+ Dump videos");
  });

  test("every screen is reachable and has a ? help button", async ({ page }) => {
    for (const path of ["/dump", "/review", "/calendar", "/brain", "/research", "/stats", "/settings", "/settings/connections", "/deals", "/voice", "/help"]) {
      await page.goto(path);
      await expect(page.getByRole("link", { name: "Help for this screen" }), path).toBeVisible();
    }
  });

  test("dump: pick a door, upload a small file in chunks, Dump is gated on the brief", async ({ page }) => {
    await page.goto("/dump");
    // nothing is picked for her: the Dump button waits until she says which videos these are
    await expect(page.locator("[data-dump-button]")).toBeDisabled();
    await page.getByRole("radio", { name: /Old posts to reuse/ }).click();
    await expect(page.locator("[data-door-picked]")).toHaveText(/You picked: Old posts to reuse/);
    // before anything is uploaded the one next step is choosing videos
    await expect(page.locator("[data-primary]")).toHaveCount(1);
    await expect(page.locator("[data-primary]")).toHaveText("Choose videos");
    // Random bytes: the dashboard refuses a file it has already seen (never re-upload the identical video).
    const bytes = Buffer.alloc(300_000);
    for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
    await page.locator('input[type="file"]').setInputFiles({ name: "sample.mp4", mimeType: "video/mp4", buffer: bytes });
    await expect(page.getByText("Uploaded")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Notes for this dump").fill("Test dump from Playwright");
    // once a video is in, the primary moves to the Dump button
    await expect(page.locator("[data-primary]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Dump 1 old post", exact: true })).toHaveAttribute("data-primary", "true");
    await page.getByRole("button", { name: "Dump 1 old post", exact: true }).click();
    // Section 6 gate: no Brand Profile locked yet → a plain-English stop with a fix link.
    await expect(page.locator(".toast.bad")).toContainText("Brand Profile");
    await expect(page.locator(".toast.bad").getByRole("link", { name: "How to fix" })).toBeVisible();
  });

  test("settings: caps stop at 10 and save; every feature switch is on by default and says what off does", async ({ page }) => {
    await page.request.patch("/api/settings", { data: { weekly_caps: { tiktok: 10, instagram: 7, youtube: 5 } } });
    await page.goto("/settings");
    // nothing switched off: a fresh database has every feature on (migration 0010)
    const features = ((await (await page.request.get("/api/settings")).json()) as { features: Record<string, boolean> }).features;
    expect(features).toEqual({ voice: true, deeper_research: true, weekly_recap: true, help_ask: true });
    for (const [label, off] of [
      ["Automatic voice overs", "Off = only the voice overs you add yourself."],
      ["Deeper web research", "Off = the brief uses the free web search only."],
      ["Weekly recap email", "Off = no Monday email."],
    ]) {
      const sw = page.locator("label.switch", { hasText: label });
      await expect(sw.getByRole("checkbox")).toBeChecked();
      await expect(sw).toContainText(off);
    }
    const more = page.getByRole("button", { name: "More TikTok posts per week" });
    await expect(more).toBeDisabled();
    await page.getByRole("button", { name: "Fewer YouTube Shorts posts per week" }).click();
    await expect(page.locator(".toast").first()).toContainText("Saved");
  });

  test("connect: a bad Buffer key is refused with a fix link, a good one lists channels", async ({ page }) => {
    await page.request.post("/api/connections/buffer/disconnect"); // start clean whatever an earlier project did
    await page.goto("/settings/connections");
    await page.getByLabel("Posting · Buffer key").fill("bad-key-000000");
    await page.getByRole("button", { name: "Check key" }).first().click();
    await expect(page.locator(".toast.bad")).toContainText("not valid");
    await page.getByLabel("Posting · Buffer key").fill("good-key-ig-missing");
    await page.getByRole("button", { name: "Check key" }).first().click();
    await expect(page.getByText("Channels we found in your Buffer")).toBeVisible();
    await expect(page.getByText("Needs reconnect in Buffer")).toBeVisible();
  });

  // Live test 25 Sep 2026: Buffer revoked the stored key, the card showed only the paste box,
  // and the dead key could not be removed. A stored key that stopped working gets Disconnect.
  test("connect: a stored key Buffer stopped accepting can be disconnected", async ({ page }) => {
    await page.request.post("/api/connections/buffer/disconnect");
    expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-ig-missing" } })).ok()).toBe(true);
    sql("UPDATE connections SET status = 'error', last_error = 'Buffer says this key is not valid.' WHERE service = 'buffer'");
    await page.goto("/settings/connections");
    const card = page.locator(".card", { has: page.getByRole("heading", { name: "Buffer", exact: true }) });
    await expect(card).toContainText("Buffer says this key is not valid.");
    await card.getByRole("button", { name: "Disconnect" }).click();
    await expect(card).toContainText("Disconnected");
    expect(sql<{ secret_enc: string | null; status: string }>("SELECT secret_enc, status FROM connections WHERE service = 'buffer'")[0]).toEqual({ secret_enc: null, status: "disconnected" });
    // put back what the suite had: a working (fake) key
    expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-ig-missing" } })).ok()).toBe(true);
  });

  // Live test 25 Sep 2026: after "Check everything now" turned Buffer red, the sidebar still said
  // "All systems OK" until the next 60-second refresh.
  test("settings: Check everything now updates the sidebar's health line at once", async ({ page }) => {
    const before = sql<{ name: string; light: string }>("SELECT name, light FROM health");
    sql("UPDATE health SET light = 'green'");
    await page.goto("/settings");
    // The sidebar is the desktop layout; under 900 px it is in the DOM but hidden behind the tab
    // bar, so read its text (both projects) rather than its visibility.
    const status = page.locator(".sidebar-foot a").first();
    await expect(status).toHaveText("All systems OK");
    await page.request.post("/api/connections/buffer/disconnect");
    await page.getByRole("button", { name: "Check everything now" }).click();
    await expect(page.getByText("Checked everything.")).toBeVisible();
    await expect(status).toHaveText("Something needs you", { timeout: 3_000 });
    expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-ig-missing" } })).ok()).toBe(true);
    for (const r of before) sql(`UPDATE health SET light = '${r.light}' WHERE name = '${r.name.replace(/'/g, "''")}'`);
  });
});

test.describe("public", () => {
  test("the media kit page needs no login, and shows only what she published", async ({ page, browser }) => {
    const pub = await (await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined })).newPage();
    sql("DELETE FROM media_kit_versions");
    await pub.goto("/kit/studio");
    await expect(pub.getByRole("heading", { name: "No media kit here" })).toBeVisible();
    expect((await page.request.post("/api/mediakit/publish")).ok()).toBe(true); // as the signed-in owner
    await pub.goto("/kit/studio");
    await expect(pub.getByRole("heading", { name: "Sample Creator", level: 1 })).toBeVisible();
    sql("DELETE FROM media_kit_versions");
    await pub.context().close();
  });
  test("a media link with a bad token is a 404, not a crash", async ({ page }) => {
    const res = await page.request.get("/media/notavalidtokenatall000000000000000000");
    expect(res.status()).toBe(404);
  });
});

test.describe("guard rails", () => {
  test("the identical video is refused the second time", async ({ page }) => {
    const bytes = Buffer.alloc(120_000);
    for (let i = 0; i < bytes.length; i += 4) bytes.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
    const upload = async () => {
      await page.goto("/dump");
      await page.getByRole("radio", { name: /New videos I just filmed/ }).click();
      await page.locator('input[type="file"]').setInputFiles({ name: "same.mp4", mimeType: "video/mp4", buffer: bytes });
      await expect(page.getByText(/Uploaded|Failed/)).toBeVisible({ timeout: 20_000 });
      return page.getByText("Uploaded").isVisible();
    };
    expect(await upload()).toBe(true);
    expect(await upload()).toBe(false);
  });
});
