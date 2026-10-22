// The one-time "What's new" note (worker/routes/whatsNew.ts): the owner sees it until she taps
// Got it, then never again (stored per user and note id in D1). A note with a new id shows once
// the same way; a helper never sees it; a studio with no note shows nothing.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "@worker/index";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { ownerCookie } from "./helpers/owner-session";
import { noteFor } from "@worker/routes/whatsNew";

const BASE = "https://studio.example";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOTE = { id: "2026-10-photo-posts", title: "New in your studio", lines: ["Add a photo and get posts from it.", "Tap Skip to stop one."] };
let env: Env;

beforeEach(() => {
  env = {
    DB: sqliteD1().DB,
    FILES: memoryR2().FILES,
    ASSETS: { fetch: async () => new Response("") },
    APP_NAME: "Demo Studio",
    OWNER_EMAIL: "owner@studio.example",
    FAKE_SERVICES: "1",
    PUBLIC_BASE_URL: BASE,
    AUDIENCE_TIMEZONE: "America/Chicago",
    SESSION_SECRET: "s",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    JOB_SHARED_SECRET: "j",
    WHATS_NEW: JSON.stringify(NOTE),
  } as unknown as Env;
});

const call = async (method: string, p: string) => worker.fetch(new Request(`${BASE}${p}`, { method, headers: { cookie: await ownerCookie(env) } }), env, ctx);
const note = async () => ((await (await call("GET", "/api/whats-new")).json()) as { note: typeof NOTE | null }).note;

describe("What's new, once", () => {
  it("shows to the owner until Got it, then never again", async () => {
    expect(await note()).toEqual(NOTE);
    expect(await note()).toEqual(NOTE); // still there on the next screen until she taps Got it
    expect((await call("POST", `/api/whats-new/${NOTE.id}/seen`)).status).toBe(200);
    expect(await note()).toBeNull();
    expect((await call("POST", `/api/whats-new/${NOTE.id}/seen`)).status).toBe(200); // a second tap is harmless
    expect(await note()).toBeNull();
  });

  it("a later note (new id) shows once the same way", async () => {
    await call("POST", `/api/whats-new/${NOTE.id}/seen`);
    env.WHATS_NEW = JSON.stringify({ ...NOTE, id: "2026-11-next" });
    expect((await note())?.id).toBe("2026-11-next");
  });

  it("five short lines at most, a helper never sees it, no note means nothing", async () => {
    env.WHATS_NEW = JSON.stringify({ ...NOTE, lines: ["1", "2", "3", "4", "5", "6", "7"] });
    expect((await note())?.lines.length).toBe(5);
    expect(await noteFor(env, { id: "usr_helper", role: "helper" })).toBeNull();
    env.WHATS_NEW = undefined;
    expect(await note()).toBeNull();
  });

  it("a dismissal for another note id is refused (no stray rows)", async () => {
    expect((await call("POST", "/api/whats-new/not-this-one/seen")).status).toBe(404);
  });
});
