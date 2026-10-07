// The help screenshots job (section 12c): for every guide in help/index.json, put the demo app in
// the state each step describes, open that step's screen, circle the element the step is about
// and save help/screenshots/<slug>-<n>.png (desktop project) and <slug>-<n>-phone.png (phone
// project). Steps on another site or app are clearly labelled illustrations (tests/e2e/help-mocks.ts),
// never a screenshot of a real account. Demo data only (seed-demo.sql + seed-help-extra.sql).
//
// Every step gets its own picture of exactly that step. Nothing falls back: a step whose click or
// target is not on screen fails the run (26 Sep 2026: the old job circled the page heading when a
// step had no target, so 20 guides shared one identical picture of the Connect screen per step
// number). A picture identical to another step's fails too, unless the step says <!-- shared -->.
// The committed files are checked again by the validator help-pictures.
//
// Runs with the e2e suite (nightly on main + dispatch; the production gate) and on its own: `npm run help:screenshots`
// (job-help_screenshots.yml, on every release).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGuide, SCREEN_ROUTES, type ParsedGuide } from "../../app/lib/markdown";
import { clearDemo, clearHelpBaseline, putObject, restoreHelpLights, seedDemo, seedHelpBaseline, setLight, setVoice, TOUR_OFF } from "./demo";
import { sql } from "./helpers";
import { mockHtml } from "./help-mocks";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "help", "screenshots");
const AUTH = "test-results/.auth/owner.json";
const index = JSON.parse(readFileSync(path.join(ROOT, "help", "index.json"), "utf8")) as { guides: { slug: string; screen: string | null }[] };

// HELP_ONLY=slug,slug re-shoots just those guides while writing them (the full run is the default).
const only = process.env.HELP_ONLY?.split(",").filter(Boolean) ?? [];
const guides: { slug: string; parsed: ParsedGuide }[] = index.guides.filter((g) => !only.length || only.includes(g.slug)).map((g) => ({
  slug: g.slug,
  parsed: parseGuide(readFileSync(path.join(ROOT, "help", "guides", `${g.slug}.md`), "utf8")),
}));

// HELP_REPORT=file (while writing guides): log each step problem to that file and go on to the next
// step instead of stopping, so one run lists every problem. Never set in CI.
const REPORT = process.env.HELP_REPORT;
async function must(where: string, check: () => Promise<unknown>): Promise<boolean> {
  if (!REPORT) {
    await check();
    return true;
  }
  try {
    await check();
    return true;
  } catch (e) {
    appendFileSync(REPORT, `${where}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`);
    return false;
  }
}

const isLookPicture = (image: string) => /^\/looks\/[a-z_]+\.webp$/.test(image);
const HEADING = "main h1, .kit h1, .login-card h1";

test.describe.configure({ mode: "serial" });

/** Picture hash → the step that made it, per project (phone and desktop differ by nature). */
const seen = new Map<string, string>();

test.beforeAll(async ({ playwright, browser }, info) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  seedDemo();
  const ctx = await playwright.request.newContext({ baseURL: info.project.use.baseURL, storageState: AUTH });
  await setVoice(ctx, true); // every feature on: nothing hidden, nothing switched off
  await seedHelpBaseline(ctx);
  await ctx.dispose();
  await putCovers(browser, info.project.use.baseURL!);
});

test.afterAll(async ({ playwright }, info) => {
  const ctx = await playwright.request.newContext({ baseURL: info.project.use.baseURL, storageState: AUTH });
  await setVoice(ctx, true).catch(() => undefined);
  await clearHelpBaseline(ctx).catch(() => undefined);
  await ctx.dispose();
  clearDemo();
});

test("every guide has steps, a known screen, and every step is pictured", () => {
  expect(guides.length, "Rule 0: zero guides").toBeGreaterThan(0);
  for (const g of guides) {
    expect(g.parsed.steps.length, g.slug).toBeGreaterThan(0);
    expect(g.parsed.meta.screen && SCREEN_ROUTES[g.parsed.meta.screen], `${g.slug}: screen '${g.parsed.meta.screen}'`).toBeTruthy();
    g.parsed.steps.forEach((s, i) => {
      expect(s.image, `${g.slug} step ${i + 1}: no picture`).toBeTruthy();
      expect(s.route, `${g.slug} step ${i + 1}: 'route: external' is not pictured; use a mock`).not.toBe("external");
      if (!isLookPicture(s.image!)) expect(s.mock || s.target, `${g.slug} step ${i + 1}: needs a target or a mock`).toBeTruthy();
    });
  }
});

