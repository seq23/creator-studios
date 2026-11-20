#!/usr/bin/env node
// New photo-real idea scenes for a plan, $0: Cloudflare Workers AI on the account's free daily
// allowance. FLUX.2 [klein] 9B looks best but MEASURED about 1,705 neurons per 768x1344 image
// (20 Nov 2026: 4 images = 6,818), more than the engine's whole day, so it is never picked by the
// cap; FLUX.1 [schnell] (priced about 60 a picture) is the default; ENGINE_IMAGE_MODEL picks another. Each "gen:<file>" picture the plan uses and that is
// not yet in the plan's gen folder is made from its prompt in plan.generate, with the engine's fixed
// rules appended (no people, no faces, no text, no house numbers, no balloon garlands).
//
// Metered, fail closed (the search-loop rule): before EVERY call it reads today's Workers AI usage
// from Cloudflare analytics; it stops when this model's use today would pass 1,500 neurons
// (ENGINE_NEURON_CAP) or the whole account would pass 9,000 of its free 10,000 (studios hold 8,500,
// overage is billed); if usage cannot be read it makes nothing. Analytics lags a few minutes, so a
// ledger of this run's own calls (engine/out/neurons-<UTC day>.json) is counted too.
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (reads usage), CLOUDFLARE_WORKERS_AI_TOKEN (runs the model)
//   node engine/imagine.mjs engine/plans/<plan>.json
// Prints OUTPUT <n> images made; NAMED STOP [WORKERS_AI_USAGE_UNREAD | WORKERS_AI_CAP] when it stops.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Worst-case neurons per 768x1344 picture: measured where we have it, else from the published price. */
export const MODELS = {
  "@cf/black-forest-labs/flux-1-schnell": { worst: 120, form: false },
  "@cf/black-forest-labs/flux-2-klein-9b": { worst: 1800, form: true },
};
export const MODEL = process.env.ENGINE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
export const ENGINE_NEURON_CAP = 1500;
export const ACCOUNT_CEILING = 9000;
const WORST_PER_IMAGE = MODELS[MODEL]?.worst ?? 2000;
export const RULES = "No people, no faces, no hands, no text, no lettering, no signs, no house numbers, no logos, no balloon garlands, no pastel balloons.";

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

/** Whether one more image fits today's caps. */
export function fits(used, ledger, worst) {
  const mine = Math.max(used.mine, ledger);
  return mine + worst <= ENGINE_NEURON_CAP && used.all + Math.max(0, ledger - used.mine) + worst <= ACCOUNT_CEILING;
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    console.log("usage: node engine/imagine.mjs <plan.json>");
    process.exit(2);
  }
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: readToken } = process.env;
  const runToken = process.env.CLOUDFLARE_WORKERS_AI_TOKEN || readToken;
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const dir = (plan.sources?.gen ?? "").replace(/^~(?=\/)/, os.homedir());
  if (!dir) throw new Error("the plan has no sources.gen folder");
  mkdirSync(dir, { recursive: true });
  const wanted = [...new Set(plan.pieces.flatMap((p) => p.pics.map((x) => x.src)).filter((s) => s.startsWith("gen:")).map((s) => s.slice(4)))];
  const todo = wanted.filter((f) => !existsSync(path.join(dir, f)));
  const day = new Date().toISOString().slice(0, 10);
  const ledgerFile = path.join(process.env.ENGINE_OUT || path.join(HERE, "out"), `neurons-${day}.json`);
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : { calls: 0, worst: 0 };
  let made = 0;
  for (const file of todo) {
    const prompt = plan.generate?.[file];
    if (!prompt) {
      console.log(`  - ${file}: no prompt in plan.generate`);
      continue;
    }
    const used = account && readToken ? await usedToday({ account, token: readToken }) : null;
    if (!used) {
      console.log(`OUTPUT ${made} images made`);
      console.log("NAMED STOP [WORKERS_AI_USAGE_UNREAD] today's Workers AI usage could not be read: nothing more is made (fail closed)");
      process.exit(1);
    }
    if (!fits(used, ledger.worst, WORST_PER_IMAGE)) {
      console.log(`OUTPUT ${made} images made`);
      console.log(`NAMED STOP [WORKERS_AI_CAP] this model ${Math.round(Math.max(used.mine, ledger.worst))}/${ENGINE_NEURON_CAP} neurons today, account ${Math.round(used.all)}/${ACCOUNT_CEILING}; the rest tomorrow`);
      process.exit(1);
    }
    let body;
    const headers = { authorization: `Bearer ${runToken}` };
    if (MODELS[MODEL]?.form) {
      body = new FormData();
      body.append("prompt", `${prompt} ${RULES}`);
      body.append("width", "768");
      body.append("height", "1344");
    } else {
      body = JSON.stringify({ prompt: `${prompt} ${RULES}`, steps: 6 });
      headers["content-type"] = "application/json";
    }
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, { method: "POST", headers, body });
    const j = await r.json().catch(() => ({}));
    ledger.calls++;
    ledger.worst += WORST_PER_IMAGE;
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    if (!r.ok || !j?.result?.image) {
      console.log(`  ✗ ${file}: ${r.status} ${String(j?.errors?.[0]?.message ?? "").slice(0, 120)}`);
      continue;
    }
    writeFileSync(path.join(dir, file), Buffer.from(j.result.image, "base64"));
    made++;
    console.log(`  ✓ ${file}`);
  }
  console.log(`OUTPUT ${made} images made (${wanted.length - todo.length} already there, ${wanted.length} wanted)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
