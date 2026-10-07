// A full video for YouTube (the third door on Dump) goes up WHOLE: it never goes through the cutter
// and is never reframed to 9:16 (owner, 26 Sep 2026). Every link of that promise is checked:
//   - the Dump button sends a full-video dump to its own job before anything that cuts;
//   - the cutter and the connected-editor path both refuse a full-video dump;
//   - the job (jobs/fullvideo.py) never imports the cutter or the Looks, never crops, never sizes
//     to a vertical frame, copies the streams (`-c copy`), and its re-encode fallback has no filter;
//   - the job may write only its own full/<dump>/ folder, never the clip folders;
//   - Review refuses the cut-only actions (Change look, music, Try another version, replace, voice over);
//   - tests prove it (tests/unit/full-video.test.ts, jobs/tests/test_fullvideo.py).
// Zero checks is a failure (Rule 0).
import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const read = (f) => readFile(path.join(root, f), "utf8").catch(() => "");
  const problems = [];
  let items = 0;
  const check = (ok, msg) => {
    items++;
    if (!ok) problems.push(msg);
  };

  const dumps = await read("worker/routes/dumps.ts");
  const branch = dumps.indexOf('if (dump.kind === "full_video") return dumpFullVideo(');
  const cut = dumps.indexOf("startDumpCut(c.env");
  check(branch > 0 && cut > 0 && branch < cut, "worker/routes/dumps.ts: a full-video dump must go to dumpFullVideo before startDumpCut");
  check(/async function dumpFullVideo[\s\S]*?dispatchJob\(c\.env, "fullvideo"/.test(dumps), "worker/routes/dumps.ts: dumpFullVideo must dispatch the fullvideo job");
  check(!/async function dumpFullVideo[\s\S]*?startDumpCut|dispatchJob\(c\.env, "cut"[\s\S]{0,80}full/.test(dumps.slice(dumps.indexOf("async function dumpFullVideo"), dumps.indexOf("export async function briefGate"))), "worker/routes/dumps.ts: dumpFullVideo must never start the cutter");

  const cutTs = await read("worker/jobs/cut.ts");
  check(/if \(dump\.kind === "full_video"\) throw new Error\("a full video is never cut"\)/.test(cutTs), "worker/jobs/cut.ts: buildDumpSpec must refuse a full-video dump");
  const editors = await read("worker/lib/editorJobs.ts");
  check(/startDumpCut[\s\S]{0,400}kind\?\.kind === "full_video"\) return \{ dispatched: false/.test(editors), "worker/lib/editorJobs.ts: startDumpCut must refuse a full-video dump (no connected editor cuts it)");

  const py = await read("jobs/fullvideo.py");
  check(py.length > 0, "jobs/fullvideo.py is missing");
  const code = py.replace(/"""[\s\S]*?"""/g, "").replace(/#.*$/gm, "");
  check(!/^\s*(import|from)\s+(cut|looks)\b/m.test(code), "jobs/fullvideo.py must not import the cutter or the Looks");
  check(!/crop/i.test(code), "jobs/fullvideo.py must never crop");
  check(!/9\s*\/\s*16|1080\s*[:x]\s*1920|720\s*[:x]\s*1280|ih\s*\*\s*9|9:16/.test(code), "jobs/fullvideo.py must never size to a vertical 9:16 frame");
  const copyFn = code.match(/def copy_command[\s\S]*?\n(?=def )/)?.[0] ?? "";
  check(/"-c", "copy"/.test(copyFn) && !/-vf|-filter/.test(copyFn), "jobs/fullvideo.py copy_command must copy the streams (-c copy) with no filter");
  const reFn = code.match(/def reencode_command[\s\S]*?\n(?=def )/)?.[0] ?? "";
  check(reFn.length > 0 && !/-vf|-filter|scale|pad/.test(reFn), "jobs/fullvideo.py reencode_command must keep the video's own size and shape (no filters)");
  check(/copy_changed_the_video/.test(code), "jobs/fullvideo.py must check the copy kept the same size, shape and length");

  const scope = await read("worker/lib/jobStorage.ts");
  const fv = scope.match(/case "fullvideo":[\s\S]*?break;/)?.[0] ?? "";
  check(/scope\.write\.push\(`full\/\$\{refId\}\/`\)/.test(fv) && !/clips\//.test(fv), "worker/lib/jobStorage.ts: the fullvideo job may write only full/<dump>/");

  const clips = await read("worker/routes/clips.ts");
  const actions = clips.match(/const CUT_ACTIONS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  for (const a of ["look", "music", "another", "replace", "voice-over"]) check(actions.includes(`"${a}"`), `worker/routes/clips.ts: a full video must refuse "${a}" (CUT_ACTIONS)`);
  check(/clips\.use\("\/:id\/:action", fullVideoGuard\)/.test(clips), "worker/routes/clips.ts: fullVideoGuard must be mounted");

  // Buffer posts YouTube Shorts only (proven on staging 26 Sep 2026): a full video it can't take is
  // never sent to it (it failed twice and emailed her), it is hers to upload.
  const sync = await read("worker/crons/buffer-sync.ts");
  // Neither a full video Buffer can't post (handoff) nor any full video while Connect YouTube is
  // connected or needs a reconnect (it goes to her channel directly, worker/lib/youtubeDirect.ts).
  check(/const direct = \(await directMode\(env\)\) !== "off";/.test(sync) && /const toBuffer = plannedRows\.filter\(\(r\) => !\(r\.full_video && \(direct \|\| parseJson<\{ handoff\?: boolean \}>\(r\.youtube, \{\}\)\.handoff\)\)\);/.test(sync) && /choosePostsToLoad\(toBuffer,/.test(sync), "worker/crons/buffer-sync.ts: a full video Buffer can't post, or any full video while YouTube is connected, must never be sent to Buffer");
  check(/handoff: !bufferCanTake\(/.test(await read("worker/jobs/fullvideo.ts")), "worker/jobs/fullvideo.ts: a landscape or long full video must be marked for her to upload");

  const unit = await read("tests/unit/full-video.test.ts");
  check(unit.includes("a full-video dump never goes through the cutter"), "tests/unit/full-video.test.ts: the test that a full-video dump never goes through the cutter is missing");
  const pyTest = await read("jobs/tests/test_fullvideo.py");
  check(pyTest.includes("same size and shape"), "jobs/tests/test_fullvideo.py: the test that the video keeps its size and shape is missing");

  if (!items) problems.push("nothing checked (Rule 0)");
  return { items, problems };
}