for (const g of guides) {
  test(`screenshots: ${g.slug}`, async ({ page, browser }, info) => {
    const phone = info.project.name === "phone";
    const loggedOut = g.parsed.meta.screen === "login";
    let p: Page = page;
    if (loggedOut) {
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined });
      p = await ctx.newPage();
    }
    await p.addInitScript(TOUR_OFF);
    let changedState = false;
    for (const [i, step] of g.parsed.steps.entries()) {
      const where = `${g.slug} step ${i + 1}`;
      if (!step.image || isLookPicture(step.image)) continue;
      const ok = await must(where, async () => {
        if (step.mock) {
          await p.setContent(mockHtml(step.mock));
        } else {
          for (const l of step.lights) {
            setLight(l.name, l.light, l.note);
            changedState = true;
          }
          for (const call of step.api) {
            await apiCall(page.request, call, where);
            changedState = true;
          }
          await p.goto(step.route ?? SCREEN_ROUTES[g.parsed.meta.screen ?? "home"] ?? "/");
          await p.locator(HEADING).first().waitFor({ timeout: 10_000 });
          await settled(p);
          for (const f of step.fills) await p.locator(f.selector).first().fill(f.text);
          for (const c of step.clicks) {
            const el = p.locator(c).first();
            await expect(el, `${where}: click '${c}' is not on screen`).toBeVisible({ timeout: 5000 });
            await el.click();
            await settled(p);
          }
        }
        const selector = step.target ?? "[data-hl]";
        const target = p.locator(selector).first();
        await expect(target, `${where}: target '${selector}' is not on screen`).toBeVisible({ timeout: 5000 });
        await target.scrollIntoViewIfNeeded();
        await drawCallout(p, target, i + 1);
      });
      if (!ok) {
        await p.keyboard.press("Escape").catch(() => undefined);
        continue;
      }
      const file = path.join(OUT, `${g.slug}-${i + 1}${phone ? "-phone" : ""}.png`);
      const png = await p.screenshot({ animations: "disabled" });
      writeFileSync(file, png);
      const hash = createHash("sha256").update(png).digest("hex");
      const before = seen.get(hash);
      if (!step.shared) await must(where, async () => expect(before, `${where}: the picture is identical to ${before}'s; picture this step's own screen or mark it <!-- shared -->`).toBeUndefined());
      seen.set(hash, where);
      await p.evaluate(() => document.getElementById("ss-callout")?.remove());
    }
    if (loggedOut) await p.context().close();
    if (changedState) await restoreHelpLights(page.request);
  });
}

/** `<!-- api: POST /api/connections/buffer/key {"key":"bad-…"} -->` */
async function apiCall(request: APIRequestContext, call: string, where: string) {
  const m = /^(GET|POST|PATCH|PUT|DELETE)\s+(\/\S+)\s*(.*)$/.exec(call);
  if (!m) throw new Error(`${where}: api directive '${call}' is not 'METHOD /path {json}'`);
  const r = await request.fetch(m[2], { method: m[1], data: m[3] ? JSON.parse(m[3]) : undefined });
  // A refused key is a state the step wants (the red light); anything else must succeed.
  if (!r.ok() && !m[2].endsWith("/key")) throw new Error(`${where}: ${call} answered ${r.status()}`);
}

/**
 * A cover for every demo clip, cut from its Look's own preview (public/looks), so Review and the
 * Calendar never show black frames. One picture per Look: seed-help-extra.sql points each clip at
 * covers/demo/<look>.png.
 */
async function putCovers(browser: import("@playwright/test").Browser, baseURL: string) {
  const looks = sql<{ look: string }>("SELECT DISTINCT COALESCE(look, 'clean') AS look FROM clips WHERE id LIKE 'demo_%'").map((r) => r.look);
  const ctx = await browser.newContext({ viewport: { width: 400, height: 600 } });
  const page = await ctx.newPage();
  const dir = path.join(os.tmpdir(), "help-covers");
  mkdirSync(dir, { recursive: true });
  for (const look of looks) {
    await page.setContent(`<body style="margin:0"><div id="c" style="width:288px;height:512px;overflow:hidden"><img id="i" src="${baseURL}/looks/${look}.webp" style="height:512px"></div></body>`);
    await page.waitForFunction(() => (document.getElementById("i") as HTMLImageElement).complete);
    const file = path.join(dir, `${look}.png`);
    await page.locator("#c").screenshot({ path: file });
    putObject(`covers/demo/${look}.png`, file, "image/png");
  }
  await ctx.close();
}

