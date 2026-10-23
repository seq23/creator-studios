// The free-model quota fix (23 Oct 2026): the OpenRouter key is on the free tier, 50 calls a day for
// every studio and the golden set together, and one dump used ~45 of them (one picture per video, one
// critic call per clip, six retries per failure), so golden-set went red at 0e0eebb. Fails when:
//   - a studio-intelligence job (cut, see, plan, critic, golden) reaches OpenRouter except through
//     the budgeted ladder in jobs/ai.py (openrouter_content imported or called directly);
//   - jobs/ai.py loses its per-job budget (at most 25), its daily-quota trip, or its per-provider
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
  else if (Number(budget[1]) > 25 || Number(budget[1]) < 1) problems.push(`jobs/ai.py: OPENROUTER_JOB_BUDGET ${budget[1]} must be 1..25 (the account has 50 free calls a day)`);
  if (!/def daily_quota_message\(/.test(ai) || !/daily_quota_message\(body\)/.test(ai)) problems.push("jobs/ai.py: a 429 for the used-up daily quota must stop further calls at once");
  if (!/"local_vlm": 0/.test(ai) || !/"openrouter": 0/.test(ai)) problems.push("jobs/ai.py: CALLS_BY must count calls per provider (openrouter, local_vlm)");
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
