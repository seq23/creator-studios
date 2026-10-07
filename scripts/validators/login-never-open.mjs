// Guard (c), studio brief §4 + §6: every studio logs in with the email one-time code. No config
// may say AUTH_MODE "open" (or anything but "code"), and the code that decides the mode must
// return "code" whatever the var says: worker/env.ts authMode() has no "open" branch, and neither
// the session middleware nor the login routes test for one.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "./studio-isolation.mjs";

export function checkLogin(cfg, sources) {
  const problems = [];
  let items = 0;
  const blocks = [["top level", cfg.vars ?? {}], ...Object.entries(cfg.env ?? {}).map(([k, v]) => [`env.${k}`, v.vars ?? {}])];
  if (blocks.length < 2) problems.push("no studio envs to check (Rule 0)");
  for (const [where, vars] of blocks) {
    items++;
    if (vars.AUTH_MODE !== "code") problems.push(`${where}: AUTH_MODE must be "code" (is ${JSON.stringify(vars.AUTH_MODE)})`);
  }
  for (const [file, text] of Object.entries(sources)) {
    items++;
    if (/AUTH_MODE\s*[=:]\s*"?open/i.test(text)) problems.push(`${file}: sets AUTH_MODE open`);
    if (/=== ?"open"/.test(text) && /worker\//.test(file)) problems.push(`${file}: has an "open" login branch`);
  }
  const env = sources["worker/env.ts"] ?? "";
  if (!/export const authMode = \([^)]*\): "code" => "code";/.test(env)) problems.push('worker/env.ts: authMode() must return the constant "code"');
  return { items, problems };
}

export default async function ({ root }) {
  const cfg = parseJsonc(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  const files = ["worker/env.ts", "worker/lib/auth.ts", "worker/routes/auth.ts", ".dev.vars.example", "tests/e2e/serve.sh", "playwright.config.ts", ".github/workflows/e2e.yml", ".github/workflows/deploy.yml", ".github/workflows/check.yml"];
  const sources = {};
  for (const f of files) sources[f] = await readFile(path.join(root, f), "utf8").catch(() => "");
  return checkLogin(cfg, sources);
}
