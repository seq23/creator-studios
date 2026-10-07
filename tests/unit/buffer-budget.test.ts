// Buffer's free API allows 3,000 requests per rolling 30 days for the WHOLE account (keys and
// integrations share it). The dashboard's design budget is 25 requests a day on an idle day
// (4 key/channel checks, each: account + channels + one queue read per channel), so it
// leaves room for anything else on the account. This runs the real hourly lane 24 times
// against the real client over a stubbed network and counts the HTTP requests that leave.
// Found in the Phase 0 live test (25 Sep 2026): the throwaway account stood at 2,607 / 3,000.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bufferSync } from "@worker/crons/buffer-sync";
import { saveConnection } from "@worker/lib/connections";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";

export const BUFFER_IDLE_DAY_BUDGET = 25;

let env: Env;
let calls: string[];

function graphql(body: string): unknown {
  const q = (JSON.parse(body) as { query: string }).query;
  if (q.includes("account")) return { account: { id: "acc", organizations: [{ id: "org1", name: "Mine" }] } };
  if (q.includes("channels(")) {
    return {
      channels: [
        { id: "ch_tt", name: "tt", service: "tiktok", displayName: "tt", isDisconnected: false, isQueuePaused: false },
        { id: "ch_ig", name: "ig", service: "instagram", displayName: "ig", isDisconnected: false, isQueuePaused: false },
        { id: "ch_yt", name: "yt", service: "youtube", displayName: "yt", isDisconnected: false, isQueuePaused: false },
      ],
    };
  }
  if (q.includes("posts(")) return { posts: { edges: [] } };
  throw new Error(`unexpected query ${q.slice(0, 40)}`);
}

beforeEach(async () => {
  const d = sqliteD1();
  env = { DB: d.DB, FAKE_SERVICES: "0", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", RESEND_API_KEY: "re_test", GITHUB_DISPATCH_TOKEN: "x", OWNER_EMAIL: "owner@example.com", PUBLIC_BASE_URL: "https://e.test", APP_NAME: "Sample Studio" } as unknown as Env;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.buffer.com")) {
        calls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ data: graphql(String(init?.body)) }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "em" }), { status: 200 }); // Resend
    }),
  );
  await saveConnection(env, "buffer", "a-real-looking-key-0000", "ok", {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Buffer request budget (real client, real lane)", () => {
  it(`an idle day of 24 hourly runs spends at most ${BUFFER_IDLE_DAY_BUDGET} requests`, async () => {
    const logged: number[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      const o = JSON.parse(line) as { step: string; buffer_requests?: number };
      if (o.step === "buffer-sync.done") logged.push(o.buffer_requests ?? NaN);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-09-28T00:00:00.000Z");
    for (let h = 0; h < 24; h++) {
      vi.setSystemTime(start + h * 3600_000);
      await bufferSync(env);
    }
    expect(calls.length).toBeGreaterThan(0); // the lane really talked to Buffer
    expect(calls.length).toBeLessThanOrEqual(BUFFER_IDLE_DAY_BUDGET);
    // the log line she (or an agent) reads to watch the budget counts what really went out
    expect(logged).toHaveLength(24);
    expect(logged.reduce((a, b) => a + b, 0)).toBe(calls.length);
  });
});
