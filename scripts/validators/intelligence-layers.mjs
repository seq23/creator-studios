// Studio intelligence, protect layer only (restored 10 Nov 2026, hostile review): the cut blurs
// faces and house numbers, the never-list and prices guard every word it writes, and the cut spec
// carries the studio's content rules. A layer nothing calls leaves a client's faces or a wrong
// price in a public post. One item per row; a missing call fails with its name.
import { readFile } from "node:fs/promises";
import path from "node:path";

const LAYERS = [
  ["5 protect", "jobs/cut.py", /PR\.protect_video\(/, "faces and house numbers are blurred"],
  ["5 protect", "jobs/cut.py", /P\.write_copy\(key, plans,[^\n]*guard=text_ok/, "the never-list and prices guard the words"],
  ["5 protect", "worker/jobs/cut.ts", /content_rules: contentRules\(env\)/, "the cut spec carries the rules"],
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
