#!/usr/bin/env node
// The studio CLI: ONE codebase, deployed as separate studios. Each studio is one registry entry,
// studios/<slug>.json (its own Worker, D1 and R2, owner, theme). Everything else is derived here.
//
//   node scripts/studio.mjs gen                 write wrangler.jsonc from the registry (one env per studio)
//   node scripts/studio.mjs check               fail if wrangler.jsonc is not what `gen` writes (validator studios-generated)
//   npm run studio:create <slug>                create its D1 + R2, migrate, deploy, set secrets, print URL + first-login link
//   npm run studio:deploy <slug>|--all          build once, migrate, deploy, smoke (the ONLY deploy path; never a bare `wrangler deploy`)
//   npm run studio:secrets <slug>|--all [--refresh] [--only=NAME,…]  set the missing secrets; --refresh re-puts every sourced one
//                                               (platform sender, owner email, host keys; never rotates SECRETS_KEY)
//   npm run studio:invite <slug>                mint a new first-login link (14 days, single use)
//   node scripts/studio.mjs storage <slug>      create its D1 + R2 only (create does this first)
//   node scripts/studio.mjs list                the registry
//
// Secrets never pass through a command line or the screen, and nothing here ever touches the macOS
// Keychain (no `security` command, nothing that reads it: a Keychain prompt interrupts the owner). A value comes
// from an environment variable of the same name or a 0600 file <secrets dir>/<NAME> (default
// ~/.config/creator-studios/secrets, override with CS_SECRETS_DIR); generated values are made with
// crypto randomness and kept in 0600 files <secrets dir>/<slug>/<NAME>. Every value is piped
// straight into `wrangler secret put` / `gh secret set` on stdin, never printed.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_KEY_NAMES } from "./lib/owner-identifiers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "8d147e242033699dd37c6f5a451f48d2";
const HOST_REPO = "seq23/creator-studios";
/**
 * The platform sender (README "Platform sender"): the host's Resend, login codes only. The address
 * is on the verified Resend domain mail.spryexecutiveos.com; the display name is neutral on purpose
 * (every studio, the host's and every client's, sends its login codes through it).
 */
const PLATFORM_RESEND = "file:PLATFORM_RESEND_API_KEY";
export const PLATFORM_FROM = "Studio sign-in <login@mail.spryexecutiveos.com>";
/** The account's workers.dev subdomain: every studio's old address, which now 301s to its own hostname. */
const WORKERS_DEV = "seq-taylor.workers.dev";
/** The file (in <secrets dir>/<slug>/) holding a studio's owner login email: never in the public registry. */
export const OWNER_EMAIL_FILE = "OWNER_EMAIL";
/**
 * The file holding the host developer's login email (README "Login"): shared by every studio at
 * <secrets dir>/DEVELOPER_EMAIL, with an optional per-studio <secrets dir>/<slug>/DEVELOPER_EMAIL
 * override. Never in the public registry; the Worker secret DEVELOPER_EMAIL.
 */
export const DEVELOPER_EMAIL_FILE = "DEVELOPER_EMAIL";
const CRONS = ["0 * * * *", "30 13 * * *", "0 12 * * 1"];
// The Worker runs first for every path but the hashed build files, so a page request on a studio's
// old workers.dev address can 301 to its hostname (worker/lib/canonical-host.ts); a path the Worker
// has no route for goes on to the assets (worker/index.ts notFound). /privacy and /terms are among
// "/*" (validator legal-pages matches the patterns, it does not read them as text).
const RUN_WORKER_FIRST = ["/*", "!/assets/*"];

// ------------------------------------------------------------------ registry

