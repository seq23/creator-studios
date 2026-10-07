// OpenRouter, free models by default (section 1 decision 6). Used by the Worker for
// small, quick calls (pitch drafts, brief edits); the heavy runs happen in jobs/.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { getConnectionSecret } from "../lib/connections";

export const FREE_MODEL = "openrouter/free";

export interface LlmClient {
  /** `accept` says whether an answer is usable; an unusable one is retried (see RealLlm). */
  complete(input: { system: string; user: string; json?: boolean; maxTokens?: number; accept?: (text: string) => boolean }): Promise<{ ok: boolean; text: string; error: string | null }>;
  checkKey(): Promise<{ ok: boolean; error: string | null }>;
}

/**
 * The fake answers like the real one, failure shapes included: a key starting "bad" is refused
 * (the same rule as the Firecrawl and Hunter fakes), so the refused-key card, light and fix
 * guide can be shown and tested without a real OpenRouter account.
 */
export class FakeLlm implements LlmClient {
  constructor(private key: string | null = null) {}
  async complete(input: { system: string; user: string; json?: boolean }) {
    if (input.json) return { ok: true, text: JSON.stringify({ fake: true, echo: input.user.slice(0, 40) }), error: null };
    return { ok: true, text: `(fake model) ${input.user.slice(0, 80)}`, error: null };
  }
  async checkKey() {
    if (this.key?.startsWith("bad")) return { ok: false, error: "OpenRouter says this key is not valid." };
    return { ok: true, error: null };
  }
}

/**
 * "openrouter/free" routes each call to whichever free model is up, and many of them are
 * reasoning models whose thinking counts against max_tokens: with 2,500 tokens one spent all of
 * it thinking and returned a JSON object cut off mid-sentence (Phase 0 live test, 25 Sep 2026:
 * "The AI's draft came back incomplete" on a 2-page brand guide). So a call that stops for
 * length is retried with four times the room, and an answer the caller cannot use (`accept`)
 * is retried once more on whichever model the router picks next. Free models cost nothing.
 */
export const LLM_ATTEMPTS = 3;
export const LLM_MAX_TOKENS_CEILING = 16_000;

/** The largest {...} in a model answer parses as JSON (tolerates a fence or chatter around it). */
export function hasJsonObject(text: string): boolean {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return false;
  try {
    JSON.parse(m[0]);
    return true;
  } catch {
    return false;
  }
}

class RealLlm implements LlmClient {
  constructor(private key: string, private referer: string) {}
  async complete(input: { system: string; user: string; json?: boolean; maxTokens?: number; accept?: (text: string) => boolean }) {
    const accept = input.accept ?? (input.json ? hasJsonObject : (t: string) => t.trim().length > 0);
    let maxTokens = input.maxTokens ?? 1200;
    let last: { ok: boolean; text: string; error: string | null } = { ok: false, text: "", error: "AI service did not answer." };
    for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
      const r = await this.once(input, maxTokens);
      if (!r.ok) return r; // busy, key refused, network: the caller shows the plain sentence
      if (accept(r.text)) return { ok: true, text: r.text, error: null };
      last = { ok: true, text: r.text, error: "The AI's answer came back incomplete." };
      if (r.finish === "length") maxTokens = Math.min(LLM_MAX_TOKENS_CEILING, maxTokens * 4);
    }
    return last;
  }
  private async once(input: { system: string; user: string; json?: boolean }, maxTokens: number): Promise<{ ok: boolean; text: string; error: string | null; finish: string | null }> {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "HTTP-Referer": this.referer, "X-Title": "Creator Studios" },
        body: JSON.stringify({
          model: FREE_MODEL,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (res.status === 429) return { ok: false, text: "", error: "The free AI model is busy right now. Try again in a minute.", finish: null };
      if (!res.ok) return { ok: false, text: "", error: `AI service answered ${res.status}`, finish: null };
      const data = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string | null }[] };
      const c = data.choices?.[0];
      return { ok: true, text: c?.message?.content ?? "", error: null, finish: c?.finish_reason ?? null };
    } catch (e) {
      return { ok: false, text: "", error: e instanceof Error ? e.message : "AI service did not answer.", finish: null };
    }
  }
  async checkKey() {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${this.key}` } });
    if (res.status === 401) return { ok: false, error: "OpenRouter says this key is not valid." };
    if (!res.ok) return { ok: false, error: `OpenRouter answered ${res.status}` };
    return { ok: true, error: null };
  }
}

export async function getLlm(env: Env, keyOverride?: string): Promise<LlmClient> {
  const key = keyOverride ?? (await getConnectionSecret(env, "openrouter"));
  if (fakeServices(env) || !key) return new FakeLlm(key);
  return new RealLlm(key, env.PUBLIC_BASE_URL);
}
