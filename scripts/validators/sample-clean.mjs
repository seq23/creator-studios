// Guard (a), studio brief §6: a CLIENT studio carries none of the host's identifiers. Checks, for
// every registry entry of kind "client": the entry itself, its generated wrangler env block (vars
// included), its secret plan (no host key name bound as a secret), and every file that ships in
// the bundle all studios serve (app/, worker/, shared/, help/, public/, index.html, migrations/).
// The built bundle itself is scanned after the build by scripts/bundle-scan.mjs (npm run check).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findIdentifiers, OWNER_KEY_NAMES } from "../lib/owner-identifiers.mjs";

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx|js|mjs|css|json|md|sql|html|svg|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function checkStudios({ studios, themes }, envBlock, secretPlan) {
  const problems = [];
  let items = 0;
  const clients = studios.filter((s) => s.kind === "client");
  if (!clients.length) problems.push("no client studios in the registry (Rule 0)");
  for (const s of clients) {
    items++;
    for (const h of findIdentifiers(JSON.stringify(s))) problems.push(`studios/${s.slug}.json: ${h}`);
    items++;
    for (const h of findIdentifiers(JSON.stringify(envBlock(s, themes)))) problems.push(`wrangler env.${s.slug}: ${h}`);
    items++;
    for (const name of Object.keys(secretPlan(s))) if (OWNER_KEY_NAMES.includes(name)) problems.push(`env.${s.slug} would bind the host's key ${name} as a secret`);
    if (s.githubRepo) problems.push(`studios/${s.slug}.json: a client studio runs its jobs in its own repository (Setup), never the host's (githubRepo set)`);
    if (s.jobSecretOnHostRepo) problems.push(`studios/${s.slug}.json: jobSecretOnHostRepo is for host-run studios only`);
  }
  return { items, problems };
}

export default async function ({ root }) {
  const studio = await import(pathToFileURL(path.join(root, "scripts", "studio.mjs")).href);
  const reg = studio.loadRegistry(root);
  const r = await checkStudios(reg, studio.envBlock, studio.secretPlan);
  // Everything that ships to every studio.
  const shipped = [...(await walk(path.join(root, "app"))), ...(await walk(path.join(root, "worker"))), ...(await walk(path.join(root, "shared"))), ...(await walk(path.join(root, "help", "guides"))), path.join(root, "help", "index.json"), ...(await walk(path.join(root, "public"))), ...(await walk(path.join(root, "migrations"))), path.join(root, "index.html")];
  for (const f of shipped) {
    r.items++;
    const text = await readFile(f, "utf8").catch(() => "");
    for (const h of findIdentifiers(text)) r.problems.push(`${path.relative(root, f)}: ${h}`);
  }
  return r;
}
