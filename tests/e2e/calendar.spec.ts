// Calendar + Buffer sync, end to end against wrangler dev with the fake Buffer.
// Approved clips are written straight into the local D1 (Review is another phase), then:
// fill → 22 posts at launch caps, moves refused over the cap, take off, the hourly cron
// (wrangler dev's /cdn-cgi/handler/scheduled) loading Buffer, posts going out, a failing post
// retried twice then emailed, a channel disconnecting once → one email, and the screens.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql } from "./helpers";

const TZ = "America/New_York";
const HOUR = 3600_000;

/** Three posts placed by hand inside the next few hours — one per channel — that Buffer will publish. */
const SOON = [
  { post: "e2e_p_tt", clip: "e2e_g0", platform: "tiktok" },
  { post: "e2e_p_ig", clip: "e2e_g1", platform: "instagram" },
  { post: "e2e_p_yt", clip: "e2e_g2", platform: "youtube" },
] as const;

const token = (prefix: string, i: number) => `${prefix}${String(i).padStart(4, "0")}`.padEnd(40, "x");
const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

function seedClips(n: number) {
  const rows: string[] = [
    "INSERT INTO dumps (id, door, notes, status) VALUES ('e2e_dn', 'new', 'e2e', 'reviewed'), ('e2e_dr', 'recycle', 'e2e', 'reviewed')",
  ];
  for (let a = 0; a < Math.ceil(n / 2); a++) rows.push(`INSERT INTO assets (id, dump_id, file_name, mime_type, r2_key, upload_status) VALUES ('e2e_a${a}', '${a % 2 ? "e2e_dr" : "e2e_dn"}', 'a.mp4', 'video/mp4', 'raw/e2e/${a}', 'uploaded')`);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / 2);
    rows.push(
      `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, score, r2_key, media_token, status) VALUES ('e2e_c${i}', 'e2e_a${a}', '${a % 2 ? "e2e_dr" : "e2e_dn"}', 0, 30, 'hook_first', 'E2E hook ${i}', 'Caption ${i}', '#e2e', ${(0.95 - i * 0.01).toFixed(2)}, 'clips/e2e/${i}.mp4', '${token("okclip", i)}', 'approved')`,
    );
  }
  sql(rows.join("; "));
}

async function tick(request: APIRequestContext) {
  const lastRun = async () => ((await (await request.get("/api/settings/health")).json()) as { name: string; light: string; checked_at: string }[]).find((h) => h.name === "Last buffer-sync run");
  const before = (await lastRun())?.checked_at ?? "";
  const res = await request.get("/cdn-cgi/handler/scheduled?cron=0+*+*+*+*");
  expect(res.ok()).toBe(true);
  // the run finishes after the trigger answers: wait for its "Last buffer-sync run" light
  await expect.poll(async () => { const r = await lastRun(); return r && r.checked_at !== before ? r.light : "waiting"; }, { timeout: 20_000 }).toBe("green");
}

/** Pull anything left in the fake Buffer, then clear the calendar and everything this spec seeds. */
async function clearCalendar(request: APIRequestContext) {
  for (const r of sql<{ id: string }>("SELECT id FROM posts WHERE status = 'in_buffer'")) await request.post(`/api/posts/${r.id}/unschedule`);
  sql(
    [
      "DELETE FROM posts",
      "DELETE FROM clips",
      "DELETE FROM assets WHERE id LIKE 'e2e_%'",
      "DELETE FROM dumps WHERE id LIKE 'e2e_%'",
      "DELETE FROM emails_sent WHERE kind IN ('posting_problem','connection_needs_you')",
      "DELETE FROM settings WHERE key = 'connection_states'",
      "DELETE FROM health WHERE name LIKE '%(via Buffer)' OR name = 'Buffer'",
    ].join("; "),
  );
}

async function reset(page: Page) {
  await clearCalendar(page.request);
  expect((await page.request.patch("/api/settings", { data: { weekly_caps: { tiktok: 10, instagram: 7, youtube: 5 } } })).ok()).toBe(true);
  await page.request.post("/api/connections/buffer/disconnect");
  expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-e2e-000" } })).ok()).toBe(true);
}

