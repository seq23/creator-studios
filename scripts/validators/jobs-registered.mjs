// Every job type the schema allows has a handler in worker/jobs/registry.ts.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  // The jobs.type CHECK as the LAST migration that defines it leaves it (0015 rebuilt the table
  // to add 'fullvideo'; reading only 0001 would miss a new type).
  const dir0 = path.join(root, "migrations");
  let m = null;
  for (const f of (await readdir(dir0)).filter((x) => x.endsWith(".sql")).sort()) {
    const all = [...(await readFile(path.join(dir0, f), "utf8")).matchAll(/type TEXT NOT NULL CHECK \(type IN \(([^)]+)\)\)/g)];
    if (all.length) m = all[all.length - 1];
  }
  if (!m) throw new Error("jobs.type CHECK not found in migrations/");
  const types = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  const registry = await readFile(path.join(root, "worker", "jobs", "registry.ts"), "utf8");
  const problems = [];
  for (const t of types) {
    if (!new RegExp(`^\\s*${t}:\\s*\\w+,?$`, "m").test(registry)) problems.push(`job type '${t}' has no handler in registry.ts`);
  }
  return { items: types.length, problems };
}
