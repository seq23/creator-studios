// Full videos straight to her own YouTube channel (owner decision, 26 Sep 2026). What must stay
// true, read from the source (tests/unit/youtube-direct.test.ts proves each rule by breaking it):
//   - the refresh token never leaves the Worker: the job asks /youtube-token for a short-lived
//     access token and never names a refresh token; the spec and the endpoint never carry one
//   - her videos are never deleted: no videos.delete / DELETE call to YouTube anywhere
//   - the quota cap: at most YT_UPLOADS_PER_DAY = 3 uploads a day, enforced by capNote in the sync
//   - the status part: madeForKids false, synthetic media declared, publishAt only 15+ min ahead
//   - the scopes are exactly youtube.upload + youtube.force-ssl (update needs force-ssl, measured 26 Sep 2026)
//   - the Calendar is followed: the hourly lane runs the sync, and move / swap / take off reconcile
//   - every YouTube failure shape (shared/youtube-errors.json) is named and tested
import { readFile } from "node:fs/promises";
import path from "node:path";

const KINDS = ["quota", "upload_limit", "revoked", "scope", "publish_at", "thumb_verify", "retry", "other"];

export function checkYouTubeDirect(src) {
  const problems = [];
  let items = 0;
  const check = (ok, msg) => {
    items++;
    if (!ok) problems.push(msg);
  };
  const { job, lib, jobsRoute, service, domain, oauth, cron, posts, fixtures, unit, pyTest } = src;
  check(!/refresh_token/.test(job), "jobs/ytupload.py must never mention a refresh token (it gets a short-lived access token from the Worker)");
  check(/\/youtube-token/.test(job), "jobs/ytupload.py must get its token from the Worker's /youtube-token");
  const spec = lib.match(/export async function buildUploadSpec[\s\S]*?\n}\n/)?.[0] ?? "";
  check(spec.length > 0 && !/refresh|token/i.test(spec.replace(/jobId/g, "")), "worker/lib/youtubeDirect.ts buildUploadSpec must not put any token in the job's spec");
  const ep = jobsRoute.match(/jobs\.post\("\/:id\/youtube-token"[\s\S]*?\n}\);/)?.[0] ?? "";
  check(ep.length > 0 && /job\.type !== "ytupload"/.test(ep) && /c\.json\(\{ access_token: tok\.access_token, expires_at: tok\.expires_at \}/.test(ep) && !/refresh/.test(ep), "worker/routes/jobs.ts /youtube-token must answer only a ytupload job, with only the access token and its expiry");
  for (const [name, text] of [["worker/services/youtubeDirect.ts", service], ["jobs/ytupload.py", job], ["worker/lib/youtubeDirect.ts", lib]]) {
    check(!/videos\.delete|method:\s*"DELETE"|method="DELETE"|"DELETE"/.test(text), `${name} must never delete a video (taken off = private and kept)`);
  }
  check(/export const YT_UPLOADS_PER_DAY = 3;/.test(domain), "worker/domain/youtubeDirect.ts: YT_UPLOADS_PER_DAY must be 3 (1600 of 10,000 quota units each)");
  check(/const cap = capNote\(today\);/.test(lib), "worker/lib/youtubeDirect.ts youtubeDirectSync must hold uploads past the daily cap (capNote)");
  check(/export const PUBLISH_AT_MIN_LEAD_MS = 15 \* 60_000;/.test(domain), "worker/domain/youtubeDirect.ts: a publish time closer than 15 minutes goes up at once");
  check(/selfDeclaredMadeForKids: false, containsSyntheticMedia: aiVoice/.test(domain), "worker/domain/youtubeDirect.ts statusPart must send madeForKids false and declare an automatic voice over");
  check(/export const YT_UPLOAD_SCOPES = \["https:\/\/www\.googleapis\.com\/auth\/youtube\.upload", "https:\/\/www\.googleapis\.com\/auth\/youtube\.force-ssl"\];/.test(lib), "worker/lib/youtubeDirect.ts: the scopes must be exactly youtube.upload + youtube.force-ssl");
  check(/oauth\.get\("\/youtube\/start"/.test(oauth) && /u\.searchParams\.set\("scope", YT_UPLOAD_SCOPES\.join\(" "\)\)/.test(oauth) && /u\.searchParams\.set\("access_type", "offline"\)/.test(oauth) && /include_granted_scopes", "true"/.test(oauth), "worker/routes/oauth.ts: Connect YouTube must ask for the upload scopes, offline, incrementally");
  check(/await youtubeDirectSync\(env\);/.test(cron), "worker/crons/index.ts: the hourly lane must run youtubeDirectSync");
  const follows = (posts.match(/await followYouTube\(c\.env, /g) ?? []).length;
  check(follows >= 4, `worker/routes/posts.ts: place, move, swap and take off must each follow YouTube (found ${follows})`);
  check(/verifyReadBack\(intent, back\)/.test(lib), "worker/lib/youtubeDirect.ts must read every upload back and compare (verifyReadBack)");
  let fx = {};
  try {
    fx = JSON.parse(fixtures);
  } catch {
    problems.push("shared/youtube-errors.json is not JSON");
  }
  const names = Object.keys(fx).filter((k) => !k.startsWith("_"));
  check(names.length >= 6, `shared/youtube-errors.json must hold the real failure shapes (found ${names.length})`);
  for (const n of names) {
    check(KINDS.includes(fx[n].kind) && fx[n].http && fx[n].body, `shared/youtube-errors.json ${n}: needs http, body and a kind from ${KINDS.join("/")}`);
  }
  check(/youtube-errors\.json/.test(unit) && /youtube-errors\.json/.test(pyTest), "tests/unit/youtube-direct.test.ts and jobs/tests/test_ytupload.py must both test every fixture");
  return { items, problems };
}

export default async function ({ root }) {
  const r = (p) => readFile(path.join(root, p), "utf8").catch(() => "");
  return checkYouTubeDirect({
    job: await r("jobs/ytupload.py"),
    lib: await r("worker/lib/youtubeDirect.ts"),
    jobsRoute: await r("worker/routes/jobs.ts"),
    service: await r("worker/services/youtubeDirect.ts"),
    domain: await r("worker/domain/youtubeDirect.ts"),
    oauth: await r("worker/routes/oauth.ts"),
    cron: await r("worker/crons/index.ts"),
    posts: await r("worker/routes/posts.ts"),
    fixtures: await r("shared/youtube-errors.json"),
    unit: await r("tests/unit/youtube-direct.test.ts"),
    pyTest: await r("jobs/tests/test_ytupload.py"),
  });
}
