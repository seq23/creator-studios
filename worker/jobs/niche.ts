// The monthly niche research (studio fix, 23 Oct 2026): jobs/niche_research.py reads the spec,
// searches the free web for what converts in this studio's niche and asks the free AI ladder to
// boil it down; the Worker checks and stores it (worker/lib/niche.ts). $0 only. No storage scope.
import { failBrief, storeBrief } from "../lib/nicheBrief";
import { sendWaitingDumps } from "../routes/dumps";
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { getConnectionSecret } from "../lib/connections";
import { parseJson, setHealth } from "../lib/db";
import { log } from "../lib/log";
import { servicesOf } from "@shared/services";
import { readStudioRules } from "../lib/studioRules";
import { chosenCtas } from "@shared/studioRules";
import { NICHE_HEALTH, storePlaybook } from "../lib/niche";
import { PROFILE_IN_USE } from "../lib/profileInUse";

export interface NicheSpec {
  job_id: string;
  type: "niche";
  llm_key: string | null;
  /** The Brand Profile's own words about the business (who, audience, themes, services, calls to action). */
  profile: { who: string; audience: string; themes: string; ctas: string };
  services: string[];
  place_words: string[];
  platforms: string[];
  /** "2026-10": which month this is for. */
  month: string;
  /** Did the studio choose a call to action (opt-in, shared/studioRules.ts)? No call-to-action tips without one. */
  has_cta: boolean;
  /** A creator studio (nothing it sells on camera): researched through successful public creators in her niche. */
  creator: boolean;
  /** "brief": the once-per-new-user niche brief (worker/lib/nicheBrief.ts), not the monthly playbook. */
  mode?: "brief";
}

async function buildSpec(env: Env, jobId: string, refId: string | null = null): Promise<NicheSpec> {
  const row = await env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
  const sections = row ? parseJson<Record<string, string>>(row.sections, {}) : {};
  const cut = (k: string) => String(sections[k] ?? "").slice(0, 1200);
  const rules = await readStudioRules(env);
  return {
    job_id: jobId,
    type: "niche",
    llm_key: await getConnectionSecret(env, "openrouter"),
    profile: { who: cut("who"), audience: cut("audience"), themes: cut("themes"), ctas: cut("ctas") },
    services: servicesOf(row ? sections : null),
    place_words: rules.place_words,
    platforms: ["tiktok", "instagram", "facebook", "pinterest", "youtube"],
    month: new Date().toISOString().slice(0, 7),
    has_cta: chosenCtas(rules, cut("ctas")).length > 0 || !!rules.cta_link,
    creator: !rules.cta_link && /\b(creator|influencer)\b/i.test(cut("who")),
    ...(refId?.startsWith("brief/") ? { mode: "brief" as const } : {}),
  };
}

async function applyResult(env: Env, jobId: string, refId: string | null, result: unknown): Promise<void> {
  if (refId?.startsWith("brief/")) {
    // Her niche brief is in: the first dump that waited on it goes by itself.
    if (await storeBrief(env, refId.slice(6), result)) await sendWaitingDumps(env, null);
    return;
  }
  const id = await storePlaybook(env, jobId, result);
  log.info("niche.apply", { stored: !!id });
}

async function onFailure(env: Env, _jobId: string, refId: string | null): Promise<void> {
  if (refId?.startsWith("brief/")) return failBrief(env, refId.slice(6));
  await setHealth(env.DB, NICHE_HEALTH, "yellow", "The niche research did not finish; it tries again within a few days. Your clips use the last one meanwhile.", null);
}

/** FAKE_SERVICES=1: a realistic, business-neutral playbook (or brief). */
async function fakeRun(_env: Env, _jobId: string, refId: string | null): Promise<unknown> {
  if (refId?.startsWith("brief/"))
    return {
      brief: {
        buyer: "Someone planning an event for someone else, who wants it done for them.",
        competitors: [1, 2, 3, 4, 5, 6].map((i) => ({ name: `Sample account ${i}`, handle: `@sample_account_${i}`, platform: "tiktok", url: `https://www.tiktok.com/@sample_account_${i}` })),
        hooks: ["POV: they think you did all this", "Wait for the reveal…", "Hosting and already tired?"],
        caption_patterns: ["Say who it is for and the ease, never what is on screen"],
        cta_patterns: ["One ask, one link"],
        avoid: ["Describing what the viewer can already see"],
        channels: { tiktok: { hashtags: "3-4, town and occasion", norms: "10-30 s" } },
      },
      sources: ["https://www.tiktok.com/@sample_account_1"],
    };
  return {
    playbook: {
      formats: ["Before and after with the finished result in the first second", "Set up with me, sped up, ending on the finished look", "A slow pan across the finished details"],
      hooks: ["POV: you walk in and see this", "Wait for the reveal", "From empty to finished in 20 seconds"],
      caption_tips: ["Say the town name in the first line", "End with the request link, not a phone number", "Ask people to send it to someone planning an event"],
    },
    summary: ["Show the finished result in the first second, then how it came together.", "Openings like “POV: you walk in” keep people watching.", "Put your town in the caption and end with your request link."],
    sources: 6,
  };
}

export const nicheJob: JobHandler = { buildSpec, applyResult, onFailure, fakeRun };
