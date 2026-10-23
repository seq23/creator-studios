// A plain (unquoted) YAML value with ": " inside is a parse error: GitHub then makes a zero-job run
// on every push and refuses workflow_dispatch ("does not have 'workflow_dispatch' trigger"). It
// happened to golden-set.yml on 23 Oct 2026 with a step name "… (jobs/ai.py: the $0 backup …)".
// Fails on any `name:` / `description:` value in .github/workflows that is not quoted, not a block
// scalar, and contains ": " or " #" (a comment would silently cut it short).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const dir = path.join(root, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  const problems = [];
  let items = 0;
  for (const f of files) {
    const lines = (await readFile(path.join(dir, f), "utf8")).split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s+)?(name|description):\s+(.*)$/);
      if (!m) return;
      items += 1;
      const v = m[2].trim();
      if (/^["'|>]/.test(v)) return;
      const body = v.replace(/\s+#.*$/, "");
      if (/: /.test(body) || / #/.test(v.replace(/\s+#[^#]*$/, ""))) problems.push(`.github/workflows/${f}:${i + 1}: quote this ${m[1]} (a ": " in a plain YAML value breaks the whole workflow)`);
    });
  }
  return { items, problems };
}
