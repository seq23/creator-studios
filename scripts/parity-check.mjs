#!/usr/bin/env node
// Studio parity (owner, 23 Oct 2026: "make sure there is parity among the 4"). Every studio in the
// registry ships from this one codebase; this proves it live: each studio's /healthz must answer ok,
// name its own slug, use the code login, and report the same commit (BUILD_SHA, set by
// scripts/studio.mjs deploy) as the newest successful deploy.yml run on main. A studio left on old
// code, down, or answering as another studio fails the run loudly. Zero studios is a failure (Rule 0).
//   node scripts/parity-check.mjs [--expect=<sha>]
import { spawnSync } from "node:child_process";
import { loadRegistry } from "./studio.mjs";

/** Problems for one run. Pure: studios [{slug,url}], health {slug: json|null}, expected sha. */
export function checkParity(studios, health, expected) {
  const problems = [];
  if (!studios.length) problems.push("no studios in the registry (Rule 0)");
  if (!expected) problems.push("no expected commit (no successful deploy on main to compare with)");
  for (const s of studios) {
    const h = health[s.slug];
    if (!h) {
      problems.push(`${s.slug}: ${s.url}/healthz did not answer`);
      continue;
    }
    if (h.ok !== true) problems.push(`${s.slug}: /healthz is not ok`);
    if (h.studio !== s.slug) problems.push(`${s.slug}: answers as studio "${h.studio}"`);
    if (h.login !== "code") problems.push(`${s.slug}: login is "${h.login}", not the code login`);
    if (expected && h.build !== expected) problems.push(`${s.slug}: runs ${String(h.build || "an unknown build").slice(0, 7)}, main deployed ${expected.slice(0, 7)}`);
  }
  return problems;
}

function expectedSha() {
  const arg = process.argv.find((a) => a.startsWith("--expect="));
  if (arg) return arg.slice(9);
  const r = spawnSync("gh", ["run", "list", "--workflow", "deploy.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "headSha", "-q", ".[0].headSha"], { encoding: "utf8" });
  return r.stdout.trim();
}

async function main() {
  const { studios } = loadRegistry();
  const expected = expectedSha();
  const health = {};
  for (const s of studios) {
    try {
      const res = await fetch(`${s.url}/healthz`, { signal: AbortSignal.timeout(20000) });
      health[s.slug] = res.ok ? await res.json() : null;
    } catch {
      health[s.slug] = null;
    }
  }
  const problems = checkParity(studios, health, expected);
  for (const s of studios) console.log(`${s.slug}: ${health[s.slug] ? String(health[s.slug].build || "?").slice(0, 7) : "no answer"}`);
  if (problems.length) {
    console.error(`PARITY FAILED (expected ${expected.slice(0, 7)}):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`parity ok: ${studios.length} studios on ${expected.slice(0, 7)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
