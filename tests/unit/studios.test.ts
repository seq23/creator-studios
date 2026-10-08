// The studio registry (studios/<slug>.json) → separate studios, each with its own Worker, D1 and
// R2 (studio brief §1). Guards (a) sample studios carry no host identifier and (b) studio
// isolation, each proven negatively here: break the input, watch the check fail, keep the repo green.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchBody } from "@worker/services/github";
import { envName, studioSlug } from "@worker/env";
// @ts-expect-error plain .mjs, no types
import { DEVELOPER_EMAIL_FILE, envBlock, loadRegistry, parseSecretList, PLATFORM_FROM, resolveSource, secretPlan, themeFor, withUrls, wranglerConfig } from "../../scripts/studio.mjs";
// @ts-expect-error plain .mjs validator, no types
import registryNoEmails, { checkRegistryText } from "../../scripts/validators/registry-no-emails.mjs";
// @ts-expect-error plain .mjs validator, no types
import noPersonalEmails, { checkText as checkPersonalText, localSecretEmails } from "../../scripts/validators/no-personal-emails.mjs";
// @ts-expect-error plain .mjs validator, no types
import noHostBrand, { findBrand } from "../../scripts/validators/no-host-brand.mjs";
// @ts-expect-error plain .mjs validator, no types
import sampleClean, { checkStudios } from "../../scripts/validators/sample-clean.mjs";
// @ts-expect-error plain .mjs validator, no types
import studioIsolation, { checkIsolation, parseJsonc } from "../../scripts/validators/studio-isolation.mjs";
// @ts-expect-error plain .mjs validator, no types
import studiosGenerated, { checkEntries } from "../../scripts/validators/studios-generated.mjs";
// @ts-expect-error plain .mjs, no types
import { findIdentifiers, OWNER_KEY_NAMES } from "../../scripts/lib/owner-identifiers.mjs";
// @ts-expect-error plain .mjs, no types
import { scan } from "../../scripts/bundle-scan.mjs";

