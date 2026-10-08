// The registry (studios/*.json) is public: an owner's login email is a deploy-time Worker secret
// from <secrets dir>/<slug>/OWNER_EMAIL (scripts/studio.mjs, README "Owner email"), never a field
// here. Fails on any email address in a registry file other than a documented placeholder, and on
// an ownerEmail field at all (the old committed shape).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Addresses a registry file may carry: reserved example domains only (RFC 2606), documented in README. */
export const PLACEHOLDER_EMAILS = ["owner@studio.example"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Problems for one registry file's text. Pure. */
export function checkRegistryText(name, text) {
  const problems = [];
  for (const m of text.matchAll(EMAIL)) if (!PLACEHOLDER_EMAILS.includes(m[0].toLowerCase())) problems.push(`studios/${name}: an email address (${m[0].replace(/^(.).*@/, "$1…@")}) is committed; owner emails are deploy-time secrets (README "Owner email")`);
  if (/"ownerEmail"\s*:/.test(text)) problems.push(`studios/${name}: an ownerEmail field; the owner email is set at deploy time from <secrets dir>/<slug>/OWNER_EMAIL`);
  return problems;
}

export default async function ({ root }) {
  const dir = path.join(root, "studios");
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const problems = [];
  for (const n of names) problems.push(...checkRegistryText(n, await readFile(path.join(dir, n), "utf8")));
  if (!names.length) problems.push("no registry files (Rule 0)");
  return { items: names.length, problems };
}
