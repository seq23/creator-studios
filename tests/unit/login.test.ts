// Login in every studio (studio brief §4, guard c): the email one-time code, never "open". A
// sample studio's owner is claimed once through its first-login invite link; login codes go
// through the PLATFORM sender, every other email through the studio's own Resend.
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env, Vars } from "@worker/env";
import { authMode } from "@worker/env";
import { requireOwner, requireUser } from "@worker/lib/auth";
import { auth } from "@worker/routes/auth";
import { me } from "@worker/routes/me";
import { senderFor, sendEmail } from "@worker/services/email";
import { sqliteD1 } from "./helpers/sqlite-d1";
// @ts-expect-error plain .mjs validator, no types
import loginNeverOpen, { checkLogin } from "../../scripts/validators/login-never-open.mjs";
// @ts-expect-error plain .mjs validator, no types
import { parseJsonc } from "../../scripts/validators/studio-isolation.mjs";

const BASE = "http://w.example";
const json = { "content-type": "application/json" };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.get("/api/who", requireUser, (c) => c.json(c.get("user")));
app.post("/api/owner-only", requireUser, requireOwner, (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/api/me", me);

let db: ReturnType<typeof sqliteD1>;
const envFor = (over: Partial<Env> = {}): Env => ({ DB: db.DB, OWNER_EMAIL: "", SESSION_SECRET: "session-secret-for-tests", APP_NAME: "Sample 1 Studio", FAKE_SERVICES: "1", PUBLIC_BASE_URL: BASE, ...over }) as unknown as Env;
const post = (env: Env, p: string, body: unknown) => app.request(`${BASE}${p}`, { method: "POST", headers: json, body: JSON.stringify(body) }, env);
const mint = (token: string, expires = new Date(Date.now() + 86_400_000).toISOString()) =>
  db.raw.prepare("INSERT INTO invites (token_hash, expires_at) VALUES (?, ?)").run(createHash("sha256").update(`invite:${token}`).digest("hex"), expires);

beforeEach(() => {
  db = sqliteD1();
});
afterEach(() => vi.unstubAllGlobals());

describe("never open", () => {
  it("authMode() is code whatever the var says", () => {
    for (const AUTH_MODE of ["open", "code", undefined, "", "Open"]) expect(authMode({ AUTH_MODE })).toBe("code");
  });

  it("AUTH_MODE open in the env still needs a login: 401 everywhere, no user made", async () => {
    const env = envFor({ AUTH_MODE: "open", OWNER_EMAIL: "o@example.com" });
    expect((await app.request(`${BASE}/api/who`, {}, env)).status).toBe(401);
    expect((await app.request(`${BASE}/api/me`, {}, env)).status).toBe(401);
    expect((await app.request(`${BASE}/api/owner-only`, { method: "POST" }, env)).status).toBe(401);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("the email code logs the owner in; /api/me then names the studio's owner", async () => {
    const env = envFor({ OWNER_EMAIL: "o@example.com", OWNER_NAME: "Hadiyah", APP_NAME: "Hadiyah Studio" });
    const r = await post(env, "/api/auth/request", { email: "o@example.com" });
    const { dev_code } = (await r.json()) as { dev_code: string };
    const v = await post(env, "/api/auth/verify", { email: "o@example.com", code: dev_code });
    expect(v.status).toBe(200);
    const cookie = v.headers.get("set-cookie")!.split(";")[0];
    const m = await app.request(`${BASE}/api/me`, { headers: { cookie } }, env);
    expect(await m.json()).toMatchObject({ email: "o@example.com", role: "owner", authMode: "code", appName: "Hadiyah Studio", ownerName: "Hadiyah" });
  });

  it("validator login-never-open passes on the repo and fails on an open config or an open branch (negative proof)", async () => {
    const root = path.resolve(__dirname, "../..");
    const r = await loginNeverOpen({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(10);
    const cfg = parseJsonc(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
    cfg.env.sample1.vars.AUTH_MODE = "open";
    delete cfg.env.hadiyah.vars.AUTH_MODE;
    const env = readFileSync(path.join(root, "worker/env.ts"), "utf8");
    const bad = checkLogin(cfg, { "worker/env.ts": env.replace('=> "code";', '=> (env?.AUTH_MODE === "open" ? "open" : "code");'), "worker/lib/auth.ts": 'if (authMode(c.env) === "open") return owner;' });
    expect(bad.problems).toEqual(
      expect.arrayContaining([
        'env.sample1: AUTH_MODE must be "code" (is "open")',
        "env.hadiyah: AUTH_MODE must be \"code\" (is undefined)",
        'worker/lib/auth.ts: has an "open" login branch',
        'worker/env.ts: authMode() must return the constant "code"',
      ]),
    );
  });
});

describe("first-login invite (sample studios)", () => {
  it("a studio with no owner refuses every email until the invite is used", async () => {
    const env = envFor();
    const r = await post(env, "/api/auth/request", { email: "new@client.example" });
    expect(await r.json()).toEqual({ ok: true }); // same answer, no code, nobody can log in
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM login_codes").get()).toEqual({ n: 0 });
    expect(await (await app.request(`${BASE}/api/auth/status`, {}, env)).json()).toMatchObject({ hasOwner: false });
  });

  it("the invite claims the owner once, sends the first code, and then logs her in", async () => {
    const env = envFor();
    mint("tok-aaaaaaaaaaaaaaaaaaaaaaaa");
    const r = await post(env, "/api/auth/invite", { token: "tok-aaaaaaaaaaaaaaaaaaaaaaaa", email: "New@Client.example" });
    expect(r.status).toBe(200);
    const { dev_code } = (await r.json()) as { dev_code: string };
    expect(dev_code).toMatch(/^\d{6}$/);
    const v = await post(env, "/api/auth/verify", { email: "new@client.example", code: dev_code });
    expect(v.status).toBe(200);
    expect(await (await app.request(`${BASE}/api/auth/status`, {}, env)).json()).toMatchObject({ hasOwner: true });
    // Used: someone else with the same link is refused; the owner opening it again just gets a code.
    expect((await post(env, "/api/auth/invite", { token: "tok-aaaaaaaaaaaaaaaaaaaaaaaa", email: "other@x.example" })).status).toBe(409);
    expect((await post(env, "/api/auth/invite", { token: "tok-aaaaaaaaaaaaaaaaaaaaaaaa", email: "new@client.example" })).status).toBe(200);
  });

  it("a wrong, short or expired link is refused; a second invite cannot take over a claimed studio", async () => {
    const env = envFor();
    expect((await post(env, "/api/auth/invite", { token: "nope-nope-nope-nope-nope-nope", email: "a@b.example" })).status).toBe(404);
    expect((await post(env, "/api/auth/invite", { token: "short", email: "a@b.example" })).status).toBe(400);
    mint("tok-expiredxxxxxxxxxxxxxxxx", new Date(Date.now() - 1000).toISOString());
    expect((await post(env, "/api/auth/invite", { token: "tok-expiredxxxxxxxxxxxxxxxx", email: "a@b.example" })).status).toBe(409);
    mint("tok-firstxxxxxxxxxxxxxxxxxxx");
    mint("tok-secondxxxxxxxxxxxxxxxxxx");
    expect((await post(env, "/api/auth/invite", { token: "tok-firstxxxxxxxxxxxxxxxxxxx", email: "owner@a.example" })).status).toBe(200);
    expect((await post(env, "/api/auth/invite", { token: "tok-secondxxxxxxxxxxxxxxxxxx", email: "thief@b.example" })).status).toBe(409);
  });
});

describe("the host developer login (DEVELOPER_EMAIL): every studio, never the owner", () => {
  const DEV = "dev@host.example";
  const code = async (r: Response) => ((await r.json()) as { dev_code: string }).dev_code;
  const ownerSetting = () => db.raw.prepare("SELECT value FROM settings WHERE key = 'owner_email'").get();
  const inviteRow = (token: string) =>
    db.raw.prepare("SELECT used_at, used_by FROM invites WHERE token_hash = ?").get(createHash("sha256").update(`invite:${token}`).digest("hex"));
  const login = async (env: Env, email: string) => {
    const v = await post(env, "/api/auth/verify", { email, code: await code(await post(env, "/api/auth/request", { email })) });
    expect(v.status).toBe(200);
    return v.headers.get("set-cookie")!.split(";")[0];
  };

  it("the owner still logs in as the owner with a developer set", async () => {
    const env = envFor({ OWNER_EMAIL: "o@example.com", DEVELOPER_EMAIL: DEV });
    const cookie = await login(env, "o@example.com");
    expect(await (await app.request(`${BASE}/api/me`, { headers: { cookie } }, env)).json()).toMatchObject({ email: "o@example.com", role: "owner" });
  });

  it("on a claimed studio the developer logs in (case and spaces ignored) with full access, and the owner is unchanged", async () => {
    const env = envFor({ OWNER_EMAIL: "o@example.com", DEVELOPER_EMAIL: " Dev@Host.Example " });
    const r = await post(env, "/api/auth/request", { email: "  DEV@host.EXAMPLE " });
    const v = await post(env, "/api/auth/verify", { email: "Dev@Host.example", code: await code(r) });
    expect(v.status).toBe(200);
    const cookie = v.headers.get("set-cookie")!.split(";")[0];
    expect(await (await app.request(`${BASE}/api/me`, { headers: { cookie } }, env)).json()).toMatchObject({ email: DEV, role: "owner" });
    expect((await app.request(`${BASE}/api/owner-only`, { method: "POST", headers: { cookie } }, env)).status).toBe(200);
    expect(ownerSetting()).toBeUndefined();
    // The owner's own login is untouched.
    await login(env, "o@example.com");
  });

  it("on an UNCLAIMED sample the developer logs in, the studio stays unclaimed, and the invite still claims it for the owner", async () => {
    const env = envFor({ DEVELOPER_EMAIL: DEV });
    mint("tok-unclaimedxxxxxxxxxxxxxxx");
    const cookie = await login(env, DEV);
    expect(await (await app.request(`${BASE}/api/me`, { headers: { cookie } }, env)).json()).toMatchObject({ email: DEV, role: "owner" });
    expect(await (await app.request(`${BASE}/api/auth/status`, {}, env)).json()).toMatchObject({ hasOwner: false });
    expect(ownerSetting()).toBeUndefined();
    expect(inviteRow("tok-unclaimedxxxxxxxxxxxxxxx")).toEqual({ used_at: null, used_by: null });
    // Even typed into the invite link itself, the developer only gets a code: nothing claimed, link unused.
    const viaInvite = await post(env, "/api/auth/invite", { token: "tok-unclaimedxxxxxxxxxxxxxxx", email: "Dev@Host.example" });
    expect(viaInvite.status).toBe(200);
    expect(inviteRow("tok-unclaimedxxxxxxxxxxxxxxx")).toEqual({ used_at: null, used_by: null });
    expect(ownerSetting()).toBeUndefined();
    // The owner's single-use link works exactly as before.
    const claim = await post(env, "/api/auth/invite", { token: "tok-unclaimedxxxxxxxxxxxxxxx", email: "new@client.example" });
    expect(claim.status).toBe(200);
    expect((await post(env, "/api/auth/verify", { email: "new@client.example", code: await code(claim) })).status).toBe(200);
    expect(await (await app.request(`${BASE}/api/auth/status`, {}, env)).json()).toMatchObject({ hasOwner: true });
    expect(inviteRow("tok-unclaimedxxxxxxxxxxxxxxx")).toMatchObject({ used_by: "new@client.example" });
    // And the developer can still log in after the claim.
    await login(env, DEV);
  });

  it("a stranger gets the byte-identical answer the developer gets, and no code; verify refuses them", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    const env = envFor({ FAKE_SERVICES: "0", OWNER_EMAIL: "o@example.com", DEVELOPER_EMAIL: DEV, PLATFORM_RESEND_API_KEY: "re_platform", PLATFORM_EMAIL_FROM: "Studio login <login@platform.example>" });
    const dev = await post(env, "/api/auth/request", { email: DEV });
    const stranger = await post(env, "/api/auth/request", { email: "stranger@else.example" });
    expect([stranger.status, await stranger.text()]).toEqual([dev.status, await dev.text()]);
    expect(stranger.status).toBe(200);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = 'stranger@else.example'").get()).toEqual({ n: 0 });
    expect((await post(env, "/api/auth/verify", { email: "stranger@else.example", code: "123456" })).status).toBe(401);
    // With no DEVELOPER_EMAIL set, that same address is just a stranger.
    const unset = envFor({ FAKE_SERVICES: "0", OWNER_EMAIL: "o@example.com", PLATFORM_RESEND_API_KEY: "re_platform", PLATFORM_EMAIL_FROM: "Studio login <login@platform.example>" });
    const before = (db.raw.prepare("SELECT COUNT(*) AS n FROM login_codes").get() as { n: number }).n;
    expect(await (await post(unset, "/api/auth/request", { email: DEV })).json()).toEqual({ ok: true });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM login_codes").get()).toEqual({ n: before });
  });
});

describe("two senders: the platform for login codes only, the studio's own for everything else", () => {
  const keys = { APP_NAME: "Sample 1 Studio", PLATFORM_RESEND_API_KEY: "re_platform", PLATFORM_EMAIL_FROM: "Studio login <login@platform.example>", RESEND_API_KEY: "re_studio", RESEND_FROM: "Me <me@mine.example>" };
  it("senderFor picks the platform only for login_code", () => {
    expect(senderFor(keys, "login_code")).toEqual({ key: "re_platform", from: "Studio login <login@platform.example>", platform: true, replyTo: null });
    for (const kind of ["clips_ready", "weekly_recap", "posting_problem", "connection_needs_you", "time_to_dump", "brief_ready"] as const) expect(senderFor(keys, kind)).toEqual({ key: "re_studio", from: "Me <me@mine.example>", platform: false, replyTo: null });
    expect(senderFor({ APP_NAME: "Sample 1 Studio" }, "weekly_recap")).toEqual({ key: null, from: "Sample 1 Studio <onboarding@resend.dev>", platform: false, replyTo: null });
  });

  it("a real studio with no Resend of its own: the login code still goes out (platform), other mail is practice (recorded, never sent)", async () => {
    const calls: { auth: string; from: string }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      calls.push({ auth: (init.headers as Record<string, string>).Authorization, from: JSON.parse(String(init.body)).from });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    });
    const env = envFor({ FAKE_SERVICES: "0", PLATFORM_RESEND_API_KEY: "re_platform", PLATFORM_EMAIL_FROM: "Studio login <login@platform.example>", PRACTICE: ["resend"] });
    const login = await sendEmail(env, { kind: "login_code", to: ["o@example.com"], subject: "s", html: "h", text: "t" });
    expect(login).toMatchObject({ ok: true, providerId: "em_1" });
    expect(calls).toEqual([{ auth: "Bearer re_platform", from: "Studio login <login@platform.example>" }]);
    const recap = await sendEmail(env, { kind: "weekly_recap", to: ["o@example.com"], subject: "s", html: "h", text: "t" });
    expect(recap.ok).toBe(true);
    expect(recap.providerId).toMatch(/^practice_/);
    expect(calls).toHaveLength(1); // nothing else left the Worker
    expect(db.raw.prepare("SELECT light, fix_guide FROM health WHERE name = 'Email (Resend)'").get()).toEqual({ light: "grey", fix_guide: "setup-email" });
  });
});
