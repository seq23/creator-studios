// Cloudflare Workers AI, the second $0 source for the studio-intelligence jobs (owner, 23 Oct 2026:
// "use the cloudflare free allowance too"). The account's free allowance is 10,000 neurons a day
// for every Worker together, reset 00:00 UTC; anything past it is BILLED. So a studio spends at most
// its own share (STUDIO_AI_BUDGET, from the registry's aiBudget; the shares sum to 8,500, validator
// cloudflare-ai-budget), checks the worst case BEFORE each call, and counts what each call used.
// No share, no binding, or a refused check = no call (fail closed: never a bill).
import type { Env } from "../env";

/** Mistral Small 3.1 24B: sees pictures and writes; Apache-2.0, no licence to accept. */
export const FREE_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
// Neurons per token, from Cloudflare's price list for this model ($0.351 / $0.555 per M tokens at
// $0.011 per 1,000 neurons), rounded UP so the count can only over-state what was used.
export const NEURONS_PER_INPUT_TOKEN = 0.032;
export const NEURONS_PER_OUTPUT_TOKEN = 0.051;
/** A picture counts as this many input tokens in the worst case. */
export const IMAGE_TOKENS = 3000;
export const MAX_OUTPUT_TOKENS = 1500;

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

export const utcDay = (now = new Date()): string => now.toISOString().slice(0, 10);
export const budgetOf = (env: Pick<Env, "STUDIO_AI_BUDGET">): number => Math.max(0, Number(env.STUDIO_AI_BUDGET ?? 0) || 0);

/** Worst-case neurons for one call: characters / 3 as tokens (over-counts English), each picture IMAGE_TOKENS, the full output cap. Pure. */
export function worstCase(messages: ChatMessage[], maxTokens: number): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const p of m.content) {
        if (p.type === "text") chars += p.text.length;
        else images += 1;
      }
  }
  const input = Math.ceil(chars / 3) + images * IMAGE_TOKENS;
  return input * NEURONS_PER_INPUT_TOKEN + Math.min(maxTokens, MAX_OUTPUT_TOKENS) * NEURONS_PER_OUTPUT_TOKEN;
}

/** What one answered call used: the model's own token counts when it reports them, else the worst case. Pure. */
export function used(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, worst: number): number {
  if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return worst;
  return usage.prompt_tokens * NEURONS_PER_INPUT_TOKEN + usage.completion_tokens * NEURONS_PER_OUTPUT_TOKEN;
}

export type FreeAiResult = { ok: true; content: string; neurons: number; left: number } | { ok: false; why: "no_share" | "budget_out" | "failed"; left: number };

/** One call if the studio's share for today still covers its worst case; counts it either way. */
export async function freeAi(env: Env, messages: ChatMessage[], maxTokens: number, now = new Date()): Promise<FreeAiResult> {
  const budget = budgetOf(env);
  const day = utcDay(now);
  const row = await env.DB.prepare("SELECT neurons FROM ai_usage WHERE day = ?").bind(day).first<{ neurons: number }>();
  const spent = row?.neurons ?? 0;
  const left = Math.max(0, budget - spent);
  if (!budget || !env.AI) return { ok: false, why: "no_share", left };
  const worst = worstCase(messages, maxTokens);
  if (worst > left) {
    await env.DB.prepare("INSERT INTO ai_usage (day, refused) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET refused = refused + 1").bind(day).run();
    return { ok: false, why: "budget_out", left };
  }
  // Reserve the worst case first, so two jobs at once can never both pass the check and overspend.
  await env.DB.prepare("INSERT INTO ai_usage (day, neurons, calls) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1").bind(day, worst).run();
  try {
    const out = (await env.AI.run(FREE_AI_MODEL as never, { messages, max_tokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS) } as never)) as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const real = used(out?.usage, worst);
    // Give back what the worst case over-reserved.
    if (real < worst) await env.DB.prepare("UPDATE ai_usage SET neurons = neurons - ? WHERE day = ?").bind(worst - real, day).run();
    const content = typeof out?.response === "string" ? out.response : "";
    return content ? { ok: true, content, neurons: real, left: Math.max(0, left - real) } : { ok: false, why: "failed", left: Math.max(0, left - real) };
  } catch {
    // A failed call may still have been billed: keep the worst case counted.
    return { ok: false, why: "failed", left: Math.max(0, left - worst) };
  }
}
