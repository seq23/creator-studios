// The host's personal OpenRouter, Resend, Firecrawl and Hunter run Hadiyah's studio (owner decision 7 Oct 2026),
// the host's Resend and OpenRouter run Porch & Party Studio (slug sample1; owner's word 22 Oct 2026, "same as
// Hadiyah": studio email + AI writing + the host's job runner), and NO other studio: Sample 2/3 carry none.
// The exact list per studio is PINNED below (ALLOWED): adding a studio or a key to it is a code change with
// the owner's decision in its comment, never a registry edit alone. Checks:
//   - the studios that are host-accounts are exactly the pinned slugs, and each one's hostKeys, secret plan
//     and generated HOST_KEYS var name exactly its pinned keys (no more, no fewer);
//   - every studio's generated env says its registry kind (STUDIO_KIND), the one thing the Worker asks;
//   - a client studio's secret plan (and hostSecrets) names none of the host fallback secrets, and
//     secretPlan refuses one if it is added;
//   - every host-accounts studio's plan carries all of them (from its own 0600 files);
//   - the list in scripts/studio.mjs is the list in worker/lib/hostKeys.ts;
//   - the host-first studios (registry openrouterOrder "host-first", generated OPENROUTER_ORDER) are exactly
//     the pinned HOST_FIRST, each carries the host's OpenRouter key, and every other env says "pasted-first";
//   - nothing in worker/ or shared/ reads OPENROUTER_ / FIRECRAWL_ / HUNTER_API_KEY or STUDIO_EMAIL_FROM off the env but
//     worker/lib/hostKeys.ts (the gate) and worker/lib/practice.ts (after hydrate ran hostBase).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./studio-isolation.mjs";

