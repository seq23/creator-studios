// Studio fix A (owner's review of the Oct 22 cut, 23 Oct 2026): the clip engine keeps its side of the
// contract with the Worker, and every fix is wired in, not merely written. One item per rule; a
// missing one fails with what it stopped doing.
import { readFile } from "node:fs/promises";
import path from "node:path";

const RULES = [
  ["jobs/cut.py", /CM\.plan_typed\(/, "clips are planned by type from the playbook"],
  ["jobs/cut.py", /ST\.build_looks\(/, "every shot gets a stage, heroes are picked"],
  ["jobs/cut.py", /ST\.quality_track\(/, "blurry and shaky seconds are measured"],
  ["jobs/cut.py", /ST\.event_groups\(/, "photos of different events are never mixed"],
  ["jobs/cut.py", /photo_video\(raw, norm\)/, "photos are turned into shots"],
  ["jobs/cut.py", /add_hero_ending\(/, "speech-picked clips end on the hero too"],
  ["jobs/cut.py", /look_fits\(/, "a grid never repeats a picture"],
  ["jobs/cut.py", /CM\.score_clip\(/, "the score is the real checks"],
  ["jobs/cut.py", /improve_moment\(/, "a clip under the bar is re-cut once"],
  ["jobs/cut.py", /CM\.final_words\(/, "the caption is built in the contract layout"],
  ["jobs/cut.py", /distinct_moments\(/, "distinct cuts only"],
  ...["clip_type", "score_reasons", "hero_asset_id", "files_used", "uses_ai_images", "event_group", "words_pending", "voice_script"].map((k) => ["jobs/cut.py", new RegExp(`"${k}":`), `every clip carries ${k}`]),
  ["jobs/cut.py", /"asset_roles": ST\.asset_roles\(/, "the dump reports each upload's stage"],
  ["jobs/cut.py", /"clip_counts":/, "the dump reports its distinct clips"],
  ["jobs/clipmaker.py", /DIVIDER = "(\u2014|\\u2014)"/, "the AI note's divider (an em dash)"],
  ["jobs/clipmaker.py", /AI_NOTE = "Made with AI"/, "the AI note's words"],
  ["jobs/clipmaker.py", /f"\{out\}\\n\\n\{DIVIDER\}\\n\{AI_NOTE\}"/, "the AI note sits after a blank line and the divider"],
  ["jobs/plan.py", /SC\.clean_line\(/, "the copy writer rejects reasoning-shaped words"],
  ["jobs/plan.py", /SC\.clean_script\(/, "the voice-over script is cleaned"],
  ["jobs/voice.py", /SCL\.clean_script\(/, "the voice job never speaks reasoning"],
  ["jobs/golden.py", /GP\.run_all\(\)/, "the weekly golden set runs the playbook set"],
  ["jobs/tests/test_studio_fix.py", /Analyze the Request/, "the real failure is pinned in a test"],
];

export default async function ({ root }) {
  const problems = [];
  const cache = new Map();
  for (const [file, re, what] of RULES) {
    if (!cache.has(file)) cache.set(file, await readFile(path.join(root, file), "utf8"));
    if (!re.test(cache.get(file))) problems.push(`${file} no longer does it: ${what}`);
  }
  const pb = JSON.parse(await readFile(path.join(root, "jobs/playbook.json"), "utf8"));
  const types = Object.entries(pb.types ?? {});
  if (types.length < 11) problems.push(`jobs/playbook.json has ${types.length} clip types, the library has 11`);
  for (const [id, t] of types) if (t.ending !== "hero") problems.push(`jobs/playbook.json: ${id} does not end on the hero`);
  return { items: RULES.length + types.length, problems };
}
