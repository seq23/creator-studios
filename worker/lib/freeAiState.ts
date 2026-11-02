// "Today's free AI is used up" (owner, 2 Nov 2026, every studio): both free sources are spent for
// the UTC day. The ladder is OpenRouter's free models first, then this studio's share of Cloudflare
// Workers AI (worker/lib/freeAi.ts), so a refused share call means OpenRouter had already not
// answered; OpenRouter's own free daily limit is the named setting DAILY_LIMIT_KEY (wordsPass.ts).
// The app shows a calm note with how to connect her own OpenRouter key (app/components/FreeAiNote.tsx).
// Nothing here spends: it only reads. The host's key never pays (free models only).
import type { Env } from "../env";
import { getSetting } from "./db";
import { budgetOf, utcDay } from "./freeAi";

/** The setting that holds "OpenRouter's free daily limit is reached until <iso>" (written by wordsPass.ts, cleared on reset). */
export const DAILY_LIMIT_KEY = "openrouter_daily_limit_until";

/** Fewer neurons than this left in the share cannot cover one words call: the share counts as spent. */
export const SMALLEST_CALL_NEURONS = 60;

/** True when today's free AI (OpenRouter free models + this studio's Workers AI share) is used up. Read-only. */
export async function freeAiUsedUp(env: Pick<Env, "DB" | "AI" | "STUDIO_AI_BUDGET">, now = new Date()): Promise<boolean> {
  const row = await env.DB.prepare("SELECT neurons, refused FROM ai_usage WHERE day = ?")
    .bind(utcDay(now))
    .first<{ neurons: number; refused: number }>()
    .catch(() => null);
  if ((row?.refused ?? 0) > 0) return true;
  const budget = budgetOf(env);
  const shareOut = !budget || !env.AI || budget - (row?.neurons ?? 0) < SMALLEST_CALL_NEURONS;
  if (!shareOut) return false;
  const until = await getSetting<string | null>(env.DB, DAILY_LIMIT_KEY, null).catch(() => null);
  return !!until && until > now.toISOString();
}
