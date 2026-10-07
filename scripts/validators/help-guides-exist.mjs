// Section 12c: every `guide="…"`, `fix_guide: "…"`, `/help/<slug>` reference and every
// fix_guide slug the Worker emits must be a real file help/guides/<slug>.md, and every
// guide must be in help/index.json with a group.
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
  const guidesDir = path.join(root, "help", "guides");
  const guides = new Set((await readdir(guidesDir)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
  const index = JSON.parse(await readFile(path.join(root, "help", "index.json"), "utf8"));
  const indexed = new Set(index.guides.map((g) => g.slug));
  const problems = [];
  for (const g of guides) if (!indexed.has(g)) problems.push(`help/guides/${g}.md is not listed in help/index.json`);
  for (const g of indexed) if (!guides.has(g)) problems.push(`help/index.json lists '${g}' but help/guides/${g}.md is missing`);

  // Every connectable service, read from the one list (ConnectionView["service"] in shared/types.ts)
  // so a new service cannot be missed here.
  const types = await readFile(path.join(root, "shared", "types.ts"), "utf8");
  const union = types.match(/interface ConnectionView \{[\s\S]*?service:\s*([^;]+);/)?.[1] ?? "";
  const services = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  if (services.length < 5) problems.push("could not read ConnectionView service list from shared/types.ts");
  const files = [...(await walk(path.join(root, "app"), [".tsx", ".ts"])), ...(await walk(path.join(root, "worker"), [".ts"]))];
  const refs = new Set();
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(/guide="([a-z0-9-]+)"/g)) refs.add([m[1], f]);
    for (const m of text.matchAll(/fix_guide:\s*"([a-z0-9-]+)"/g)) refs.add([m[1], f]);
    for (const m of text.matchAll(/["'`]\/help\/([a-z0-9-]+)["'`]/g)) refs.add([m[1], f]);
    for (const m of text.matchAll(/, "([a-z0-9-]+)"\)/g)) if (/fail\(c, \d+, /.test(text) && guides.size && m[1].includes("-") && text.includes(`"${m[1]}")`)) refs.add([m[1], f]);
    for (const m of text.matchAll(/setHealth\([^)]*"([a-z0-9-]+)"\)/g)) refs.add([m[1], f]);
    for (const m of text.matchAll(/`(connect|reconnect)-\$\{/g)) {
      // template slugs: connect-<service>, reconnect-<service> must exist for every service
      for (const s of services) refs.add([`${m[1]}-${s}`, f]);
    }
  }
  for (const [slug, f] of refs) {
    if (!guides.has(slug)) problems.push(`${path.relative(root, f)} references guide '${slug}' but help/guides/${slug}.md is missing`);
  }
  return { items: guides.size + refs.size, problems };
}
