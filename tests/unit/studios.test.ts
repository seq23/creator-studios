// The studio registry (studios/<slug>.json) → separate studios, each with its own Worker, D1 and
// R2 (studio brief §1). Guards (a) sample studios carry no host identifier and (b) studio
// isolation, each proven negatively here: break the input, watch the check fail, keep the repo green.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchBody } from "@worker/services/github";
import { envName, studioSlug } from "@worker/env";
// @ts-expect-error plain .mjs, no types
import { envBlock, loadRegistry, secretPlan, themeFor, wranglerConfig } from "../../scripts/studio.mjs";
// @ts-expect-error plain .mjs validator, no types
import sampleClean, { checkStudios } from "../../scripts/validators/sample-clean.mjs";
// @ts-expect-error plain .mjs validator, no types
import studioIsolation, { checkIsolation, parseJsonc } from "../../scripts/validators/studio-isolation.mjs";
// @ts-expect-error plain .mjs validator, no types
import studiosGenerated from "../../scripts/validators/studios-generated.mjs";
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
    expect(by.hadiyah).toMatchObject({ kind: "host-accounts", appName: "Hadiyah Studio", ownerName: "Hadiyah", ownerEmail: "sequoia@westpeek.ventures", theme: "hadiyah", url: "https://hadiyahstudio.seq-taylor.workers.dev" });
    for (const n of [1, 2, 3]) expect(by[`sample${n}`]).toMatchObject({ kind: "client", appName: `Sample ${n} Studio`, ownerEmail: "", theme: "slate", url: `https://sample${n}studio.seq-taylor.workers.dev` });
  });

  it("wrangler.jsonc is exactly what the registry generates (validator studios-generated)", async () => {
    expect(readFileSync(path.join(root, "wrangler.jsonc"), "utf8")).toBe(wranglerConfig(reg));
    expect((await studiosGenerated({ root })).problems).toEqual([]);
  });

  it("each studio's env carries its own name, URL, theme and the code login; the theme names the studio", () => {
    for (const s of reg.studios) {
      const e = envBlock(s, reg.themes);
      expect(e.vars).toMatchObject({ APP_NAME: s.appName, STUDIO_SLUG: s.slug, PUBLIC_BASE_URL: s.url, FAKE_SERVICES: "0", AUTH_MODE: "code", ENV_NAME: "production" });
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
      expect(names.sort()).toEqual(["JOB_SHARED_SECRET", "PLATFORM_EMAIL_FROM", "PLATFORM_RESEND_API_KEY", "SECRETS_KEY", "SESSION_SECRET"]);
      for (const n of names) expect(OWNER_KEY_NAMES).not.toContain(n);
    }
  });

  it("negative proof: the host's email, West Peek, Sheila, a host channel id or a host key bound as a secret each fail", async () => {
    const bad = clone(reg);
    const s1 = bad.studios.find((s: { slug: string }) => s.slug === "sample1");
    s1.ownerEmail = "sequoia@westpeek.ventures";
    const s2 = bad.studios.find((s: { slug: string }) => s.slug === "sample2");
    s2.appName = "Sheila's other studio";
    const s3 = bad.studios.find((s: { slug: string }) => s.slug === "sample3");
    s3.hostSecrets = { YOUTUBE_API_KEY: "vault:x" };
    s3.wordmark = { tag: "UC5vZFZc15DIM6IrFwFgAECg" };
    const r = await checkStudios(bad, envBlock, secretPlan);
    const text = r.problems.join("\n");
    expect(text).toMatch(/studios\/sample1\.json: a West Peek name or address/);
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
    writeFileSync(path.join(dir, "assets", "bad.js"), 'const c="seq.taylor@gmail.com";const id="6ab6d55c95ac053d3fefb3dc";');
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

describe("working rules", () => {
  it("CLAUDE.md carries 'nothing waits on the owner' and the only-a-secret-or-account stop rule", () => {
    const md = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/\*\*Nothing waits on the owner\.\*\*/);
    expect(md).toMatch(/Only a secret or an\s+account she alone holds may stop/);
    expect(md).toMatch(/nothing hidden, nothing switched off/i);
  });
});
