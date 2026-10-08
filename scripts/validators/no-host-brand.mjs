// The host's former business name appears nowhere in this public repo: not in config, code, docs,
// tests or workflows (owner, 7 Oct 2026: the studios moved to her own domain and sender). Scans
// every file git tracks, plus any untracked file not ignored, with HOST_BRAND (every spelling).
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HOST_BRAND } from "../lib/owner-identifiers.mjs";

/** Every hit as "<file>:<line>". Pure: takes [relativePath, text] pairs. */
export function findBrand(files) {
  const problems = [];
  for (const [f, text] of files) {
    if (HOST_BRAND.test(f)) problems.push(`${f}: the file name carries the host's former business name`);
    text.split("\n").forEach((line, i) => {
      if (HOST_BRAND.test(line)) problems.push(`${f}:${i + 1}: the host's former business name`);
    });
  }
  return problems;
}

export default async function ({ root }) {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const names = (r.stdout ?? "").split("\0").filter(Boolean);
  const files = [];
  for (const f of names) {
    const buf = await readFile(path.join(root, f)).catch(() => null);
    if (!buf || buf.includes(0)) continue; // deleted in the worktree, or binary
    files.push([f, buf.toString("utf8")]);
  }
  const problems = findBrand(files);
  if (!files.length) problems.push("no files scanned (Rule 0)");
  return { items: files.length, problems };
}
