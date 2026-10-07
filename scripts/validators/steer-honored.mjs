// Steering (owner, 26 Sep 2026): an instruction is followed, or the dump says why not; never
// silently dropped. For every control in shared/steer.ts STEER_KEYS this checks the whole chain
// exists: a note fixture reads it (tests/unit/fixtures/steer-notes.json), the Worker maps it into
// the cut spec (worker/jobs/cut.ts), the job honors it (jobs/cut.py / jobs/looks.py), and a test
// proves it (tests/unit/steer.test.ts spec tests, jobs/selftest_cut.py check_steer). Voice over is
// honored after the cut, by the automatic voice overs (worker/lib/autoVoice.ts voicePlans). A control
// with a missing link is a chip or a note that does nothing. Zero controls fails (Rule 0).
import { readFile } from "node:fs/promises";
import path from "node:path";

// control → [file, the code that carries it]
const CHAIN = {
  looks: [["worker/jobs/cut.ts", "rotationFor(ctl.looks"], ["jobs/cut.py", 'a_steer.get("rotation")'], ["jobs/selftest_cut.py", '"rotation": ["grid_eight"]']],
  music: [["worker/jobs/cut.ts", "steerMusic("], ["jobs/cut.py", "music_key("], ["jobs/selftest_cut.py", 'c["music"] != song["r2_key"]']],
  pace: [["worker/jobs/cut.ts", "steerLook("], ["worker/domain/steer.ts", 'c.pace === "fast"'], ["jobs/selftest_cut.py", '"punch_in": True']],
  length: [["worker/jobs/cut.ts", "steerRecipes("], ["jobs/cut.py", 'st.get("recipes")'], ["jobs/selftest_cut.py", "longer than the short length"]],
  count: [["worker/jobs/cut.ts", "steerTarget("], ["jobs/cut.py", '(spec.get("steer") or {}).get("count")'], ["jobs/selftest_cut.py", "asked for 2 clips"]],
  captions: [["worker/jobs/cut.ts", "steerLook("], ["worker/domain/steer.ts", "out.captions = c.captions"], ["tests/unit/steer.test.ts", 'l!.captions === "none"']],
  platforms: [["worker/jobs/cut.ts", "steerPlatforms("], ["tests/unit/steer.test.ts", "allowed_platforms"]],
  voice: [["worker/lib/autoVoice.ts", "voiceFor(mergeControls(chips, note"], ["worker/domain/autoVoice.ts", "export function voiceFor("], ["worker/jobs/cut.ts", "askedVoice.includes(\"quiet\")"], ["tests/unit/auto-voice.test.ts", "the Voice over chip"]],
  include: [["worker/jobs/cut.ts", "include: ctl.include"], ["jobs/cut.py", "apply_steer("], ["jobs/selftest_cut.py", "she asked to include is missing"]],
  avoid: [["worker/jobs/cut.ts", "avoid: ctl.avoid"], ["jobs/cut.py", "apply_steer("], ["jobs/selftest_cut.py", "she asked to leave out was kept"]],
};

export default async function ({ root }) {
  const problems = [];
  const shared = await readFile(path.join(root, "shared", "steer.ts"), "utf8");
  const keys = [...(shared.match(/export const STEER_KEYS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const fixtures = JSON.parse(await readFile(path.join(root, "tests", "unit", "fixtures", "steer-notes.json"), "utf8"));
  const read = new Set(fixtures.cases.flatMap((c) => Object.keys(c.controls)));
  const cache = new Map();
  const text = async (f) => (cache.has(f) ? cache.get(f) : (cache.set(f, await readFile(path.join(root, f), "utf8").catch(() => "")), cache.get(f)));
  for (const k of keys) {
    if (!read.has(k)) problems.push(`${k}: no note in tests/unit/fixtures/steer-notes.json reads it`);
    const chain = CHAIN[k];
    if (!chain) {
      problems.push(`${k}: a control with no chain here: add where the Worker maps it, the job honors it and a test proves it`);
      continue;
    }
    for (const [f, token] of chain) if (!(await text(f)).includes(token)) problems.push(`${k}: ${f} no longer has ${token}`);
  }
  if (!(await text("jobs/selftest_cut.py")).includes("check_steer(tmp, problems, heavy)")) problems.push("jobs/selftest_cut.py no longer runs check_steer");
  return { items: keys.length, problems };
}
