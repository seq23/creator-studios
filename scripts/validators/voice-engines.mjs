// Two voice engines (Phase 11): every narration row written says which engine made it, and every
// ElevenLabs call handles a refused key (401), used-up credits (402 / quota_exceeded) and busy
// (429) instead of passing a raw status on. Checked in code, not remembered:
//   1. every `INSERT INTO narrations` (Worker and jobs) names the engine column
//   2. the Worker reaches ElevenLabs only through elevenFetch in worker/services/elevenlabs.ts
//      (exactly one fetch there, inside elevenFetch; no other file names the ElevenLabs host)
//   3. every failed answer goes through classifyElevenError, which maps 401, 402 and 429
//   4. every real client method returns early on a failed elevenFetch
//   5. every call site of an ElevenLabs client method outside the service reads `.failure`
//      (the classified reason) within the next lines, so no failure is dropped
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir, exts) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, exts)));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const SERVICE = path.join("worker", "services", "elevenlabs.ts");
const DOMAIN = path.join("worker", "domain", "voiceEngine.ts");
const METHODS = ["subscription", "addVoice", "deleteVoice", "tts"];
const WINDOW = 12;

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const files = [...(await walk(path.join(root, "worker"), [".ts"])), ...(await walk(path.join(root, "jobs"), [".py"]))];

  for (const f of files) {
    const rel = path.relative(root, f);
    const text = await readFile(f, "utf8");

    // 1. narration rows carry an engine
    for (const m of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+narrations\s*\(([^)]*)\)/gi)) {
      items++;
      if (!/\bengine\b/.test(m[1])) problems.push(`${rel}: INSERT INTO narrations (${m[1].trim()}) does not write the engine column`);
    }

    // 2. only the service talks to ElevenLabs
    if (rel !== SERVICE && /api\.elevenlabs\.io|\bELEVEN_BASE\b/.test(text)) problems.push(`${rel}: calls ElevenLabs directly; go through worker/services/elevenlabs.ts`);

    // 5. call sites read the classified failure
    if (rel !== SERVICE && rel.endsWith(".ts")) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(new RegExp(`\\w\\)?!?\\.(${METHODS.join("|")})\\(`));
        if (!m) return;
        items++;
        const after = lines.slice(i, i + WINDOW).join("\n");
        if (!/\.failure\b/.test(after)) problems.push(`${rel}:${i + 1}: ElevenLabs ${m[1]}() result is not checked for its failure (401 / 402 / 429) within ${WINDOW} lines`);
      });
    }
  }

  const service = await readFile(path.join(root, SERVICE), "utf8");
  const fetches = [...service.matchAll(/\bfetch\(/g)];
  items++;
  if (fetches.length !== 1) problems.push(`${SERVICE}: expected exactly one fetch( (inside elevenFetch), found ${fetches.length}`);
  const body = service.match(/async function elevenFetch\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!body) problems.push(`${SERVICE}: elevenFetch not found`);
  else {
    if (!/\bfetch\(/.test(body)) problems.push(`${SERVICE}: the fetch is not inside elevenFetch`);
    if (!/classifyElevenError\(/.test(body)) problems.push(`${SERVICE}: elevenFetch does not classify failed answers with classifyElevenError`);
  }

  // 4. real methods return early on failure
  const real = service.match(/export class RealElevenLabs[\s\S]*?\n}\n/)?.[0] ?? "";
  const calls = [...real.matchAll(/await elevenFetch\(/g)];
  if (!calls.length) problems.push(`${SERVICE}: RealElevenLabs makes no elevenFetch calls`);
  for (const c of calls) {
    items++;
    const after = real.slice(c.index, c.index + 700);
    if (!/if \(!r\.ok\) return r;|return r\.ok \? .* : r;/.test(after)) problems.push(`${SERVICE}: an elevenFetch call in RealElevenLabs does not return its failure`);
  }

  // 3. the classifier maps the three statuses
  const domain = await readFile(path.join(root, DOMAIN), "utf8");
  const classify = domain.match(/export function classifyElevenError\([\s\S]*?\n}\n/)?.[0] ?? "";
  for (const status of ["401", "402", "429"]) {
    items++;
    if (!new RegExp(`status === ${status}`).test(classify)) problems.push(`${DOMAIN}: classifyElevenError does not handle ${status}`);
  }
  items++;
  if (!/quota/.test(classify)) problems.push(`${DOMAIN}: classifyElevenError does not read detail.status quota_exceeded`);

  return { items, problems };
}
