// Tidy and storage never delete her footage or anything unposted without a warning first (owner,
// 26 Sep 2026, day 358: "maybe do not keep them long", with the rule that nothing unposted goes
// unwarned). A guard that reads the code that deletes:
//   1. every storage delete (FILES.delete) in the daily lane's files sits in a function on the
//      list below, each with its rule; a new delete in a lane fails until it is listed here (and
//      so reviewed against the rule).
//   2. worker/domain/tidy.ts clipFileAction deletes a draft only when its warning is old enough
//      (warnedLongEnough on delete_warned_at and FILES.warnDays).
//   3. the hard budget never offers a draft, an approved clip waiting to post, or a kit clip.
//   4. tidy (archive) never deletes: tidyDaily has no FILES.delete and no DELETE FROM except
//      forgetting old Home dismissals.
//   5. the unit test "never deletes an unposted draft without the warning first" exists.
import { readFile } from "node:fs/promises";
import path from "node:path";

/** file → function → the rule that allows its deletes */
const ALLOWED = {
  "worker/crons/daily.ts": {
    retention: "raw originals 7 days after cutting (the clips are made); rejected clips 7 days after she rejects them (Rejected shows the date)",
  },
  "worker/lib/fullVideo.ts": { fullVideoRetention: "full videos: 7 days after posting, or unapproved after 14 days with the Home warning from day 11" },
  "worker/lib/storage.ts": {
    clipFileRules: "posted clip files 30 days after posting (not kit clips); drafts only after the Home warning is 7 days old",
    clearMixes: "a voice-over mix is a copy of a clip whose file is being cleared by the rule above",
    enforceBudget: "over 90%: originals already cut, rejected clips, clips posted a week ago; never drafts, waiting or kit clips",
  },
};

function functionsWithDeletes(src) {
  const out = [];
  const re = /(?:async function|function)\s+(\w+)\s*\(/g;
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  for (const m of src.matchAll(/FILES\.delete\(/g)) {
    const owner = starts.filter((s) => s.at < m.index).pop();
    out.push(owner?.name ?? "(top level)");
  }
  return out;
}

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const read = (p) => readFile(path.join(root, p), "utf8");
  for (const file of ["worker/crons/daily.ts", "worker/lib/storage.ts", "worker/lib/fullVideo.ts", "worker/crons/weekly.ts", "worker/crons/buffer-sync.ts", "worker/crons/deals.ts", "worker/crons/brief.ts"]) {
    const src = await read(file);
    for (const fn of functionsWithDeletes(src)) {
      items++;
      if (!ALLOWED[file]?.[fn]) problems.push(`${file}: ${fn}() deletes files but is not on the tidy-warns-first list; say which rule allows it (and that anything unposted is warned first)`);
    }
  }
  const tidy = await read("worker/domain/tidy.ts");
  items++;
  const action = tidy.slice(tidy.indexOf("export function clipFileAction"), tidy.indexOf("// ------", tidy.indexOf("export function clipFileAction")));
  if (!/warnedLongEnough\s*=\s*!!c\.delete_warned_at\s*&&[^;]*FILES\.warnDays/.test(action) || !/&&\s*warnedLongEnough\)\s*return\s*\{\s*do:\s*"delete",\s*why:\s*"draft"/.test(action))
    problems.push("worker/domain/tidy.ts clipFileAction: a draft must be deleted only when its Home warning (delete_warned_at) is at least FILES.warnDays old");
  const storage = await read("worker/lib/storage.ts");
  const budget = storage.slice(storage.indexOf("export async function enforceBudget"), storage.indexOf("export async function storageHealth"));
  items++;
  if (/status\s*=\s*'draft'|status IN \([^)]*'draft'/.test(budget)) problems.push("worker/lib/storage.ts enforceBudget: offers drafts to the budget (drafts go only by their warned rule)");
  if (!/kit\.has\(/.test(budget)) problems.push("worker/lib/storage.ts enforceBudget: kit clips are not excluded");
  if (!/NOT EXISTS \(SELECT 1 FROM posts p WHERE p\.clip_id = c\.id AND p\.status IN \('planned','in_buffer'\)\)/.test(budget) || !/p\.status = 'posted'/.test(budget)) problems.push("worker/lib/storage.ts enforceBudget: only clips already posted (and not posting again) may be offered");
  const tidyFn = storage.slice(storage.indexOf("export async function tidyDaily"));
  items++;
  if (/FILES\.delete/.test(tidyFn)) problems.push("worker/lib/storage.ts tidyDaily deletes files: tidy only archives");
  for (const m of tidyFn.matchAll(/DELETE FROM (\w+)/g)) if (m[1] !== "dismissals") problems.push(`worker/lib/storage.ts tidyDaily deletes rows from ${m[1]}: tidy only archives`);
  const unit = await read("tests/unit/day-358.test.ts").catch(() => "");
  items++;
  if (!/never deletes an unposted draft without the warning first/.test(unit)) problems.push('tests/unit/day-358.test.ts: the test "never deletes an unposted draft without the warning first" is missing');
  return { items, problems };
}
