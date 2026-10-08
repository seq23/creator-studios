// The host's own OpenRouter, Resend, Firecrawl and Hunter, for a host-accounts studio ONLY (owner
// decisions 7 Oct 2026, README "Hadiyah: whose account runs what"). Hadiyah's studio runs AI
// writing, studio email, web research and brand contacts on the host's personal accounts when she
// has not pasted her own on Setup; a client studio
// (Sample 1/2/3) never reads these Worker secrets, even if someone sets them on its Worker.
//
// The ONE place that reads OPENROUTER_API_KEY, FIRECRAWL_API_KEY, HUNTER_API_KEY and
// STUDIO_EMAIL_FROM from the Worker env (validator `host-keys-host-only`). hydrate()
// (worker/lib/practice.ts) calls hostBase() first, so for a client studio these names are gone
// before anything else sees the env.
import type { Env } from "../env";

/** Worker secrets only a host-accounts studio may carry (scripts/studio.mjs secretPlan refuses them for a client). */
export const HOST_FALLBACK_SECRETS = ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM", "FIRECRAWL_API_KEY", "HUNTER_API_KEY"] as const;

/** The pasted-key services (connections rows) the host's key stands in for, and the secret that holds it. */
export const HOST_KEY_SERVICES = { openrouter: "OPENROUTER_API_KEY", firecrawl: "FIRECRAWL_API_KEY", hunter: "HUNTER_API_KEY" } as const;
export type HostKeyService = keyof typeof HOST_KEY_SERVICES;
export const isHostKeyService = (service: string): service is HostKeyService => Object.hasOwn(HOST_KEY_SERVICES, service);

/** The studio kind from its registry entry (var STUDIO_KIND). Anything but "host-accounts" is a client. */
export const hostAccounts = (env: Pick<Env, "STUDIO_KIND">): boolean => env.STUDIO_KIND === "host-accounts";

/**
 * The env a request starts from, before stored (Setup) keys are laid over it. Pure.
 *  - client studio: the host fallback secrets are removed, whatever the Worker holds.
 *  - host-accounts studio: the host's Resend sends from STUDIO_EMAIL_FROM, with replies going to
 *    the host developer (DEVELOPER_EMAIL), whose account the sender is.
 */
export function hostBase(env: Env): Env {
  const out: Env = { ...env };
  if (!hostAccounts(env)) {
    for (const k of HOST_FALLBACK_SECRETS) delete (out as unknown as Record<string, unknown>)[k];
    delete out.RESEND_REPLY_TO;
    return out;
  }
  if (out.RESEND_API_KEY) {
    if (out.STUDIO_EMAIL_FROM && !out.RESEND_FROM) out.RESEND_FROM = out.STUDIO_EMAIL_FROM;
    if (out.DEVELOPER_EMAIL) out.RESEND_REPLY_TO = out.DEVELOPER_EMAIL;
  }
  return out;
}

/** The host's key for a service when none is stored on Setup: host-accounts studios only, else null. */
export function hostKeyFor(env: Pick<Env, "STUDIO_KIND" | "OPENROUTER_API_KEY" | "FIRECRAWL_API_KEY" | "HUNTER_API_KEY">, service: string): string | null {
  if (!hostAccounts(env) || !isHostKeyService(service)) return null;
  return env[HOST_KEY_SERVICES[service]] || null;
}
