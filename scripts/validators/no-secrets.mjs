// Public repo: no key-shaped strings anywhere in tracked source.
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const PATTERNS = [
  [/sk-or-v1-[a-f0-9]{20,}/, "OpenRouter key"],
  [/re_[A-Za-z0-9]{20,}/, "Resend key"],
  [/fc-[a-f0-9]{20,}/, "Firecrawl key"],
  [/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "AWS/R2 access key"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/(?:api|secret|access)[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i, "hard-coded key"],
];
const SKIP = /^(package-lock\.json|docs\/wireframes\/|public\/assets\/)/;

export default async function ({ root }) {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !SKIP.test(f));
  const problems = [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|gif|mp4|mov|webp|ico|woff2?)$/i.test(f)) continue;
    const text = await readFile(path.join(root, f), "utf8").catch(() => "");
    for (const [re, label] of PATTERNS) {
      if (re.test(text)) problems.push(`${f}: looks like a ${label}`);
    }
  }
  return { items: files.length, problems };
}
