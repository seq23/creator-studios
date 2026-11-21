#!/usr/bin/env node
// New photo-real idea scenes for a plan, $0: Cloudflare Workers AI on the free daily allowance.
// FLUX.2 [klein] 9B looks best (MEASURED about 1,705 neurons per 768x1344 image, 20 Nov 2026) and
// can edit a reference picture (plan.generate entry {prompt, ref}: the same door with one wreath);
// FLUX.1 [schnell] (MEASURED about 250 a 1024x1024 picture, 20 Nov 2026) is the default;
// ENGINE_IMAGE_MODEL picks another. Each "gen:<file>" picture the plan uses and that is not yet in the
// plan's gen folder is made from its prompt in plan.generate, with the engine's fixed line appended
// (a still, quiet scene, ready and waiting; the review checks for people, writing and house numbers).
//
// Two free accounts, tried in order: the main one (CLOUDFLARE_ACCOUNT_ID; studios share it, so the
// engine keeps to 1,500 neurons a day, ENGINE_NEURON_CAP) and, when it is full, the second one
// (CF2_ACCOUNT_ID + CF2_WORKERS_AI_TOKEN; only the engine runs models there, so its cap is the
// account ceiling). Metered, fail closed (the search-loop rule): before EVERY call it reads that
// account's usage today from Cloudflare analytics; no account passes 9,000 of its free 10,000
// (overage is billed); an account whose usage cannot be read makes nothing. Analytics lags a few
// minutes, so a ledger of this run's own calls per account ($ENGINE_OUT/neurons-<UTC day>[-<acct>].json)
// is counted too.
//   main: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (reads usage), CLOUDFLARE_WORKERS_AI_TOKEN (runs the model)
//   second: CF2_ACCOUNT_ID, CF2_WORKERS_AI_TOKEN (reads usage and runs the model)
//   node engine/imagine.mjs engine/plans/<plan>.json [--only=file.jpg,file.jpg]
// Prints OUTPUT <n> images made; NAMED STOP [WORKERS_AI_USAGE_UNREAD | WORKERS_AI_CAP] when it stops.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Worst-case neurons per 768x1344 picture: measured where we have it, else from the published price. */
export const MODELS = {
  "@cf/black-forest-labs/flux-1-schnell": { worst: 260, form: false },
  "@cf/black-forest-labs/flux-2-klein-9b": { worst: 1800, form: true },
  "@cf/black-forest-labs/flux-2-klein-4b": { worst: 1000, form: true },
};
export const MODEL = process.env.ENGINE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
export const ENGINE_NEURON_CAP = 1500;
export const ACCOUNT_CEILING = 9000;
const WORST_PER_IMAGE = MODELS[MODEL]?.worst ?? 2000;
// FLUX has no negative prompt and draws what a prompt names, so the fixed line is positive; people,
// writing and house numbers are checks on the finished picture (the review), never words in the prompt.
export const RULES = "A still, quiet scene, ready and waiting.";

export function usageQuery(account, now = new Date()) {
  const since = now.toISOString().slice(0, 10) + "T00:00:00Z"; // the free allowance resets at 00:00 UTC
  return { query: "query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:200,filter:{datetime_geq:$s,datetime_lt:$u}){sum{totalNeurons} dimensions{modelId}}}}}", variables: { a: account, s: since, u: now.toISOString() } };
}

/** Today's neurons: the engine's (every image model it may use) and the whole account's; null when it cannot be read (fail closed). */
export async function usedToday({ account, token, fetchImpl = fetch, now = new Date() }) {
  try {
    const r = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(usageQuery(account, now)) });
    const rows = (await r.json())?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
    if (!r.ok || !Array.isArray(rows)) return null;
    let mine = 0;
    let all = 0;
    for (const x of rows) {
      const n = Number(x?.sum?.totalNeurons || 0);
      all += n;
      if (x?.dimensions?.modelId in MODELS) mine += n;
    }
    return { mine, all };
  } catch {
    return null;
  }
}

/** Whether one more image fits today's caps on one account (cap: the engine's share of it). */
export function fits(used, ledger, worst, cap = ENGINE_NEURON_CAP) {
  const mine = Math.max(used.mine, ledger);
  return mine + worst <= cap && used.all + Math.max(0, ledger - used.mine) + worst <= ACCOUNT_CEILING;
}

