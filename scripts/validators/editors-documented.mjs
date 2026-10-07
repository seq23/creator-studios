// Editors (docs/EDITORS.md is the research behind shared/editors.ts): the two must agree, or the
// Connect screen offers a connection nobody checked, or a researched "no API" tool gets a key box.
//   - every connected editor in shared/editors.ts has a "Self-serve API: Yes" row in the research
//     table and a row in "What the dashboard builds", with a connect-<id> and reconnect-<id> guide
//   - every tool the research marks "No" or "Gated" is not a connected editor
//   - the hand-off apps (CapCut, InShot) are researched as "No" API
// Zero editors fails (Rule 0, in the runner).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const SLUG = { "Opus Clip": "opusclip", Vizard: "vizard", Klap: "klap", Submagic: "submagic", Descript: "descript", CapCut: "capcut", InShot: "inshot" };

export default async function ({ root }) {
  const problems = [];
  const doc = await readFile(path.join(root, "docs", "EDITORS.md"), "utf8");
  const shared = await readFile(path.join(root, "shared", "editors.ts"), "utf8");
  const ids = [...(shared.match(/export const API_EDITORS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  const names = Object.fromEntries([...shared.matchAll(/id: "([a-z]+)",\s*name: "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const research = new Map();
  for (const m of doc.matchAll(/^\| \*\*([^*]+)\*\* \| \*\*(Yes|No|Gated)\*\*/gm)) research.set(m[1], m[2]);
  for (const m of doc.matchAll(/^\| \*\*([^*]+)\*\* \| (Yes)[, ]/gm)) if (!research.has(m[1])) research.set(m[1], m[2]);
  if (research.size < 8) problems.push(`docs/EDITORS.md: the research table lists ${research.size} tools, expected the 11 checked`);
  const builds = doc.split("## What the dashboard builds")[1] ?? "";
  for (const id of ids) {
    const name = names[id];
    if (!name) {
      problems.push(`shared/editors.ts: ${id} has no name`);
      continue;
    }
    if (research.get(name) !== "Yes") problems.push(`${name}: connected in the app but the research does not say it has a self-serve API`);
    if (!builds.includes(`| ${name} |`)) problems.push(`${name}: missing from "What the dashboard builds" in docs/EDITORS.md`);
    for (const g of [`connect-${id}`, `reconnect-${id}`]) if (!(await stat(path.join(root, "help", "guides", `${g}.md`)).catch(() => null))) problems.push(`${name}: no help/guides/${g}.md`);
  }
  for (const [name, api] of research) {
    const id = SLUG[name];
    if (api !== "Yes" && id && ids.includes(id)) problems.push(`${name}: the research says ${api} API but it is a connected editor`);
  }
  for (const app of ["CapCut", "InShot"]) if (research.get(app) !== "No") problems.push(`${app}: a hand-off app, but the research does not say "No" API`);
  return { items: ids.length + research.size, problems };
}