/** Loading placeholders gone, fonts in: the screen as she would see it. */
async function settled(p: Page) {
  await p.locator(".skeleton").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => undefined);
  await p.evaluate(() => document.fonts.ready.then(() => undefined));
  await p.waitForTimeout(150);
}

/**
 * Numbered circle + arrow + ring on the element, drawn in the page so it lands in the PNG. A tall
 * element (a whole section on a phone) is scrolled to the top of the screen and ringed where it
 * is visible, above the phone's tab bar, so the circle never lands on the menu.
 */
async function drawCallout(p: Page, target: import("@playwright/test").Locator, n: number) {
  await target.evaluate((el) => {
    const bar = Array.from(document.querySelectorAll<HTMLElement>(".tabbar")).find((e) => e.getClientRects().length > 0);
    const floor = (bar ? bar.getBoundingClientRect().top : window.innerHeight) - 12;
    const r = el.getBoundingClientRect();
    if (r.height > floor * 0.6) {
      el.scrollIntoView({ block: "start" });
      window.scrollBy(0, -72);
    } else if (r.bottom > floor) {
      window.scrollBy(0, r.bottom - floor + 60);
    }
  });
  const raw = await target.boundingBox();
  if (!raw) throw new Error(`step ${n}: the target has no box on screen`);
  const safeBottom = await p.evaluate(() => {
    const bar = Array.from(document.querySelectorAll<HTMLElement>(".tabbar")).find((e) => e.getClientRects().length > 0);
    return bar ? bar.getBoundingClientRect().top : window.innerHeight;
  });
  const top = Math.max(raw.y, 6);
  const bottom = Math.min(raw.y + raw.height, safeBottom - 6);
  const box = { x: raw.x, y: top, width: raw.width, height: Math.max(12, bottom - top) };
  await p.evaluate(
    ({ box, n, safeBottom }) => {
      const vw = window.innerWidth;
      const vh = safeBottom;
      const R = 22;
      const inX = (x: number) => x >= R + 8 && x <= vw - R - 8;
      const inY = (y: number) => y >= R + 8 && y <= vh - R - 8;
      let cx: number;
      let cy: number;
      if (inX(box.x - 46) && inY(box.y - 46)) [cx, cy] = [box.x - 46, box.y - 46];
      else if (inY(box.y - 46)) [cx, cy] = [Math.min(vw - R - 8, Math.max(R + 8, box.x + box.width - R - 12)), box.y - 46];
      else if (inY(box.y + box.height + 46)) [cx, cy] = [Math.min(vw - R - 8, Math.max(R + 8, box.x + box.width / 2)), box.y + box.height + 46];
      else [cx, cy] = [Math.min(vw - R - 8, box.x + box.width - R - 12), Math.max(R + 8, box.y + R + 12)];
      const tx = Math.max(box.x, Math.min(cx, box.x + box.width));
      const ty = Math.max(box.y, Math.min(cy, box.y + box.height));
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.id = "ss-callout";
      svg.setAttribute("width", String(vw));
      svg.setAttribute("height", String(vh));
      svg.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;pointer-events:none");
      // Colours are the app's tokens (app/styles/tokens.css), read from the page.
      svg.innerHTML = `
        <defs><marker id="ss-ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--rose)"/></marker></defs>
        <rect x="${box.x - 5}" y="${box.y - 5}" width="${box.width + 10}" height="${box.height + 10}" rx="12" style="fill:none;stroke:var(--gold);stroke-width:4"/>
        <line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" style="stroke:var(--rose);stroke-width:4" marker-end="url(#ss-ah)"/>
        <circle cx="${cx}" cy="${cy}" r="${R}" style="fill:var(--rose);stroke:var(--ivory);stroke-width:3"/>
        <text x="${cx}" y="${cy + 7}" text-anchor="middle" style="font-family:var(--font-body);font-size:20px;font-weight:700;fill:var(--ivory)">${n}</text>`;
      document.body.appendChild(svg);
    },
    { box, n, safeBottom },
  );
}

