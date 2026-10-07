// The studio registry (studios/<slug>.json) is the ONE list; wrangler.jsonc is generated from it
// (node scripts/studio.mjs gen). Two components each keeping their own list is how a studio gets
// deployed with another's config. Fails when wrangler.jsonc drifts, or an entry is malformed.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SLUG = /^[a-z][a-z0-9]{1,30}$/;

export function checkEntries(studios, themes) {
  const problems = [];
  for (const s of studios) {
    if (!SLUG.test(s.slug ?? "")) problems.push(`studio slug ${JSON.stringify(s.slug)} must be lowercase letters and digits`);
    if (!["host-accounts", "client"].includes(s.kind)) problems.push(`${s.slug}: kind must be host-accounts or client`);
    if (!themes[s.theme]) problems.push(`${s.slug}: theme ${s.theme} is not in studios/themes.json`);
    if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$|^https:\/\/[a-z0-9.-]+$/.test(s.url ?? "")) problems.push(`${s.slug}: url must be https`);
    if (!s.appName) problems.push(`${s.slug}: appName is empty`);
    if (s.kind === "host-accounts" && !s.ownerEmail) problems.push(`${s.slug}: a host-run studio needs its owner email`);
    if (s.kind === "client" && s.ownerEmail) problems.push(`${s.slug}: a client studio's owner email is claimed through its invite link, not set here`);
  }
  return problems;
}

export default async function ({ root }) {
  const studio = await import(pathToFileURL(path.join(root, "scripts", "studio.mjs")).href);
  const reg = studio.loadRegistry(root);
  const problems = checkEntries(reg.studios, reg.themes);
  if (!reg.studios.length) problems.push("no studios (Rule 0)");
  const have = await readFile(path.join(root, "wrangler.jsonc"), "utf8").catch(() => "");
  if (have !== studio.wranglerConfig(reg)) problems.push("wrangler.jsonc is not what the registry generates: run node scripts/studio.mjs gen");
  return { items: reg.studios.length + 1, problems };
}
