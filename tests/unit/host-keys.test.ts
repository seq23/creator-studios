// Owner decisions 7 Oct 2026: Hadiyah's studio (host-accounts) runs AI writing (OpenRouter), studio
// email (Resend), web research (Firecrawl) and brand contacts (Hunter) on the HOST's personal
// accounts when she has saved none of her own; a client studio (Sample 1/2/3) never reads those
// Worker secrets, even when they are set on its Worker. Driven through the real Worker entry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { hydrate } from "@worker/lib/practice";
import { getConnectionSecret, listConnections, saveConnection } from "@worker/lib/connections";
import { HOST_FALLBACK_SECRETS, hostBase, hostKeyFor } from "@worker/lib/hostKeys";
import { sendEmail } from "@worker/services/email";
import { researchJob } from "@worker/jobs/research";
import type { SetupView } from "@shared/setup";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
// @ts-expect-error plain .mjs module
import { HOST_FALLBACK_SECRETS as CLI_LIST, loadRegistry, secretPlan, wranglerConfig } from "../../scripts/studio.mjs";
// @ts-expect-error plain .mjs module
import hostKeysValidator, { checkHostKeys } from "../../scripts/validators/host-keys-host-only.mjs";
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

function studio(kind: "host-accounts" | "client"): Env {
  return {
    DB: sqliteD1().DB,
    FILES: memoryR2().FILES,
    ASSETS,
    APP_NAME: "Studio",
    OWNER_NAME: "",
    OWNER_EMAIL: "owner@owner.example",
    STUDIO_SLUG: kind === "client" ? "sample1" : "hadiyah",
    STUDIO_KIND: kind,
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

describe("client studio (Sample 1/2/3): never the host's keys, even if they are set on its Worker", () => {
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

describe("secret plan and validator host-keys-host-only", () => {
  const reg = loadRegistry(root);
  const cfg = () => parseJsonc(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));

  it("hadiyah carries all five host secrets from her own 0600 files; no sample carries any", () => {
    expect([...CLI_LIST].sort()).toEqual([...HOST_FALLBACK_SECRETS].sort());
    for (const s of reg.studios) {
      const plan = secretPlan(s);
      for (const n of CLI_LIST) {
        if (s.kind === "host-accounts") expect(plan[n], `${s.slug} ${n}`).toBe(`studio-file:${n}`);
        else expect(plan, `${s.slug} ${n}`).not.toHaveProperty(n);
      }
    }
    const gen = parseJsonc(wranglerConfig(reg));
    for (const s of reg.studios) expect(gen.env[s.slug].vars.STUDIO_KIND, s.slug).toBe(s.kind);
  });

  it("secretPlan refuses a host key on a client studio", () => {
    const s1 = structuredClone(reg.studios.find((s: { slug: string }) => s.slug === "sample1"));
    s1.hostSecrets = { HUNTER_API_KEY: "file:HUNTER_API_KEY" };
    expect(() => secretPlan(s1)).toThrow(/HUNTER_API_KEY is the host's own key, for host-accounts studios only/);
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
  });
});
