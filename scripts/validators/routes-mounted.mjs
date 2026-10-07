// Every worker/routes/*.ts exports a Hono app that worker/index.ts mounts.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const dir = path.join(root, "worker", "routes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
  const index = await readFile(path.join(root, "worker", "index.ts"), "utf8");
  const problems = [];
  for (const f of files) {
    const src = await readFile(path.join(dir, f), "utf8");
    const m = src.match(/export const (\w+) = new Hono/);
    if (!m) {
      problems.push(`${f}: does not export a Hono app`);
      continue;
    }
    if (!new RegExp(`app\\.route\\("[^"]+",\\s*${m[1]}\\)`).test(index)) problems.push(`${f}: '${m[1]}' is not mounted in worker/index.ts`);
  }
  return { items: files.length, problems };
}
