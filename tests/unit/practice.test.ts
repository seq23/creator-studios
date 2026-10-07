// Guard (d), studio brief §3/§6: every feature without a key shows PRACTICE MODE, never an error.
// A real studio (FAKE_SERVICES "0") with an empty database and no vendor secrets is driven through
// the real Worker entry (worker/index.ts: hydrate → routes): every screen's API answers without a
// 5xx, nothing reaches a vendor (fetch throws if anything tries), Setup lists every service as
// practice, /api/me tells the app which ones to label, each vendor factory hands back its stand-in,
// and a key stored on Setup is read FIRST (before the Worker secret).
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { hydrate, practice, practiceList } from "@worker/lib/practice";
import { saveConnection } from "@worker/lib/connections";
import { getBuffer } from "@worker/services/buffer";
import { getLlm } from "@worker/services/openrouter";
import { getYouTubePublic } from "@worker/services/youtube";
import { getYouTubeDirect } from "@worker/services/youtubeDirect";
import { dispatchJob, drainPracticeJobs } from "@worker/services/github";
import { SETUP_IDS, type SetupView } from "@shared/setup";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";

const BASE = "https://sample1studio.example";
const KEY = "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=";
const ASSETS = { fetch: async () => new Response("<!doctype html><div id=root></div>", { headers: { "content-type": "text/html" } }) };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let env: Env;
let vendorCalls: string[];

beforeEach(() => {
  env = {
    DB: sqliteD1().DB,
    FILES: memoryR2().FILES,
    ASSETS,
    APP_NAME: "Sample 1 Studio",
    OWNER_NAME: "",
    OWNER_EMAIL: "client@client.example",
    STUDIO_SLUG: "sample1",
    FAKE_SERVICES: "0",
    PUBLIC_BASE_URL: BASE,
    GITHUB_REPO: "",
    AUDIENCE_TIMEZONE: "America/New_York",
    ENV_NAME: "production",
    AUTH_MODE: "code",
    SESSION_SECRET: "s",
    SECRETS_KEY: KEY,
    JOB_SHARED_SECRET: "j",
  } as unknown as Env;
  vendorCalls = [];
  vi.stubGlobal("fetch", async (u: string | URL | Request) => {
    vendorCalls.push(String(u instanceof Request ? u.url : u));
    throw new Error("no vendor may be called in practice mode");
  });
});
afterEach(() => vi.unstubAllGlobals());

const get = async (p: string) => worker.fetch(new Request(`${BASE}${p}`, { headers: { cookie: await ownerCookie(env) } }), env, ctx);

