import { describe, expect, it } from "vitest";
import type { Env } from "@worker/env";
import { jobs } from "@worker/routes/jobs";
import { signJobMessage } from "@worker/lib/crypto";

const key = "local-studio-fixture";
const endpoint = "http://localhost/pnp/receipts";

describe("Porch & Party receipt export", () => {
  async function signedHeaders() {
    const { timestamp, signature } = await signJobMessage(key, "pnp:receipts");
    return { "x-job-timestamp": String(timestamp), "x-job-signature": signature };
  }

  it("refuses a client studio even with a valid signature and never queries its database", async () => {
    const env = { STUDIO_SLUG: "client-fixture", JOB_SHARED_SECRET: key } as Env;
    expect((await jobs.request(endpoint, { headers: await signedHeaders() }, env)).status).toBe(404);
    expect((await jobs.request(endpoint, {}, { ...env, STUDIO_SLUG: "sample1" })).status).toBe(401);
  });

  it("exports only receipt metadata and hashes the platform identifier", async () => {
    const row = { channel: "instagram", platform_id: "fixture-buffer-id", at: "2026-11-24T12:00:00Z", caption: "fixture caption" };
    const env = {
      STUDIO_SLUG: "sample1",
      JOB_SHARED_SECRET: key,
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }) },
    } as unknown as Env;
    const response = await jobs.request(endpoint, { headers: await signedHeaders() }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual([{ channel: row.channel, at: row.at, id: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });
});