const root = path.resolve(__dirname, "../..");
const reg = loadRegistry(root);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("the registry", () => {
  it("has Hadiyah (host accounts) and three sample studios (clients) at the agreed URLs", () => {
    const by = Object.fromEntries(reg.studios.map((s: { slug: string }) => [s.slug, s]));
    expect(Object.keys(by).sort()).toEqual(["hadiyah", "sample1", "sample2", "sample3"]);
    expect(by.hadiyah).toMatchObject({ kind: "host-accounts", appName: "Hadiyah Studio", ownerName: "Hadiyah", theme: "hadiyah", hostname: "hadiyah-studio.spryexecutiveos.com", url: "https://hadiyah-studio.spryexecutiveos.com", workersDevUrl: "https://hadiyahstudio.seq-taylor.workers.dev" });
    for (const n of [1, 2, 3]) expect(by[`sample${n}`]).toMatchObject({ kind: "client", appName: `Sample ${n} Studio`, theme: "slate", hostname: `sample${n}-studio.spryexecutiveos.com`, url: `https://sample${n}-studio.spryexecutiveos.com`, workersDevUrl: `https://sample${n}studio.seq-taylor.workers.dev` });
    for (const s of reg.studios) expect(s, s.slug).not.toHaveProperty("ownerEmail");
  });

  it("wrangler.jsonc is exactly what the registry generates (validator studios-generated)", async () => {
    expect(readFileSync(path.join(root, "wrangler.jsonc"), "utf8")).toBe(wranglerConfig(reg));
    expect((await studiosGenerated({ root })).problems).toEqual([]);
  });

  it("each studio's env carries its own name, URL, theme and the code login; the theme names the studio", () => {
    for (const s of reg.studios) {
      const e = envBlock(s, reg.themes);
      expect(e.vars).toMatchObject({ APP_NAME: s.appName, STUDIO_SLUG: s.slug, PUBLIC_BASE_URL: s.url, FAKE_SERVICES: "0", AUTH_MODE: "code", ENV_NAME: "production" });
      // Its own hostname as a Workers Custom Domain; workers.dev kept on (it 301s); no owner email var.
      expect(e.routes).toEqual([{ pattern: s.hostname, custom_domain: true }]);
      expect(e.workers_dev).toBe(true);
      expect(e.vars).not.toHaveProperty("OWNER_EMAIL");
      expect(JSON.parse(e.vars.STUDIO_THEME).wordmark.name).toBe(s.slug === "hadiyah" ? "hadiyah" : s.appName);
    }
    expect(themeFor(reg.studios.find((s: { slug: string }) => s.slug === "hadiyah"), reg.themes).light["--font-display"]).toMatch(/Young Serif/);
  });

  it("job dispatches name the studio, so the workflow picks JOB_SHARED_SECRET_<SLUG>", () => {
    const b = dispatchBody({ STUDIO_SLUG: "hadiyah", PUBLIC_BASE_URL: "https://hadiyahstudio.example" }, "cut", { jobId: "job_1", nonce: "n", ts: 1, sig: "s" });
    expect(b.client_payload).toMatchObject({ studio: "HADIYAH", worker_url: "https://hadiyahstudio.example" });
    expect(studioSlug({ STUDIO_SLUG: undefined })).toBe("dev");
    expect(envName({ ENV_NAME: "dev" })).toBe("dev");
    expect(envName({ ENV_NAME: "production" })).toBe("production");
    for (const f of ["job-cut.yml", "job-research.yml", "job-brand_finder.yml", "job-voice.yml", "job-extract.yml", "job-fullvideo.yml", "job-metrics.yml", "job-ytupload.yml"]) {
      const y = readFileSync(path.join(root, ".github/workflows", f), "utf8");
      expect(y, f).toContain("secrets[format('JOB_SHARED_SECRET_{0}', github.event.client_payload.studio)]");
      expect(y, f).not.toMatch(/OPENROUTER_API_KEY: \$\{\{ secrets\.|FIRECRAWL_API_KEY: \$\{\{ secrets\./);
    }
  });
});

describe("guard (a): a client studio carries none of the host's identifiers", () => {
  it("passes on the repo", async () => {
    const r = await sampleClean({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(300);
  });

  it("a sample's secret plan holds only its own generated secrets and the platform sender", () => {
    for (const s of reg.studios.filter((x: { kind: string }) => x.kind === "client")) {
      const names = Object.keys(secretPlan(s));
      expect(names.sort()).toEqual(["DEVELOPER_EMAIL", "JOB_SHARED_SECRET", "OWNER_EMAIL", "PLATFORM_EMAIL_FROM", "PLATFORM_RESEND_API_KEY", "SECRETS_KEY", "SESSION_SECRET"]);
      for (const n of names) expect(OWNER_KEY_NAMES).not.toContain(n);
      // A client's owner email is optional (claimed through the invite link); its own file, never the host's.
      expect(secretPlan(s).OWNER_EMAIL).toBe("studio-file?:OWNER_EMAIL");
    }
  });

  it("negative proof: the host's email, her former business name, Sheila, a host channel id or a host key bound as a secret each fail", async () => {
    const bad = clone(reg);
    const s1 = bad.studios.find((s: { slug: string }) => s.slug === "sample1");
    s1.ownerEmail = `sequoia@${["we", "st", "pe", "ek"].join("")}.ventures`;
    const s2 = bad.studios.find((s: { slug: string }) => s.slug === "sample2");
    s2.appName = "Sheila's other studio";
    const s3 = bad.studios.find((s: { slug: string }) => s.slug === "sample3");
    s3.hostSecrets = { YOUTUBE_API_KEY: "file:YOUTUBE_API_KEY" };
    s3.wordmark = { tag: "UC5vZFZc15DIM6IrFwFgAECg" };
    const r = await checkStudios(bad, envBlock, secretPlan);
    const text = r.problems.join("\n");
    expect(text).toMatch(/studios\/sample1\.json: the host's former business name or address/);
    expect(text).toMatch(/studios\/sample1\.json: the host's email/);
    expect(text).toMatch(/studios\/sample2\.json: another client's studio \(Sheila\)/);
    expect(text).toMatch(/env\.sample3 would bind the host's key YOUTUBE_API_KEY as a secret/);
    expect(text).toMatch(/a host channel or account id/);
  });

  it("the bundle scan finds a planted identifier in a built file, and passes a clean one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "ok.js"), 'const a="Sample 1 Studio";');
    expect((await scan([dir])).problems).toEqual([]);
    writeFileSync(path.join(dir, "assets", "bad.js"), 'const c="seq.taylor@host.example";const id="6ab6d55c95ac053d3fefb3dc";');
    const r = await scan([dir]);
    expect(r.problems.join("\n")).toMatch(/bad\.js: the host's email/);
    expect(r.problems.join("\n")).toMatch(/bad\.js: a host channel or account id/);
    expect(findIdentifiers("nothing here, just Hadiyah")).toEqual([]);
  });
});

describe("guard (b): studio A's D1 and R2 are never studio B's", () => {
  const cfg = () => parseJsonc(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));

  it("passes on the repo: every studio has its own Worker, D1, R2 and URL", async () => {
    const r = await studioIsolation({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBe(4);
    const all = reg.studios.flatMap((s: { d1: { name: string }; r2: { bucket: string } }) => [s.d1.name, s.r2.bucket]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("negative proof: a shared D1, a shared bucket, a studio env pointing at another's storage, a shared Worker all fail", () => {
    const studios = clone(reg.studios);
    studios[2].d1.name = studios[1].d1.name;
    studios[3].r2.bucket = studios[0].r2.bucket;
    const c = cfg();
    c.env.sample1.d1_databases[0].database_name = reg.studios.find((s: { slug: string }) => s.slug === "hadiyah").d1.name;
    c.env.sample2.r2_buckets.push({ binding: "OTHER", bucket_name: "creator-studios-hadiyah-files" });
    const r = checkIsolation(studios, c);
    const text = r.problems.join("\n");
    expect(text).toMatch(/D1 name creator-studios-sample1-db is shared by sample1 and sample2/);
    expect(text).toMatch(/R2 bucket creator-studios-hadiyah-files is shared by hadiyah and sample3/);
    expect(text).toMatch(/env\.sample1: DB must bind exactly its own D1/);
    expect(text).toMatch(/env\.sample2: FILES must bind exactly its own R2/);
    const w = clone(reg.studios);
    w[1].worker = w[0].worker;
    expect(checkIsolation(w, cfg()).problems.join("\n")).toMatch(/Worker hadiyahstudio is shared by hadiyah and sample1/);
  });
});

describe("the owner email and the platform sender are never committed config", () => {
  it("hadiyah's owner email is required from its own 0600 file; the sender is the neutral mail.spryexecutiveos.com address", () => {
    const h = reg.studios.find((s: { slug: string }) => s.slug === "hadiyah");
    expect(secretPlan(h).OWNER_EMAIL).toBe("studio-file:OWNER_EMAIL");
    expect(PLATFORM_FROM).toBe("Studio sign-in <login@mail.spryexecutiveos.com>");
    expect(secretPlan(h).PLATFORM_EMAIL_FROM).toBe(`literal:${PLATFORM_FROM}`);
  });

  it("studio-file reads <dir>/<slug>/<NAME> (0600 only) or OWNER_EMAIL_<SLUG>, and names the file when missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
    expect(resolveSource("studio-file:OWNER_EMAIL", { slug: "hadiyah", dir, env: {} }).stop).toMatch(new RegExp(`^OWNER_EMAIL: no secret file\\. create ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/hadiyah/OWNER_EMAIL .*export OWNER_EMAIL_HADIYAH$`));
    mkdirSync(path.join(dir, "hadiyah"));
    writeFileSync(path.join(dir, "hadiyah", "OWNER_EMAIL"), "a@b.example\n", { mode: 0o644 });
    chmodSync(path.join(dir, "hadiyah", "OWNER_EMAIL"), 0o644);
    expect(resolveSource("studio-file:OWNER_EMAIL", { slug: "hadiyah", dir, env: {} }).stop).toMatch(/readable by others/);
    chmodSync(path.join(dir, "hadiyah", "OWNER_EMAIL"), 0o600);
    expect(resolveSource("studio-file:OWNER_EMAIL", { slug: "hadiyah", dir, env: {} })).toEqual({ value: "a@b.example" });
    expect(resolveSource("studio-file:OWNER_EMAIL", { slug: "hadiyah", dir, env: { OWNER_EMAIL_HADIYAH: "c@d.example" } })).toEqual({ value: "c@d.example" });
    // Another studio's file is never read.
    expect(resolveSource("studio-file:OWNER_EMAIL", { slug: "sample1", dir, env: { OWNER_EMAIL: "x@y.example" } }).stop).toMatch(/no secret file\. create .*\/sample1\/OWNER_EMAIL /);
  });

  it("every studio carries DEVELOPER_EMAIL from the shared 0600 file, a studio's own file overriding it", () => {
    for (const s of reg.studios) expect(secretPlan(s).DEVELOPER_EMAIL, s.slug).toBe(`studio-or-file:${DEVELOPER_EMAIL_FILE}`);
    expect(DEVELOPER_EMAIL_FILE).toBe("DEVELOPER_EMAIL");
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
    const src = "studio-or-file:DEVELOPER_EMAIL";
    // Neither file: a named stop naming the SHARED file.
    expect(resolveSource(src, { slug: "sample1", dir, env: {} }).stop).toMatch(new RegExp(`^DEVELOPER_EMAIL: no secret file\\. create ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/DEVELOPER_EMAIL `));
    writeFileSync(path.join(dir, "DEVELOPER_EMAIL"), "dev@host.example\n", { mode: 0o600 });
    chmodSync(path.join(dir, "DEVELOPER_EMAIL"), 0o600);
    for (const slug of ["hadiyah", "sample1", "sample2", "sample3"]) expect(resolveSource(src, { slug, dir, env: {} })).toEqual({ value: "dev@host.example" });
    // A studio's own file wins; a loose one is a stop, never a silent fall-back to the shared file.
    mkdirSync(path.join(dir, "sample2"));
    writeFileSync(path.join(dir, "sample2", "DEVELOPER_EMAIL"), "other@host.example", { mode: 0o600 });
    chmodSync(path.join(dir, "sample2", "DEVELOPER_EMAIL"), 0o600);
    expect(resolveSource(src, { slug: "sample2", dir, env: {} })).toEqual({ value: "other@host.example" });
    expect(resolveSource(src, { slug: "sample1", dir, env: {} })).toEqual({ value: "dev@host.example" });
    chmodSync(path.join(dir, "sample2", "DEVELOPER_EMAIL"), 0o644);
    expect(resolveSource(src, { slug: "sample2", dir, env: {} }).stop).toMatch(/readable by others/);
    // A loose shared file is refused too.
    chmodSync(path.join(dir, "DEVELOPER_EMAIL"), 0o644);
    expect(resolveSource(src, { slug: "sample1", dir, env: {} }).stop).toMatch(/readable by others/);
  });

  it("validator no-personal-emails passes on the repo and fails on a real address or a local secret's value (negative proof)", async () => {
    const r = await noPersonalEmails({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(400);
    expect(checkPersonalText("a.ts", 'to: "owner@studio.example", from: "login@mail.spryexecutiveos.com", x: "a@b.test", pkg@0.16.2')).toEqual([]);
    // Built at runtime, so this file itself never carries a real-looking address for the scan to find.
    const at = (local: string, domain: string) => [local, domain].join("@");
    expect(checkPersonalText("worker/lib/auth.ts", `const DEV = "${at("someone.real", "gmail.com")}";`).join("\n")).toMatch(/worker\/lib\/auth\.ts: a real email address \(s…@gmail\.com\) is committed/);
    expect(checkPersonalText("README.md", `mail me at ${at("boss", "realclient.com")}`).join("\n")).toMatch(/README\.md: a real email address/);
    // A secret file's value is caught even in an allowed shape, and never printed.
    const hit = checkPersonalText("t.ts", 'x = "Owner@Studio.Example"', ["owner@studio.example"]);
    expect(hit).toEqual(["t.ts: contains the value of a local secret email file"]);
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
    mkdirSync(path.join(dir, "sample1"));
    writeFileSync(path.join(dir, "DEVELOPER_EMAIL"), "Dev@Host.example\n", { mode: 0o600 });
    writeFileSync(path.join(dir, "sample1", "OWNER_EMAIL"), "o@client.example", { mode: 0o600 });
    writeFileSync(path.join(dir, "PLATFORM_RESEND_API_KEY"), "re_notanemail", { mode: 0o600 });
    expect((await localSecretEmails(dir)).sort()).toEqual(["dev@host.example", "o@client.example"]);
  });

  it("reads secret names through wrangler's coloured warnings, and refuses to guess on output it cannot read", () => {
    const warn = "\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m something\n";
    expect([...parseSecretList(`${warn}[\n  { "name": "SECRETS_KEY", "type": "secret_text" }\n]\n`)]).toEqual(["SECRETS_KEY"]);
    expect([...parseSecretList("[]")]).toEqual([]);
    // An unreadable answer is never "no secrets" (that would put a new SECRETS_KEY over the live one).
    expect(() => parseSecretList(`${warn}✘ [ERROR] something went wrong`)).toThrow(/refusing to guess/);
  });

  it("validator registry-no-emails passes on the repo and fails on a committed address or an ownerEmail field (negative proof)", async () => {
    const r = await registryNoEmails({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBe(5);
    expect(checkRegistryText("x.json", '{"note":"local dev uses owner@studio.example"}')).toEqual([]);
    expect(checkRegistryText("hadiyah.json", '{"note":"someone@client.example"}').join("\n")).toMatch(/hadiyah\.json: an email address \(s…@client\.example\) is committed/);
    expect(checkRegistryText("hadiyah.json", '{"ownerEmail":""}').join("\n")).toMatch(/an ownerEmail field/);
    expect(checkEntries([{ ...clone(reg.studios[0]), ownerEmail: "" }], reg.themes).join("\n")).toMatch(/ownerEmail is never in the public registry/);
  });

  it("a registry hostname must be a bare domain of its own, not a URL, not workers.dev, not shared", () => {
    for (const bad of ["https://a.example", "x.seq-taylor.workers.dev", "nodot", ""]) expect(checkEntries([{ ...clone(reg.studios[0]), hostname: bad }], reg.themes).join("\n"), bad).toMatch(/hostname must be/);
    expect(() => withUrls({ slug: "x", worker: "xstudio", hostname: "x.example", url: "https://x.example" })).toThrow(/derived from "hostname"/);
  });
});

describe("guard: the host's former business name is nowhere in the repo", () => {
  const brand = ["We", "st ", "Pe", "ek"].join("");
  it("passes on every tracked file", async () => {
    const r = await noHostBrand({ root });
    expect(r.problems).toEqual([]);
    expect(r.items).toBeGreaterThanOrEqual(300);
  });

  it("negative proof: each spelling, in a file or a file name, fails", () => {
    for (const v of [brand, brand.replace(" ", ""), brand.replace(" ", "-").toLowerCase(), brand.replace(" ", "_").toUpperCase()]) {
      expect(findBrand([["README.md", `line one\nfrom ${v} ventures`]]), v).toEqual(["README.md:2: the host's former business name"]);
    }
    expect(findBrand([[`docs/${brand.replace(" ", "").toLowerCase()}.md`, "clean"]]).join("\n")).toMatch(/the file name carries/);
    expect(findBrand([["a.md", "the western peak, Spry Executive OS"]])).toEqual([]);
  });

  it("negative proof on disk: an untracked file carrying it reds the validator", async () => {
    const f = path.join(root, "docs", `brand-probe-${process.pid}.md`);
    writeFileSync(f, `contact login@${brand.replace(" ", "").toLowerCase()}.ventures\n`);
    try {
      expect((await noHostBrand({ root })).problems.join("\n")).toMatch(new RegExp(`docs/brand-probe-${process.pid}\.md:1`));
    } finally {
      unlinkSync(f);
    }
    expect((await noHostBrand({ root })).problems).toEqual([]);
  });
});

describe("working rules", () => {
  it("CLAUDE.md carries 'nothing waits on the owner' and the only-a-secret-or-account stop rule", () => {
    const md = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/\*\*Nothing waits on the owner\.\*\*/);
    expect(md).toMatch(/Only a secret or an\s+account she alone holds may stop/);
    expect(md).toMatch(/nothing hidden, nothing switched off/i);
  });
});
