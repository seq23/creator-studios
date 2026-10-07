// Guard (b), studio brief §6: every studio has its OWN Worker, D1 and R2. No two studios (and not
// the local dev config) share a Worker name, a D1 name or id, an R2 bucket or a URL, and each
// studio's generated env binds DB and FILES to its own registry entry and nothing else.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function checkIsolation(studios, cfg) {
  const problems = [];
  let items = 0;
  if (studios.length < 2) problems.push("fewer than two studios: nothing to keep apart (Rule 0)");
  const seen = new Map();
  const claim = (kind, value, owner) => {
    if (!value) return;
    const k = `${kind}:${value}`;
    if (seen.has(k) && seen.get(k) !== owner) problems.push(`${kind} ${value} is shared by ${seen.get(k)} and ${owner}`);
    else seen.set(k, owner);
  };
  claim("D1 name", cfg.d1_databases?.[0]?.database_name, "local dev");
  claim("R2 bucket", cfg.r2_buckets?.[0]?.bucket_name, "local dev");
  claim("Worker", cfg.name, "local dev");
  for (const s of studios) {
    items++;
    claim("Worker", s.worker, s.slug);
    claim("D1 name", s.d1.name, s.slug);
    if (s.d1.id) claim("D1 id", s.d1.id, s.slug);
    claim("R2 bucket", s.r2.bucket, s.slug);
    claim("URL", s.url, s.slug);
    const env = cfg.env?.[s.slug];
    if (!env) {
      problems.push(`wrangler.jsonc has no env.${s.slug}`);
      continue;
    }
    const db = env.d1_databases ?? [];
    const r2 = env.r2_buckets ?? [];
    if (db.length !== 1 || db[0].binding !== "DB" || db[0].database_name !== s.d1.name || (s.d1.id && db[0].database_id !== s.d1.id)) problems.push(`env.${s.slug}: DB must bind exactly its own D1 ${s.d1.name}`);
    if (r2.length !== 1 || r2[0].binding !== "FILES" || r2[0].bucket_name !== s.r2.bucket) problems.push(`env.${s.slug}: FILES must bind exactly its own R2 ${s.r2.bucket}`);
    if (env.name !== s.worker) problems.push(`env.${s.slug}: Worker name ${env.name}, registry says ${s.worker}`);
    if (env.vars?.STUDIO_SLUG !== s.slug) problems.push(`env.${s.slug}: STUDIO_SLUG is ${env.vars?.STUDIO_SLUG}`);
    if (env.vars?.PUBLIC_BASE_URL !== s.url) problems.push(`env.${s.slug}: PUBLIC_BASE_URL is ${env.vars?.PUBLIC_BASE_URL}, registry says ${s.url}`);
  }
  for (const slug of Object.keys(cfg.env ?? {})) if (!studios.some((s) => s.slug === slug)) problems.push(`wrangler.jsonc env.${slug} has no registry entry`);
  return { items, problems };
}

export const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

export default async function ({ root }) {
  const studio = await import(pathToFileURL(path.join(root, "scripts", "studio.mjs")).href);
  const { studios } = studio.loadRegistry(root);
  const cfg = parseJsonc(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  return checkIsolation(studios, cfg);
}
