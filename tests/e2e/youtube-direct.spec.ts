// Connect YouTube (full videos), phone and desktop, fake services. She taps one button on Connect
// (the fake sign-in answers at once, as Google's Continue would); an approved full video on the
// Calendar then uploads through the hourly lane and the ytupload job to the stand-in YouTube,
// which answers YouTube's real bodies (shared/youtube-errors.json) for the scenario set in the
// settings row `fake_youtube`. Review says where it stands; Home names every failure: the
// unverified-thumbnail note with its link, the revoked sign-in (red, Reconnect YouTube, Upload it
// yourself), quota (tomorrow). Everything this spec adds is removed afterwards.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql as d1 } from "./helpers";
import { TOUR_OFF } from "./demo";

test.describe.configure({ mode: "serial" });

const tag = () => `e2eyd${test.info().project.name === "phone" ? "p" : "d"}`;

function cleanup() {
  d1(
    "DELETE FROM youtube_uploads; DELETE FROM connections WHERE service = 'youtube'; DELETE FROM settings WHERE key = 'fake_youtube';" +
      "DELETE FROM health WHERE name = 'YouTube (full videos)';" +
      "DELETE FROM posts WHERE clip_id LIKE 'clp_e2eyd%'; DELETE FROM clips WHERE id LIKE 'clp_e2eyd%'; DELETE FROM assets WHERE id LIKE 'ast_e2eyd%'; DELETE FROM dumps WHERE id LIKE 'dmp_e2eyd%';" +
      "DELETE FROM jobs WHERE type = 'ytupload';",
  );
}
test.beforeAll(cleanup);
test.afterAll(cleanup);

/** An approved full video (landscape, 10 minutes) on the Calendar two hours from now. */
function seed(t: string, privacy: "public" | "private") {
  const dump = `dmp_${t}`;
  const clip = `clp_${t}${privacy.slice(0, 2)}aafv`;
  const d = { title: `TEST ${t} ${privacy}`, description: "Synthetic test video.", chapters: [], tags: ["test"], thumbnails: [{ key: `full/${dump}/${clip}-t1.jpg`, t: 60 }], thumb_pick: 0, privacy, width: 1920, height: 1080, duration_s: 600, size_bytes: 1000, studio_done_at: null, handoff: true };
  const at = new Date(Date.now() + 2 * 3600_000).toISOString();
  d1(
    `INSERT OR IGNORE INTO dumps (id, door, status, kind) VALUES ('${dump}', 'new', 'ready', 'full_video');` +
      `INSERT OR IGNORE INTO assets (id, dump_id, file_name, mime_type, size_bytes, r2_key, upload_status) VALUES ('ast_${t}', '${dump}', 'test.mp4', 'video/mp4', 1000, 'raw/${dump}/a', 'uploaded');` +
      `INSERT INTO clips (id, asset_id, dump_id, start_s, end_s, recipe, hook_text, caption, r2_key, status, full_video, platforms, youtube) VALUES ('${clip}', 'ast_${t}', '${dump}', 0, 600, 'story', 'TEST', '', 'full/${dump}/${clip}.mp4', 'approved', 1, '["youtube"]', '${JSON.stringify(d)}');` +
      `INSERT INTO posts (id, clip_id, platform, scheduled_at, status) VALUES ('pst_${clip}', '${clip}', 'youtube', '${at}', 'planned');`,
  );
  return { dump, clip };
}

const scenario = (s: string) => d1(`INSERT INTO settings (key, value, updated_at) VALUES ('fake_youtube', '{"scenario":"${s}","videos":{},"calls":[]}', '2026-09-26T00:00:00Z') ON CONFLICT(key) DO UPDATE SET value = json_set(settings.value, '$.scenario', '${s}')`);

async function hourlyThenJob(request: APIRequestContext, v: { dump: string; clip: string }) {
  // Earlier tests' uploads count toward today's 3 (the cap is unit-tested): move them to another day.
  d1("UPDATE youtube_uploads SET started_at = '2000-01-01T00:00:00.000Z' WHERE status != 'uploading'");
  expect((await request.get("/cdn-cgi/handler/scheduled?cron=0+*+*+*+*")).ok()).toBe(true);
  const [row] = d1<{ job_id: string | null; status: string }>(`SELECT job_id, status FROM youtube_uploads WHERE clip_id = '${v.clip}'`);
  expect(row?.status).toBe("uploading");
  expect((await request.post(`/api/jobs/${row.job_id}/run-fake`, { data: {} })).ok()).toBe(true);
}

/** Home shows one notice at a time ("1 of N"): hide the ones before this video's, then return it. */
async function homeNotice(page: Page, key: string) {
  await page.goto("/");
  const note = page.locator(`[data-notice-key="${key}"]`);
  const shown = page.locator("[data-notice-key]").first();
  await shown.waitFor();
  for (let i = 0; i < 8 && !(await note.isVisible()); i++) {
    const current = await shown.getAttribute("data-notice-key");
    await page.getByRole("button", { name: "Hide this notice" }).click();
    await expect(page.locator(`[data-notice-key="${current}"]`)).toHaveCount(0);
    await shown.waitFor();
  }
  return note;
}

