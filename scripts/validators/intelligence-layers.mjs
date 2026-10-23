// Studio intelligence (owner's plan, 22 Oct 2026): every layer is wired into the cut, not merely
// written. A layer whose module exists but that nothing calls is "exists but nothing invokes it".
// One item per layer; a missing call fails with the layer's name.
import { readFile } from "node:fs/promises";
import path from "node:path";

const LAYERS = [
  ["1 know the business", "jobs/cut.py", /P\.shapes_fit\(profile, service\)/, "the Brand Profile's shapes decide the story shape"],
  ["1 know the business", "jobs/cut.py", /P\.service_looks\(spec\.get\("brand_profile"\), services\)/, "what each service looks like reaches the shot sheet"],
  ["1 know the business", "shared/constants.ts", /key: "service_looks"[\s\S]*key: "video_shapes"/, "the Brand Profile has both sections"],
  ["2 see", "jobs/cut.py", /V\.see_videos\(/, "every video gets a shot sheet"],
  ["3 hear", "jobs/cut.py", /H\.sound_segments\(/, "the sound is labelled"],
  ["3 hear", "jobs/cut.py", /H\.caption_words\(/, "only talk to the camera becomes captions"],
  ["4 plan", "jobs/cut.py", /P\.plan_clips\(/, "the story is planned from the sheets"],
  ["5 protect", "jobs/cut.py", /PR\.protect_video\(/, "faces and house numbers are blurred"],
  ["5 protect", "jobs/cut.py", /P\.write_copy\(key, plans,[^\n]*guard=text_ok/, "the never-list and prices guard the words"],
  ["5 protect", "worker/jobs/cut.ts", /content_rules: contentRules\(env\)/, "the cut spec carries the rules"],
  ["5 protect", "worker/crons/buffer-sync.ts", /withAiLabel\(/, "an AI voice over is labelled"],
  ["6 critic", "jobs/cut.py", /C\.critic_rounds\(/, "the critic checks and re-cuts"],
  ["7 plain line + questions", "app/components/LooksLikeLine.tsx", /\/api\/dumps\/\$\{dumpId\}\/answer/, "one-tap answers"],
  ["7 plain line + questions", "jobs/cut.py", /P\.mark_before\(/, "her before answer reaches the cut"],
  ["8 memory", "worker/jobs/cut.ts", /memory: await loadMemory\(env\)/, "the cut spec carries Studio Memory"],
  ["8 memory", "jobs/cut.py", /memory=memory/, "the copy and the critic read it"],
  ["9 golden + switch", "jobs/golden.py", /len\(SCENES\) < 6/, "the golden set covers six businesses"],
  ["9 golden + switch", "jobs/cut.py", /P\.careful_quota\(/, "the careful approach changes the cut"],
];

export default async function ({ root }) {
  const problems = [];
  const cache = new Map();
  for (const [layer, file, re, what] of LAYERS) {
    if (!cache.has(file)) cache.set(file, await readFile(path.join(root, file), "utf8"));
    if (!re.test(cache.get(file))) problems.push(`layer ${layer}: ${file} no longer does it (${what})`);
  }
  return { items: LAYERS.length, problems };
}
