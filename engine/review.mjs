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
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const only = arg("only")?.split(",").filter(Boolean);
const again = process.argv.includes("--again");
const outRoot = path.join(process.env.ENGINE_OUT || path.join(HERE, "out"), path.basename(planPath, ".json"));

const BRAND_NOTE = `Porch & Party (Memphis, porchandparty901.com): porch decorating, celebration setups (birthdays, anniversaries, showers, hotel-room surprises), grazing tables, giant yard game rentals. Idea: "Memphis porches & parties, set up for you." Voice: a friendly Memphis neighbour, plain words. Palette: Cotton #FBF6EE ground, Porch-step plum #2A1A28 ink, Marigold #F2B01E ONLY on the one call-to-action button, Haint blue #CFE8E6 for the 901 plaque and tags. Fonts: Fraunces (soft, heavy) for headings and the wordmark, Figtree for body. Logo: "Porch & Party" wordmark with "901" on a haint-blue plaque. Do not: pastel balloon-garland look, script fonts, stock-photo feel, customer faces or names, house numbers, prices, "insured"/"licensed"/guarantees, "Book now".`;

const CHECKLIST = `Judge it as a 20-year social video veteran would before shipping (bar: "nothing looks and feels and sounds like AI created it"):
1. First second: is the hook readable and does it give a reason to keep watching? Is frame 0 a usable cover?
2. Text: readable at phone size, inside the safe area (not under the platform's top bar, right-hand buttons or bottom caption block), no awkward line breaks or orphan words, no typos, no clipped or overlapping text.
3. Pictures: no AI tells (warped text or letters, melted objects, impossible light, extra or fused parts), no faces, no house numbers, no stretched, blurry or badly cropped pictures, no picture repeated inside the piece.
4. Brand: on-palette, the brand fonts, one marigold thing per screen, the end card with the wordmark and one next step.
5. Honesty (hard rule): a picture marked AI SCENE must never be presented or captioned as a job Porch & Party did (words like "we did this", "our client", "this job", "real setup" over an AI scene are a FAIL). Ideas, looks, questions and "we can do this for you" are fine. Pictures marked REAL are our own jobs and may be shown as ours. Neither needs to say it is AI.
6. Words and captions: no AI tells ("elevate", "delve", "unlock", "seamless", empty hype, triplets for rhythm), no prices, no invented customers, reviews or counts, no claims we cannot back, plain friendly voice, the request link present.
7. Overall: would a real person in Memphis stop, understand it in 3 seconds, and trust it? Anything that would make them scroll past, cringe or distrust it is a FAIL.`;

function brief(piece, dir, files) {
  const pics = piece.pics.map((p, i) => `  ${i + 1}. ${p.src.startsWith("real:") ? "REAL (our own job)" : "AI SCENE (an idea, never our job)"}${p.label ? ` — label "${p.label}"` : ""}`).join("\n");
  const words = [`hook: ${JSON.stringify(piece.hook)}`, ...(piece.lines ?? []).map((l) => `line: ${JSON.stringify(l)}`), ...(piece.spots ?? []).map((s) => `label: ${JSON.stringify(s.label)}`), piece.endLine ? `end line: ${JSON.stringify(piece.endLine)}` : ""].filter(Boolean).join("\n");
  const caps = Object.entries(piece.captions).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
  return `You are a fresh, independent reviewer. You did not make this. Look at the REAL rendered output with the Read tool (each file below), then judge it.

Piece: ${piece.id} — format "${piece.format}" — ${piece.format === "carousel" ? "a photo set (swipe post)" : "a vertical short video (TikTok / Reels / Facebook), music only, no voice"}.
Files to look at (absolute paths):
${files.map((f) => `  ${path.join(dir, f)}`).join("\n")}
${piece.format === "carousel" ? "" : "sheet.jpg holds one frame per second in reading order (left to right, top to bottom); cover.jpg is frame 0 at full size."}

Brand: ${BRAND_NOTE}

Pictures in it:
${pics}

On-screen words:
${words}

Captions (posted with it):
${caps}

${CHECKLIST}

Answer with ONE JSON object and nothing else:
{"verdict":"PASS" or "FAIL","hook_score":<1-10, how likely a scroller stops in the first second>,"looked_at":"<which files and frames you actually looked at>","fails":[{"item":"<what>","feel":"<what a real person would feel>","fix":"<the concrete fix>"}]}
PASS only when nothing on the checklist fails.`;
}

async function reviewOne(piece) {
  const dir = path.join(outRoot, piece.id);
  const out = path.join(dir, "review.json");
  if (!existsSync(path.join(dir, "manifest.json"))) return { id: piece.id, verdict: "MISSING" };
  if (existsSync(out) && !again) return { id: piece.id, ...JSON.parse(readFileSync(out, "utf8")) };
  const files = piece.format === "carousel" ? ["sheet.jpg", ...JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).files] : ["sheet.jpg", "cover.jpg"];
  const { stdout } = await run("claude", ["-p", brief(piece, dir, files), "--allowedTools", "Read", "--output-format", "json"], { cwd: dir, maxBuffer: 20 * 1024 * 1024, timeout: 600_000 });
  const text = JSON.parse(stdout).result ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  let r;
  try {
    r = m ? JSON.parse(m[0]) : null;
  } catch {
    r = null;
  }
  if (!r || !["PASS", "FAIL"].includes(r.verdict)) r = { verdict: "FAIL", hook_score: 0, looked_at: "", fails: [{ item: "reviewer answer unreadable", feel: "", fix: "review again" }] };
  const pass = r.verdict === "PASS" && Number(r.hook_score) >= 6 && !(r.fails ?? []).length;
  const verdict = { verdict: pass ? "PASS" : "FAIL", by: "fresh reviewer (claude -p, new session, output only)", hook_score: Number(r.hook_score) || 0, looked_at: String(r.looked_at ?? ""), fails: r.fails ?? [], at: new Date().toISOString() };
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
