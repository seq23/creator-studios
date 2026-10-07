// The free router's reasoning models can spend max_tokens thinking and return JSON cut off
// mid-sentence (Phase 0 live test, 25 Sep 2026: "The AI's draft came back incomplete" on a
// 2-page brand guide, finish_reason "length"). The client retries with more room, and retries
// an answer the caller cannot use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLlm, LLM_ATTEMPTS } from "@worker/services/openrouter";
import type { Env } from "@worker/env";

const env = { FAKE_SERVICES: "0", PUBLIC_BASE_URL: "https://e.test" } as unknown as Env;
const answer = (content: string, finish: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });

function stub(...responses: Response[]) {
  const sent: { max_tokens: number }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return responses.shift() ?? answer("", "stop");
    }),
  );
  return sent;
}
afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter free-model answers", () => {
  it("an answer cut off for length is asked again with four times the room", async () => {
    const sent = stub(answer('{"who": "The Golden Table is a hosting studio run by', "length"), answer('{"who":"The Golden Table"}', "stop"));
    const llm = await getLlm(env, "sk-test");
    const r = await llm.complete({ system: "s", user: "u", json: true, maxTokens: 2500 });
    expect(r).toEqual({ ok: true, text: '{"who":"The Golden Table"}', error: null });
    expect(sent.map((b) => b.max_tokens)).toEqual([2500, 10_000]);
  });

  it("an answer the caller cannot use is retried, at most LLM_ATTEMPTS times, then reported incomplete", async () => {
    const sent = stub(answer('{"a":1}', "stop"), answer('{"a":2}', "stop"), answer('{"a":3}', "stop"), answer('{"a":4}', "stop"));
    const llm = await getLlm(env, "sk-test");
    const r = await llm.complete({ system: "s", user: "u", json: true, accept: (t) => t.includes('"who"') });
    expect(sent).toHaveLength(LLM_ATTEMPTS);
    expect(r.ok).toBe(true);
    expect(r.error).toMatch(/incomplete/);
  });

  it("busy (429) is not retried here: the caller shows the plain sentence", async () => {
    const sent = stub(new Response("", { status: 429 }));
    const llm = await getLlm(env, "sk-test");
    const r = await llm.complete({ system: "s", user: "u", json: true });
    expect(sent).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("busy") });
  });
});
