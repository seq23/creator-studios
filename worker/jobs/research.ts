// Research Brief from her data + web + her uploads (BUILD_PLAN.md section 6). jobs/research.py
// fetches this spec, searches the web (jobs/common.py Web: Firecrawl when she connected it, else
// the free keyless search, so it never needs a key), reads her uploaded reports, and asks an OpenRouter free model to draft a
// BriefBody (shared/types.ts) citing only the sources it was given. The Worker then enforces
// the truth rules (domain/brief.ts) before storing a new draft version.
import type { JobHandler } from "./registry";
import type { Env } from "../env";
import { DEFAULT_FEATURES, DEFAULT_WEEKLY_CAPS, LAUNCH_SLOTS, PLATFORMS, type Platform } from "@shared/constants";
import type { BriefBody, BriefSource, Features } from "@shared/types";
import { getConnectionSecret } from "../lib/connections";
import { getSetting, parseJson, recordEvent } from "../lib/db";
import { log } from "../lib/log";
import { BASELINE_SOURCES, enforceTruth, shapeProblems, sourceProblems } from "../domain/brief";
import { bucketByTime, historyDays } from "../domain/learning";
import { FREE_MODEL } from "../services/openrouter";
import { readSettings } from "../routes/settings";
import { loadObservations } from "./metrics";
import { buildFakeBrief } from "./research_fake";

export const RESEARCH_SYSTEM = `You write a Research Brief for a short-form video creator. Answer with ONE JSON object only.
Keys: "audience": Claim[], "themes": [{"title": string, "claims": Claim[]}] (3 to 5 themes), "hooks": Claim[] (hook formulas in her voice),
"cut_styles": Claim[] (cut styles and lengths to favor), "comparable_creators": [{"handle": string, "platform": "tiktok"|"instagram"|"youtube", "why": Claim}],
"shot_list": Claim[] (5 to 8 things to film next).
Claim = {"text": string, "source_ids": string[], "basis": "her_data"|"web"|"upload", "confidence": "solid"|"uncertain"}.
TRUTH RULES: cite only source ids from the SOURCES list. Every claim cites at least one source unless it is marked "uncertain".
basis is "her_data" for her profile or her own numbers, "web" for web sources, "upload" for reports she uploaded.
Weak, indirect or conflicting evidence is "uncertain". Never invent numbers, creators or studies. Name a creator only if a web source names them.
Plain words, short sentences.`;

export interface ResearchResult {
  body: BriefBody;
  sources: BriefSource[];
}

async function herData(env: Env) {
  const s = await readSettings(env);
  const obs = await loadObservations(env);
  const buckets = bucketByTime(obs, s.audience_timezone);
  const summary = {} as Record<Platform, { videos: number; avg_views: number; history_days: number; top_times: { day: number; hour: number; avg_views: number; posts: number }[] }>;
  for (const p of PLATFORMS) {
    const mine = obs.filter((o) => o.platform === p);
    summary[p] = {
      videos: mine.length,
      avg_views: mine.length ? Math.round(mine.reduce((a, o) => a + o.views, 0) / mine.length) : 0,
      history_days: historyDays(obs, p),
      top_times: buckets.filter((b) => b.platform === p).slice(0, 5).map(({ day, hour, avg_views, posts }) => ({ day, hour, avg_views, posts })),
    };
  }
  const { results: accounts } = await env.DB.prepare(
    "SELECT a.platform, a.followers, a.avg_views, a.captured_at, a.source FROM account_stats a WHERE a.captured_at = (SELECT MAX(b.captured_at) FROM account_stats b WHERE b.platform = a.platform)",
  ).all<{ platform: Platform; followers: number; avg_views: number; captured_at: string; source: string }>();
  return { summary, accounts, learned_slots: await getSetting(env.DB, "learned_slots", {}), timezone: s.audience_timezone };
}

async function buildSpec(env: Env, jobId: string) {
  const profile = await env.DB.prepare("SELECT sections FROM brand_profile WHERE locked = 1 ORDER BY version DESC LIMIT 1").first<{ sections: string }>();
  const { results: uploads } = await env.DB.prepare("SELECT id, file_name, r2_key FROM research_uploads ORDER BY uploaded_at DESC LIMIT 10").all<{ id: string; file_name: string; r2_key: string }>();
  const present: typeof uploads = [];
  for (const u of uploads) if (await env.FILES.head(u.r2_key)) present.push(u);
  const features = await getSetting<Features>(env.DB, "features", { ...DEFAULT_FEATURES });
  return {
    job_id: jobId,
    type: "research",
    profile: parseJson(profile?.sections, null),
    her_data: await herData(env),
    uploads: present.map((u) => ({ id: u.id, source_id: `up_${u.id}`, title: u.file_name, r2_key: u.r2_key, ext: (u.file_name.split(".").pop() ?? "").toLowerCase().slice(0, 5) })),
    baseline: { basis: "BUILD_PLAN.md section 10b", slots: LAUNCH_SLOTS, caps: DEFAULT_WEEKLY_CAPS, sources: BASELINE_SOURCES },
    features: { deeper_research: !!features.deeper_research },
    // Firecrawl is optional: without it the job searches with the free keyless path (jobs/common.py Web).
    keys: { openrouter: await getConnectionSecret(env, "openrouter"), firecrawl: await getConnectionSecret(env, "firecrawl") },
    model: FREE_MODEL,
    deeper_model: "perplexity/sonar",
    system: RESEARCH_SYSTEM,
  };
}

export const researchJob: JobHandler = {
  async buildSpec(env, jobId) {
    return buildSpec(env, jobId);
  },

  async applyResult(env, jobId, refId, raw) {
    void refId;
    const r = (raw ?? {}) as Partial<ResearchResult>;
    const problems = [...sourceProblems(r.sources), ...shapeProblems(r.body)];
    if (problems.length) {
      log.error("research.apply.invalid", { problems: problems.length });
      throw new Error(`brief failed shape check (${problems.length} problems)`);
    }
    const sources = r.sources as BriefSource[];
    const body = enforceTruth(r.body as BriefBody, sources);
    await env.DB.prepare("UPDATE research_briefs SET status = 'superseded' WHERE status = 'draft'").run();
    const res = await env.DB.prepare("INSERT INTO research_briefs (body, sources, status) VALUES (?, ?, 'draft')").bind(JSON.stringify(body), JSON.stringify(sources)).run();
    await recordEvent(env.DB, "brief.drafted", jobId, { version: res.meta.last_row_id, sources: sources.length });
    log.info("research.apply", { sources: sources.length });
  },

  async onFailure(env, jobId, refId, safeError) {
    void refId;
    await recordEvent(env.DB, "brief.failed", jobId, { len: safeError.length });
    log.warn("research.failed");
  },

  async fakeRun(env, jobId) {
    const spec = await buildSpec(env, jobId);
    const stats: Partial<Record<Platform, { videos: number }>> = {};
    for (const p of PLATFORMS) stats[p] = { videos: spec.her_data.summary[p].videos };
    return buildFakeBrief({ stats, uploads: spec.uploads.map((u) => ({ id: u.id, title: u.title })) });
  },
};
