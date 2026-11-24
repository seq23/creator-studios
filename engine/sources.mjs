// THE ENGINE'S SOURCES, MOVED FOR A RENDER ON GITHUB (Noelle, 23 Nov 2026: renders run on GitHub, never
// on the host's Mac). Two halves of one contract, both signed with the studio's job secret
// (worker/routes/ops.ts engine-src-file):
//
//   push (the Mac, through scripts/studio.mjs engine-push): the plan file and every picture it names go
//     to private storage under engine-src/<plan>/ ("<kind>--<path with / as -->").
//   fetch (the engine-render workflow): the plan comes back into engine/plans/, and each picture into
//     the SAME place the plan names (its `sources` folders under the runner's home), so render.mjs runs
//     unchanged and reads exactly the bytes the Mac had.
//
//   node engine/sources.mjs fetch <plan-name>     env WORKER_URL, JOB_SHARED_SECRET
//
// Rule 0: a fetch that brings back no picture, or a picture whose bytes differ from the plan's list,
// is a NAMED STOP and exit 1, never a render of whatever happened to be there.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The storage key of one picture `kind:rel` of a plan. */
export function srcKeyFor(planName, src) {
  const at = src.indexOf(":");
  const kind = src.slice(0, at);
  const rel = src.slice(at + 1);
  if (!/^[a-z]+$/.test(kind) || !rel || rel.includes("..")) throw new Error(`not a picture reference: ${src}`);
  return `engine-src/${planName}/${kind}--${rel.replace(/[/\\]/g, "--")}`;
}

/** Every picture a plan names, once. */
export function picturesOf(plan) {
  return [...new Set((plan.pieces ?? []).flatMap((p) => (p.pics ?? []).map((x) => x.src)))];
}

/** Headers for one signed ops call over `message`. */
export function signed(secret, message, ts = Math.floor(Date.now() / 1000)) {
  return { "x-ops-timestamp": String(ts), "x-ops-signature": createHmac("sha256", secret).update(`${ts}.ops:${message}`).digest("hex") };
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// A dropped connection or a 5xx/429 from the Worker is tried again (4 tries, waits 1s, 3s, 9s); one
// network blip on 23 Nov 2026 cost a whole night's queue. A 4xx (bad signature, missing file) is final.
const TRIES = 4;
const waitMs = (i) => Number(process.env.ENGINE_FETCH_RETRY_MS ?? 1000) * 3 ** i;
async function get(base, secret, key) {
  let last;
  for (let i = 0; i < TRIES; i++) {
    if (i) await new Promise((r) => setTimeout(r, waitMs(i - 1)));
    let r;
    try {
      r = await fetch(`${base}/api/ops/engine-src-file/${key}`, { headers: signed(secret, `get:${key}`) });
    } catch (e) {
      last = `${key}: ${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : ""}`;
      continue;
    }
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    last = `${key}: ${r.status}`;
    if (r.status < 500 && r.status !== 429) break;
  }
  throw new Error(`${last} after ${TRIES} tries`.replace(/(: 4\d\d) after \d+ tries$/, "$1"));
}

/** Fetch a pushed plan and its pictures into the places the plan names. */
export async function fetchPlan(planName, { base, secret, home = os.homedir(), plansDir = path.join(HERE, "plans") }) {
  const plan = JSON.parse(String(await get(base, secret, `engine-src/${planName}/plan.json`)));
  const want = plan.source_sha ?? {};
  let n = 0;
  for (const src of picturesOf(plan)) {
    const kind = src.slice(0, src.indexOf(":"));
    const rel = src.slice(src.indexOf(":") + 1);
    const dir = String(plan.sources?.[kind] ?? "").replace(/^~(?=\/)/, home);
    if (!dir.startsWith(home)) throw new Error(`NAMED STOP [SOURCE_OUTSIDE_HOME] the plan's ${kind} folder is not under the home folder`);
    const bytes = await get(base, secret, srcKeyFor(planName, src));
    if (want[src] && want[src] !== sha256(bytes)) throw new Error(`NAMED STOP [SOURCE_CHANGED] ${src} came back with other bytes than the Mac pushed`);
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), bytes);
    n++;
  }
  if (!n) throw new Error("NAMED STOP [NO_SOURCES] the plan names no picture; nothing to render");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(path.join(plansDir, `${planName}.json`), JSON.stringify(plan, null, 2));
  return { pictures: n, pieces: plan.pieces.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, planName] = process.argv.slice(2);
  if (cmd !== "fetch" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(planName ?? "")) {
    console.log("usage: node engine/sources.mjs fetch <plan-name>   (env WORKER_URL, JOB_SHARED_SECRET)");
    process.exit(2);
  }
  if (!process.env.WORKER_URL || !process.env.JOB_SHARED_SECRET) {
    console.log("NAMED STOP [SECRET_MISSING] WORKER_URL and JOB_SHARED_SECRET are both needed");
    process.exit(1);
  }
  try {
    const r = await fetchPlan(planName, { base: process.env.WORKER_URL, secret: process.env.JOB_SHARED_SECRET });
    console.log(`OUTPUT ${r.pictures} pictures fetched for ${r.pieces} pieces`);
  } catch (e) {
    console.log(String(e?.message ?? e).startsWith("NAMED STOP") ? e.message : `NAMED STOP [FETCH_FAILED] ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
  }
}
