#!/usr/bin/env node
// Render a content plan on this Mac, $0: every piece in the plan (or --only=id,id) becomes
//   out/<plan>/<id>/reel.mp4 + cover.jpg   (a reel, 1080x1920, H.264 + AAC, music on the beat)
//   out/<plan>/<id>/slide-N.jpg            (a photo set, 1080x1350 each)
//   out/<plan>/<id>/sheet.jpg              (the review sheet: one frame a second, or every slide)
//   out/<plan>/<id>/<size>.mp4             (with --sizes=feed,story,pin: the same piece at ad sizes)
// then prints OUTPUT <n> pieces rendered. The plan is checked first (src/plan.ts); a plan with any
// problem renders nothing (NAMED STOP [PLAN_INVALID]). Pictures are read from the plan's source
// folders (never committed: the owner's own photos stay on the Mac).
//   node engine/render.mjs engine/plans/<plan>.json [--only=a,b] [--sizes=feed,story,pin]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const planPath = process.argv[2];
if (!planPath || planPath.startsWith("--")) {
  console.log("usage: node engine/render.mjs <plan.json> [--only=id,id] [--sizes=feed,story,pin]");
  process.exit(2);
}

// The plan check is TypeScript (shared with the tests); run it through the engine's own esbuild.
const { build } = await import("esbuild");
const planJs = path.join(os.tmpdir(), `engine-plan-${process.pid}.mjs`);
await build({ entryPoints: [path.join(HERE, "src/plan.ts")], bundle: true, format: "esm", platform: "node", outfile: planJs, logLevel: "error" });
const { validatePlan, aiScene, localToUtc } = await import(planJs);

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const problems = validatePlan(plan, Date.now());
if (problems.length) {
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`NAMED STOP [PLAN_INVALID] ${problems.length} problem(s); nothing rendered`);
  process.exit(1);
}
const only = arg("only")?.split(",").filter(Boolean);
const pieces = plan.pieces.filter((p) => !only || only.includes(p.id));
const extraSizes = (arg("sizes") ?? "").split(",").filter(Boolean);
const planName = path.basename(planPath, ".json");
const outRoot = path.join(process.env.ENGINE_OUT || path.join(HERE, "out"), planName);
const pub = path.join(HERE, "public");
mkdirSync(path.join(pub, "in"), { recursive: true });
mkdirSync(path.join(pub, "music"), { recursive: true });

const home = (p) => p.replace(/^~(?=\/)/, os.homedir());
const sourceDir = (kind) => {
  const d = home(plan.sources?.[kind] ?? "");
  if (!d || !existsSync(d)) {
    console.log(`NAMED STOP [SOURCE_MISSING] the plan's "${kind}" folder is not on this Mac: ${plan.sources?.[kind]}`);
    process.exit(1);
  }
  return d;
};
const library = JSON.parse(readFileSync(path.join(ROOT, "jobs/music/library.json"), "utf8")).tracks;

/** Copy one source picture into public/in and read its size. */
function pic(p) {
  const [kind, rel] = [p.src.slice(0, p.src.indexOf(":")), p.src.slice(p.src.indexOf(":") + 1)];
  const from = path.join(sourceDir(kind), rel);
  if (!existsSync(from)) {
    console.log(`NAMED STOP [PICTURE_MISSING] ${p.src}`);
    process.exit(1);
  }
  const name = `${kind}-${rel.replace(/[/\\]/g, "--")}`;
  copyFileSync(from, path.join(pub, "in", name));
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", from], { encoding: "utf8" }).trim().split("x").map(Number);
  return { src: `in/${name}`, w, h, fx: p.fx, fy: p.fy, label: p.label };
}

function propsFor(p, size) {
  const track = p.music ? library.find((t) => t.id === p.music) : null;
  if (p.music && !track) {
    console.log(`NAMED STOP [MUSIC_MISSING] ${p.music}`);
    process.exit(1);
  }
  if (track) copyFileSync(path.join(ROOT, track.file), path.join(pub, "music", `${track.id}.mp3`));
  return { brand: plan.brand, format: p.format, size, bpm: track?.bpm ?? 100, music: track ? `music/${track.id}.mp3` : null, pics: p.pics.map(pic), hook: p.hook, lines: p.lines ?? [], count: p.count, spots: p.spots, endLine: p.endLine, cover: p.cover };
}

