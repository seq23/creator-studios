#!/usr/bin/env node
// Guard (a), on the BUILT bundle (studio brief §6): every studio serves the same client bundle
// (dist/client) and the same Worker bundle, so neither may carry a host identifier. Run after
// `npm run build` (npm run check, and the deploy before it ships). The Worker bundle is produced
// with `wrangler deploy --dry-run --outdir` for a client studio env, exactly what would ship.
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findIdentifiers } from "./lib/owner-identifiers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(js|mjs|css|html|json|svg|txt)$/.test(e.name)) out.push(p); // source maps are not uploaded
  }
  return out;
}

export async function scan(dirs) {
  const problems = [];
  let files = 0;
  for (const d of dirs) for (const f of await walk(d)) {
    files++;
    for (const h of findIdentifiers(await readFile(f, "utf8"))) problems.push(`${path.relative(ROOT, f)}: ${h}`);
  }
  return { files, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(ROOT, "dist", "worker-scan");
  const r = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--env", "sample1", "--outdir", out], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`bundle-scan: the Worker bundle did not build (${(r.stderr || r.stdout || "").split("\n").slice(-3).join(" ")})`);
    process.exit(1);
  }
  const res = await scan([path.join(ROOT, "dist", "client"), out]);
  if (!res.files) {
    console.error("bundle-scan: no files scanned (Rule 0): build first");
    process.exit(1);
  }
  if (res.problems.length) {
    console.error(`bundle-scan: ${res.problems.length} host identifier(s) in the shipped bundle:\n  ${res.problems.slice(0, 30).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`bundle-scan: ${res.files} shipped files, no host identifiers`);
}
