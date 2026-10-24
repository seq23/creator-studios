// Owner decisions 7 Oct 2026: Hadiyah's studio (host-accounts) runs AI writing (OpenRouter), studio
// email (Resend), web research (Firecrawl) and brand contacts (Hunter) on the HOST's personal
// accounts when she has saved none of her own. Owner's word 22 Oct 2026 ("same as Hadiyah"): Porch &
// Party Studio (slug sample1) runs studio email and AI writing on the host's accounts too, and ONLY
// those (HOST_KEYS). A client studio (Sample 2/3) never reads those Worker secrets, even when they are
// set on its Worker. Driven through the real Worker entry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { hydrate } from "@worker/lib/practice";
import { getConnectionSecret, getOpenRouterFallback, listConnections, saveConnection } from "@worker/lib/connections";
import { HOST_FALLBACK_SECRETS, hostBase, hostFirst, hostKeyFor } from "@worker/lib/hostKeys";
import { getLlm } from "@worker/services/openrouter";
import { sendEmail } from "@worker/services/email";
import { researchJob } from "@worker/jobs/research";
import type { SetupView } from "@shared/setup";
import { Hono } from "hono";
import { jobs as jobRoutes } from "@worker/routes/jobs";
import { hmacHex } from "@worker/lib/crypto";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
// @ts-expect-error plain .mjs module
import { HOST_FALLBACK_SECRETS as CLI_LIST, loadRegistry, secretPlan, wranglerConfig } from "../../scripts/studio.mjs";
// @ts-expect-error plain .mjs module
import hostKeysValidator, { ALLOWED, HOST_FIRST, checkHostKeys } from "../../scripts/validators/host-keys-host-only.mjs";
// @ts-expect-error plain .mjs module
import { parseJsonc } from "../../scripts/validators/studio-isolation.mjs";

const root = path.resolve(__dirname, "../..");
const KEY = "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=";
const BASE = "https://studio.example";
const ASSETS = { fetch: async () => new Response("<!doctype html><div id=root></div>", { headers: { "content-type": "text/html" } }) };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const HOST = {
  OPENROUTER_API_KEY: "sk-or-host",
  RESEND_API_KEY: "re_host",
  STUDIO_EMAIL_FROM: "Hadiyah Studio <hadiyah@mail.host.example>",
  FIRECRAWL_API_KEY: "fc-host",
  HUNTER_API_KEY: "hunter-host",
  DEVELOPER_EMAIL: "dev@host.example",
};
const FOUR = ["resend", "openrouter", "firecrawl", "hunter"] as const;

const PNP_KEYS = "OPENROUTER_API_KEY,RESEND_API_KEY,STUDIO_EMAIL_FROM";

const MERCEDES_KEYS = "OPENROUTER_API_KEY,RESEND_API_KEY,STUDIO_EMAIL_FROM";

function studio(kind: "host-accounts" | "client" | "pnp" | "mercedes"): Env {
  if (kind === "mercedes") return { ...studio("pnp"), STUDIO_SLUG: "mercedes", HOST_KEYS: MERCEDES_KEYS, OPENROUTER_ORDER: "host-first" } as Env;
  return {
    DB: sqliteD1().DB,
    FILES: memoryR2().FILES,
    ASSETS,
    APP_NAME: "Studio",
    OWNER_NAME: "",
    OWNER_EMAIL: "owner@owner.example",
    STUDIO_SLUG: kind === "client" ? "sample2" : kind === "pnp" ? "sample1" : "hadiyah",
    STUDIO_KIND: kind === "client" ? "client" : "host-accounts",
    HOST_KEYS: kind === "client" ? "" : kind === "pnp" ? PNP_KEYS : HOST_FALLBACK_SECRETS.join(","),
    FAKE_SERVICES: "0",
    PUBLIC_BASE_URL: BASE,
    GITHUB_REPO: "",
    AUDIENCE_TIMEZONE: "America/New_York",
    ENV_NAME: "production",
    AUTH_MODE: "code",
    SESSION_SECRET: "s",
    SECRETS_KEY: KEY,
    JOB_SHARED_SECRET: "j",
    ...HOST,
  } as unknown as Env;
}

