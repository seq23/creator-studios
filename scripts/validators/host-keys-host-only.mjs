// The host's personal OpenRouter, Resend, Firecrawl and Hunter run Hadiyah's studio (owner decision 7 Oct 2026) and
// NO client studio: Sample 1/2/3 carry none of the host's keys. Checks:
//   - every studio's generated env says its registry kind (STUDIO_KIND), the one thing the Worker asks;
//   - a client studio's secret plan (and hostSecrets) names none of the host fallback secrets, and
//     secretPlan refuses one if it is added;
//   - every host-accounts studio's plan carries all of them (from its own 0600 files);
//   - the list in scripts/studio.mjs is the list in worker/lib/hostKeys.ts;
//   - nothing in worker/ or shared/ reads OPENROUTER_ / FIRECRAWL_ / HUNTER_API_KEY or STUDIO_EMAIL_FROM off the env but
//     worker/lib/hostKeys.ts (the gate) and worker/lib/practice.ts (after hydrate ran hostBase).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./studio-isolation.mjs";

const READERS_ALLOWED = new Set(["worker/lib/hostKeys.ts", "worker/lib/practice.ts", "worker/env.ts"]);
const READ = /\.(OPENROUTER_API_KEY|FIRECRAWL_API_KEY|HUNTER_API_KEY|STUDIO_EMAIL_FROM)\b/;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Pure: studios, the parsed wrangler config, secretPlan, the two lists, and { relPath: text } of the Worker sources. */
export function checkHostKeys({ studios, cfg, secretPlan, cliList, workerList, sources }) {
  const problems = [];
  let items = 0;
  const want = [...cliList].sort().join(",");
  if (!cliList.length) problems.push("scripts/studio.mjs HOST_FALLBACK_SECRETS is empty (Rule 0)");
  if ([...workerList].sort().join(",") !== want) problems.push(`worker/lib/hostKeys.ts HOST_FALLBACK_SECRETS (${workerList.join(", ")}) differs from scripts/studio.mjs (${cliList.join(", ")})`);
  const clients = studios.filter((s) => s.kind === "client");
  const hosts = studios.filter((s) => s.kind === "host-accounts");
  if (!clients.length || !hosts.length) problems.push("the registry needs a client and a host-accounts studio to check (Rule 0)");
  for (const s of studios) {
    items++;
    if (s.kind !== "client" && s.kind !== "host-accounts") problems.push(`studios/${s.slug}.json: kind "${s.kind}" is neither client nor host-accounts`);
    const kind = cfg.env?.[s.slug]?.vars?.STUDIO_KIND;
    if (kind !== s.kind) problems.push(`wrangler env.${s.slug}: STUDIO_KIND is ${kind}, registry says ${s.kind}`);
    let plan;
    try {
      plan = secretPlan(s);
    } catch (e) {
      problems.push(`env.${s.slug}: ${e.message}`);
      plan = { ...(s.hostSecrets ?? {}) };
    }
    for (const n of cliList) {
      if (s.kind === "client" && (n in plan || n in (s.hostSecrets ?? {}))) problems.push(`env.${s.slug} (client) would carry the host's ${n}`);
      if (s.kind === "host-accounts" && !(n in plan)) problems.push(`env.${s.slug} (host-accounts) is missing ${n} in its secret plan`);
    }
  }
  if (cfg.vars?.STUDIO_KIND !== "client") problems.push(`wrangler.jsonc top level (local dev) STUDIO_KIND is ${cfg.vars?.STUDIO_KIND}, must be client`);
  const files = Object.keys(sources);
  if (!files.length) problems.push("no Worker sources scanned (Rule 0)");
  for (const f of files) {
    items++;
    if (READERS_ALLOWED.has(f)) continue;
    const m = READ.exec(sources[f]);
    if (m) problems.push(`${f}: reads ${m[1]} off the env; only worker/lib/hostKeys.ts may (it gates on STUDIO_KIND)`);
  }
  if (!/hostBase\(env\)/.test(sources["worker/lib/practice.ts"] ?? "")) problems.push("worker/lib/practice.ts: hydrate no longer starts from hostBase(env), so a client studio would read the host's keys");
  return { items, problems };
}

export default async function ({ root }) {
  const studio = await import(pathToFileURL(path.join(root, "scripts", "studio.mjs")).href);
  const { studios } = studio.loadRegistry(root);
  const cfg = parseJsonc(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  const hk = await readFile(path.join(root, "worker", "lib", "hostKeys.ts"), "utf8").catch(() => "");
  const workerList = [...(/HOST_FALLBACK_SECRETS = \[([^\]]*)\]/.exec(hk)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  const sources = {};
  for (const f of [...(await walk(path.join(root, "worker"))), ...(await walk(path.join(root, "shared")))]) sources[path.relative(root, f)] = await readFile(f, "utf8");
  return checkHostKeys({ studios, cfg, secretPlan: studio.secretPlan, cliList: studio.HOST_FALLBACK_SECRETS, workerList, sources });
}
