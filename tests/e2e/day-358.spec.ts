// Day 358 (docs/reviews/2026-09-26-day-358.md): a YEAR of demo data (scripts/seed-year.mjs), used
// the way Sam would on her phone and on a desktop. Home fits one phone screen however much has
// piled up; every card dismisses with Undo; dumps, deals and voice overs archive with Undo and come
// back from Show archived; long lists page with true counts; the daily lane clears storage and
// warns before any unreviewed clip goes, with one-tap Keep; Settings shows the meter and the rules.
// Everything the year adds is removed afterwards (the other specs start from the base state).
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { TOUR_OFF } from "./demo";
import { sql } from "./helpers";

test.describe.configure({ mode: "serial" });
let started = "";

function seedYear() {
  execFileSync("node", ["scripts/seed-year.mjs", "--apply"], { stdio: "pipe" });
}
async function dailyLane(page: Page) {
  // serve.sh runs wrangler dev with --test-scheduled: /cdn-cgi/handler/scheduled fires a cron on
  // THIS server. The lane runs in waitUntil, so wait for its "Last daily run" row to be rewritten.
  const since = new Date().toISOString();
  const r = await page.request.get("/cdn-cgi/handler/scheduled?cron=30+13+*+*+*");
  expect(r.ok()).toBe(true);
  await expect
    .poll(() => sql<{ n: number }>(`SELECT COUNT(*) AS n FROM health WHERE name = 'Last daily run' AND checked_at >= '${since}'`)[0].n, { timeout: 60_000, intervals: [1000] })
    .toBe(1);
}

test.beforeAll(() => {
  started = new Date().toISOString();
});
test.beforeEach(async ({ page }) => {
  seedYear();
  await page.addInitScript(TOUR_OFF);
});
test.afterAll(() => {
  execFileSync("node", ["scripts/seed-year.mjs", "--clear"], { stdio: "pipe" });
  // what the daily lane added while the year was loaded
  sql(`DELETE FROM jobs WHERE created_at >= '${started}'; DELETE FROM emails_sent WHERE sent_at >= '${started}'; DELETE FROM health WHERE checked_at >= '${started}'; DELETE FROM settings WHERE key IN ('storage_report'); UPDATE dumps SET archived_at = NULL, archived_by = NULL`);
});

const HOME_MAX = 844; // an iPhone 13 screen

async function homeBottom(page: Page): Promise<number> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  const parts = await page.evaluate(() => [...document.querySelectorAll(".page > *:not(.help-btn)")].map((e) => [e.className, e.getBoundingClientRect().bottom + window.scrollY] as const));
  return Math.max(...parts.map((p) => p[1]));
}

test("Home fits one phone screen, whatever is on top; every card dismisses with Undo", async ({ page }) => {
  test.setTimeout(120_000);
  await dailyLane(page);
  // the clearing-soon notice and the storage light are on Home too
  await page.goto("/");
  await expect(page.locator("[data-notice]")).toHaveCount(1);
  const phone = test.info().project.name === "phone";
  // walk every notice (dismiss shows the next one): the page never grows past one phone screen
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const n = page.locator("[data-notice]");
    if (!(await n.count())) break;
    const kind = (await n.getAttribute("data-notice")) ?? "";
    const key = (await n.getAttribute("data-notice-key")) ?? "";
    seen.add(kind);
    if (phone) expect(await homeBottom(page), `Home with a "${kind}" notice`).toBeLessThanOrEqual(HOME_MAX);
    await page.getByRole("button", { name: "Hide this notice" }).click();
    await expect(page.getByRole("button", { name: "Undo" }).last()).toBeVisible();
    // the next notice (or none) replaces it
    await expect(page.locator(`[data-notice-key="${key}"]`)).toHaveCount(0);
  }
  expect(seen.size).toBeGreaterThanOrEqual(3);
  // Undo brings the last one back
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(page.locator("[data-notice]")).toHaveCount(1);
  // two dumps and two follow-ups at most, each "See all (N)" with the true count
  await expect(page.locator(".home-lists .list-row")).toHaveCount(4);
  const dumpsTotal = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NULL")[0].n);
  await expect(page.getByRole("link", { name: `See all (${dumpsTotal})` })).toBeVisible();
  const key = await page.locator(".home-lists [data-home-key^='dump:']").first().getAttribute("data-home-key");
  const row = page.locator(`[data-home-key="${key}"]`);
  await row.getByRole("button", { name: "Hide this dump from Home" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(row).toHaveCount(1);
  if (phone) expect(await homeBottom(page)).toBeLessThanOrEqual(HOME_MAX);
});

test("Dump: 20 at a time of 50, search, archive with Undo, Show archived and Restore", async ({ page }) => {
  // the year's 50 plus whatever the other specs dumped today: the count on screen is the true one
  const total = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NULL")[0].n);
  const failed = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NULL AND status = 'failed'")[0].n);
  expect(total).toBeGreaterThanOrEqual(50);
  await page.goto("/dump");
  const history = page.getByRole("complementary", { name: "Your dumps" });
  await expect(history.locator("[data-count]")).toHaveText(`Showing 20 of ${total} dumps`);
  await history.getByRole("button", { name: "Show more" }).click();
  await expect(history.locator("[data-count]")).toHaveText(`Showing 40 of ${total} dumps`);
  await history.getByRole("button", { name: "Needs a look" }).click();
  await expect(history.locator("[data-dump-row]")).toHaveCount(Math.min(20, failed));
  await history.getByRole("button", { name: "All" }).click();
  await expect(history.locator("[data-count]")).toHaveText(`Showing 20 of ${total} dumps`);
  // a dump still cutting has no archive button (it is not finished); take the first one that has it
  const id = await history.locator('[data-dump-row]:has(button[aria-label^="Archive the dump from"])').first().getAttribute("data-dump-row");
  const row = history.locator(`[data-dump-row="${id}"]`);
  await row.getByRole("button", { name: /Archive the dump from/ }).click();
  await expect(history.locator(`[data-dump-row="${id}"]`)).toHaveCount(0);
  await expect(history.locator("[data-count]")).toHaveText(`Showing 20 of ${total - 1} dumps`);
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(history.locator(`[data-dump-row="${id}"]`)).toHaveCount(1);
  await row.getByRole("button", { name: /Archive the dump from/ }).click();
  await history.getByRole("button", { name: /Show archived/ }).click();
  await expect(page.getByRole("heading", { name: "Archived dumps" })).toBeVisible();
  const archived = page.getByRole("complementary", { name: "Your dumps" }).locator(`[data-dump-row="${id}"]`);
  await archived.getByRole("button", { name: "Restore" }).click();
  await expect(archived).toHaveCount(0);
  expect(sql<{ a: string | null }>(`SELECT archived_at AS a FROM dumps WHERE id = '${id}'`)[0].a).toBeNull();
  await expect(page.locator("[data-free-space]")).toContainText("of 10 GB used");
});

test("Review pages its clips with the true count; ?tab= opens the right tab", async ({ page }) => {
  await page.goto("/review?tab=approved");
  await expect(page.getByRole("tab", { name: /Approved/ })).toHaveAttribute("aria-selected", "true");
  const approved = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved'")[0].n);
  await expect(page.locator("[data-count]")).toHaveText(`Showing 12 of ${approved} clips`);
  await expect(page.locator("[data-clip-id]")).toHaveCount(12);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.locator("[data-clip-id]")).toHaveCount(24);
  await page.getByRole("searchbox", { name: "Search hooks, captions and hashtags" }).fill("checklist");
  const checklist = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved' AND (hook_text LIKE '%checklist%' OR caption LIKE '%checklist%' OR hashtags LIKE '%checklist%')")[0].n);
  await expect(page.locator("[data-count]")).toHaveText(`Showing ${Math.min(12, checklist)} of ${checklist} clips`);
});

