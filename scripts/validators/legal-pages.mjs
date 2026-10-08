// Google will not publish the sign-in app ("Connect YouTube") without a public privacy policy and
// terms of service on the app's own domain, linked from its home page. This proves, from source:
//   - worker/routes/legal.ts serves GET /privacy and GET /terms, and index.ts mounts it
//   - both deployments in wrangler.jsonc send /privacy and /terms to the Worker first (a missing
//     entry would hand the path to the React app, which shows the login page on staging)
//   - the privacy page says what it reads and uploads, that tokens are encrypted, how to revoke at
//     myaccount.google.com/permissions, the Limited Use sentence, and the contact address
//   - the footer links are on every screen: the Shell sidebar foot, the phone Menu sheet, the login card
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "./studio-isolation.mjs";

export const REQUIRED_PRIVACY = [
  ["upload", /Upload/],
  ["encrypted tokens", /encrypted/],
  ["revoke link", /myaccount\.google\.com\/permissions/],
  ["Limited Use", /Limited Use requirements/],
  ["contact", /mailto:\$\{contact\}/],
  ["never deletes", /never deletes a video/],
];

/**
 * Does wrangler's run_worker_first send this path to the Worker? true = every path; an array is
 * globs ("*" any run of characters), "!"-prefixed ones excluding. Matched, never read as text.
 */
export function routesToWorker(rwf, p) {
  if (rwf === true) return true;
  if (!Array.isArray(rwf)) return false;
  const re = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const pos = rwf.filter((g) => !g.startsWith("!"));
  const neg = rwf.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return pos.some((g) => re(g).test(p)) && !neg.some((g) => re(g).test(p));
}

export function checkLegal({ legal, index, wrangler, shell, login }) {
  const problems = [];
  let items = 0;
  for (const p of ["/privacy", "/terms"]) {
    items++;
    if (!new RegExp(`legal\\.get\\("${p}"`).test(legal)) problems.push(`worker/routes/legal.ts does not serve GET ${p}`);
  }
  items++;
  if (!/app\.route\("\/",\s*legal\)/.test(index)) problems.push("worker/index.ts does not mount the legal routes at /");
  const cfg = parseJsonc(wrangler);
  for (const [name, a] of [["local dev", cfg.assets], ...Object.entries(cfg.env ?? {}).map(([k, v]) => [`env.${k}`, v.assets])]) {
    for (const p of ["/privacy", "/terms"]) {
      items++;
      if (!routesToWorker(a?.run_worker_first, p)) problems.push(`wrangler.jsonc ${name}: run_worker_first is missing "${p}" (the React app would answer it)`);
    }
  }
  for (const [what, re] of REQUIRED_PRIVACY) {
    items++;
    if (!re.test(legal)) problems.push(`the privacy page no longer says: ${what}`);
  }
  items++;
  if (!/href="\/privacy"/.test(shell) || !/href="\/terms"/.test(shell)) problems.push("app/components/Shell.tsx LegalLinks lost the /privacy or /terms link");
  const uses = (shell.match(/<LegalLinks \/>/g) ?? []).length;
  items++;
  if (uses < 2) problems.push(`Shell.tsx shows <LegalLinks /> ${uses} time(s); it must be in the sidebar foot and the phone Menu sheet`);
  items++;
  if (!/<LegalLinks \/>/.test(login)) problems.push("app/pages/Login.tsx does not show <LegalLinks /> on the login card");
  return { items, problems };
}

export default async function ({ root }) {
  const r = (p) => readFile(path.join(root, p), "utf8");
  return checkLegal({
    legal: await r("worker/routes/legal.ts"),
    index: await r("worker/index.ts"),
    wrangler: await r("wrangler.jsonc"),
    shell: await r("app/components/Shell.tsx"),
    login: await r("app/pages/Login.tsx"),
  });
}
