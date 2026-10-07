// Automatic voice overs never go on a clip where she talks (owner, 26 Sep 2026). Checks the chain:
//   - the cut job measures how much of each clip is her talking (jobs/cut.py speech_share) and the
//     Worker stores it (worker/jobs/cut.ts clips.speech);
//   - isSilentClip (worker/domain/autoVoice.ts) says "no talking" only for a measured share under
//     15%; an unmeasured clip (null) counts as talking;
//   - EVERY place in worker/ that makes an automatic voice over (a narrations row with auto = 1, or
//     a call that passes `auto: true`) is in a file that filters its targets through isSilentClip,
//     and the dump entry point applies that filter before voicing;
//   - a unit test proves a talking clip is never voiced and an unmeasured one neither.
// Zero automatic-voice sites found fails (Rule 0): the scan would then be checking nothing.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

export default async function ({ root }) {
  const problems = [];
  const read = (f) => readFile(path.join(root, f), "utf8").catch(() => "");
  let items = 0;

  // 1. the rule itself
  const domain = await read("worker/domain/autoVoice.ts");
  const below = Number(domain.match(/export const SILENT_BELOW = ([0-9.]+);/)?.[1]);
  items++;
  if (!(below > 0 && below <= 0.15)) problems.push("worker/domain/autoVoice.ts: SILENT_BELOW must be set and at most 0.15 (under ~15% talking)");
  items++;
  if (!/export function isSilentClip\([^)]*\)[^{]*\{\s*return typeof speech === "number" && Number\.isFinite\(speech\) && speech >= 0 && speech < SILENT_BELOW;/.test(domain))
    problems.push("worker/domain/autoVoice.ts: isSilentClip must be true only for a measured share under SILENT_BELOW (null counts as talking)");

  // 2. every automatic voice over is behind isSilentClip
  const files = await walk(path.join(root, "worker"));
  let sites = 0;
  for (const abs of files) {
    const rel = path.relative(root, abs);
    const src = await readFile(abs, "utf8");
    const autoInsert = /INSERT INTO narrations\s*\([^)]*\bauto\b/.test(src);
    const autoTrue = /\bauto:\s*true\b/.test(src);
    if (!autoInsert && !autoTrue) continue;
    sites++;
    items++;
    if (!/isSilentClip\(/.test(src)) problems.push(`${rel}: makes automatic voice overs but never filters clips through isSilentClip`);
  }
  if (!sites) problems.push("no automatic voice over site found in worker/ (Rule 0: nothing to check; the scan is stale)");
  const lib = await read("worker/lib/autoVoice.ts");
  const dump = lib.match(/export async function autoVoiceDump[\s\S]*?\n}\n/)?.[0] ?? "";
  items++;
  if (!dump) problems.push("worker/lib/autoVoice.ts: autoVoiceDump is gone");
  else {
    const filter = dump.indexOf("isSilentClip(");
    const voice = dump.indexOf("voiceClips(");
    if (filter < 0 || voice < 0 || filter > voice) problems.push("worker/lib/autoVoice.ts: autoVoiceDump must filter its targets through isSilentClip before voiceClips");
  }

  // 3. the measurement reaches the rule
  items++;
  if (!(await read("jobs/cut.py")).includes('"speech": speech_share(')) problems.push("jobs/cut.py: clips no longer carry their measured speech share");
  items++;
  if (!/INSERT INTO clips[\s\S]{0,400}\bspeech\b/.test(await read("worker/jobs/cut.ts"))) problems.push("worker/jobs/cut.ts: clips.speech is no longer stored");

  // 4. a test proves it
  const test = await read("tests/unit/auto-voice.test.ts");
  items++;
  if (!test.includes("a clip where she talks is never voiced")) problems.push("tests/unit/auto-voice.test.ts: the test that a talking clip is never voiced is missing");
  items++;
  if (!test.includes("isSilentClip(null)")) problems.push("tests/unit/auto-voice.test.ts: the test that an unmeasured clip counts as talking is missing");

  return { items, problems };
}
