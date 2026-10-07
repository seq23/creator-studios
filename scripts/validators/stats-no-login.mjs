// Stats with no login (owner decision 25 Sep 2026: Sam never sees a Google or Meta consent
// screen; the sign-ins stay visible as optional extra detail, nothing gated behind them).
//   1. TikTok: no route refuses an upload just because it starts with "PK" (TikTok Studio's
//      "Download data → CSV" hands her a zip); the Excel refusal sits behind looksLikeXlsx; the
//      Stats file picker accepts .zip; the zip fixture the unit test reads is a real zip whose
//      CSV inflates to a TikTok Content export (checked here with Node's own zlib).
//   2. YouTube: the public client sends the API key only, never an Authorization header; the
//      key is declared in worker/env.ts and documented in wrangler.jsonc.
//   3. Nothing waits on a sign-in: POST /api/stats/sync never refuses; the Monday lane and the
//      daily lane run refreshPublicStats; the metrics job (sign-in path) is dispatched only
//      behind a sign-in check.
//   4. The sign-ins stay visible and say they are optional: Stats and Connections each link
//      both /api/oauth/{google,meta}/start and carry the "until the app is approved" sentence.
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";

function zipFirstCsv(buf) {
  // End of central directory → first .csv entry → local header → data.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (/\.csv$/i.test(name)) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}

export default async function ({ root }) {
  const problems = [];
  let items = 0;
  const read = (rel) => readFile(path.join(root, rel), "utf8");
  const check = (ok, msg) => {
    items++;
    if (!ok) problems.push(msg);
  };

  // 1. TikTok zip
  const statsRoute = await read("worker/routes/stats.ts");
  check(!/startsWith\(\s*["']PK["']\s*\)/.test(statsRoute), "worker/routes/stats.ts refuses anything starting with \"PK\": TikTok's own export is a zip");
  const excelLine = statsRoute.split("\n").find((l) => l.includes("That is an Excel file"));
  check(!!excelLine && /if \(looksLikeXlsx\(/.test(excelLine), "worker/routes/stats.ts: the Excel refusal must be on the `if (looksLikeXlsx(…))` line, so only a real workbook gets it");
  const statsPage = await read("app/pages/Stats.tsx");
  const accept = statsPage.match(/aria-label="Choose your TikTok export"[^>]*accept="([^"]+)"/)?.[1] ?? "";
  check(/\.zip/.test(accept) && /\.csv/.test(accept), "app/pages/Stats.tsx: the TikTok file picker must accept .zip and .csv");
  const fixture = zipFirstCsv(await readFile(path.join(root, "tests/unit/fixtures/tiktok-content.zip")));
  check(!!fixture && /"Video link"/.test(fixture) && /"Total views"/.test(fixture), "tests/unit/fixtures/tiktok-content.zip must be a real (deflated) zip holding a TikTok Content CSV");
  const guide = await read("help/guides/upload-your-tiktok-export.md");
  check(/\bzip\b/i.test(guide), "help/guides/upload-your-tiktok-export.md must tell her the download may be a zip and that is fine");

  // 2. YouTube with a key, no sign-in
  const yt = await read("worker/services/youtube.ts");
  check(!/Authorization/.test(yt), "worker/services/youtube.ts must never send an Authorization header: public numbers use the API key only");
  check(/key:\s*this\.key/.test(yt), "worker/services/youtube.ts must pass the API key on every call");
  check(/YOUTUBE_API_KEY\?: string/.test(await read("worker/env.ts")), "worker/env.ts must declare YOUTUBE_API_KEY");
  check(/secrets: \["YOUTUBE_API_KEY"\]/.test(await read("shared/setup.ts")), "shared/setup.ts must back YouTube numbers with the YOUTUBE_API_KEY secret");

  // 3. nothing waits on a sign-in
  const sync = statsRoute.slice(statsRoute.indexOf('stats.post("/sync"'), statsRoute.indexOf("stats.post(", statsRoute.indexOf('stats.post("/sync"') + 10));
  check(sync.length > 0 && !/fail\(/.test(sync) && /refreshPublicStats\(/.test(sync), "POST /api/stats/sync must run refreshPublicStats and never refuse for a missing sign-in");
  const weekly = await read("worker/crons/weekly.ts");
  check(/refreshPublicStats\(/.test(weekly), "worker/crons/weekly.ts must read the no-login numbers every Monday");
  const metricsLines = weekly.split("\n").filter((l) => /dispatchJob\(env,\s*"metrics"/.test(l));
  check(metricsLines.length > 0 && metricsLines.every((l) => /if \(signedIn/.test(l)), "worker/crons/weekly.ts: the metrics job (sign-in path) is dispatched only behind a sign-in check (Rule 0)");
  check(/refreshPublicStats\(/.test(await read("worker/crons/index.ts")), "worker/crons/index.ts: the daily lane must refresh the no-login numbers");

  // 4. sign-ins visible, labelled optional
  const connect = await read("app/pages/Connect.tsx");
  for (const [rel, text] of [["app/pages/Stats.tsx", statsPage], ["app/pages/Connect.tsx", connect]]) {
    const links = rel.endsWith("Connect.tsx") ? /\/api\/oauth\/\$\{provider\}\/start/.test(text) && /provider="google"/.test(text) && /provider="meta"/.test(text) : /\/api\/oauth\/google\/start/.test(text) && /\/api\/oauth\/meta\/start/.test(text);
    check(links, `${rel}: both sign-in buttons (Google and Instagram) must stay on the screen`);
    check(/until the app is approved/.test(text) && /optional/i.test(text), `${rel}: the sign-ins must say they are optional and that a warning may show until the app is approved`);
  }
  return { items, problems };
}
