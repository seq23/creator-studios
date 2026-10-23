// Owner's ruling 22 Oct 2026 for Porch & Party Studio: every studio email goes ONLY to the host
// (Worker secret NOTIFY_EMAIL), none to the owner; the owner still logs in (a login code goes to
// whoever typed their address). Studios without the override are unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@worker/env";
import { routeRecipients, sendEmail, type EmailKind } from "@worker/services/email";
// @ts-expect-error plain .mjs module
import { loadRegistry, secretPlan } from "../../scripts/studio.mjs";
import path from "node:path";
import { sqliteD1 } from "./helpers/sqlite-d1";

const OWNER = "owner@owner.example";
const HOST = "host@host.example";
const KINDS: EmailKind[] = ["time_to_dump", "clips_ready", "posting_problem", "connection_needs_you", "weekly_recap", "brief_ready", "heads_up", "niche_note"];

let d: ReturnType<typeof sqliteD1>;
const env = (over: Partial<Env> = {}) => ({ DB: d.DB, FAKE_SERVICES: "1", OWNER_EMAIL: OWNER, ...over }) as unknown as Env;
beforeEach(() => {
  d = sqliteD1();
  vi.unstubAllGlobals();
});
const rows = () => d.raw.prepare("SELECT kind, to_email FROM emails_sent").all() as { kind: string; to_email: string }[];

describe("NOTIFY_EMAIL: every studio email to the host only", () => {
  it("re-addresses every kind but the login code (pure)", () => {
    for (const kind of KINDS) expect(routeRecipients({ NOTIFY_EMAIL: ` ${HOST.toUpperCase()} ` }, { kind, to: [OWNER, "x@y.example"] }), kind).toEqual([HOST]);
    expect(routeRecipients({ NOTIFY_EMAIL: HOST }, { kind: "login_code", to: [OWNER] })).toEqual([OWNER]);
    expect(routeRecipients({}, { kind: "heads_up", to: [OWNER] })).toEqual([OWNER]);
    expect(routeRecipients({ NOTIFY_EMAIL: "  " }, { kind: "heads_up", to: [OWNER] })).toEqual([OWNER]);
  });

  it("no send of any kind reaches OWNER_EMAIL on a studio with the override; the login code still does", async () => {
    const e = env({ NOTIFY_EMAIL: HOST });
    for (const kind of KINDS) await sendEmail(e, { kind, to: [OWNER], subject: "s", html: "<p>x</p>", text: "x" });
    const sent = rows();
    expect(sent).toHaveLength(KINDS.length);
    expect(sent.filter((r) => r.to_email.includes("owner.example"))).toEqual([]);
    expect(sent.every((r) => r.to_email === HOST)).toBe(true);
    await sendEmail(e, { kind: "login_code", to: [OWNER], subject: "code", html: "<p>1</p>", text: "1" });
    expect(rows().filter((r) => r.kind === "login_code")).toEqual([{ kind: "login_code", to_email: OWNER }]);
  });

  it("the real send goes to the host only (Resend payload)", async () => {
    const calls: { to: string[] }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    });
    await sendEmail(env({ FAKE_SERVICES: "0", RESEND_API_KEY: "re_x", NOTIFY_EMAIL: HOST, PRACTICE: [] } as Partial<Env>), { kind: "heads_up", to: [OWNER], subject: "s", html: "<p>x</p>", text: "x" });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual([HOST]);
  });

  it("Porch & Party (sample1) carries NOTIFY_EMAIL from its own required 0600 file; Hadiyah and the samples do not", () => {
    const reg = loadRegistry(path.resolve(__dirname, "../.."));
    for (const s of reg.studios) {
      const plan = secretPlan(s);
      if (s.slug === "sample1") expect(plan.NOTIFY_EMAIL).toBe("studio-file:NOTIFY_EMAIL");
      else expect(plan, s.slug).not.toHaveProperty("NOTIFY_EMAIL");
    }
  });
});
