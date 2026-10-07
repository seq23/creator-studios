// Firecrawl is optional (owner, 26 Sep 2026): the brand finder and the Research Brief must
// produce output with no web-research key. Fails when:
//   * a job other than jobs/common.py calls a web provider directly (Firecrawl, Jina,
//     DuckDuckGo): every job goes through common.Web, which falls back to the free path;
//   * common.Web is missing its keyless fallbacks (DuckDuckGo search, Jina reader, plain fetch);
//   * a job raises when Firecrawl is not connected;
//   * a Worker route or job handler refuses to start because Firecrawl is not connected.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const jobsDir = path.join(root, "jobs");
  for (const f of (await readdir(jobsDir)).filter((x) => x.endsWith(".py"))) {
    items++;
    const text = await readFile(path.join(jobsDir, f), "utf8");
    if (f === "common.py") {
      if (!/class Web\b/.test(text) || !/DDG_HTML_URL/.test(text) || !/JINA_READ_URL/.test(text) || !/strip_tags\(/.test(text)) problems.push("jobs/common.py: class Web must fall back to DuckDuckGo search, the Jina reader and a plain fetch");
      continue;
    }
    if (/api\.firecrawl\.dev|r\.jina\.ai|s\.jina\.ai|duckduckgo\.com/.test(text)) problems.push(`jobs/${f}: reaches a web provider directly; use common.Web`);
    if (/raise RuntimeError\(["']firecrawl_not_connected/.test(text) || /if not fc_key:\s*\n\s*raise/.test(text)) problems.push(`jobs/${f}: refuses to run without Firecrawl`);
  }
  for (const sub of ["worker/routes", "worker/jobs"]) {
    const dir = path.join(root, sub);
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".ts"))) {
      items++;
      const text = await readFile(path.join(dir, f), "utf8");
      if (/getConnectionSecret\([^)]*"firecrawl"\)\)\)?\)?\s*(return fail|throw)/.test(text)) problems.push(`${sub}/${f}: refuses to start without Firecrawl`);
    }
  }
  return { items, problems };
}