describe("an empty real studio runs entirely in practice mode", () => {
  it("every service is in practice, and /api/me says so for the banner", async () => {
    const h = await hydrate(env);
    expect([...(h.PRACTICE ?? [])].sort()).toEqual([...SETUP_IDS].sort());
    for (const id of SETUP_IDS) expect(practice(h, id)).toBe(true);
    const me = (await (await get("/api/me")).json()) as { practice: string[] };
    expect([...me.practice].sort()).toEqual([...SETUP_IDS].sort());
  });

  it("every screen's API answers without a server error, and no vendor is called", async () => {
    const screens = ["/api/me", "/api/home", "/api/dumps", "/api/clips", "/api/posts", "/api/brain", "/api/research", "/api/stats", "/api/voice", "/api/deals", "/api/mediakit", "/api/settings", "/api/connections", "/api/editing", "/api/setup", "/api/jobs", "/api/studio", "/studio-theme.css", "/privacy", "/terms", "/healthz"];
    for (const p of screens) {
      const res = await get(p);
      expect(res.status, `${p} answered ${res.status}`).toBeLessThan(500);
    }
    expect(vendorCalls).toEqual([]);
  });

  it("Setup lists every step as Practice mode, with the redirect addresses and the job secret for her own runner", async () => {
    const v = (await (await get("/api/setup")).json()) as SetupView;
    expect(v.steps.map((s: { id: string; state: string }) => [s.id, s.state])).toEqual(SETUP_IDS.map((id) => [id, "practice"]));
    expect(v.redirects.google).toBe(`${BASE}/api/oauth/google/callback`);
    expect(v.job_secret).toBe("j");
  });

  it("each vendor hands back its stand-in: posting waits safely, AI writes starter text, YouTube numbers wait labelled, uploads are simulated", async () => {
    const h = await hydrate(env);
    const buffer = await getBuffer(h);
    expect(buffer.constructor.name).toBe("FakeBuffer");
    expect((await getLlm(h)).constructor.name).toBe("FakeLlm");
    expect(getYouTubePublic(h)).toBeNull(); // no invented numbers stored as hers: Stats names the wait
    const { refreshYouTubePublic } = await import("@worker/lib/publicStats");
    expect((await refreshYouTubePublic(h)).state).toBe("no_key");
    const light = await h.DB.prepare("SELECT light, note FROM health WHERE name = 'YouTube stats'").first<{ light: string; note: string }>();
    expect(light).toMatchObject({ light: "yellow" });
    expect(light?.note).toMatch(/^Practice mode: .*Setup/);
    expect(typeof getYouTubeDirect(h).listVideos).toBe("function");
    expect(vendorCalls).toEqual([]);
  });

  it("a job with no runner is cut by the practice cutter after the request: dispatched, then done, never failed", async () => {
    const h = await hydrate(env);
    const r = await dispatchJob(h, "research", null);
    expect(r).toMatchObject({ dispatched: true, error: null });
    expect(h.PRACTICE_JOBS).toHaveLength(1);
    await drainPracticeJobs(h);
    const row = await h.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(r.jobId).first<{ status: string }>();
    expect(row?.status).toBe("done");
    expect(vendorCalls).toEqual([]);
  });

  it("the Email and Job runner lights say Practice mode with the Setup guide, never red", async () => {
    const h = await hydrate(env);
    const { serviceHealthRows } = await import("@worker/crons/buffer-sync");
    await serviceHealthRows(h);
    const rows = (await h.DB.prepare("SELECT name, light, fix_guide FROM health WHERE name IN ('Email (Resend)', 'Job runner (GitHub)') ORDER BY name").all()).results;
    expect(rows).toEqual([
      { name: "Email (Resend)", light: "grey", fix_guide: "setup-email" },
      { name: "Job runner (GitHub)", light: "grey", fix_guide: "setup-job-runner" },
    ]);
  });
});

describe("keys: encrypted storage first, then Worker secrets", () => {
  it("a key pasted on Setup wins over the Worker secret, and lifts that service out of practice", async () => {
    await saveConnection(env, "youtube_api", "studio-own-key", "ok", {});
    await saveConnection(env, "github", JSON.stringify({ token: "tok-own", repo: "me/jobs" }), "ok", { repo: "me/jobs" });
    const h = await hydrate({ ...env, YOUTUBE_API_KEY: "host-key", GITHUB_DISPATCH_TOKEN: "host-token", GITHUB_REPO: "host/repo" } as Env);
    expect(h.YOUTUBE_API_KEY).toBe("studio-own-key");
    expect(h.GITHUB_DISPATCH_TOKEN).toBe("tok-own");
    expect(h.GITHUB_REPO).toBe("me/jobs");
    expect(h.PRACTICE).not.toContain("youtube_api");
    expect(h.PRACTICE).not.toContain("github");
    // Stored encrypted: the row never holds the plain key.
    const raw = await env.DB.prepare("SELECT secret_enc FROM connections WHERE service = 'youtube_api'").first<{ secret_enc: string }>();
    expect(raw?.secret_enc).not.toContain("studio-own-key");
  });

  it("with no stored key the Worker secret is used (a host-run studio shows it as provided)", async () => {
    const h = await hydrate({ ...env, YOUTUBE_API_KEY: "host-key" } as Env);
    expect(h.YOUTUBE_API_KEY).toBe("host-key");
    expect(h.PRACTICE).not.toContain("youtube_api");
    const res = await worker.fetch(new Request(`${BASE}/api/setup`, { headers: { cookie: await ownerCookie(env) } }), { ...env, YOUTUBE_API_KEY: "host-key" } as Env, ctx);
    const v = (await res.json()) as SetupView;
    expect(v.steps.find((s) => s.id === "youtube_api")!.state).toBe("provided");
  });

  it("local fakes are not practice: FAKE_SERVICES 1 lists nothing for the banner", () => {
    expect(practiceList({ FAKE_SERVICES: "1" }, new Set())).toEqual([]);
  });
});
