// Studio fix A+B combined (23 Oct 2026): the two sides of the clip contract read the SAME lists and
// each cross-dependency is wired, not merely written. The engine (jobs/**) and the Worker (worker/**,
// shared/**) were built apart; this is the one check that they still meet. One item per rule.
import { readFile } from "node:fs/promises";
import path from "node:path";

const RULES = [
  ["shared/clipWords.ts", /from "\.\.\/jobs\/script_rules\.json"/, "the Worker cleans words with the engine's own script rules"],
  ["worker/lib/autoVoice.ts", /cleanScript\(clip\.voice_script/, "the automatic voice over speaks the engine's voice_script first, cleaned"],
  ["worker/lib/autoVoice.ts", /c\.words_pending = 0[\s\S]*c\.words_pending = 0/, "a words-pending clip is never voiced (both voice paths)"],
  ["worker/domain/sourceCheck.ts", /POSTABLE_CLIP_SQL = "[^"]*c\.words_pending = 0/, "a words-pending clip never posts"],
  ["worker/routes/clips.ts", /to === "approved" && clip\.words_pending/, "a words-pending clip cannot be approved"],
  ["worker/crons/index.ts", /await wordsPass\(env\)/, "the words pass runs every hour"],
  ["worker/jobs/cut.ts", /Math\.round\(Math\.max\(0, Math\.min\(100,/, "every stored score is an integer 0..100"],
  ["worker/jobs/cut.ts", /c\.words_pending === true\);/, "a words-pending clip (no hook yet) is stored, not dropped"],
  ["worker/jobs/cut.ts", /cleanGridLayout\(look, c\.layout, ctx\.allowed\)/, "the engine's own-shot grid cells are stored"],
  ["worker/jobs/cut.ts", /cta_turn: ctaTurnFor\(/, "a re-render's end card says the caption's call to action"],
  ["worker/jobs/cut.ts", /if \(layout\.ending\) ending = await dumpStretch\(/, "a re-rendered grid still ends on its hero"],
  ["worker/jobs/cut.ts", /logo_r2_key: \(await readStudioRules\(env\)\)\.logo_r2_key/, "the studio's end-card logo reaches the engine"],
  ["worker/lib/postText.ts", /final \}\);/, "the engine's final caption goes out as written"],
  ["jobs/cut.py", /CM\.apply_fixes\(/, "her one-tap fixes steer Try another version"],
  ["jobs/cut.py", /a\.get\("taken_at"\)/, "the camera date read at upload is used to group events"],
  ["migrations/0028_studio_fix_ab.sql", /UPDATE clips SET score = CAST\(ROUND\(score \* 100\) AS INTEGER\) WHERE score <= 1;/, "stored scores move to 0..100 once"],
];

export default async function ({ root }) {
  const problems = [];
  const cache = new Map();
  const read = async (f) => {
    if (!cache.has(f)) cache.set(f, await readFile(path.join(root, f), "utf8"));
    return cache.get(f);
  };
  for (const [file, re, what] of RULES) if (!re.test(await read(file))) problems.push(`${file} no longer does it: ${what}`);
  // The one-tap fix keys: shared/fixes.ts FIXES and jobs/clipmaker.py FIX_KEYS are one list.
  const ts = [...(await read("shared/fixes.ts")).matchAll(/^\s{2}([a-z_]+): \{ label:/gm)].map((m) => m[1]);
  const py = ((await read("jobs/clipmaker.py")).match(/FIX_KEYS = \(([^)]*)\)/)?.[1] ?? "").match(/"([a-z_]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  if (!ts.length || ts.join(",") !== py.join(",")) problems.push(`fix keys differ: shared/fixes.ts [${ts}] vs jobs/clipmaker.py FIX_KEYS [${py}]`);
  // The caption's AI note: the Worker's tail is exactly the engine's divider + note.
  const tail = (await read("shared/postText.ts")).match(/AI_NOTE_TAIL = "([^"]*)"/)?.[1];
  if (tail !== "\\n\\n—\\nMade with AI") problems.push(`shared/postText.ts AI_NOTE_TAIL is ${JSON.stringify(tail)}, the engine writes "\\n\\n—\\nMade with AI"`);
  // Migrations: numbered once each, every jobs/emails_sent rebuild copies every row back.
  const migs = (await import("node:fs")).readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const nums = migs.map((f) => f.slice(0, 4));
  if (new Set(nums).size !== nums.length) problems.push(`two migrations share a number: ${nums.join(" ")}`);
  for (const f of migs) {
    const sql = await read(`migrations/${f}`);
    for (const m of sql.matchAll(/DROP TABLE (\w+);/g)) {
      const t = m[1];
      if (!new RegExp(`INSERT INTO ${t}_new \\([^)]*\\)\\s*SELECT [^;]* FROM ${t}(\\s+\\w+)?;`).test(sql)) problems.push(`migrations/${f} drops ${t} without copying every row into ${t}_new first`);
    }
  }
  return { items: RULES.length + 2 + migs.length, problems };
}