/** Pinned: which host fallback secrets each host-accounts studio carries. Every other studio carries none. */
export const ALLOWED = Object.freeze({
  // Owner decisions 7 Oct 2026 (README "Hadiyah: whose account runs what").
  hadiyah: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM", "FIRECRAWL_API_KEY", "HUNTER_API_KEY"],
  // Owner's word 22 Oct 2026 ("Yes, same as Hadiyah"): Porch & Party Studio's email and AI writing.
  sample1: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
  // Owner's word 23 Oct 2026 ("One codebase"): Sheila's and Mercedes' studios joined the shared code;
  // only their studio email runs on a host Resend sender, everything else is their own.
  sheila: ["RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
  // Owner's word 24 Oct 2026: Mercedes's AI writing runs on the host's OpenRouter FIRST (ORDER below),
  // with her own pasted key as the backup.
  mercedes: ["OPENROUTER_API_KEY", "RESEND_API_KEY", "STUDIO_EMAIL_FROM"],
});

/** Pinned: the studios whose host OpenRouter key goes FIRST, her pasted key the backup. Every other studio: pasted wins. */
export const HOST_FIRST = Object.freeze(["mercedes"]);

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
export function checkHostKeys({ studios, cfg, secretPlan, cliList, workerList, sources, allowed = ALLOWED, hostFirst = HOST_FIRST }) {
  const problems = [];
  let items = 0;
  const want = [...cliList].sort().join(",");
  if (!cliList.length) problems.push("scripts/studio.mjs HOST_FALLBACK_SECRETS is empty (Rule 0)");
  if ([...workerList].sort().join(",") !== want) problems.push(`worker/lib/hostKeys.ts HOST_FALLBACK_SECRETS (${workerList.join(", ")}) differs from scripts/studio.mjs (${cliList.join(", ")})`);
  const clients = studios.filter((s) => s.kind === "client");
  const hosts = studios.filter((s) => s.kind === "host-accounts");
  if (!clients.length || !hosts.length) problems.push("the registry needs a client and a host-accounts studio to check (Rule 0)");
  const pinned = Object.keys(allowed).sort().join(",");
  const hostSlugs = hosts.map((s) => s.slug).sort().join(",");
  if (hostSlugs !== pinned) problems.push(`host-accounts studios are [${hostSlugs}], the pinned list is [${pinned}]`);
  const same = (a, b) => [...a].sort().join(",") === [...b].sort().join(",");
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
    const want = s.kind === "host-accounts" ? (allowed[s.slug] ?? []) : [];
    for (const n of cliList) {
      const carries = n in plan || n in (s.hostSecrets ?? {});
      if (s.kind === "client" && carries) problems.push(`env.${s.slug} (client) would carry the host's ${n}`);
      if (s.kind === "host-accounts" && want.includes(n) && !(n in plan)) problems.push(`env.${s.slug} (host-accounts) is missing ${n} in its secret plan`);
      if (s.kind === "host-accounts" && !want.includes(n) && carries) problems.push(`env.${s.slug} would carry the host's ${n}, which is not pinned for it`);
    }
    if (s.kind === "host-accounts" && !same(s.hostKeys ?? [], want)) problems.push(`studios/${s.slug}.json hostKeys [${(s.hostKeys ?? []).join(", ")}] differ from the pinned [${want.join(", ")}]`);
    if (s.kind === "client" && (s.hostKeys ?? []).length) problems.push(`studios/${s.slug}.json: a client studio has hostKeys`);
    const generated = (cfg.env?.[s.slug]?.vars?.HOST_KEYS ?? "").split(",").filter(Boolean);
    if (!same(generated, want)) problems.push(`wrangler env.${s.slug}: HOST_KEYS is [${generated.join(", ")}], pinned [${want.join(", ")}]`);
    const first = hostFirst.includes(s.slug);
    const order = cfg.env?.[s.slug]?.vars?.OPENROUTER_ORDER;
    if ((s.openrouterOrder === "host-first") !== first) problems.push(`studios/${s.slug}.json: openrouterOrder is ${s.openrouterOrder ?? "unset"}, pinned ${first ? "host-first" : "unset (pasted key wins)"}`);
    if (order !== (first ? "host-first" : "pasted-first")) problems.push(`wrangler env.${s.slug}: OPENROUTER_ORDER is ${order}, pinned ${first ? "host-first" : "pasted-first"}`);
    if (first && !want.includes("OPENROUTER_API_KEY")) problems.push(`${s.slug} is host-first but the host's OPENROUTER_API_KEY is not pinned for it`);
  }
  if (!hostFirst.length) problems.push("no host-first studio pinned; the key-order check read nothing (Rule 0)");
  if (cfg.vars?.OPENROUTER_ORDER !== "pasted-first") problems.push(`wrangler.jsonc top level (local dev) OPENROUTER_ORDER is ${cfg.vars?.OPENROUTER_ORDER}, must be pasted-first`);
  if (cfg.vars?.HOST_KEYS) problems.push("wrangler.jsonc top level (local dev) carries HOST_KEYS");
  if (cfg.vars?.STUDIO_KIND !== "client") problems.push(`wrangler.jsonc top level (local dev) STUDIO_KIND is ${cfg.vars?.STUDIO_KIND}, must be client`);
  const files = Object.keys(sources);
  if (!files.length) problems.push("no Worker sources scanned (Rule 0)");
  for (const f of files) {
    items++;
    if (READERS_ALLOWED.has(f)) continue;
    const m = READ.exec(sources[f]);
    if (m) problems.push(`${f}: reads ${m[1]} off the env; only worker/lib/hostKeys.ts may (it gates on STUDIO_KIND)`);
  }
  if (!/allowedHostKeys\(env\)/.test(sources["worker/lib/hostKeys.ts"] ?? "")) problems.push("worker/lib/hostKeys.ts: hostBase/hostKeyFor no longer gate on allowedHostKeys (HOST_KEYS), so a studio could read a host key not pinned for it");
  if (!/OPENROUTER_ORDER === "host-first"/.test(sources["worker/lib/hostKeys.ts"] ?? "")) problems.push("worker/lib/hostKeys.ts: hostFirst no longer reads OPENROUTER_ORDER, so the pinned key order governs nothing");
  if (!/getOpenRouterFallback\(/.test(sources["worker/services/openrouter.ts"] ?? "") || !/getOpenRouterFallback\(/.test(sources["worker/routes/jobs.ts"] ?? "")) problems.push("worker/services/openrouter.ts and worker/routes/jobs.ts must pass the host-first studio's own key as the backup (getOpenRouterFallback)");
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
