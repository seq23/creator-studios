// Media kit + brand deals, as Sam uses them, on phone and desktop with fake services and demo
// data (tests/e2e/seed-demo.sql). Each test re-seeds, so the phone and desktop runs each start
// from the same state. Screenshots of each state go to test-results/mediakit-deals/ (the WebPs in
// docs/design/mediakit-deals/ are made from them).
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { clearDemo, seedDemo, seedLabel, TOUR_OFF } from "./demo";
import { sql } from "./helpers";
import { qrSvg } from "../../worker/domain/qr";
import { SCENARIO_KEYS } from "../../worker/domain/emails";

test.describe.configure({ mode: "serial" });
const SHOTS = "test-results/mediakit-deals";
mkdirSync(SHOTS, { recursive: true });

test.beforeEach(async ({ page }) => {
  seedDemo();
  await page.addInitScript(TOUR_OFF);
});
test.afterAll(() => clearDemo());

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

async function anon(browser: Browser, page: Page) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined });
  return { ctx, pub: await ctx.newPage() };
}

test.describe("media kit", () => {
  test("from empty to published: one-tap fixes, autosave, preview, publish, versions, views, old links", async ({ page, browser }) => {
    test.setTimeout(120_000);
    sql("DELETE FROM media_kit_versions; DELETE FROM kit_views; UPDATE media_kit SET draft = NULL, bio = '', featured_clip_ids = '[]', past_partners = '[]', contact_email = NULL WHERE id = 1");
    const { ctx, pub } = await anon(browser, page);
    await pub.goto("/kit/studio");
    await expect(pub.getByRole("heading", { name: "No media kit here" })).toBeVisible();

    await page.goto("/deals?tab=kit");
    const check = page.locator(".kit-check");
    await expect(check).toContainText("Your kit is not published yet");
    await expect(check).toContainText("No packages");
    await shot(page, "kit-01-empty");

    // one-tap fixes
    await check.getByRole("button", { name: "Add starter packages" }).click();
    await expect(page.locator(".rc-pkg")).toHaveCount(4);
    await check.getByRole("button", { name: "Pick my best clips" }).click();
    await expect(page.locator(".kit-pick-item.on")).toHaveCount(4);
    await check.getByRole("button", { name: /^Use / }).click();
    await check.getByRole("button", { name: "Suggest prices" }).first().click();
    const firstStart = page.locator(".rc-pkg").first().getByLabel("Starting at ($, on your kit)");
    await expect(firstStart).toHaveValue("800"); // Later 2026, 10K–100K TikTok: low end $800
    await expect(page.locator(".rc-help").first()).toContainText("Later's 2026 range");

    // typed inputs autosave
    await page.getByLabel("One line under your name").fill("Small habits that make every day feel easier.");
    await page.getByLabel("TikTok handle").fill("samplecreator");
    await expect(page.locator(".kit-bar")).toContainText(/Draft saved/, { timeout: 10_000 });
    await shot(page, "kit-02-filled");

    // preview is exactly what brands see, and still not public
    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Preview: what brands see" });
    await expect(preview).toContainText("Small habits that make every day feel easier.");
    await expect(preview).toContainText("Preview: not published.");
    await pub.reload();
    await expect(pub.getByRole("heading", { name: "No media kit here" })).toBeVisible();
    await preview.getByRole("button", { name: "Publish" }).click();
    await expect(page.locator(".toast", { hasText: "Published version 1" })).toBeVisible();

    await pub.goto("/kit/studio");
    await expect(pub.getByRole("heading", { name: "Sample Creator", level: 1 })).toBeVisible();
    await expect(pub.getByText("TikTok @samplecreator")).toBeVisible();
    await expect(pub.locator(".ks-figure").first()).toContainText(`As of ${seedLabel("2026-09-24T12:00:00.000Z")} · TikTok`);
    await expect(pub.getByText("Starting at $800")).toBeVisible();
    await shot(pub, "kit-03-public");

    // an edit is a draft until she publishes again
    await page.getByLabel("About you (a few sentences)").fill("A second version of my story.");
    await expect(page.locator(".kit-bar")).toContainText("Changes not public yet", { timeout: 10_000 });
    await pub.reload();
    await expect(pub.getByText("A second version of my story.")).toHaveCount(0);
    await page.getByRole("button", { name: "Publish changes" }).first().click();
    await expect(page.locator(".toast", { hasText: "Published version 2" })).toBeVisible();
    await pub.reload();
    await expect(pub.getByText("A second version of my story.")).toBeVisible();
    await expect(page.locator(".kit-versions li")).toHaveCount(2);

    // views: the public loads counted, her own preview not
    await page.reload();
    await expect(page.locator(".kit-bar")).toContainText(/Viewed 3 times, last on/);

    // the settled screen does not re-fetch itself: a re-fetch resets the fields she is typing in
    // (a render loop once did, and the Link name edit below was lost before blur)
    let refetches = 0;
    page.on("request", (r) => {
      if (r.method() === "GET" && r.url().endsWith("/api/mediakit")) refetches++;
    });

    // renaming the link keeps sent links working
    await page.getByLabel("Link name").fill("samplecreator");
    await expect(page.getByLabel("Link name")).toHaveValue("samplecreator");
    expect(refetches, "the kit screen re-fetched itself while she typed").toBe(0);
    const [renamed] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/mediakit") && r.request().method() === "PATCH" && (r.request().postData() ?? "").includes('"slug"')), page.getByLabel("Link name").blur()]);
    expect(renamed.status()).toBe(200);
    expect(((await renamed.json()) as { view: { slug: string } }).view.slug).toBe("samplecreator");
    await expect(page.getByLabel("Link name")).toHaveValue("samplecreator");
    expect(refetches).toBe(0);
    await pub.goto("/kit/studio");
    await expect(pub).toHaveURL(/\/kit\/samplecreator$/);
    await expect(pub.getByRole("heading", { name: "Sample Creator", level: 1 })).toBeVisible();
    await page.request.patch("/api/mediakit", { data: { slug: "studio" } });
    await ctx.close();
  });

  test("the public kit: phone-first, private rates never sent, a QR of its own link, two printed pages", async ({ page, browser }) => {
    const { ctx, pub } = await anon(browser, page);
    const res = await pub.request.get("/api/public/kit/studio");
    const body = await res.text();
    expect(res.status()).toBe(200);
    expect(body).not.toMatch(/"floor"|"target"/); // private floor/target never leave the Worker
    expect(body).not.toContain("1,800");
    const kit = JSON.parse(body) as { url: string; qrSvg: string; figures: { asOf: string; source: string }[]; manual: { selfReported: boolean }[] };
    for (const f of kit.figures) {
      expect(f.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(f.source.length).toBeGreaterThan(5);
    }
    expect(kit.manual.every((m) => m.selfReported)).toBe(true);
    expect(kit.qrSvg).toBe(qrSvg(kit.url, { dark: "#211713", light: "#fffaf1", title: `QR code: ${kit.url}` }));

    await pub.goto("/kit/studio");
    await expect(pub.getByRole("heading", { name: "Sample Creator", level: 1 })).toBeVisible();
    await expect(pub.getByText("Self-reported, as of Sep 20, 2026")).toBeVisible();
    const work = pub.getByRole("link", { name: "Work with me" });
    await expect(work).toHaveAttribute("href", /^mailto:partnerships@demo-creator\.example/);
    await expect(work).toBeInViewport();
    await expect(pub.locator("[data-primary]")).toHaveCount(1);
    await expect(pub.locator(".ks-qr svg")).toBeVisible();
    expect(await pub.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    // tap a clip to play it (covers load first, not three heavy players)
    await pub.getByRole("button", { name: /^Play: / }).first().click();
    await expect(pub.locator(".ks-clip video")).toHaveCount(1);
    // the page's share preview names her
    const html = await (await pub.request.get("/kit/studio")).text();
    expect(html).toContain("<title>Sample Creator · media kit</title>");
    expect(html).toMatch(/og:description" content="Everyday routines that make busy days feel easy\./);
    await shot(pub, "kit-04-public-phone-or-desktop");

    await pub.goto("/kit/studio/print");
    await expect(pub.getByRole("button", { name: "Save as PDF" })).toBeVisible();
    await expect(pub.locator(".ks-print h1")).toHaveText("Sample Creator");
    await pub.emulateMedia({ media: "print" });
    const pdf = await pub.pdf({ format: "Letter", printBackground: true });
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBe(2);
    // the old printable address forwards to the new one
    const old = await pub.request.get("/api/public/kit/studio/print", { maxRedirects: 0 });
    expect(old.status()).toBe(302);
    expect(old.headers()["location"]).toBe("/kit/studio/print");
    await ctx.close();
  });
});

test.describe("brand deals", () => {
  test("brands to pitch: ranked by money with sources, unproven below the line, off-limits and unsourced never shown", async ({ page }) => {
    await page.goto("/deals");
    const money = page.getByRole("region", { name: "Money" });
    await expect(money).toContainText("Pitched this month");
    await expect(money).toContainText("Paid");
    const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/deals/finder/run")), page.getByRole("button", { name: "Find brands now" }).click()]);
    const { jobId } = (await res.json()) as { jobId: string };
    expect((await page.request.post(`/api/jobs/${jobId}/run-fake`, { data: {} })).ok()).toBe(true);
    await page.reload();
    const list = page.getByRole("region", { name: "Brands to pitch this week" });
    const maison = list.getByRole("article", { name: "Maison Lumière Studio" });
    await expect(maison).toContainText("Pays creators");
    await expect(maison).toContainText("(maisonlumiere.example)");
    await maison.getByText("How it ranked").click();
    await expect(maison).toContainText("Pays creators 1.00 × fit 0.92 × partnerships email 1.00 = 0.92");
    await expect(list.getByRole("article", { name: "Brightline Creator Agency" })).toContainText("Agency");
    await expect(list.getByRole("article", { name: "Hearth & Honey Bakery" })).toHaveCount(0);
    await list.getByRole("button", { name: /Show \d+ brands? with no sign yet that they pay/ }).click();
    await expect(list.getByRole("article", { name: "Hearth & Honey Bakery" })).toBeVisible();
    await expect(page.getByText("Midnight Spirits")).toHaveCount(0);
    await expect(page.getByText("Nowhere Home Goods")).toHaveCount(0);
    await shot(page, "deals-01-overview");

    const tt = page.getByRole("region", { name: "Get listed here" }).locator("details", { hasText: "TikTok One" });
    await tt.locator("summary").click();
    await expect(tt).toContainText("You have 12,400 followers; it asks for 1,000+.");
    await tt.getByLabel("I'm on it").check();
    await expect(page.getByRole("region", { name: "Get listed here" }).locator("details").last()).toContainText("TikTok One");

    // one tap: the deal opens with its first pitch written, contact and kit link in Gmail
    await list.getByRole("article", { name: "Cedar & Salt Kitchen" }).getByRole("button", { name: "Pitch" }).click();
    await expect(page.getByRole("heading", { name: "Cedar & Salt Kitchen", level: 2 })).toBeVisible();
    const gmail = new URL((await page.getByRole("link", { name: "Open in Gmail" }).getAttribute("href"))!);
    expect(gmail.searchParams.get("to")).toBe("pr@cedarandsalt.example");
    expect(gmail.searchParams.get("body")).toContain("/kit/studio");
    expect(gmail.searchParams.get("body")).toContain("Three ways we could do it");
    await expect(page.getByRole("region", { name: "Before you send" }).or(page.locator(".before-send"))).toContainText("Your media kit link is in it");
  });

  test("a deal from cold pitch to paid: every step names its email, every scenario drafts", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/deals");
    await page.locator(".deal-card", { hasText: "Brightside Bottle Co." }).click();
    await expect(page.getByRole("heading", { name: "Brightside Bottle Co.", level: 2 })).toBeVisible();
    await expect(page.locator(".next-card")).toContainText("Send your pitch");
    const subject = page.getByLabel("Subject", { exact: true });
    const gmail = () => page.getByRole("link", { name: "Open in Gmail" }).getAttribute("href");
    const url = new URL((await gmail())!);
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("to")).toBe("partnerships@brightsidebottle.example");
    expect(url.searchParams.get("su")).toBe(await subject.inputValue());
    expect(await gmail()).not.toContain("+");
    await subject.fill("Morning routines × Brightside");
    await subject.blur();
    await expect.poll(async () => new URL((await gmail())!).searchParams.get("su")).toBe("Morning routines × Brightside");
    await shot(page, "deals-02-pitch");

    await page.getByRole("button", { name: "Mark sent" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark as sent" });
    await dialog.getByLabel("When did you send it?").fill(new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10));
    await dialog.getByRole("button", { name: "Yes, I sent it" }).click();
    await expect(page.locator(".next-card")).toContainText("Send follow-up 1");
    await expect(page.locator(".email-panel select")).toHaveValue("followup_1");

    // Home and the Monday recap carry the same due email
    await page.goto("/");
    const followups = page.locator("section", { has: page.getByRole("heading", { name: "Follow-ups" }) });
    await expect(followups).toContainText("Brightside Bottle Co.");
    // The row names the step (not a generic "Follow up") and opens that deal, not the Deals list.
    const row = followups.locator("a.list-row", { hasText: "Brightside Bottle Co." });
    await expect(row.locator(".title")).toContainText("follow-up 1", { ignoreCase: true });
    await expect(row.locator(".pill")).toContainText(/^(Due|Overdue) /);
    await expect(row).toHaveAttribute("href", /\/deals\?deal=/);
    const before = ((await (await page.request.get("/api/settings")).json()) as { features: Record<string, boolean> }).features;
    expect((await page.request.patch("/api/settings", { data: { features: { ...before, weekly_recap: true } } })).ok()).toBe(true);
    try {
      expect((await page.request.get("/cdn-cgi/handler/scheduled?cron=0+12+*+*+1")).ok()).toBe(true);
      await expect.poll(() => sql<{ n: number }>("SELECT COUNT(*) AS n FROM emails_sent WHERE kind = 'weekly_recap'")[0]?.n ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
    } finally {
      await page.request.patch("/api/settings", { data: { features: before } });
      sql("DELETE FROM emails_sent WHERE kind = 'weekly_recap'; DELETE FROM jobs WHERE type IN ('metrics','brand_finder') AND status = 'dispatched'");
    }

    await page.goto("/deals");
    await page.locator(".deal-card", { hasText: "Brightside Bottle Co." }).click();
    const dealId = new URL(page.url()).searchParams.get("deal")!;
    // a move the pipeline does not allow is refused, with a fix guide
    const bad = await page.request.post(`/api/deals/deals/${dealId}/stage`, { data: { stage: "paid" } });
    expect(bad.status()).toBe(409);
    expect(((await bad.json()) as { fix_guide?: string }).fix_guide).toBe("pitch-a-brand");
    const noReason = await page.request.post(`/api/deals/deals/${dealId}/stage`, { data: { stage: "lost" } });
    expect(noReason.status()).toBe(422);

    await page.getByRole("button", { name: "They replied" }).click();
    await expect(page.locator(".next-card")).toContainText("Send your rate proposal");
    await page.getByRole("button", { name: "We agreed a deal" }).click();
    await expect(page.locator(".next-card")).toContainText("Confirm the deal in writing");
    await page.getByLabel("Agreed fee ($)").fill("900");
    await page.getByLabel("Agreed fee ($)").blur();
    await page.getByLabel("Deliverables", { exact: true }).fill("2 TikTok videos + 1 Instagram Reel");
    await page.getByLabel("Deliverables", { exact: true }).blur();
    await expect(page.locator(".memo")).toContainText("$900");

    // every scenario writes a draft from this deal's facts, and each lands on the timeline
    for (const scenario of SCENARIO_KEYS) {
      const r = await page.request.post(`/api/deals/deals/${dealId}/emails`, { data: { scenario, tone: "straight", length: "brief" } });
      expect(r.status(), scenario).toBe(200);
      const { email } = (await r.json()) as { email: { body: string; subjects: string[]; checks: unknown[] } };
      expect(email.body.length, scenario).toBeGreaterThan(40);
      expect(email.subjects, scenario).toHaveLength(3);
    }
    const detail = (await (await page.request.get(`/api/deals/deals/${dealId}`)).json()) as { timeline: { what: string }[] };
    expect(detail.timeline.filter((t) => t.what.startsWith("Drafted:")).length).toBeGreaterThanOrEqual(SCENARIO_KEYS.length);

    await page.reload();
    await expect(page.locator(".email-panel select")).toHaveValue("deliverables_confirm");
    await page.locator(".email-panel").getByRole("radio", { name: "Warm" }).click();
    await page.locator(".email-panel").getByRole("radio", { name: "Detailed" }).click();
    await page.getByRole("button", { name: "Rewrite" }).click();
    await expect(page.locator("textarea.email-body")).toHaveValue(/Fee: \$900/);
    await expect(page.locator(".before-send li.miss")).toHaveCount(0);
    await shot(page, "deals-03-confirm");
    await page.getByRole("button", { name: "Mark sent" }).click();
    await page.getByRole("dialog", { name: "Mark as sent" }).getByRole("button", { name: "Yes, I sent it" }).click();
    await expect(page.locator(".next-card")).toContainText("Start making the content");

    // delivery: a deliverable starts it; the checklist runs it; the day-7 report is next
    await page.getByLabel("Due date", { exact: true }).fill(new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
    await page.getByLabel("Note", { exact: true }).fill("Morning routine video");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".next-card")).toContainText("Send your draft for approval");
    for (const step of ["Draft sent for approval", /Approved \(/, "Posted with #ad and the paid-partnership label"]) {
      const box = page.locator(".steps li", { hasText: step }).getByRole("checkbox");
      await box.check();
      await expect(box).toBeChecked();
    }
    await expect(page.locator(".next-card")).toContainText("Send their results");
    await shot(page, "deals-04-delivery");

    await page.getByRole("button", { name: "Make the invoice" }).click();
    await expect(page.locator(".delivery-card")).toContainText(/Open invoice SB-\d{4}-\d{4}/);
    const inv = await page.request.get(`/api/deals/deals/${dealId}/invoice`);
    expect(inv.status()).toBe(200);
    const invHtml = await inv.text();
    expect(invHtml).toContain("Brightside Bottle Co.");
    expect(invHtml).toContain("$900.00");
    expect(invHtml).toMatch(/Net-30/);
    await page.locator(".delivery-card").getByRole("button", { name: "Mark paid" }).click();
    await expect(page.locator(".next-card")).toContainText("Say thank you, then close it");
    const kit = (await (await page.request.get("/api/mediakit")).json()) as { draft: { collabs: { brand: string }[] } };
    expect(kit.draft.collabs.map((c) => c.brand)).toContain("Brightside Bottle Co.");

    await page.goto("/deals");
    const money = page.getByRole("region", { name: "Money" });
    await expect(money).toContainText("$900");
    await expect(money.locator(".money", { hasText: "Paid" })).toContainText("$900");
  });

  test("a brand wrote to me: paste their email, read the terms and red flags, send the suggested reply", async ({ page }) => {
    await page.goto("/deals");
    await page.getByRole("button", { name: "A brand wrote to me" }).click();
    const dialog = page.getByRole("dialog", { name: "A brand wrote to me" });
    await dialog.getByLabel("Brand name").fill("Bright Lane Goods");
    await dialog.getByLabel("Their website (optional)").fill("linenlark.example");
    await dialog
      .getByLabel("Paste what the brand sent")
      .fill("Hi Sam! We'd love 2 TikTok videos for our tumbler launch. Our budget is $600. We need usage rights in perpetuity across all media and exclusivity with no other home brands for 6 months. Payment is net-90 after posting.");
    await dialog.getByRole("button", { name: "Read it" }).click();
    await expect(page.getByRole("heading", { name: "Bright Lane Goods", level: 2 })).toBeVisible();
    const offer = page.locator(".offer-read");
    await expect(offer.locator(".from").first()).toHaveText("from their email");
    await expect(offer).toContainText("$600");
    await expect(offer).toContainText("They want to use your video forever or everywhere");
    await expect(offer).toContainText("They pay net-90");
    await expect(offer.locator(".verdict")).toContainText("Counter");
    await shot(page, "deals-05-inbound");
    await expect(page.locator(".email-panel select")).toHaveValue("inbound_reply");
    await page.locator(".email-panel select").selectOption("usage_clarify");
    await page.getByRole("button", { name: "Write it" }).click();
    await expect(page.locator("textarea.email-body")).toHaveValue(/I don't grant perpetual rights/);
    await expect(page.locator(".before-send li.miss")).toHaveCount(0);
  });
});