async function connectYouTube(page: Page) {
  await page.goto("/settings/connections");
  const card = page.locator("[data-youtube-direct]");
  await expect(card.getByText("Google then shows “Google hasn't verified this app”")).toBeVisible();
  await card.getByRole("link", { name: "Connect YouTube (full videos)" }).click();
  await expect(page.getByText("YouTube connected. Your full videos now upload straight to your channel")).toBeVisible();
  await expect(card.getByText(/Connected · Practice channel/)).toBeVisible();
}

test("one tap on Connect, then a full video uploads itself: private until its time, no Studio step", async ({ page }) => {
  await page.addInitScript(TOUR_OFF);
  scenario("ok");
  await connectYouTube(page);
  const v = seed(`${tag()}a`, "public");
  await hourlyThenJob(page.request, v);
  const [u] = d1<{ status: string; privacy: string; publish_at: string | null; thumbnail: string }>(`SELECT status, privacy, publish_at, thumbnail FROM youtube_uploads WHERE clip_id = '${v.clip}'`);
  expect(u).toMatchObject({ status: "scheduled", privacy: "private", thumbnail: "set" });
  expect(u.publish_at).toBeTruthy();
  await page.goto("/review?tab=approved");
  const item = page.locator(`[data-clip-id="${v.clip}"]`);
  await expect(item.locator('[data-direct="scheduled"]')).toContainText("On your channel as private; it goes public");
  await expect(item.locator("[data-handoff]")).toHaveCount(0);
  await expect(item.getByText("The one you pick goes up to YouTube with the video.")).toBeVisible();
  await page.goto("/");
  await expect(page.locator(`[data-notice-key="yt:upload_yourself:${v.clip}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-notice-key="yt:finish_in_studio:${v.clip}"]`)).toHaveCount(0);
  // taken off the Calendar before it went public: private, kept
  expect((await page.request.post(`/api/posts/pst_${v.clip}/unschedule`)).ok()).toBe(true);
  expect(d1<{ status: string }>(`SELECT status FROM youtube_uploads WHERE clip_id = '${v.clip}'`)[0].status).toBe("removed");
});

test("thumbnail refused (channel not verified): uploaded anyway, Home says how to verify", async ({ page }) => {
  await page.addInitScript(TOUR_OFF);
  scenario("thumb_unverified");
  const v = seed(`${tag()}b`, "private");
  await hourlyThenJob(page.request, v);
  const note = await homeNotice(page, `yt:youtube_note:${v.clip}`);
  await expect(note).toContainText("Verify your channel's phone number in YouTube to use custom thumbnails");
  await expect(note.getByRole("link", { name: "Verify my channel" })).toHaveAttribute("href", "https://www.youtube.com/verify");
});

test("quota exceeded: it waits for tomorrow, in plain words", async ({ page }) => {
  await page.addInitScript(TOUR_OFF);
  scenario("quota");
  const v = seed(`${tag()}c`, "public");
  await hourlyThenJob(page.request, v);
  expect(d1<{ status: string; reason: string }>(`SELECT status, reason FROM youtube_uploads WHERE clip_id = '${v.clip}'`)[0]).toMatchObject({ status: "queued", reason: "quota" });
  await page.goto(`/review?tab=approved`);
  await expect(page.locator(`[data-clip-id="${v.clip}"] [data-direct="queued"]`)).toContainText("upload allowance for today is used up");
});

test("sign-in revoked: red light, Reconnect YouTube, and the video falls back to Upload it yourself", async ({ page }) => {
  await page.addInitScript(TOUR_OFF);
  scenario("revoked");
  const v = seed(`${tag()}d`, "public");
  await hourlyThenJob(page.request, v);
  await page.goto("/settings/connections");
  const card = page.locator("[data-youtube-direct]");
  await expect(card.getByRole("link", { name: "Reconnect YouTube" })).toBeVisible();
  await expect(card.getByText("YouTube needs you to reconnect")).toBeVisible();
  await expect(await homeNotice(page, `yt:upload_yourself:${v.clip}`)).toContainText("Tap Reconnect YouTube");
  await page.goto("/review?tab=approved");
  await expect(page.locator(`[data-clip-id="${v.clip}"] [data-handoff]`)).toBeVisible();
  // reconnect: one tap again, and it goes up
  scenario("ok");
  await page.goto("/settings/connections");
  await card.getByRole("link", { name: "Reconnect YouTube" }).click();
  await expect(page.getByText("YouTube connected.")).toBeVisible();
  await hourlyThenJob(page.request, v);
  expect(d1<{ status: string }>(`SELECT status FROM youtube_uploads WHERE clip_id = '${v.clip}'`)[0].status).toBe("scheduled");
  d1("DELETE FROM connections WHERE service = 'youtube'; DELETE FROM youtube_uploads;");
});
