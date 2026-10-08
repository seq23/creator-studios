// /privacy and /terms: public, no login in either auth mode, plain HTML Google's reviewers can read,
// saying what the dashboard does on her channel and how to take the permission back. The validator
// legal-pages is proven negatively here too (each broken input names its problem).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { GOOGLE_PERMISSIONS_URL } from "@worker/routes/legal";
import { sqliteD1 } from "./helpers/sqlite-d1";
// @ts-expect-error plain .mjs validator, no types
import legalPages, { checkLegal, routesToWorker } from "../../scripts/validators/legal-pages.mjs";
// @ts-expect-error plain .mjs validator, no types
import { parseJsonc } from "../../scripts/validators/studio-isolation.mjs";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const ASSETS = { fetch: async () => new Response("<!doctype html><div id=root></div>", { headers: { "content-type": "text/html" } }) };
const envFor = (AUTH_MODE: string): Env => ({ AUTH_MODE, FAKE_SERVICES: "1", ASSETS, DB: sqliteD1().DB, APP_NAME: "Sample 1 Studio", OWNER_NAME: "", OWNER_EMAIL: "o@example.com", PUBLIC_BASE_URL: "https://w.example" }) as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("public legal pages", () => {
  // "open" in the env changes nothing: every studio logs in, and these pages never need one.
  for (const mode of ["code", "open"]) {
    for (const p of ["/privacy", "/terms"]) {
      it(`${p} answers 200 HTML with no cookie in ${mode} mode (never the app's login page)`, async () => {
        const res = await worker.fetch(new Request(`https://w.example${p}`), envFor(mode), ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/html/);
        const html = await res.text();
        expect(html).not.toContain('id=root');
        // The contact is the studio's own owner, never the host.
        expect(html).toContain("mailto:o@example.com");
        expect(html).toContain("Sample 1 Studio");
        expect(html).toContain('href="/privacy"');
        expect(html).toContain('href="/terms"');
      });
    }
  }

  it("privacy says what it does on YouTube, that tokens are encrypted, how to revoke, and Limited Use", async () => {
    const html = await (await worker.fetch(new Request("https://w.example/privacy"), envFor("code"), ctx)).text();
    for (const s of ["Upload", "encrypted", GOOGLE_PERMISSIONS_URL, "Limited Use requirements", "never deletes a video", "Disconnect", "short-lived access token"]) expect(html).toContain(s);
  });

  it("terms link the privacy policy and YouTube's terms", async () => {
    const html = await (await worker.fetch(new Request("https://w.example/terms"), envFor("code"), ctx)).text();
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("youtube.com/t/terms");
  });

  it("every studio (and local dev) sends /privacy and /terms to the Worker first", () => {
    const cfg = read("wrangler.jsonc");
    const studios = (cfg.match(/"STUDIO_SLUG"/g) ?? []).length;
    expect(studios).toBeGreaterThanOrEqual(5);
    const parsed = parseJsonc(cfg);
    const all = [parsed.assets, ...Object.values(parsed.env as Record<string, { assets: { run_worker_first: unknown } }>).map((e) => e.assets)];
    expect(all).toHaveLength(studios);
    for (const a of all) for (const p of ["/privacy", "/terms", "/healthz", "/api/me", "/media/x", "/kit/x", "/studio-theme.css", "/", "/dump"]) expect(routesToWorker(a.run_worker_first, p), p).toBe(true);
    // The hashed build files stay static; a negative pattern really excludes.
    for (const a of all) expect(routesToWorker(a.run_worker_first, "/assets/index-abc.js")).toBe(false);
    expect(routesToWorker(["/api/*"], "/privacy")).toBe(false);
    expect(routesToWorker(["/*", "!/privacy"], "/privacy")).toBe(false);
  });
});

describe("validator legal-pages", () => {
  const good = () => ({ legal: read("worker/routes/legal.ts"), index: read("worker/index.ts"), wrangler: read("wrangler.jsonc"), shell: read("app/components/Shell.tsx"), login: read("app/pages/Login.tsx") });

  it("passes on the repo and checks every item", async () => {
    const r = await legalPages({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(15);
  });

  it("fails when a route, a mount, a worker-first path, a sentence or a footer link is lost", () => {
    const cases: [string, (g: ReturnType<typeof good>) => void, RegExp][] = [
      ["route", (g) => (g.legal = g.legal.replace('legal.get("/terms"', 'legal.get("/tos"')), /does not serve GET \/terms/],
      ["mount", (g) => (g.index = g.index.replace('app.route("/", legal);', "")), /does not mount/],
      ["studio worker-first", (g) => (g.wrangler = g.wrangler.replace(/("sample1": \{[\s\S]*?"run_worker_first": \[)/, '$1"!/privacy", ')), /env\.sample1: run_worker_first is missing "\/privacy"/],
      ["local worker-first", (g) => (g.wrangler = g.wrangler.replace(/"run_worker_first": \[\s*"\/\*",/, '"run_worker_first": [')), /local dev: run_worker_first is missing "\/privacy"/],
      ["revoke", (g) => (g.legal = g.legal.replaceAll("https://myaccount.google.com/permissions", "https://example.com")), /revoke link/],
      ["sidebar", (g) => (g.shell = g.shell.replace("<LegalLinks />", "")), /1 time\(s\)/],
      ["login", (g) => (g.login = g.login.replace("<LegalLinks />", "")), /Login\.tsx does not show/],
    ];
    for (const [name, breakIt, want] of cases) {
      const g = good();
      breakIt(g);
      const r = checkLegal(g);
      expect(r.problems.join("\n"), name).toMatch(want);
    }
  });
});
