// Section 13 logging rule. Worker code logs only through worker/lib/log.ts; jobs/ Python logs
// only through jobs/common.py's `log()`. Direct console.* / print() elsewhere is a leak path.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir, exts) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, exts)));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

export default async function ({ root }) {
  const problems = [];
  const tsFiles = await walk(path.join(root, "worker"), [".ts"]);
  for (const f of tsFiles) {
    if (f.endsWith(path.join("lib", "log.ts"))) continue;
    const text = await readFile(f, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/\bconsole\.(log|info|warn|error|debug)\(/.test(line)) problems.push(`${path.relative(root, f)}:${i + 1}: direct console call; use log.*`);
    });
  }
  let pyFiles = [];
  try {
    pyFiles = await walk(path.join(root, "jobs"), [".py"]);
  } catch {
    pyFiles = [];
  }
  for (const f of pyFiles) {
    if (f.endsWith("common.py")) continue;
    const text = await readFile(f, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/^\s*print\(/.test(line)) problems.push(`${path.relative(root, f)}:${i + 1}: print(); use log()`);
    });
  }
  return { items: tsFiles.length + pyFiles.length, problems };
}