/** The accounts to try, in order: the main one, then the second (engine-only) one when its keys are set. */
export function accountsFrom(env) {
  const out = [];
  if (env.CLOUDFLARE_ACCOUNT_ID) out.push({ name: "main", account: env.CLOUDFLARE_ACCOUNT_ID, read: env.CLOUDFLARE_API_TOKEN, run: env.CLOUDFLARE_WORKERS_AI_TOKEN || env.CLOUDFLARE_API_TOKEN, cap: ENGINE_NEURON_CAP, ledger: "" });
  if (env.CF2_ACCOUNT_ID && env.CF2_WORKERS_AI_TOKEN && env.CF2_ACCOUNT_ID !== env.CLOUDFLARE_ACCOUNT_ID) out.push({ name: "second", account: env.CF2_ACCOUNT_ID, read: env.CF2_WORKERS_AI_TOKEN, run: env.CF2_WORKERS_AI_TOKEN, cap: ACCOUNT_CEILING, ledger: "-cf2" });
  return out;
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    console.log("usage: node engine/imagine.mjs <plan.json>");
    process.exit(2);
  }
  const accounts = accountsFrom(process.env);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const dir = (plan.sources?.gen ?? "").replace(/^~(?=\/)/, os.homedir());
  if (!dir) throw new Error("the plan has no sources.gen folder");
  mkdirSync(dir, { recursive: true });
  const wanted = [...new Set(plan.pieces.flatMap((p) => p.pics.map((x) => x.src)).filter((s) => s.startsWith("gen:")).map((s) => s.slice(4)))];
  // a picture made by editing another (ref) waits for that one
  const entry = (f) => (typeof plan.generate?.[f] === "string" ? { prompt: plan.generate[f] } : plan.generate?.[f] ?? null);
  // --only=a.jpg,b.jpg makes just those (the ones whose prompts have passed their review)
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",").filter(Boolean);
  const todo = wanted.filter((f) => !existsSync(path.join(dir, f)) && (!only || only.includes(f))).sort((a, b) => (entry(a)?.ref ? 1 : 0) - (entry(b)?.ref ? 1 : 0));
  const day = new Date().toISOString().slice(0, 10);
  const outDir = process.env.ENGINE_OUT || path.join(HERE, "out");
  mkdirSync(outDir, { recursive: true });
  const ledgerFile = (a) => path.join(outDir, `neurons-${day}${a.ledger}.json`);
  const ledgers = new Map(accounts.map((a) => [a.name, existsSync(ledgerFile(a)) ? JSON.parse(readFileSync(ledgerFile(a), "utf8")) : { calls: 0, worst: 0 }]));
  let made = 0;
  const stops = [];
  for (const file of todo) {
    const e = entry(file);
    if (!e?.prompt) {
      console.log(`  - ${file}: no prompt in plan.generate`);
      continue;
    }
    if (e.ref && !MODELS[MODEL]?.form) {
      console.log(`  - ${file}: edits a reference picture, which only FLUX.2 does (ENGINE_IMAGE_MODEL)`);
      continue;
    }
    if (e.ref && !existsSync(path.join(dir, e.ref))) {
      console.log(`  - ${file}: its reference ${e.ref} is not made yet`);
      continue;
    }
    // the first account with room today
    let acct = null;
    stops.length = 0;
    for (const a of accounts) {
      const used = a.account && a.read ? await usedToday({ account: a.account, token: a.read }) : null;
      if (!used) {
        stops.push(`[WORKERS_AI_USAGE_UNREAD] ${a.name}: today's usage could not be read (fail closed)`);
        continue;
      }
      const l = ledgers.get(a.name);
      if (!fits(used, l.worst, WORST_PER_IMAGE, a.cap)) {
        stops.push(`[WORKERS_AI_CAP] ${a.name}: engine ${Math.round(Math.max(used.mine, l.worst))}/${a.cap} neurons today, account ${Math.round(used.all)}/${ACCOUNT_CEILING}`);
        continue;
      }
      acct = a;
      break;
    }
    if (!acct) break;
    let body;
    const headers = { authorization: `Bearer ${acct.run}` };
    if (MODELS[MODEL]?.form) {
      body = new FormData();
      body.append("prompt", e.ref ? e.prompt : `${e.prompt} ${RULES}`); // an edit keeps its reference; nothing appended
      body.append("width", "768");
      body.append("height", "1344");
      if (e.ref) body.append("input_image_0", new Blob([readFileSync(path.join(dir, e.ref))], { type: "image/jpeg" }), e.ref);
    } else {
      body = JSON.stringify({ prompt: `${e.prompt} ${RULES}`, steps: 6 });
      headers["content-type"] = "application/json";
    }
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct.account}/ai/run/${MODEL}`, { method: "POST", headers, body });
    const j = await r.json().catch(() => ({}));
    const l = ledgers.get(acct.name);
    l.calls++;
    l.worst += WORST_PER_IMAGE;
    writeFileSync(ledgerFile(acct), JSON.stringify(l, null, 2));
    if (!r.ok || !j?.result?.image) {
      console.log(`  ✗ ${file} (${acct.name}): ${r.status} ${String(j?.errors?.[0]?.message ?? "").slice(0, 160)}`);
      continue;
    }
    writeFileSync(path.join(dir, file), Buffer.from(j.result.image, "base64"));
    made++;
    console.log(`  ✓ ${file} (${acct.name} account)`);
  }
  const left = wanted.filter((f) => !existsSync(path.join(dir, f))).length;
  console.log(`OUTPUT ${made} images made (${wanted.length - left} of ${wanted.length} wanted are there)`);
  if (left && !accounts.length) {
    console.log("NAMED STOP [WORKERS_AI_USAGE_UNREAD] no account keys set (CLOUDFLARE_ACCOUNT_ID or CF2_ACCOUNT_ID)");
    process.exit(1);
  }
  if (left && stops.length) {
    for (const x of stops) console.log(`NAMED STOP ${x}; the rest tomorrow (00:00 UTC)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
