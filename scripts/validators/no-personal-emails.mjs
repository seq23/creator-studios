// Public repo: no real person's email address in any tracked file. The owner's and the host
// developer's login emails are deploy-time Worker secrets from 0600 files (README "Owner email",
// "Login"), never code, tests or docs. An address passes only on a reserved example domain
// (RFC 2606/6761: *.example, *.test, *.invalid, *.localhost, example.com/.net/.org) or on the short
// ALLOWED list below (public sender and placeholder addresses, role-address fixtures). On this
// machine the secret files' own values are also searched for, so the real addresses can never
// land even inside an allowed shape.
import { readFile, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const RESERVED = /(?:^|\.)(?:example|test|invalid|localhost)$|^example\.(?:com|net|org)$/i;
/** Exact addresses that are not a person: the platform sender, the provider's test sender, form placeholders, role-address test fixtures. */
export const ALLOWED = [
  "login@mail.spryexecutiveos.com",
  "onboarding@resend.dev",
  "hello@yourdomain.com",
  "partnerships@yourdomain.com",
  "partnerships@brand.com",
  "us-partnerships@brand.com",
  "creators.team@brand.com",
  "pr@brand.com",
  "jane.doe@brand.com",
  "jdoe@brand.com",
  "pr@brand.co.uk",
  "partnerships@gmail.com",
  "jane.doe@gmail.com",
  "pr@icloud.com",
];
const SKIP = /^(package-lock\.json|public\/assets\/)/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|mp4|mov|wav|pdf)$/i;

/** Problems for one file's text. `secrets` are the local secret files' values (lowercased). Pure. */
export function checkText(file, text, secrets = []) {
  const problems = [];
  for (const m of text.matchAll(EMAIL)) {
    const addr = m[0].toLowerCase();
    const domain = addr.split("@")[1];
    if (RESERVED.test(domain) || ALLOWED.includes(addr)) continue;
    problems.push(`${file}: a real email address (${addr.replace(/^(.).*@/, "$1…@")}) is committed; login emails are deploy-time secrets from 0600 files (README "Owner email", "Login")`);
  }
  const lower = text.toLowerCase();
  for (const v of secrets) if (v && lower.includes(v)) problems.push(`${file}: contains the value of a local secret email file`);
  return problems;
}

/** The values of the email secret files on this machine (DEVELOPER_EMAIL, <slug>/OWNER_EMAIL, …), never printed. */
export async function localSecretEmails(dir = process.env.CS_SECRETS_DIR || path.join(os.homedir(), ".config", "creator-studios", "secrets")) {
  if (!existsSync(dir)) return [];
  const out = [];
  const read = async (f) => {
    if (!existsSync(f) || !statSync(f).isFile()) return;
    const v = (await readFile(f, "utf8")).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+$/.test(v)) out.push(v);
  };
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && /EMAIL$/.test(e.name)) await read(path.join(dir, e.name));
    if (e.isDirectory()) for (const n of ["OWNER_EMAIL", "DEVELOPER_EMAIL"]) await read(path.join(dir, e.name, n));
  }
  return out;
}

export default async function ({ root }) {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !SKIP.test(f) && !BINARY.test(f));
  const secrets = await localSecretEmails();
  const problems = [];
  for (const f of files) problems.push(...checkText(f, await readFile(path.join(root, f), "utf8").catch(() => ""), secrets));
  if (!files.length) problems.push("no tracked files (Rule 0)");
  return { items: files.length, problems };
}
