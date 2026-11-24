#!/usr/bin/env node
// The fresh reviewer (ship-ready: the builder never grades its own work). For each rendered piece of
// a plan, a new model session with no stake and no history of the build is given ONLY the real
// output (the review sheet: one frame a second, the cover at phone size, or every slide), the brand
// note, the piece's words and captions, and the checklist; it answers PASS or FAIL with what a real
// person would feel, plus a stop-scrolling hook score. A piece passes only on PASS with a hook
// score of at least 6. The verdict is written to out/<plan>/<id>/review.json; queueing
// (scripts/studio.mjs engine-queue) takes PASS pieces only and the studio holds anything else.
//   node engine/review.mjs engine/plans/<plan>.json [--only=a,b] [--again]
// Runs on the host's Claude seat through the `claude` CLI (no API key, $0 extra). OUTPUT line at the end.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const planPath = process.argv[2];
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!planPath) {
  console.log("usage: node engine/review.mjs <plan.json> [--only=id,id] [--again]");
  process.exit(2);
}
// The brief is TypeScript (src/review-brief.ts, shared with the tests); run it through the engine's own esbuild.
const { build } = await import("esbuild");
const briefJs = path.join(os.tmpdir(), `engine-review-brief-${process.pid}.mjs`);
await build({ entryPoints: [path.join(HERE, "src/review-brief.ts")], bundle: true, format: "esm", platform: "node", outfile: briefJs, logLevel: "error" });
const { brief } = await import(briefJs);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const only = arg("only")?.split(",").filter(Boolean);
const again = process.argv.includes("--again");
const outRoot = path.join(process.env.ENGINE_OUT || path.join(HERE, "out"), path.basename(planPath, ".json"));

async function reviewOne(piece) {
  const dir = path.join(outRoot, piece.id);
  const out = path.join(dir, "review.json");
  if (!existsSync(path.join(dir, "manifest.json"))) return { id: piece.id, verdict: "MISSING" };
  if (existsSync(out) && !again) return { id: piece.id, ...JSON.parse(readFileSync(out, "utf8")) };
  const files = piece.format === "carousel" ? ["sheet.jpg", ...JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).files] : ["sheet.jpg", "cover.jpg"];
  const { stdout } = await run("claude", ["-p", brief(plan, piece, dir, files), "--allowedTools", "Read", "--output-format", "json"], { cwd: dir, maxBuffer: 20 * 1024 * 1024, timeout: 600_000 });
  const answer = JSON.parse(stdout);
  const text = answer.result ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  let r;
  try {
    r = m ? JSON.parse(m[0]) : null;
  } catch {
    r = null;
  }
  if (!r || !["PASS", "FAIL"].includes(r.verdict)) r = { verdict: "FAIL", hook_score: 0, looked_at: "", fails: [{ item: "reviewer answer unreadable", feel: "", fix: "review again" }] };
  const pass = r.verdict === "PASS" && Number(r.hook_score) >= 6 && !(r.fails ?? []).length;
  const verdict = { verdict: pass ? "PASS" : "FAIL", by: "fresh reviewer (claude -p, new session, output only)", session: String(answer.session_id ?? ""), hook_score: Number(r.hook_score) || 0, looked_at: String(r.looked_at ?? ""), fails: r.fails ?? [], at: new Date().toISOString() };
  writeFileSync(out, JSON.stringify(verdict, null, 2));
  return { id: piece.id, ...verdict };
}

const pieces = plan.pieces.filter((p) => !only || only.includes(p.id));
const results = [];
const queue = [...pieces];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        const r = await reviewOne(p);
        results.push(r);
        console.log(`  ${r.verdict === "PASS" ? "✓ PASS" : "✗ " + r.verdict} ${p.id} (hook ${r.hook_score ?? "-"})${r.verdict === "FAIL" ? ": " + (r.fails ?? []).map((f) => f.item).join("; ") : ""}`);
      } catch (e) {
        results.push({ id: p.id, verdict: "ERROR" });
        console.log(`  ✗ ERROR ${p.id}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }),
);
const passed = results.filter((r) => r.verdict === "PASS").length;
console.log(`OUTPUT ${passed} of ${results.length} pieces passed review`);
if (!passed) {
  console.log("NAMED STOP [NOTHING_PASSED] remake the failed pieces (render.mjs --only=…) and review them --again");
  process.exit(1);
}