// Pictures and music go into public/ before bundling (the bundle serves public/ as static files).
const prepared = pieces.map((p) => ({ p, props: propsFor(p, p.format === "carousel" ? "feed" : "reel") }));
console.log(`bundling ${prepared.length} piece(s)…`);
const serveUrl = await bundle({ entryPoint: path.join(HERE, "src/index.ts"), publicDir: pub });
// One browser for the whole plan (a browser per call timed out on a busy Mac), and a long frame timeout.
// Remotion gives the browser a fixed 25 s to start; on a busy Mac (or with the host's background-priority
// guard) that can pass, so the start is tried up to 6 times before the run stops.
async function startBrowser() {
  for (let i = 1; ; i++) {
    try {
      return await openBrowser("chrome");
    } catch (e) {
      if (i >= 6 || !/Timed out/i.test(String(e?.message ?? e))) throw e;
      console.log(`  browser start timed out (try ${i} of 6); trying again in 20 s`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}
const browser = await startBrowser();
const shared = { puppeteerInstance: browser, timeoutInMilliseconds: 600_000 };

const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
let done = 0;
for (const { p, props } of prepared) {
  const dir = path.join(outRoot, p.id);
  mkdirSync(dir, { recursive: true });
  const files = [];
  if (p.format === "carousel") {
    const slides = p.pics.length + 2;
    for (let i = 0; i < slides; i++) {
      const inputProps = { ...props, slide: i };
      const comp = await selectComposition({ serveUrl, ...shared, id: "Piece", inputProps });
      const file = `slide-${i + 1}.jpg`;
      await renderStill({ composition: comp, serveUrl, ...shared, inputProps, output: path.join(dir, file), imageFormat: "jpeg", jpegQuality: 92 });
      files.push(file);
    }
    ff(["-i", path.join(dir, "slide-%d.jpg"), "-vf", `scale=432:540,tile=${Math.min(slides, 4)}x${Math.ceil(slides / 4)}:padding=6:color=white`, "-frames:v", "1", path.join(dir, "sheet.jpg")]);
  } else {
    const comp = await selectComposition({ serveUrl, ...shared, id: "Piece", inputProps: props });
    await renderMedia({ composition: comp, serveUrl, ...shared, codec: "h264", crf: 18, pixelFormat: "yuv420p", audioCodec: "aac", inputProps: props, outputLocation: path.join(dir, "reel.mp4") });
    await renderStill({ composition: comp, serveUrl, ...shared, inputProps: props, frame: 0, output: path.join(dir, "cover.jpg"), imageFormat: "jpeg", jpegQuality: 90 });
    files.push("reel.mp4", "cover.jpg");
    const secs = comp.durationInFrames / comp.fps;
    const cols = 5;
    const n = Math.ceil(secs);
    ff(["-i", path.join(dir, "reel.mp4"), "-vf", `fps=1,scale=324:576,tile=${cols}x${Math.ceil(n / cols)}:padding=6:color=white`, "-frames:v", "1", path.join(dir, "sheet.jpg")]);
    for (const size of extraSizes) {
      const sp = { ...props, size };
      const c2 = await selectComposition({ serveUrl, ...shared, id: "Piece", inputProps: sp });
      await renderMedia({ composition: c2, serveUrl, ...shared, codec: "h264", crf: 20, pixelFormat: "yuv420p", audioCodec: "aac", inputProps: sp, outputLocation: path.join(dir, `${size}.mp4`) });
      files.push(`${size}.mp4`);
    }
    writeFileSync(path.join(dir, "duration.txt"), `${secs.toFixed(2)}\n`);
  }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: p.id, format: p.format, ai_scene: aiScene(p), files, at: p.at, at_utc: localToUtc(p.at, plan.tz), platforms: p.platforms }, null, 2));
  done++;
  console.log(`  ✓ ${p.id} (${p.format})`);
}
await browser.close({ silent: true });
console.log(`OUTPUT ${done} pieces rendered → ${outRoot}`);
if (!done) {
  console.log("NAMED STOP [NOTHING_RENDERED]");
  process.exit(1);
}
