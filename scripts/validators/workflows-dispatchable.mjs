// Every job type has a GitHub Actions workflow with `repository_dispatch: types: [<type>]`.
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
  const dir = path.join(root, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
  const listened = new Set();
  for (const f of files) {
    const y = await readFile(path.join(dir, f), "utf8");
    const block = y.match(/repository_dispatch:\s*\n\s*types:\s*\[([^\]]+)\]/);
    if (block) for (const t of block[1].split(",")) listened.add(t.trim().replace(/['"]/g, ""));
  }
  const problems = types.filter((t) => !listened.has(t)).map((t) => `job type '${t}' has no workflow listening for repository_dispatch '${t}'`);
  return { items: types.length, problems };
}