test("Deals: Do this next is capped with Show all; a dead deal archives and comes back", async ({ page }) => {
  await page.goto("/deals");
  const next = page.getByRole("region", { name: "Do this next" });
  await expect(next.locator(".deal-card")).toHaveCount(8);
  const open = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('declined','lost') AND archived_at IS NULL")[0].n);
  await next.getByRole("button", { name: `Show all (${open})` }).click();
  await expect(next.locator(".deal-card")).toHaveCount(open);
  const brand = await next.locator(".deal-card-name").first().innerText();
  await next.getByRole("button", { name: `Archive the ${brand} deal` }).first().click();
  await expect(next.locator(".deal-card-name", { hasText: brand })).toHaveCount(0);
  const archivedBox = page.getByRole("region", { name: "Archived deals" });
  await archivedBox.getByRole("button", { name: /Show archived/ }).click();
  await archivedBox.locator(".list-row", { hasText: brand }).getByRole("button", { name: "Restore" }).click();
  await expect(next.locator(".deal-card-name", { hasText: brand })).toHaveCount(1);
});

test("Calendar history: what already happened, failed ones to retry or let go", async ({ page }) => {
  await page.goto("/calendar");
  const h = page.getByRole("region", { name: "History" });
  const failed = Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed'")[0].n);
  await h.getByRole("button", { name: `Didn't go out (${failed})` }).click();
  await expect(h.locator("[data-history-row]").first()).toHaveAttribute("data-history-row", "failed");
  await h.locator("[data-history-row]").first().getByRole("button", { name: "Let go" }).click();
  await expect(h.getByRole("button", { name: `Didn't go out (${failed - 1})` })).toBeVisible();
});

test("the daily lane: storage back under control, a warning before unreviewed clips go, one-tap Keep", async ({ page }) => {
  await page.goto("/settings");
  const storage = page.getByRole("region", { name: "Storage" });
  await expect(storage).toContainText("Almost full");
  await dailyLane(page);
  await page.reload();
  await expect(storage).not.toContainText("Almost full");
  await expect(storage.locator('[data-storage-kind="clips_drafts"]')).toContainText("warning on Home a week before");
  await expect(page.getByRole("switch", { name: "Tidy up automatically" }).or(page.getByLabel("Tidy up automatically"))).toBeChecked();
  // nothing unposted went: every draft is still there, now with its date
  expect(Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE status = 'deleted' AND file_deleted_at IS NOT NULL AND full_video = 0")[0].n)).toBe(0);
  await page.goto("/");
  // the clearing notice may sit behind a more urgent one: walk to it
  for (let i = 0; i < 6 && !(await page.locator('[data-notice="clearing"]').count()); i++) {
    await page.getByRole("button", { name: "Hide this notice" }).click();
    await page.waitForLoadState("networkidle");
  }
  const clearing = page.locator('[data-notice="clearing"]');
  await expect(clearing).toContainText("unreviewed clip");
  await clearing.getByRole("button", { name: "Keep them" }).click();
  await expect(page.getByText(/^Kept \d+ clips? until/)).toBeVisible();
  expect(Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE delete_warned_at IS NOT NULL")[0].n)).toBe(0);
});