let sent: { url: string; body: Record<string, unknown> }[];
beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url === "https://api.resend.com/emails") {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    throw new Error(`no vendor call expected: ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function setupStates(env: Env) {
  const res = await worker.fetch(new Request(`${BASE}/api/setup`, { headers: { cookie: await ownerCookie(env) } }), env, ctx);
  expect(res.status).toBe(200);
  const v = (await res.json()) as SetupView;
  return Object.fromEntries(v.steps.map((s) => [s.id, s.state]));
}

describe("host-accounts studio (Hadiyah): the host's four services stand in until she saves her own", () => {
  it("Setup shows email, AI writing, web research and brand contacts as provided by the host, and none is in practice", async () => {
    const env = studio("host-accounts");
    const states = await setupStates(env);
    for (const id of FOUR) expect(states[id], id).toBe("provided");
    const h = await hydrate(env);
    for (const id of FOUR) expect(h.PRACTICE, id).not.toContain(id);
  });

  it("every key reader and every job's signed spec gets the host's key; Connect shows them connected by the host", async () => {
    const env = await hydrate(studio("host-accounts"));
    expect(await getConnectionSecret(env, "openrouter")).toBe("sk-or-host");
    expect(await getConnectionSecret(env, "firecrawl")).toBe("fc-host");
    expect(await getConnectionSecret(env, "hunter")).toBe("hunter-host");
    expect(await getConnectionSecret(env, "buffer")).toBeNull();
    const spec = (await researchJob.buildSpec(env, "job_1", null)) as { keys: Record<string, string | null> };
    expect(spec.keys).toEqual({ openrouter: "sk-or-host", firecrawl: "fc-host" });
    const conns = await listConnections(env);
    for (const s of ["openrouter", "firecrawl", "hunter"]) expect(conns.find((c) => c.service === s), s).toMatchObject({ status: "ok", meta: { host: true } });
  });

  it("studio email goes out on the host's Resend from STUDIO_EMAIL_FROM, replies to the host developer", async () => {
    const env = await hydrate(studio("host-accounts"));
    const r = await sendEmail(env, { kind: "weekly_recap", to: ["owner@owner.example"], subject: "Weekly recap", html: "<p>x</p>", text: "x" });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ from: HOST.STUDIO_EMAIL_FROM, reply_to: HOST.DEVELOPER_EMAIL });
  });

  it("a key she saves on Setup wins over the host's, and her own Resend drops the host's From and reply-to", async () => {
    const raw = studio("host-accounts");
    await saveConnection(raw, "openrouter", "sk-or-hers", "ok", {});
    await saveConnection(raw, "hunter", "hunter-hers", "ok", {});
    await saveConnection(raw, "resend", JSON.stringify({ key: "re_hers", from: "Me <me@hers.example>" }), "ok", {});
    const env = await hydrate(raw);
    expect(await getConnectionSecret(env, "openrouter")).toBe("sk-or-hers");
    expect(await getOpenRouterFallback(env)).toBeNull();
    expect(hostFirst(env, "openrouter")).toBe(false);
    expect(await getConnectionSecret(env, "hunter")).toBe("hunter-hers");
    expect(env.RESEND_API_KEY).toBe("re_hers");
    expect(env.RESEND_FROM).toBe("Me <me@hers.example>");
    expect(env.RESEND_REPLY_TO).toBeUndefined();
    const states = await setupStates(raw);
    expect(states.openrouter).toBe("live");
    expect(states.resend).toBe("live");
    expect(states.firecrawl).toBe("provided");
  });
});

describe("Porch & Party Studio (sample1): the host's email and AI writing, and nothing else of the host's", () => {
  it("hydrate keeps the host's Resend, From and OpenRouter, and drops Firecrawl and Hunter even when they are set on its Worker", async () => {
    const h = await hydrate(studio("pnp"));
    expect(h.OPENROUTER_API_KEY).toBe("sk-or-host");
    expect(h.RESEND_API_KEY).toBe("re_host");
    expect(h.FIRECRAWL_API_KEY).toBeUndefined();
    expect(h.HUNTER_API_KEY).toBeUndefined();
    expect(h.PRACTICE).not.toContain("resend");
    expect(h.PRACTICE).not.toContain("openrouter");
    expect(h.PRACTICE).toContain("firecrawl");
    expect(h.PRACTICE).toContain("hunter");
    const states = await setupStates(studio("pnp"));
    expect(states).toMatchObject({ resend: "provided", openrouter: "provided", firecrawl: "practice", hunter: "practice" });
  });

  it("key readers give the host's OpenRouter only; studio email goes from its own From, replies to the host developer", async () => {
    const raw = studio("pnp");
    expect(hostKeyFor(raw, "openrouter")).toBe("sk-or-host");
    expect(hostKeyFor(raw, "firecrawl")).toBeNull();
    expect(hostKeyFor(raw, "hunter")).toBeNull();
    const env = await hydrate(raw);
    const spec = (await researchJob.buildSpec(env, "job_1", null)) as { keys: Record<string, string | null> };
    expect(spec.keys).toEqual({ openrouter: "sk-or-host", firecrawl: null });
    await sendEmail(env, { kind: "weekly_recap", to: ["owner@owner.example"], subject: "Weekly recap", html: "<p>x</p>", text: "x" });
    expect(sent[0].body).toMatchObject({ from: HOST.STUDIO_EMAIL_FROM, reply_to: HOST.DEVELOPER_EMAIL });
  });

  it("a host-accounts studio with no HOST_KEYS reads none of the host's keys (fail closed)", async () => {
    const raw = { ...studio("host-accounts"), HOST_KEYS: undefined } as Env;
    const b = hostBase(raw);
    for (const n of HOST_FALLBACK_SECRETS) expect((b as unknown as Record<string, unknown>)[n], n).toBeUndefined();
    for (const s of ["openrouter", "firecrawl", "hunter"]) expect(hostKeyFor(raw, s), s).toBeNull();
  });
});

describe("client studio (Sample 2/3): never the host's keys, even if they are set on its Worker", () => {
  it("hydrate removes every host fallback secret, so all four run in practice mode", async () => {
    const env = studio("client");
    const h = await hydrate(env);
    for (const n of HOST_FALLBACK_SECRETS) expect((h as unknown as Record<string, unknown>)[n], n).toBeUndefined();
    expect(h.RESEND_REPLY_TO).toBeUndefined();
    for (const id of FOUR) expect(h.PRACTICE, id).toContain(id);
    const states = await setupStates(env);
    for (const id of FOUR) expect(states[id], id).toBe("practice");
  });

  it("no key reader, job spec, connection list or email reaches a host key", async () => {
    const raw = studio("client");
    for (const s of ["openrouter", "firecrawl", "hunter"]) {
      expect(hostKeyFor(raw, s), s).toBeNull();
      expect(await getConnectionSecret(raw, s as "openrouter"), s).toBeNull();
    }
    const env = await hydrate(raw);
    const spec = (await researchJob.buildSpec(env, "job_1", null)) as { keys: Record<string, string | null> };
    expect(spec.keys).toEqual({ openrouter: null, firecrawl: null });
    expect(await listConnections(env)).toEqual([]);
    await sendEmail(env, { kind: "weekly_recap", to: ["owner@owner.example"], subject: "Weekly recap", html: "<p>x</p>", text: "x" });
    expect(sent).toEqual([]);
  });

  it("a missing STUDIO_KIND reads as a client", async () => {
    const raw = { ...studio("client"), STUDIO_KIND: undefined } as Env;
    const b = hostBase(raw);
    for (const n of HOST_FALLBACK_SECRETS) expect((b as unknown as Record<string, unknown>)[n], n).toBeUndefined();
    expect(hostKeyFor(raw, "openrouter")).toBeNull();
  });

  it("her own pasted keys still work on a client studio", async () => {
    const raw = studio("client");
    await saveConnection(raw, "firecrawl", "fc-client", "ok", {});
    const env = await hydrate(raw);
    expect(await getConnectionSecret(env, "firecrawl")).toBe("fc-client");
    expect(env.PRACTICE).not.toContain("firecrawl");
    expect(env.PRACTICE).toContain("openrouter");
  });
});

describe("Mercedes (host-first, owner's word 24 Oct 2026): the host's OpenRouter first, her own pasted key the backup", () => {
  it("with her key pasted, every reader and job spec gets the host's key first, hers is the backup, and her stored row is untouched", async () => {
    const raw = studio("mercedes");
    await saveConnection(raw, "openrouter", "sk-or-hers", "ok", { checked: true });
    const before = await raw.DB.prepare("SELECT secret_enc, status, meta FROM connections WHERE service = 'openrouter'").first();
    const env = await hydrate(raw);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-host");
    expect(hostFirst(env, "openrouter")).toBe(true);
    expect(await getConnectionSecret(env, "openrouter")).toBe("sk-or-host");
    expect(await getOpenRouterFallback(env)).toBe("sk-or-hers");
    const spec = (await researchJob.buildSpec(env, "job_1", null)) as { keys: Record<string, string | null> };
    expect(spec.keys.openrouter).toBe("sk-or-host");
    expect(await raw.DB.prepare("SELECT secret_enc, status, meta FROM connections WHERE service = 'openrouter'").first()).toEqual(before);
    expect(env.PRACTICE).not.toContain("openrouter");
  });

  it("every job's spec carries her key as llm_key_fallback (jobs/common.py run reads it); no other studio's spec has one", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/jobs", jobRoutes);
    const specOf = async (raw: Env) => {
      await raw.DB.prepare("INSERT INTO jobs (id, type, status, ref_id, nonce) VALUES ('job_r1', 'research', 'queued', NULL, 'n_1')").run();
      const env = { ...(await hydrate(raw)), JOB_SHARED_SECRET: "jsec" } as Env;
      const ts = Math.floor(Date.now() / 1000);
      const res = await app.request(`${BASE}/api/jobs/job_r1/spec`, { headers: { "x-job-timestamp": String(ts), "x-job-signature": await hmacHex("jsec", `${ts}.spec:job_r1`), "x-job-nonce": "n_1" } }, env);
      expect(res.status).toBe(200);
      return (await res.json()) as { keys: Record<string, string | null>; llm_key_fallback?: string };
    };
    const m = studio("mercedes");
    await saveConnection(m, "openrouter", "sk-or-hers", "ok", {});
    const spec = await specOf(m);
    expect(spec.keys.openrouter).toBe("sk-or-host");
    expect(spec.llm_key_fallback).toBe("sk-or-hers");
    const h = studio("host-accounts");
    await saveConnection(h, "openrouter", "sk-or-hers", "ok", {});
    const hs = await specOf(h);
    expect(hs.keys.openrouter).toBe("sk-or-hers");
    expect("llm_key_fallback" in hs).toBe(false);
  });

  it("the Worker asks her key when the host's hits its daily limit, and the host's first on every new ask", async () => {
    const raw = studio("mercedes");
    await saveConnection(raw, "openrouter", "sk-or-hers", "ok", {});
    const env = await hydrate(raw);
    const auth: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      const a = String((init?.headers as Record<string, string>).Authorization);
      auth.push(a);
      if (a === "Bearer sk-or-host") return new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hers" }, finish_reason: "stop" }] }), { status: 200 });
    });
    const llm = await getLlm(env);
    expect(await llm.complete({ system: "s", user: "u" })).toEqual({ ok: true, text: "hers", error: null });
    expect(auth).toEqual(["Bearer sk-or-host", "Bearer sk-or-hers"]);
  });

  it("refused (401/402) or no usable answer on the host's key also moves to hers; a good host answer never touches hers", async () => {
    const raw = studio("mercedes");
    await saveConnection(raw, "openrouter", "sk-or-hers", "ok", {});
    const env = await hydrate(raw);
    for (const hostReply of [() => new Response("no", { status: 401 }), () => new Response("pay", { status: 402 }), () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200 })]) {
      const auth: string[] = [];
      vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
        const a = String((init?.headers as Record<string, string>).Authorization);
        auth.push(a);
        return a === "Bearer sk-or-host" ? hostReply() : new Response(JSON.stringify({ choices: [{ message: { content: "hers" }, finish_reason: "stop" }] }), { status: 200 });
      });
      const r = await (await getLlm(env)).complete({ system: "s", user: "u" });
      expect(r.text).toBe("hers");
      expect(auth[0]).toBe("Bearer sk-or-host");
      expect(auth.at(-1)).toBe("Bearer sk-or-hers");
    }
    const auth: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({ choices: [{ message: { content: "host" }, finish_reason: "stop" }] }), { status: 200 });
    });
    expect((await (await getLlm(env)).complete({ system: "s", user: "u" })).text).toBe("host");
    expect(auth).toEqual(["Bearer sk-or-host"]);
  });

  it("no backup without her key, none on Hadiyah or Porch & Party even with a key pasted, and none when the host key is not allowed", async () => {
    expect(await getOpenRouterFallback(await hydrate(studio("mercedes")))).toBeNull();
    for (const kind of ["host-accounts", "pnp"] as const) {
      const raw = studio(kind);
      await saveConnection(raw, "openrouter", "sk-or-hers", "ok", {});
      const env = await hydrate(raw);
      expect(await getConnectionSecret(env, "openrouter"), kind).toBe("sk-or-hers");
      expect(await getOpenRouterFallback(env), kind).toBeNull();
    }
    const noHost = { ...studio("mercedes"), HOST_KEYS: "RESEND_API_KEY,STUDIO_EMAIL_FROM" } as Env;
    await saveConnection(noHost, "openrouter", "sk-or-hers", "ok", {});
    const env = await hydrate(noHost);
    expect(hostFirst(env, "openrouter")).toBe(false);
    expect(await getConnectionSecret(env, "openrouter")).toBe("sk-or-hers");
    expect(await getOpenRouterFallback(env)).toBeNull();
  });
});

describe("secret plan and validator host-keys-host-only", () => {
  const reg = loadRegistry(root);
  const cfg = () => parseJsonc(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));

  it("the pinned list is exactly hadiyah (all five), sample1 (email + AI writing), sheila (email only), mercedes (email + AI writing host-first, her key the backup, 24 Oct 2026); sample2 and sample3 carry none", () => {
    expect(ALLOWED).toEqual({
      hadiyah: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM", "FIRECRAWL_API_KEY", "HUNTER_API_KEY"],
      sample1: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
      sheila: ["RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
      mercedes: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
    });
    expect(HOST_FIRST).toEqual(["mercedes"]);
    const gen = parseJsonc(wranglerConfig(reg));
    for (const s of reg.studios) expect(gen.env[s.slug].vars.OPENROUTER_ORDER, s.slug).toBe(s.slug === "mercedes" ? "host-first" : "pasted-first");
    expect(gen.vars.OPENROUTER_ORDER).toBe("pasted-first");
    expect(reg.studios.filter((s: { kind: string }) => s.kind === "host-accounts").map((s: { slug: string }) => s.slug).sort()).toEqual(["hadiyah", "mercedes", "sample1", "sheila"]);
    for (const slug of ["sample2", "sample3"]) expect(reg.studios.find((s: { slug: string }) => s.slug === slug).kind, slug).toBe("client");
  });

  it("each studio's secret plan and generated HOST_KEYS carry exactly its pinned host secrets, each from its own 0600 file", () => {
    expect([...CLI_LIST].sort()).toEqual([...HOST_FALLBACK_SECRETS].sort());
    const gen = parseJsonc(wranglerConfig(reg));
    for (const s of reg.studios) {
      const want: string[] = (ALLOWED as Record<string, string[]>)[s.slug] ?? [];
      const plan = secretPlan(s);
      expect(CLI_LIST.filter((n: string) => n in plan).sort(), s.slug).toEqual([...want].sort());
      for (const n of want) expect(plan[n], `${s.slug} ${n}`).toMatch(new RegExp(`^studio-file\\??:${n}$`));
      expect(gen.env[s.slug].vars.STUDIO_KIND, s.slug).toBe(s.kind);
      expect(String(gen.env[s.slug].vars.HOST_KEYS).split(",").filter(Boolean).sort(), s.slug).toEqual([...want].sort());
    }
    expect(gen.vars.HOST_KEYS).toBe("");
    // Hadiyah's are required files, as before (7 Oct 2026).
    for (const n of CLI_LIST) expect(secretPlan(reg.studios.find((s: { slug: string }) => s.slug === "hadiyah"))[n]).toBe(`studio-file:${n}`);
  });

  it("secretPlan refuses a host key on a client studio, and one not in a host-accounts studio's hostKeys", () => {
    const s2 = structuredClone(reg.studios.find((s: { slug: string }) => s.slug === "sample2"));
    s2.hostSecrets = { HUNTER_API_KEY: "file:HUNTER_API_KEY" };
    expect(() => secretPlan(s2)).toThrow(/HUNTER_API_KEY is the host's own key, for host-accounts studios only/);
    const s1 = structuredClone(reg.studios.find((s: { slug: string }) => s.slug === "sample1"));
    s1.hostSecrets = { ...s1.hostSecrets, HUNTER_API_KEY: "studio-file:HUNTER_API_KEY" };
    expect(() => secretPlan(s1)).toThrow(/HUNTER_API_KEY is the host's own key and is not in this studio's hostKeys/);
  });

  it("passes on the repo", async () => {
    const r = await hostKeysValidator({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(100);
  });

  it("negative proof: a client carrying a host key, a wrong STUDIO_KIND, hadiyah missing one, a stray reader, a hydrate without hostBase, and lists that drift each fail", () => {
    const studios = structuredClone(reg.studios);
    studios.find((s: { slug: string }) => s.slug === "sample2").hostSecrets = { OPENROUTER_API_KEY: "file:OPENROUTER_API_KEY" };
    delete studios.find((s: { slug: string }) => s.slug === "hadiyah").hostSecrets.FIRECRAWL_API_KEY;
    const c = cfg();
    c.env.sample3.vars.STUDIO_KIND = "host-accounts";
    const sources = {
      "worker/lib/practice.ts": "export async function hydrate(env) { const out = { ...env }; }",
      "worker/routes/stray.ts": "const k = env.FIRECRAWL_API_KEY;",
      "worker/lib/hostKeys.ts": "env.OPENROUTER_API_KEY",
    };
    const r = checkHostKeys({ studios, cfg: c, secretPlan, cliList: CLI_LIST, workerList: CLI_LIST.slice(1), sources });
    const text = r.problems.join("\n");
    expect(text).toMatch(/env\.sample2: studios\/sample2\.json: OPENROUTER_API_KEY is the host's own key/);
    expect(text).toMatch(/env\.sample2 \(client\) would carry the host's OPENROUTER_API_KEY/);
    expect(text).toMatch(/env\.hadiyah \(host-accounts\) is missing FIRECRAWL_API_KEY/);
    expect(text).toMatch(/wrangler env\.sample3: STUDIO_KIND is host-accounts, registry says client/);
    expect(text).toMatch(/worker\/routes\/stray\.ts: reads FIRECRAWL_API_KEY off the env/);
    expect(text).not.toMatch(/worker\/lib\/hostKeys\.ts: reads/);
    expect(text).toMatch(/hydrate no longer starts from hostBase\(env\)/);
    expect(text).toMatch(/worker\/lib\/hostKeys\.ts HOST_FALLBACK_SECRETS .* differs/);
    expect(text).toMatch(/hostBase\/hostKeyFor no longer gate on allowedHostKeys/);
  });

  it("negative proof: a third host-accounts studio, a widened sample1, a hostKeys/HOST_KEYS drift, and a client with hostKeys each fail", () => {
    const studios = structuredClone(reg.studios);
    const s1 = studios.find((s: { slug: string }) => s.slug === "sample1");
    s1.hostKeys = [...s1.hostKeys, "FIRECRAWL_API_KEY"];
    s1.hostSecrets = { ...s1.hostSecrets, FIRECRAWL_API_KEY: "studio-file:FIRECRAWL_API_KEY" };
    const s3 = studios.find((s: { slug: string }) => s.slug === "sample3");
    s3.hostKeys = ["RESEND_API_KEY"];
    const s2 = studios.find((s: { slug: string }) => s.slug === "sample2");
    s2.kind = "host-accounts";
    const c = cfg();
    c.env.sample2.vars.STUDIO_KIND = "host-accounts";
    c.env.hadiyah.vars.HOST_KEYS = "OPENROUTER_API_KEY";
    const sources = { "worker/lib/practice.ts": "hydrate: const out = hostBase(env);", "worker/lib/hostKeys.ts": "allowedHostKeys(env)" };
    const r = checkHostKeys({ studios, cfg: c, secretPlan, cliList: CLI_LIST, workerList: CLI_LIST, sources });
    const text = r.problems.join("\n");
    expect(text).toMatch(/host-accounts studios are \[hadiyah,mercedes,sample1,sample2,sheila\], the pinned list is \[hadiyah,mercedes,sample1,sheila\]/);
    expect(text).toMatch(/env\.sample1 would carry the host's FIRECRAWL_API_KEY, which is not pinned for it/);
    expect(text).toMatch(/studios\/sample1\.json hostKeys .* differ from the pinned/);
    expect(text).toMatch(/studios\/sample3\.json: a client studio has hostKeys/);
    expect(text).toMatch(/wrangler env\.hadiyah: HOST_KEYS is \[OPENROUTER_API_KEY\]/);
  });

  it("negative proof: host-first on an unpinned studio, a dropped host-first, a host-first without the host's OpenRouter, a drifted OPENROUTER_ORDER, and an unwired hostFirst each fail", () => {
    const studios = structuredClone(reg.studios);
    studios.find((s: { slug: string }) => s.slug === "hadiyah").openrouterOrder = "host-first";
    delete studios.find((s: { slug: string }) => s.slug === "mercedes").openrouterOrder;
    const c = cfg();
    c.env.sample1.vars.OPENROUTER_ORDER = "host-first";
    c.vars.OPENROUTER_ORDER = "host-first";
    const sources = { "worker/lib/practice.ts": "hostBase(env)", "worker/lib/hostKeys.ts": "allowedHostKeys(env)" };
    const r = checkHostKeys({ studios, cfg: c, secretPlan, cliList: CLI_LIST, workerList: CLI_LIST, sources, hostFirst: ["mercedes", "sheila"] });
    const text = r.problems.join("\n");
    expect(text).toMatch(/studios\/hadiyah\.json: openrouterOrder is host-first, pinned unset/);
    expect(text).toMatch(/studios\/mercedes\.json: openrouterOrder is unset, pinned host-first/);
    expect(text).toMatch(/sheila is host-first but the host's OPENROUTER_API_KEY is not pinned for it/);
    expect(text).toMatch(/wrangler env\.sample1: OPENROUTER_ORDER is host-first, pinned pasted-first/);
    expect(text).toMatch(/top level \(local dev\) OPENROUTER_ORDER is host-first/);
    expect(text).toMatch(/hostFirst no longer reads OPENROUTER_ORDER/);
    expect(text).toMatch(/must pass the host-first studio's own key as the backup/);
    expect(checkHostKeys({ studios: reg.studios, cfg: cfg(), secretPlan, cliList: CLI_LIST, workerList: CLI_LIST, sources, hostFirst: [] }).problems.join("\n")).toMatch(/no host-first studio pinned/);
  });
});
