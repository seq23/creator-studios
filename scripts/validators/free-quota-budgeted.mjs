// The free-model quota fix (23 Oct 2026): the OpenRouter key was then on the free tier, 50 calls a day
// for every studio and the golden set together, and one dump used ~45 of them (one picture per video, one
// critic call per clip, six retries per failure), so golden-set went red at 0e0eebb. Fails when:
//   - a studio-intelligence job (cut, see, plan, critic, golden) reaches OpenRouter except through
//     the budgeted ladder in jobs/ai.py (openrouter_content imported or called directly);
//   Since 24 Oct 2026 the host key is the owner's $0-routing account (1,000 free calls a day, shared
//   with her other repos; the studios keep to ~500). Also fails when:
//   - STUDIOS_DAILY_CEILING in jobs/ai.py is missing or above 500, a job's budget is over 60 or over a
//     tenth of the ceiling, the words reserve is under 4 or over half the budget, or the Worker's hourly
//     words pass (WORDS_PER_RUN x 24 x every studio carrying the host OpenRouter key) could spend more
//     than 80% of the ceiling on its own;
//   - jobs/ai.py loses its per-job budget, its daily-quota trip, or its per-provider
//     counts with the local $0 model;
//   - the shot sheet or the critic stops batching (BATCH_VIDEOS / BATCH_CLIPS under 2);
//   - the cut job stops logging and returning its calls per provider.
import { readFile } from "node:fs/promises";
import path from "node:path";

const INTELLIGENCE = ["cut.py", "see.py", "plan.py", "critic.py", "golden.py"];

export default async function ({ root }) {
  const read = (f) => readFile(path.join(root, "jobs", f), "utf8");
  const problems = [];
  let items = 0;
  for (const f of INTELLIGENCE) {
    const text = await read(f);
    items += 1;
    if (/^\s*from common import[^\n]*\bopenrouter_content\b/m.test(text) || /\bopenrouter_content\(/.test(text.replace(/^\s*#.*$/gm, "").replace(/"""[\s\S]*?"""/g, ""))) {
      problems.push(`jobs/${f}: calls OpenRouter outside the budgeted ladder; use jobs/ai.py (ask_openrouter / see.ask_vision / cut.or_text)`);
    }
  }
  const ai = await read("ai.py");
  items += 1;
  const budget = ai.match(/OPENROUTER_JOB_BUDGET = int\(os\.environ\.get\("OPENROUTER_JOB_BUDGET", "(\d+)"\)\)/);
  if (!budget) problems.push("jobs/ai.py: OPENROUTER_JOB_BUDGET (the per-job cap) is missing");
  const ceiling = ai.match(/^STUDIOS_DAILY_CEILING = (\d+)$/m);
  const reserve = ai.match(/WORDS_RESERVE = int\(os\.environ\.get\("OPENROUTER_WORDS_RESERVE", "(\d+)"\)\)/);
  if (!ceiling || Number(ceiling[1]) < 1 || Number(ceiling[1]) > 500) problems.push("jobs/ai.py: STUDIOS_DAILY_CEILING must be 1..500 (the studios' share of the account's 1,000 free calls a day, shared with her other repos)");
  const cap = ceiling ? Number(ceiling[1]) : 500;
  if (budget && (Number(budget[1]) > 60 || Number(budget[1]) < 1 || Number(budget[1]) > cap / 10)) problems.push(`jobs/ai.py: OPENROUTER_JOB_BUDGET ${budget[1]} must be 1..60 and at most a tenth of STUDIOS_DAILY_CEILING ${cap}`);
  if (!reserve) problems.push("jobs/ai.py: OPENROUTER_WORDS_RESERVE (calls the picker may never spend) is missing");
  else if (budget && (Number(reserve[1]) < 4 || Number(reserve[1]) > Number(budget[1]) / 2)) problems.push(`jobs/ai.py: OPENROUTER_WORDS_RESERVE ${reserve[1]} must be 4..half of OPENROUTER_JOB_BUDGET`);
  const words = await readFile(path.join(root, "worker", "lib", "wordsPass.ts"), "utf8");
  items += 1;
  const perRun = words.match(/^export const WORDS_PER_RUN = (\d+);/m);
  const studioDir = path.join(root, "studios");
  const { readdir } = await import("node:fs/promises");
  let keyed = 0;
  for (const f of (await readdir(studioDir)).filter((n) => n.endsWith(".json") && n !== "themes.json")) {
    const s = JSON.parse(await readFile(path.join(studioDir, f), "utf8"));
    items += 1;
    if ((s.hostKeys ?? []).includes("OPENROUTER_API_KEY")) keyed += 1;
  }
  if (!perRun) problems.push("worker/lib/wordsPass.ts: WORDS_PER_RUN (clips per hourly words pass) is missing");
  else if (keyed === 0) problems.push("studios/*.json: no studio carries the host OpenRouter key; the words-lane check read nothing");
  else if (Number(perRun[1]) * 24 * keyed > cap * 0.8) problems.push(`worker/lib/wordsPass.ts: WORDS_PER_RUN ${perRun[1]} x 24 runs x ${keyed} keyed studios could spend over 80% of STUDIOS_DAILY_CEILING ${cap} on words alone`);
  if (!/def daily_quota_message\(/.test(ai) || !/daily_quota_message\(body\)/.test(ai)) problems.push("jobs/ai.py: a 429 for the used-up daily quota must stop further calls at once");
  if (!/"local_vlm": 0/.test(ai) || !/"openrouter": 0/.test(ai) || !/"cloudflare": 0/.test(ai)) problems.push("jobs/ai.py: CALLS_BY must count calls per provider (openrouter, cloudflare, local_vlm)");
  // Cloudflare Workers AI (owner, 23 Oct 2026): only through the studio's own share; a refusal stops it for the job.
  if (!/def ask_cloudflare\(/.test(ai) || !/STATE\["cloudflare_out"\] = True/.test(ai)) problems.push("jobs/ai.py: Cloudflare must go through ask_cloudflare, and a refused share must stop further Cloudflare calls in the job");
  const see = await read("see.py");
  const critic = await read("critic.py");
  const bv = see.match(/^BATCH_VIDEOS = (\d+)/m);
  const bc = critic.match(/^BATCH_CLIPS = (\d+)/m);
  if (!bv || Number(bv[1]) < 2) problems.push("jobs/see.py: BATCH_VIDEOS must be 2 or more (several videos per shot-sheet call)");
  if (!bc || Number(bc[1]) < 2) problems.push("jobs/critic.py: BATCH_CLIPS must be 2 or more (several clips per critic call)");
  const cut = await read("cut.py");
  if (!/V\.see_videos\(/.test(cut)) problems.push("jobs/cut.py: shot sheets must go through see.see_videos (batched, saved sheets never looked at again)");
  if (!/C\.critic_rounds\(/.test(cut)) problems.push("jobs/cut.py: the critic must run as critic_rounds (batched per round)");
  if (!/log\("ai\.calls", \*\*A\.report\(\)\)/.test(cut)) problems.push("jobs/cut.py: must log ai.calls per provider at the end of a cut");
  return { items, problems };
}
