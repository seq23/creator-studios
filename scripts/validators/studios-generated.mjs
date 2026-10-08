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
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s.hostname ?? "") || /workers\.dev$/.test(s.hostname ?? "")) problems.push(`${s.slug}: hostname must be the studio's own domain name (e.g. ${s.slug}-studio.spryexecutiveos.com), not a URL or workers.dev`);
    if (!s.appName) problems.push(`${s.slug}: appName is empty`);
    if ("ownerEmail" in s) problems.push(`${s.slug}: ownerEmail is never in the public registry; it is set at deploy time from <secrets dir>/${s.slug}/OWNER_EMAIL (validator registry-no-emails)`);
  }
  return problems;
}

export default async function ({ root }) {
  const studio = await import(pathToFileURL(path.join(root, "scripts", "studio.mjs")).href);
  const reg = studio.loadRegistry(root);
  const problems = checkEntries(reg.studios, reg.themes);
  const hosts = reg.studios.map((s) => s.hostname);
  for (const h of new Set(hosts)) if (hosts.filter((x) => x === h).length > 1) problems.push(`hostname ${h} is used by more than one studio`);
  if (!reg.studios.length) problems.push("no studios (Rule 0)");
  const have = await readFile(path.join(root, "wrangler.jsonc"), "utf8").catch(() => "");
  if (have !== studio.wranglerConfig(reg)) problems.push("wrangler.jsonc is not what the registry generates: run node scripts/studio.mjs gen");
  return { items: reg.studios.length + 1, problems };
}
