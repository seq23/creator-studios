// Migrations only (restored 10 Nov 2026, hostile review): D1 migrations are numbered once each,
// and every DROP TABLE <t> first copies its rows into <t>_new. A rebuild that drops a table
// without copying it back deletes live business records.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const problems = [];
  const migs = (await readdir(path.join(root, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
  const nums = migs.map((f) => f.slice(0, 4));
  if (new Set(nums).size !== nums.length) problems.push(`two migrations share a number: ${nums.join(" ")}`);
  for (const f of migs) {
    const sql = await readFile(path.join(root, "migrations", f), "utf8");
    for (const m of sql.matchAll(/DROP TABLE (\w+);/g)) {
      const t = m[1];
      if (!new RegExp(`INSERT INTO ${t}_new \\([^)]*\\)\\s*SELECT [^;]* FROM ${t}(\\s+\\w+)?;`).test(sql)) problems.push(`migrations/${f} drops ${t} without copying every row into ${t}_new first`);
    }
  }
  return { items: migs.length + 1, problems };
}