export function loadRegistry(root = ROOT) {
  const dir = path.join(root, "studios");
  const themes = JSON.parse(readFileSync(path.join(dir, "themes.json"), "utf8"));
  const studios = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "themes.json")
    .sort()
    .map((f) => withUrls(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
  return { studios, themes };
}

/**
 * A registry entry names its `hostname` (its own custom domain, attached as a Workers Custom
 * Domain on deploy); the URLs are derived from it, so renaming a studio is one field. `url` is the
 * studio's one public address (PUBLIC_BASE_URL: links, cookies, OAuth redirects); `workersDevUrl`
 * is its old workers.dev address, kept answering with a 301 to `url`.
 */
export function withUrls(s) {
  if ("url" in s) throw new Error(`studios/${s.slug}.json: "url" is derived from "hostname"; remove it`);
  return { ...s, url: `https://${s.hostname}`, workersDevUrl: `https://${s.worker}.${WORKERS_DEV}` };
}

/** The theme a studio's Worker serves: the named theme, with the studio's wordmark name filled in. */
export function themeFor(studio, themes) {
  const t = themes[studio.theme];
  if (!t) throw new Error(`studio ${studio.slug}: theme "${studio.theme}" is not in studios/themes.json`);
  const { _about, ...rest } = t;
  return { ...rest, wordmark: { name: studio.appName, ...(t.wordmark ?? {}), ...(studio.wordmark ?? {}) } };
}

/** The wrangler env block for one studio. Pure. */
export function envBlock(s, themes) {
  return {
    name: s.worker,
    // workers.dev stays on so old links and in-flight jobs still reach the studio (GET/HEAD 301 to
    // the hostname: worker/lib/canonical-host.ts); the hostname is the studio's own address.
    workers_dev: true,
    routes: [{ pattern: s.hostname, custom_domain: true }],
    assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: RUN_WORKER_FIRST },
    d1_databases: [{ binding: "DB", database_name: s.d1.name, database_id: s.d1.id ?? "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "FILES", bucket_name: s.r2.bucket }],
    triggers: { crons: CRONS },
    vars: {
      APP_NAME: s.appName,
      OWNER_NAME: s.ownerName ?? "",
      // OWNER_EMAIL is NOT a var: it is a deploy-time Worker secret from <secrets dir>/<slug>/OWNER_EMAIL
      // (public repo; README "Owner email"), set by `studio:secrets`.
      STUDIO_SLUG: s.slug,
      STUDIO_THEME: JSON.stringify(themeFor(s, themes)),
      FAKE_SERVICES: "0",
      PUBLIC_BASE_URL: s.url,
      GITHUB_REPO: s.githubRepo ?? "",
      AUDIENCE_TIMEZONE: s.audienceTimezone ?? "America/New_York",
      ENV_NAME: "production",
      AUTH_MODE: "code",
    },
  };
}

/** The whole wrangler.jsonc: a local-dev top level (fakes on, local D1) plus one env per studio. Pure. */
export function wranglerConfig({ studios, themes }) {
  const slate = themeFor({ slug: "dev", appName: "Sample Studio", theme: "slate" }, themes);
  const cfg = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: "creator-studios-dev",
    main: "worker/index.ts",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    account_id: ACCOUNT_ID,
    workers_dev: false,
    observability: { enabled: true },
    assets: { directory: "./dist/client", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: RUN_WORKER_FIRST },
    d1_databases: [{ binding: "DB", database_name: "creator-studios-dev-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "creator-studios-dev-files" }],
    triggers: { crons: CRONS },
    vars: {
      APP_NAME: "Sample Studio",
      OWNER_NAME: "Sample Creator",
      STUDIO_SLUG: "dev",
      STUDIO_THEME: JSON.stringify(slate),
      FAKE_SERVICES: "1",
      PUBLIC_BASE_URL: "http://localhost:8787",
      GITHUB_REPO: "example/studio-jobs",
      AUDIENCE_TIMEZONE: "America/New_York",
      ENV_NAME: "dev",
      AUTH_MODE: "code",
    },
    env: Object.fromEntries(studios.map((s) => [s.slug, envBlock(s, themes)])),
  };
  const head = [
    "// GENERATED by `node scripts/studio.mjs gen` from studios/*.json. Do not edit by hand:",
    "// change the registry and run gen (validator studios-generated fails when this drifts).",
    "// Top level = local dev and e2e only (FAKE_SERVICES 1, local D1, never deployed: workers_dev false).",
    "// env.<slug> = one studio: its own Worker, D1 and R2. Deploy only with `npm run studio:deploy`.",
    "// Secrets are never here: `npm run studio:secrets <slug>` sets them (README \"Secrets\").",
  ].join("\n");
  return `${head}\n${JSON.stringify(cfg, null, 2)}\n`;
}

// ------------------------------------------------------------------ shell helpers

function run(cmd, args, { input, quiet, allowFail } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(cmd, args, { cwd: ROOT, input, encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // Cloudflare sometimes refuses the first request after wrangler refreshes its login (7403): retry that only.
    if (r.status !== 0 && /code: 7403/.test(out) && attempt < 3) {
      spawnSync("sleep", [String(attempt * 5)]);
      continue;
    }
    if (!quiet) process.stdout.write(out.split("\n").filter((l) => !/^\s*$/.test(l)).slice(-12).join("\n") + "\n");
    if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${r.status})`);
    return { ok: r.status === 0, out };
  }
}
const wrangler = (args, opts) => run("npx", ["wrangler", ...args], opts);

/** Where secret files live: CS_SECRETS_DIR, else ~/.config/creator-studios/secrets. */
export function secretsDir(env = process.env) {
  return env.CS_SECRETS_DIR || path.join(homedir(), ".config", "creator-studios", "secrets");
}

/** The secret-source forms a registry entry may name. Anything else is refused. */
export const SOURCE_FORMS = [/^file\??:[A-Z][A-Z0-9_]*$/, /^studio-file\??:[A-Z][A-Z0-9_]*$/, /^studio-or-file:[A-Z][A-Z0-9_]*$/, /^gh-auth-token$/, /^literal:.+$/, /^generate:(base64|hex)-32$/];
export const isKnownSource = (src) => typeof src === "string" && SOURCE_FORMS.some((re) => re.test(src));

/**
 * The value for `file:<NAME>` / `file?:<NAME>`: the environment variable NAME, else the file
 * <dir>/<NAME>, which must be 0600 (owner-only). Returns { value } or { stop } (a NAMED stop that
 * says exactly which file to create). The value is returned in memory only, never printed.
 */
export function fileSecret(name, { env = process.env, dir = secretsDir(env) } = {}) {
  const fromEnv = (env[name] ?? "").trim();
  if (fromEnv) return { value: fromEnv };
  const file = path.join(dir, name);
  const make = `create ${file} holding only the value (umask 077; printf '%s' "$VALUE" > ${file}; chmod 600 ${file}), or export ${name}`;
  if (!existsSync(file)) return { stop: `${name}: no secret file. ${make}` };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) return { stop: `${name}: ${file} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${file}` };
  const value = readFileSync(file, "utf8").trim();
  if (!value) return { stop: `${name}: ${file} is empty. ${make}` };
  return { value };
}

/**
 * A generated secret for one studio: reused from <dir>/<slug>/<NAME> when that file exists (so a
 * re-run after a failed put sets the same value), else made with crypto randomness and written
 * there 0600 before it is used. Never printed.
 */
export function generatedSecret(slug, name, kind, { env = process.env, dir = secretsDir(env) } = {}) {
  const sub = path.join(dir, slug);
  const file = path.join(sub, name);
  if (existsSync(file)) {
    const kept = readFileSync(file, "utf8").trim();
    if (kept) {
      chmodSync(file, 0o600);
      return kept;
    }
  }
  const value = kind === "hex-32" ? randomBytes(32).toString("hex") : randomBytes(32).toString("base64");
  mkdirSync(sub, { recursive: true, mode: 0o700 });
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
  return value;
}

/** Resolve one source to { value } or { stop }. Never reads the Keychain. */
export function resolveSource(src, opts = {}) {
  if (!isKnownSource(src)) throw new Error(`unknown secret source ${src}`);
  if (src === "gh-auth-token") {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const v = (r.stdout ?? "").trim();
    return v ? { value: v } : { stop: "GITHUB_DISPATCH_TOKEN: `gh auth token` gave nothing. Run: gh auth login" };
  }
  // studio-file: the studio's own 0600 file <dir>/<slug>/<NAME> (or env <NAME>_<SLUG>), e.g. its owner email.
  if (src.startsWith("studio-file")) {
    const name = src.replace(/^studio-file\??:/, "");
    const slug = opts.slug;
    if (!slug) throw new Error(`${src} needs the studio slug`);
    const env = opts.env ?? process.env;
    const dir = opts.dir ?? secretsDir(env);
    const r = fileSecret(name, { env: { [name]: env[`${name}_${slug.toUpperCase()}`] ?? "" }, dir: path.join(dir, slug) });
    return r.stop ? { stop: r.stop.replace(`export ${name}`, `export ${name}_${slug.toUpperCase()}`) } : r;
  }
  // studio-or-file: the studio's own file (or env <NAME>_<SLUG>) when present, else the shared
  // <dir>/<NAME> (or env <NAME>), e.g. the developer email every studio carries.
  if (src.startsWith("studio-or-file:")) {
    const name = src.slice("studio-or-file:".length);
    const own = resolveSource(`studio-file:${name}`, opts);
    if (own.value || !/: no secret file\./.test(own.stop)) return own;
    return fileSecret(name, opts);
  }
  if (src.startsWith("file?:")) return fileSecret(src.slice(6), opts);
  if (src.startsWith("file:")) return fileSecret(src.slice(5), opts);
  if (src.startsWith("literal:")) return { value: src.slice(8) };
  throw new Error(`secret source ${src} is resolved by the caller`);
}

const studioBySlug = (slug) => {
  const reg = loadRegistry();
  const s = reg.studios.find((x) => x.slug === slug);
  if (!s) throw new Error(`no studio "${slug}" in studios/ (have: ${reg.studios.map((x) => x.slug).join(", ")})`);
  return { s, reg };
};
const regPath = (slug) => path.join(ROOT, "studios", `${slug}.json`);

// ------------------------------------------------------------------ commands

function gen() {
  writeFileSync(path.join(ROOT, "wrangler.jsonc"), wranglerConfig(loadRegistry()));
  console.log(`wrangler.jsonc: ${loadRegistry().studios.length} studios`);
}

function provisionStorage(s) {
  const list = JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true }).out.replace(/^[^[]*/, ""));
  let db = list.find((d) => d.name === s.d1.name);
  if (!db) {
    wrangler(["d1", "create", s.d1.name]);
    db = JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true }).out.replace(/^[^[]*/, "")).find((d) => d.name === s.d1.name);
  }
  if (!db?.uuid) throw new Error(`D1 ${s.d1.name} was not created`);
  const buckets = wrangler(["r2", "bucket", "list"], { quiet: true }).out;
  if (!new RegExp(`name:\\s+${s.r2.bucket}\\b`).test(buckets)) wrangler(["r2", "bucket", "create", s.r2.bucket]);
  if (s.d1.id !== db.uuid) {
    const raw = JSON.parse(readFileSync(regPath(s.slug), "utf8"));
    raw.d1.id = db.uuid;
    writeFileSync(regPath(s.slug), JSON.stringify(raw, null, 2) + "\n");
  }
  console.log(`storage: D1 ${s.d1.name} (${db.uuid}), R2 ${s.r2.bucket}`);
}

/**
 * The secret NAMES a studio's Worker holds. A Worker that does not exist yet has none; output that
 * cannot be read is an error, never "none" (an empty answer makes `secrets` think SECRETS_KEY is
 * unset and put a new one, which would orphan every key pasted on Setup).
 */
export function parseSecretList(out) {
  // wrangler may print warnings first, and their ANSI colour codes contain "[": start at the JSON line.
  const at = out.search(/^\[/m);
  if (at < 0) throw new Error("wrangler secret list printed no JSON list; refusing to guess which secrets are set");
  const list = JSON.parse(out.slice(at, out.lastIndexOf("]") + 1));
  if (!Array.isArray(list)) throw new Error("wrangler secret list did not print a list");
  return new Set(list.map((x) => x.name));
}

function secretNames(slug) {
  const r = wrangler(["secret", "list", "--env", slug], { quiet: true, allowFail: true });
  if (!r.ok) {
    if (/not found|does not exist|10007/i.test(r.out)) return new Set();
    throw new Error(`wrangler secret list --env ${slug} failed; refusing to guess which secrets are set`);
  }
  return parseSecretList(r.out);
}

/** The secrets a studio carries, by name → where the value comes from. Pure (no values). */
export function secretPlan(s) {
  const plan = {
    SESSION_SECRET: "generate:base64-32",
    SECRETS_KEY: "generate:base64-32",
    JOB_SHARED_SECRET: "generate:hex-32",
    // The platform sender: the ONE shared piece (login codes only).
    PLATFORM_RESEND_API_KEY: PLATFORM_RESEND,
    PLATFORM_EMAIL_FROM: `literal:${PLATFORM_FROM}`,
    // The owner's login email, from the studio's own 0600 file, never the public registry. A
    // host-run studio needs it; a client studio's owner claims hers through the invite link.
    OWNER_EMAIL: `${s.kind === "host-accounts" ? "studio-file" : "studio-file?"}:${OWNER_EMAIL_FILE}`,
    // The host developer's login (every studio, full access, never the owner): the shared 0600
    // file, or the studio's own override. Required, so no studio is made without it.
    DEVELOPER_EMAIL: `studio-or-file:${DEVELOPER_EMAIL_FILE}`,
  };
  for (const [k, v] of Object.entries(s.hostSecrets ?? {})) if (!k.startsWith("_")) plan[k] = v;
  return plan;
}

/**
 * Prove a freshly made studio from the inside, without anyone's login: a throwaway HELPER session
 * (D1 rows made here, signed with the session secret this run just generated, deleted afterwards)
 * reads /api/me and /api/setup and loads the Setup screen in a headless browser. It must show every
 * service the studio has no key for as practice mode. Nothing is kept; the owner's login is untouched.
 */
async function verifyInside(s, sessionSecret) {
  const { createHmac } = await import("node:crypto");
  const sid = `ses_verify_${randomBytes(12).toString("hex")}`;
  const uid = `usr_verify_${randomBytes(6).toString("hex")}`;
  const sql = (q) => wrangler(["d1", "execute", s.d1.name, "--remote", "--env", s.slug, "--command", q], { quiet: true });
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  sql(`INSERT INTO users (id, email, role) VALUES ('${uid}', '${uid}@verify.invalid', 'helper'); INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES ('${sid}', '${uid}', '${expires}', '${new Date().toISOString()}')`);
  const cookie = `ss_session=${sid}.${createHmac("sha256", sessionSecret).update(sid).digest("hex")}`;
  const out = {};
  try {
    const me = await (await fetch(`${s.url}/api/me`, { headers: { cookie } })).json();
    const setup = await (await fetch(`${s.url}/api/setup`, { headers: { cookie } })).json();
    out.practice = me.practice ?? [];
    out.states = Object.fromEntries((setup.steps ?? []).map((x) => [x.id, x.state]));
    if (process.env.VERIFY_SHOTS_DIR) {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.context().addCookies([{ name: "ss_session", value: cookie.split("=")[1], url: s.url }]);
      await page.goto(`${s.url}/setup`);
      await page.locator(".setup-step .pill[data-state]").first().waitFor({ timeout: 20000 });
      out.page = { progress: await page.locator(".setup-progress").innerText(), practicePills: await page.locator('.pill[data-state="practice"]').count(), banner: await page.locator(".practice-banner").count(), title: await page.title() };
      await page.screenshot({ path: path.join(process.env.VERIFY_SHOTS_DIR, `${s.slug}-setup.png`), fullPage: false });
      await page.goto(`${s.url}/`);
      await page.screenshot({ path: path.join(process.env.VERIFY_SHOTS_DIR, `${s.slug}-home.png`), fullPage: false });
      await browser.close();
    }
  } finally {
    sql(`DELETE FROM sessions WHERE id = '${sid}'; DELETE FROM users WHERE id = '${uid}'`);
  }
  console.log(`verify ${s.slug}: ${JSON.stringify(out)}`);
  return out;
}

/**
 * Set the secrets a studio is missing. With `refresh`, every secret that comes from a source (a
 * file, a literal, `gh auth token`) is put again from that source, so changing the platform sender
 * or an owner email is one command; generated ones (SESSION_SECRET, SECRETS_KEY, JOB_SHARED_SECRET)
 * are never rotated. A client studio's optional OWNER_EMAIL whose file is gone is deleted on
 * refresh (the owner then comes from the invite claim only).
 */
function secrets(slug, { refresh = false, only = null } = {}) {
  const { s } = studioBySlug(slug);
  const have = secretNames(slug);
  const stops = [];
  const missing = [];
  let jobSecret = null;
  let freshSession = null;
  for (const [name, src] of Object.entries(secretPlan(s))) {
    if (only && !only.includes(name)) continue;
    const generated = src.startsWith("generate:");
    if (have.has(name) && (generated || !refresh)) {
      console.log(`secret ${name}: already set`);
      continue;
    }
    let value;
    if (generated) value = generatedSecret(slug, name, src.slice(9));
    else {
      const r = resolveSource(src, { slug });
      if (r.stop) {
        const optional = /^(studio-)?file\?:/.test(src);
        if (optional && name === "OWNER_EMAIL") {
          if (refresh && have.has(name)) {
            wrangler(["secret", "delete", name, "--env", slug], { input: "y\n", quiet: true });
            console.log(`secret ${name}: deleted (no file; the owner comes from the invite claim)`);
          } else console.log(`secret ${name}: not set (the owner claims the studio with the invite link)`);
          continue;
        }
        if (refresh && have.has(name)) {
          // Already set and nothing here to refresh it from: keep what the Worker has.
          console.log(`secret ${name}: kept (no source on this machine to refresh it from)`);
          continue;
        }
        // Optional (file?:) → the feature stays in practice mode; required → the run fails, naming the file.
        (optional ? stops : missing).push(r.stop);
        continue;
      }
      value = r.value;
    }
    wrangler(["secret", "put", name, "--env", slug], { input: value, quiet: true });
    console.log(`secret ${name}: ${have.has(name) ? "replaced" : "set"}`);
    if (name === "JOB_SHARED_SECRET") jobSecret = value;
    if (name === "SESSION_SECRET") freshSession = value;
  }
  // The host's job runner signs callbacks with the studio's own job secret: GitHub secret JOB_SHARED_SECRET_<SLUG>.
  if (s.jobSecretOnHostRepo && jobSecret) {
    run("gh", ["secret", "set", `JOB_SHARED_SECRET_${slug.toUpperCase()}`, "-R", HOST_REPO], { input: jobSecret, quiet: true });
    console.log(`GitHub secret JOB_SHARED_SECRET_${slug.toUpperCase()}: set`);
  } else if (s.jobSecretOnHostRepo && !jobSecret) {
    console.log(`GitHub secret JOB_SHARED_SECRET_${slug.toUpperCase()}: kept (the Worker's job secret was already set)`);
  }
  for (const stop of stops) console.log(`NAMED STOP: ${stop}`);
  if (missing.length) throw new Error(`NAMED STOP: required secret(s) missing for ${slug}; nothing else waits on them, re-run npm run studio:secrets ${slug} once they exist:\n  ${missing.join("\n  ")}`);
  return { stops, freshSession };
}

function invite(slug) {
  const { s } = studioBySlug(slug);
  const token = randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(`invite:${token}`).digest("hex");
  const expires = new Date(Date.now() + 14 * 86_400_000).toISOString();
  wrangler(["d1", "execute", s.d1.name, "--remote", "--env", slug, "--command", `INSERT INTO invites (token_hash, expires_at) VALUES ('${hash}', '${expires}')`], { quiet: true });
  const link = `${s.url}/#invite=${token}`;
  console.log(`first-login link for ${s.appName} (single use, until ${expires.slice(0, 10)}):\n  ${link}`);
  return link;
}

async function smoke(s) {
  const want = `"studio":"${s.slug}"`;
  let body = "";
  // A brand-new Worker's workers.dev name can take a minute to answer (7 Oct 2026: sample2's first
  // smoke read nothing at 40 s and 200 a minute later): read for up to ~2 minutes before judging.
  for (let i = 0; i < 24; i++) {
    try {
      body = await (await fetch(`${s.url}/healthz`)).text();
    } catch {
      body = "";
    }
    if (body.includes(want)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const problems = [];
  if (!body.includes('"fake":false') || !body.includes(want) || !body.includes('"login":"code"')) problems.push(`/healthz: ${body.slice(0, 120)}`);
  const me = await fetch(`${s.url}/api/me`);
  if (me.status !== 401) problems.push(`/api/me answered ${me.status} with no login (want 401: the login is on)`);
  const page = await fetch(`${s.url}/`);
  if (page.status !== 200) problems.push(`/ answered ${page.status}`);
  const css = await (await fetch(`${s.url}/studio-theme.css`)).text();
  if (!css.includes(":root")) problems.push("/studio-theme.css has no theme");
  const st = (await (await fetch(`${s.url}/api/studio`)).json().catch(() => ({})));
  if (st.appName !== s.appName) problems.push(`/api/studio names "${st.appName}", want "${s.appName}"`);
  // The old workers.dev address answers with a 301 to the studio's own hostname, path kept.
  const old = await fetch(`${s.workersDevUrl}/dump?x=1`, { redirect: "manual" }).catch(() => null);
  if (old?.status !== 301 || old.headers.get("location") !== `${s.url}/dump?x=1`) problems.push(`${s.workersDevUrl} answered ${old?.status} → ${old?.headers.get("location")} (want 301 → ${s.url}/dump?x=1)`);
  if (problems.length) throw new Error(`smoke ${s.slug}:\n  ${problems.join("\n  ")}`);
  console.log(`smoke ${s.slug}: ok (${s.url})`);
}

async function deploy(target) {
  const reg = loadRegistry();
  const list = target === "--all" ? reg.studios : [studioBySlug(target).s];
  if (!list.length) throw new Error("no studios in the registry");
  gen();
  run("npm", ["run", "build"], { quiet: true });
  // Guard (a) on what is about to ship: no host identifier in the client or Worker bundle.
  run("node", ["scripts/bundle-scan.mjs"]);
  for (const s of list) {
    if (!s.d1.id) throw new Error(`studio ${s.slug} has no D1 yet: run npm run studio:create ${s.slug}`);
    console.log(`==> ${s.slug}: migrations`);
    wrangler(["d1", "migrations", "apply", s.d1.name, "--remote", "--env", s.slug]);
    console.log(`==> ${s.slug}: deploy`);
    wrangler(["deploy", "--env", s.slug]);
    await smoke(s);
    if (s.kind === "client") {
      // Guard (a), live: a client studio's Worker holds none of the host's keys as secrets.
      const bound = [...secretNames(s.slug)].filter((n) => OWNER_KEY_NAMES.includes(n));
      if (bound.length) throw new Error(`${s.slug}: the host's key(s) ${bound.join(", ")} are bound as secrets on a client studio. Remove them: npx wrangler secret delete <NAME> --env ${s.slug}`);
    }
  }
}

async function create(slug) {
  const { s } = studioBySlug(slug);
  provisionStorage(s);
  await deploy(slug); // gen + build + migrations + deploy + smoke
  const { stops, freshSession } = secrets(slug);
  // Each secret put is a new Worker version; old isolates answer for a little while (7 Oct 2026:
  // the first Hadiyah check read the new version, the browser a moment later an older one). Wait
  // for the last one to settle, smoke again, then prove it from the inside.
  await new Promise((r) => setTimeout(r, 30000));
  await smoke(studioBySlug(slug).s);
  if (freshSession) await verifyInside(studioBySlug(slug).s, freshSession);
  const link = s.kind === "client" ? invite(slug) : null;
  console.log(`\n${s.appName}: ${s.url}`);
  if (link) console.log(`first-login link: ${link}`);
  else console.log(`log in at ${s.url} with the owner email from <secrets dir>/${slug}/OWNER_EMAIL (an email code)`);
  if (stops.length) console.log(`named stops: ${stops.join("; ")}`);
}

const [cmd, arg] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const commands = {
    gen,
    check: () => {
      const want = wranglerConfig(loadRegistry());
      const have = existsSync(path.join(ROOT, "wrangler.jsonc")) ? readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8") : "";
      if (want !== have) {
        console.log("wrangler.jsonc is not what the registry generates: run node scripts/studio.mjs gen");
        process.exit(1);
      }
      console.log("wrangler.jsonc matches the registry");
    },
    list: () => loadRegistry().studios.forEach((s) => console.log(`${s.slug.padEnd(10)} ${s.kind.padEnd(14)} ${s.url}  (old: ${s.workersDevUrl} → 301)`)),
    create: () => create(arg),
    deploy: () => deploy(arg),
    secrets: () => {
      const refresh = process.argv.includes("--refresh");
      // --only=NAME,NAME limits a run to those secrets (e.g. the platform sender on every studio).
      const only = process.argv.find((x) => x.startsWith("--only="))?.slice(7).split(",").filter(Boolean) ?? null;
      for (const slug of arg === "--all" ? loadRegistry().studios.map((x) => x.slug) : [arg]) {
        console.log(`==> ${slug}: secrets${refresh ? " (refresh)" : ""}`);
        secrets(slug, { refresh, only });
      }
    },
    invite: () => invite(arg),
    storage: () => {
      provisionStorage(studioBySlug(arg).s);
      gen();
    },
  };
  const fn = commands[cmd];
  if (!fn || (["create", "deploy", "secrets", "invite", "storage"].includes(cmd) && !arg)) {
    console.log("usage: node scripts/studio.mjs gen|check|list | create <slug> | deploy <slug>|--all | secrets <slug>|--all [--refresh] [--only=NAME,…] | invite <slug>");
    process.exit(2);
  }
  Promise.resolve(fn()).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
