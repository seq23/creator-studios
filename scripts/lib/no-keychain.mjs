// Guard: nothing in this repo may reach the macOS Keychain (CLAUDE.md: "Never call the vault or
// the macOS `security` command; Keychain prompts interrupt the owner"). The patterns are built from
// pieces so this file does not match itself. Read by tests/unit/no-keychain.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const OP = "repo" + "_operator";
export const KEYCHAIN_PATTERNS = [
  { why: "the vault's Python package", re: new RegExp(OP) },
  { why: "the vault's CLI home", re: new RegExp("repo-tools" + "/agent") },
  { why: "a vault CLI call", re: new RegExp("\\bvault\\s+(set|get|list|show|authori[sz]e|inject|launch|run|delete|rm|put|read|grant|export|unlock)\\b", "i") },
  { why: "a vault secret source", re: new RegExp("[\"'`]vault\\??:") },
  { why: "the macOS security command", re: new RegExp("\\bsecurity\\s+(find|add|delete)-(generic|internet)-password\\b") },
];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", "test-results", "playwright-report"]);

/** Every text file under root (skipping SKIP_DIRS and binaries) with the patterns it matches. */
export function scanKeychain(root) {
  const problems = [];
  let files = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
        continue;
      }
      const buf = readFileSync(p);
      if (buf.includes(0)) continue; // binary
      files++;
      const text = buf.toString("utf8");
      text.split("\n").forEach((line, i) => {
        for (const { why, re } of KEYCHAIN_PATTERNS) if (re.test(line)) problems.push(`${path.relative(root, p)}:${i + 1}: ${why}`);
      });
    }
  };
  walk(root);
  return { files, problems };
}