test.describe.configure({ mode: "serial" });

// Leave the database as this spec found it. The posts it drives through the fake Buffer read
// back as `posted`, and the deals spec counts posted TikTok posts for marketplace eligibility.
test.afterAll(async ({ playwright }, info) => {
  const ctx = await playwright.request.newContext({ baseURL: info.project.use.baseURL, storageState: "test-results/.auth/owner.json" });
  await clearCalendar(ctx);
  await ctx.dispose();
});

test.describe("calendar and the hourly Buffer sync", () => {
  test("with no approved clips the Calendar says so and points to Review", async ({ page }) => {
    await reset(page);
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "No approved clips yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Review" })).toBeVisible();
    const r = await page.request.post("/api/posts/plan", { data: {} });
    expect(r.status()).toBe(409);
    expect((await r.json()).fix_guide).toBe("review-and-approve-clips");
  });

  test("fill: a full week is 22 posts at launch caps (10 / 7 / 5), and filling again adds nothing", async ({ page }) => {
    seedClips(14);
    const r = await page.request.post("/api/posts/plan", { data: { start_week: 1, weeks: 1 } });
    expect(r.ok()).toBe(true);
    expect(await r.json()).toMatchObject({ added: 22, perPlatform: { tiktok: 10, instagram: 7, youtube: 5 }, slotsFrom: "launch" });
    const again = await page.request.post("/api/posts/plan", { data: { start_week: 1, weeks: 1 } });
    expect((await again.json()).added).toBe(0);
    const perClip = sql<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT clip_id, platform FROM posts GROUP BY clip_id, platform HAVING COUNT(*) > 1)");
    expect(perClip[0].n).toBe(0); // never a clip twice on one platform
  });

  test("moves: over the cap is refused in plain words; inside the week it moves", async ({ page }) => {
    const r = await page.request.post("/api/posts/plan", { data: { start_week: 2, weeks: 1 } });
    expect((await r.json()).added).toBe(12); // the 4 clips left, on all three platforms
    const week1 = sql<{ scheduled_at: string }>("SELECT scheduled_at FROM posts ORDER BY scheduled_at LIMIT 1")[0].scheduled_at;
    const tt2 = sql<{ id: string; scheduled_at: string }>("SELECT id, scheduled_at FROM posts WHERE platform = 'tiktok' ORDER BY scheduled_at DESC LIMIT 1")[0];

    const refused = await page.request.patch(`/api/posts/${tt2.id}`, { data: { date: localDate(week1) } });
    expect(refused.status()).toBe(409);
    const body = await refused.json();
    expect(body.error).toMatch(/TikTok already has 10 posts that week and your limit is 10/);
    expect(body.fix_guide).toBe("change-posts-per-week");

    const sameWeekDay = localDate(new Date(Date.parse(tt2.scheduled_at) - 24 * HOUR).toISOString());
    const moved = await page.request.patch(`/api/posts/${tt2.id}`, { data: { date: sameWeekDay } });
    expect(moved.ok()).toBe(true);
    expect(localDate((await moved.json()).scheduled_at)).toBe(sameWeekDay);

    const past = await page.request.patch(`/api/posts/${tt2.id}`, { data: { scheduled_at: new Date(Date.now() - HOUR).toISOString() } });
    expect(past.status()).toBe(422);
  });

  test("take off: the clip goes back to the pool and the hourly run leaves it there", async ({ page }) => {
    const clip = sql<{ clip_id: string }>("SELECT clip_id FROM posts ORDER BY scheduled_at DESC LIMIT 1")[0].clip_id;
    for (const p of sql<{ id: string }>(`SELECT id FROM posts WHERE clip_id = '${clip}'`)) expect((await page.request.post(`/api/posts/${p.id}/unschedule`)).ok()).toBe(true);
    const pool = (await (await page.request.get("/api/posts/pool")).json()) as { id: string }[];
    expect(pool.map((c) => c.id)).toContain(clip);

    // Posts INSIDE the 7-day Buffer window, placed by hand: three that post and one that fails at
    // the platform. The fill above lands in NEXT week at the launch slots, and whether any of those
    // are inside the window depends on the weekday: on a Monday before the first launch slot
    // (TikTok 15:00 ET) none are, the hourly run loads nothing but the failing clip, and "next run
    // after their time" reads back zero posted — the scheduled run of Monday 28 Sep 2026 08:28 UTC
    // (tests/unit/buffer-window-monday.test.ts pins the arithmetic). These rows are what the read-back
    // tests prove, whatever day it is. Rows, not POST /api/posts: the API counts the week's cap, and
    // late on a Sunday ET "two hours from now" is next week, which the fill has already filled.
    sql(
      [
        `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, score, r2_key, media_token, status, platforms) VALUES ('e2e_fail', 'e2e_a0', 'e2e_dn', 0, 20, 'montage', 'E2E failing clip', 'c', '', 0.01, 'clips/e2e/f.mp4', '${token("failclip", 1)}', 'approved', '["tiktok"]')`,
        `INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES ('e2e_p_fail', 'e2e_fail', 'tiktok', '${new Date(Date.now() + 2 * HOUR).toISOString()}', 'planned')`,
        ...SOON.map(
          (g, i) =>
            `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, hashtags, score, r2_key, media_token, status, platforms) VALUES ('${g.clip}', 'e2e_a0', 'e2e_dn', 0, 20, 'montage', 'E2E soon ${i}', 'c', '', 0.02, 'clips/e2e/g${i}.mp4', '${token("okgood", i)}', 'approved', '["${g.platform}"]'); ` +
            `INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES ('${g.post}', '${g.clip}', '${g.platform}', '${new Date(Date.now() + (3 + i) * HOUR).toISOString()}', 'planned')`,
        ),
      ].join("; "),
    );
    const twice = await page.request.post("/api/posts", { data: { clip_id: "e2e_fail", platform: "tiktok", scheduled_at: new Date(Date.now() + 3 * HOUR).toISOString() } });
    expect(twice.status()).toBe(409); // already on the calendar for TikTok

    await tick(page.request);
    const active = sql<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE clip_id = '${clip}' AND status != 'unscheduled'`);
    expect(active[0].n).toBe(0);
  });

  test("hourly run: everything inside 7 days goes to Buffer (never past 10 a channel), the rest waits", async () => {
    const horizon = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
    const rows = sql<{ platform: string; status: string; scheduled_at: string }>("SELECT platform, status, scheduled_at FROM posts WHERE status IN ('planned','in_buffer')");
    const inBuffer = rows.filter((r) => r.status === "in_buffer");
    expect(inBuffer.length).toBeGreaterThan(0);
    // The hand-placed posts are inside the window on every weekday: all four went to Buffer.
    expect(sql<{ id: string }>("SELECT id FROM posts WHERE status = 'in_buffer' AND id LIKE 'e2e_p_%' ORDER BY id").map((r) => r.id)).toEqual(["e2e_p_fail", ...SOON.map((g) => g.post)].sort());
    for (const p of ["tiktok", "instagram", "youtube"]) {
      const n = inBuffer.filter((r) => r.platform === p).length;
      expect(n).toBeLessThanOrEqual(10);
      const waitingInWindow = rows.filter((r) => r.platform === p && r.status === "planned" && r.scheduled_at < horizon).length;
      if (waitingInWindow) expect(n).toBe(10); // only a full queue leaves posts waiting
    }
    for (const r of rows.filter((x) => x.scheduled_at >= horizon)) expect(r.status).toBe("planned");
    const buf = sql<{ light: string; note: string }>("SELECT light, note FROM health WHERE name = 'Buffer'")[0];
    expect(buf.light).toBe("green");
    expect(buf.note).toMatch(/^OK · \d+ of 10 queue slots used$/);
  });

  test("next run after their time: posts read back as posted with a link", async ({ page }) => {
    const earlier = new Date(Date.now() - HOUR).toISOString();
    sql(`UPDATE posts SET scheduled_at = '${earlier}' WHERE status = 'in_buffer'`); // time passes
    await tick(page.request);
    const posted = sql<{ n: number; links: number }>("SELECT COUNT(*) AS n, SUM(url IS NOT NULL AND posted_at IS NOT NULL) AS links FROM posts WHERE status = 'posted'")[0];
    expect(posted.n).toBeGreaterThanOrEqual(SOON.length);
    expect(posted.links).toBe(posted.n);
    // Each hand-placed post that Buffer published reads back posted, with its link and time.
    expect(sql<{ id: string; status: string; url: string | null }>("SELECT id, status, url FROM posts WHERE id IN ('e2e_p_tt','e2e_p_ig','e2e_p_yt') ORDER BY id")).toEqual(
      SOON.map((g) => ({ id: g.post, status: "posted", url: expect.stringMatching(/^https:\/\/example\.invalid\/post\//) })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    const fail = sql<{ status: string; retries: number }>("SELECT status, retries FROM posts WHERE clip_id = 'e2e_fail'")[0];
    expect(fail).toEqual({ status: "in_buffer", retries: 1 }); // re-created once
  });

  test("a post that keeps failing is retried twice, then failed, emailed once, and its channel goes red", async ({ page }) => {
    await tick(page.request);
    expect(sql<{ status: string; retries: number }>("SELECT status, retries FROM posts WHERE clip_id = 'e2e_fail'")[0]).toEqual({ status: "in_buffer", retries: 2 });
    await tick(page.request);
    expect(sql<{ status: string }>("SELECT status FROM posts WHERE clip_id = 'e2e_fail'")[0].status).toBe("failed");
    await tick(page.request);
    const mails = sql<{ n: number; subject: string }>("SELECT COUNT(*) AS n, MAX(subject) AS subject FROM emails_sent WHERE kind = 'posting_problem'")[0];
    expect(mails.n).toBe(1);
    expect(mails.subject).toBe("Posting problem: a TikTok post did not go out");
    expect(sql("SELECT light, fix_guide FROM health WHERE name = 'TikTok (via Buffer)'")[0]).toEqual({ light: "red", fix_guide: "a-post-failed" });
  });

  test("a channel that disconnects sends one Connection needs you email, and its posts wait", async ({ page }) => {
    const igBefore = sql<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE platform = 'instagram' AND status IN ('in_buffer','posted')")[0].n;
    expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-ig-missing" } })).ok()).toBe(true);
    await tick(page.request);
    await tick(page.request);
    const mails = sql<{ ref_id: string }>("SELECT ref_id FROM emails_sent WHERE kind = 'connection_needs_you'");
    expect(mails.map((m) => m.ref_id)).toEqual(["Instagram (via Buffer)"]);
    expect(sql("SELECT light, fix_guide FROM health WHERE name = 'Instagram (via Buffer)'")[0]).toEqual({ light: "red", fix_guide: "reconnect-an-account" });
    // nothing new went to Instagram while it was disconnected; its posts wait as planned
    expect(sql<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE platform = 'instagram' AND status IN ('in_buffer','posted')")[0].n).toBe(igBefore);
    expect(sql<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE platform = 'instagram' AND status = 'planned'")[0].n).toBeGreaterThan(0);
    expect(sql<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent WHERE kind = 'connection_needs_you'")[0].n).toBe(1);
    // back to a healthy Buffer for the screens; the next hourly run restores every light
    expect((await page.request.post("/api/connections/buffer/key", { data: { key: "good-key-e2e-000" } })).ok()).toBe(true);
    await tick(page.request);
    expect(sql("SELECT light FROM health WHERE name = 'Instagram (via Buffer)'")[0]).toEqual({ light: "green" });
    expect(sql("SELECT light, fix_guide FROM health WHERE name = 'TikTok (via Buffer)'")[0]).toEqual({ light: "red", fix_guide: "a-post-failed" });
  });

  test("the Calendar screen: failed post with a fix link, caps line, move with the picker, fill, month view", async ({ page, isMobile }) => {
    await page.goto("/calendar");
    await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "How to fix" }).first()).toHaveAttribute("href", "/help/a-post-failed");

    await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page.locator(".cal-caps")).toContainText(/TikTok \d+ \/ 10/);
    await expect(page.locator(".cal-caps")).toContainText(/Instagram \d+ \/ 7/);
    const card = page.locator(".cal-post.planned").first();
    await expect(card).toBeVisible();
    // Readable at every width: the hook never wraps one letter per line (live test 26 Sep 2026:
    // at 1280 px beside the pool the text column was ~10 px wide). At most 3 lines tall.
    const hook = card.locator(".cal-hook");
    const box = (await hook.boundingBox())!;
    expect(box.width, "hook text column width").toBeGreaterThanOrEqual(60);
    const lineHeight = await hook.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3);
    expect(box.height / lineHeight, "hook lines").toBeLessThanOrEqual(3.2);
    const fromDay = (await card.locator("xpath=ancestor::section[1]").getAttribute("data-day"))!;
    // a neighbouring day in the same week (Mon..Sat → next day, Sun → Sat): never over the cap
    const d = new Date(`${fromDay}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 0 ? -1 : 1));
    const target = d.toISOString().slice(0, 10);
    await card.locator(".cal-post-main").click();
    await page.getByLabel("Move to…").selectOption(target);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.locator(".toast").first()).toContainText("Moved to");
    await expect(page.locator(`section.cal-day[data-day="${target}"] .cal-post`).first()).toBeVisible();

    if (!isMobile) {
      // Desktop: drag a planned post onto another day of the same week.
      await page.goto("/calendar");
      await page.getByRole("button", { name: "Next week" }).click();
      await page.getByRole("button", { name: "Next week" }).click();
      const drag = page.locator(".cal-post.planned").first();
      const id = await drag.getAttribute("data-post");
      const src = await drag.locator("xpath=ancestor::section[1]").getAttribute("data-day");
      const dest = page.locator(`section.cal-day:not([data-day="${src}"])`).last();
      const destDay = await dest.getAttribute("data-day");
      // HTML5 drag and drop: press on the card, pass over the day twice so dragover fires, release.
      await drag.hover();
      await page.mouse.down();
      await dest.hover({ position: { x: 20, y: 20 } });
      await dest.hover({ position: { x: 30, y: 40 } });
      await page.mouse.up();
      await expect(page.locator(".toast").first()).toContainText("Moved to");
      await expect(page.locator(`section.cal-day[data-day="${destDay}"] [data-post="${id}"]`)).toBeVisible();
    }

    await expect(page.locator("[data-primary]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Fill the calendar" })).toHaveAttribute("data-primary", "true");
    // a platform is shown by a dot and its name, never a side stripe
    await expect(page.locator(".cal-caps .cal-dot")).toHaveCount(3);
    await page.getByRole("button", { name: "Fill the calendar" }).click();
    await expect(page.locator(".toast").last()).toContainText(/Added \d+ posts? to the calendar|already full/);

    await page.getByRole("button", { name: "Month" }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.locator(".cal-mini").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Help for this screen" })).toHaveAttribute("href", "/help/move-or-remove-a-post");
    // no sideways scroll on a phone
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("Settings health: every light listed, red ones link their fix, Check everything now rewrites them", async ({ page }) => {
    await page.goto("/settings");
    const row = page.locator('[data-health="TikTok (via Buffer)"]');
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: "How to fix" })).toHaveAttribute("href", "/help/a-post-failed");
    for (const name of ["Buffer", "Instagram (via Buffer)", "YouTube (via Buffer)", "Clip cutting", "Email (Resend)", "Job runner (GitHub)"]) await expect(page.locator(`[data-health="${name}"]`)).toBeVisible();
    await expect(page.locator('[data-health="buffer"]')).toHaveCount(0); // the bare Connect row is folded into Buffer
    await page.getByRole("button", { name: "Check everything now" }).click();
    await expect(page.locator(".toast").first()).toContainText("Checked everything.");
    await expect(page.locator('[data-health="Instagram (via Buffer)"] .dot')).toHaveAttribute("data-light", "green");
    await expect(page.locator('[data-health="Instagram (via Buffer)"] .dot')).toHaveAttribute("aria-label", "Working");
    // a recheck never hides a post that did not go out
    await expect(page.locator('[data-health="TikTok (via Buffer)"] .dot')).toHaveAttribute("data-light", "red");
    await expect(page.locator('[data-health="TikTok (via Buffer)"] .dot')).toHaveAttribute("aria-label", "Not working");
  });
});
