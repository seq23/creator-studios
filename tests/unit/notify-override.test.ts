// Owner's ruling 22 Oct 2026 for Porch & Party Studio: every studio email goes ONLY to the host
// (Worker secret NOTIFY_EMAIL), none to the owner; the owner still logs in (a login code goes to
// whoever typed their address). Studios without the override are unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@worker/env";
import { routeRecipients, sendEmail, type EmailKind } from "@worker/services/email";
import { hostBase } from "@worker/lib/hostKeys";
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

// Owner's rulings: 1 Nov 2026 "I don't need creator studio emails at all, not even pnp studio", then
// 2 Nov 2026 "pnp is different since im running it u can keep that one". Porch & Party Studio (sample1,
// whose NOTIFY_EMAIL is her address) mails her again; every other studio never addresses the host
// developer (DEVELOPER_EMAIL), not as a recipient and not as the reply-to, in any Gmail spelling.
// worker/lib/mailbox.ts, worker/services/email.ts routeRecipients, worker/lib/hostKeys.ts hostBase.
describe("who mails the host developer (1 and 2 Nov 2026)", () => {
  const G = ["gmail", "com"].join(".");
  const DEV = `dev.host@${G}`;
  // Every spelling Gmail delivers to the same mailbox: capitals, dots moved, a +tag, googlemail.
  const VARIANTS = [DEV, ` DEV.HOST@${G.toUpperCase()} `, `devhost@${G}`, `d.e.v.h.o.s.t@${G}`, `dev.host+studio@${G}`, `devhost@google${"mail"}.com`, `Dev Host <dev.host+x@${G}>`];
  const CLIENT = "client@client.example";
  /** The test's own reading of "is this her mailbox" (not the code's), so the check is independent. */
  const isDev = (a: string) => {
    const m = /<([^>]+)>/.exec(a)?.[1] ?? a;
    const [local, domain] = m.trim().toLowerCase().split("@");
    return /^(gmail|googlemail)\.com$/.test(domain ?? "") && local.split("+")[0].replace(/\./g, "") === "devhost";
  };
  const reg = loadRegistry(path.resolve(__dirname, "../.."));
  const others = reg.studios.map((s: { slug: string }) => s.slug).filter((slug: string) => slug !== "sample1");

  async function realSends(over: Partial<Env>) {
    const calls: { to: string[]; reply_to?: string }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    });
    const e = env({ FAKE_SERVICES: "0", RESEND_API_KEY: "re_x", PRACTICE: [], DEVELOPER_EMAIL: DEV, ...over } as Partial<Env>);
    for (const kind of KINDS) await sendEmail(e, { kind, to: [...VARIANTS, CLIENT], subject: "s", html: "<p>x</p>", text: "x" });
    return calls;
  }

  it("the test's own mailbox check sees every variant, and nothing else", () => {
    for (const v of VARIANTS) expect(isDev(v), v).toBe(true);
    for (const v of [CLIENT, `devhost@other.example`, `devhosts@${G}`]) expect(isDev(v), v).toBe(false);
  });

  it("every studio but Porch & Party: no notice and no reply-to addresses her, whatever spelling or reply-to it was handed", async () => {
    expect(others.length).toBeGreaterThanOrEqual(5);
    expect(others).toContain("ashly");
    for (const slug of others) {
      for (const replyTo of [...VARIANTS, undefined]) {
        const calls = await realSends({ STUDIO_SLUG: slug, RESEND_REPLY_TO: replyTo } as Partial<Env>);
        expect(calls, slug).toHaveLength(KINDS.length);
        for (const c of calls) {
          expect(c.to.filter(isDev), `${slug} to`).toEqual([]);
          expect(c.to, slug).toEqual([CLIENT]);
          expect(c.reply_to && isDev(c.reply_to) ? c.reply_to : null, `${slug} reply-to`).toBeNull();
        }
      }
    }
  });

  it("a host-accounts studio's reply-to is its own owner, or none when the owner address is hers; never her", () => {
    for (const slug of others) {
      const base = { STUDIO_SLUG: slug, STUDIO_KIND: "host-accounts", HOST_KEYS: "RESEND_API_KEY,STUDIO_EMAIL_FROM", RESEND_API_KEY: "re_x", STUDIO_EMAIL_FROM: "S <s@mail.example>", DEVELOPER_EMAIL: DEV } as unknown as Env;
      expect(hostBase({ ...base, OWNER_EMAIL: OWNER }).RESEND_REPLY_TO, slug).toBe(OWNER);
      for (const v of VARIANTS) expect(hostBase({ ...base, OWNER_EMAIL: v }).RESEND_REPLY_TO, `${slug} ${v}`).toBeUndefined();
    }
  });

  it("negative proof, Porch & Party (sample1): the same sends DO reach her, as the 2 Nov ruling says, so the check above can see her", async () => {
    const calls = await realSends({ STUDIO_SLUG: "sample1", NOTIFY_EMAIL: DEV, RESEND_REPLY_TO: DEV } as Partial<Env>);
    expect(calls).toHaveLength(KINDS.length);
    for (const c of calls) {
      expect(c.to).toEqual([DEV]);
      expect(c.reply_to).toBe(DEV);
    }
    const base = { STUDIO_SLUG: "sample1", STUDIO_KIND: "host-accounts", HOST_KEYS: "RESEND_API_KEY,STUDIO_EMAIL_FROM", RESEND_API_KEY: "re_x", STUDIO_EMAIL_FROM: "S <s@mail.example>", DEVELOPER_EMAIL: DEV, OWNER_EMAIL: OWNER } as unknown as Env;
    expect(hostBase(base).RESEND_REPLY_TO).toBe(DEV);
    for (const kind of KINDS) expect(routeRecipients({ STUDIO_SLUG: "sample1", NOTIFY_EMAIL: DEV, DEVELOPER_EMAIL: DEV }, { kind, to: [OWNER] }), kind).toEqual([DEV]);
  });

  it("on any other studio a NOTIFY_EMAIL that is hers leaves nobody: no Resend call, and the Email light is not turned red", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      calls.push(init?.body);
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    });
    const e = env({ FAKE_SERVICES: "0", RESEND_API_KEY: "re_x", STUDIO_SLUG: "ashly", NOTIFY_EMAIL: `devhost+n@${G}`, DEVELOPER_EMAIL: DEV, PRACTICE: [] } as Partial<Env>);
    for (const kind of KINDS) await sendEmail(e, { kind, to: [DEV], subject: "s", html: "<p>x</p>", text: "x" });
    expect(calls).toEqual([]);
    const red = d.raw.prepare("SELECT COUNT(*) AS n FROM health WHERE light = 'red'").get() as { n: number } | undefined;
    expect(red?.n ?? 0).toBe(0);
  });

  it("kept everywhere: her login code, and a send she asks for by pressing a button (the [Test] heads-up)", () => {
    expect(routeRecipients({ STUDIO_SLUG: "ashly", DEVELOPER_EMAIL: DEV }, { kind: "login_code", to: [DEV] })).toEqual([DEV]);
    expect(routeRecipients({ STUDIO_SLUG: "ashly", DEVELOPER_EMAIL: DEV }, { kind: "heads_up", to: [DEV], requested: true })).toEqual([DEV]);
    expect(routeRecipients({ STUDIO_SLUG: "ashly", DEVELOPER_EMAIL: DEV }, { kind: "heads_up", to: [DEV] })).toEqual([]);
  });
});
