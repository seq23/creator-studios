// A studio's old workers.dev address 301s every page to its own hostname (one address: one login
// cookie, one OAuth redirect URI), but never the API, so a job dispatched before the move still
// calls back. Proven through the real Worker entry point.
import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "@worker/lib/canonical-host";
import worker from "@worker/index";
import type { Env } from "@worker/env";

const BASE = "https://sample1-studio.spryexecutiveos.com";
const req = (url: string, method = "GET") => new Request(url, { method });

describe("canonicalRedirect", () => {
  it("301s a page on the old workers.dev address to the same path and query on the hostname", () => {
    const r = canonicalRedirect(req("https://sample1studio.seq-taylor.workers.dev/dump?x=1"), BASE);
    expect(r?.status).toBe(301);
    expect(r?.headers.get("location")).toBe(`${BASE}/dump?x=1`);
    expect(canonicalRedirect(req("https://sample1studio.seq-taylor.workers.dev/", "HEAD"), BASE)?.headers.get("location")).toBe(`${BASE}/`);
    expect(canonicalRedirect(req("https://sample1studio.seq-taylor.workers.dev/healthz"), BASE)?.status).toBe(301);
  });

  it("never redirects the API, a POST, the hostname itself, local dev, or a studio still on workers.dev", () => {
    expect(canonicalRedirect(req("https://sample1studio.seq-taylor.workers.dev/api/jobs/j1/spec"), BASE)).toBeNull();
    expect(canonicalRedirect(req("https://sample1studio.seq-taylor.workers.dev/dump", "POST"), BASE)).toBeNull();
    expect(canonicalRedirect(req(`${BASE}/dump`), BASE)).toBeNull();
    expect(canonicalRedirect(req("http://localhost:8787/dump"), "http://localhost:8787")).toBeNull();
    expect(canonicalRedirect(req("https://a.seq-taylor.workers.dev/"), "https://a.seq-taylor.workers.dev")).toBeNull();
    expect(canonicalRedirect(req("https://a.seq-taylor.workers.dev/"), "")).toBeNull();
  });

  it("the Worker answers the 301 before anything else (no storage touched)", async () => {
    const env = { PUBLIC_BASE_URL: BASE } as unknown as Env;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const r = await worker.fetch(req("https://sample1studio.seq-taylor.workers.dev/review"), env, ctx);
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`${BASE}/review`);
  });
});
