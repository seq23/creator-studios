// CLAUDE.md: "Never call the vault or the macOS `security` command; Keychain prompts interrupt the
// owner." This reads that line and scans every file in the repo for a Keychain route.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error plain .mjs, no types
import { scanKeychain } from "../../scripts/lib/no-keychain.mjs";
// @ts-expect-error plain .mjs, no types
import { fileSecret, generatedSecret, isKnownSource, loadRegistry, resolveSource, secretPlan, secretsDir } from "../../scripts/studio.mjs";

const ROOT = path.resolve(__dirname, "../..");
const V = "vau" + "lt";

describe("no Keychain route anywhere in the repo", () => {
  it("CLAUDE.md carries the rule", () => {
    expect(readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8")).toContain(
      "Never call the vault or the macOS `security` command; Keychain prompts interrupt the owner.",
    );
  });

  it("no file calls the vault or `security`", () => {
    const r = scanKeychain(ROOT);
    expect(r.files).toBeGreaterThan(100); // hard-fail on a scan that read nothing
    expect(r.problems).toEqual([]);
  });

  it("negative proof: each Keychain route is caught, a clean file passes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keychain-"));
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "ignored.js"), "repo" + "_operator");
    writeFileSync(path.join(dir, "clean.md"), "Secrets come from 0600 files. Never the vault or the `security` command.\n");
    expect(scanKeychain(dir)).toEqual({ files: 1, problems: [] });
    const bad = [
      `cd ~/repo-tools${"/"}agent && python3 -m ${"repo" + "_operator"}.cli status`,
      `python3 -m x.cli ${V} set some-id --class X`,
      `"YOUTUBE_API_KEY": "${V}:sheila-youtube-api-key"`,
      `"G": "${V}?:hadiyah-google"`,
      `security ${"find"}-generic-password -s x -w`,
      `security ${"add"}-generic-password -s x -w y`,
    ];
    bad.forEach((line, i) => writeFileSync(path.join(dir, `bad${i}.sh`), `ok\n${line}\n`));
    const r = scanKeychain(dir);
    for (let i = 0; i < bad.length; i++) expect(r.problems.some((p: string) => p.startsWith(`bad${i}.sh:2:`))).toBe(true);
    expect(r.problems.some((p: string) => p.startsWith("node_modules"))).toBe(false);
  });
});

describe("secrets come from env vars or 0600 files, never the Keychain", () => {
  const dirOf = () => mkdtempSync(path.join(tmpdir(), "cs-secrets-"));

  it("the directory defaults to ~/.config/creator-studios/secrets and CS_SECRETS_DIR overrides it", () => {
    expect(secretsDir({ HOME: "/h" } as NodeJS.ProcessEnv)).toMatch(/\.config\/creator-studios\/secrets$/);
    expect(secretsDir({ CS_SECRETS_DIR: "/x/y" } as NodeJS.ProcessEnv)).toBe("/x/y");
  });

  it("every registry source is a known form, none a vault one", () => {
    for (const s of loadRegistry().studios) {
      for (const [name, src] of Object.entries(secretPlan(s))) {
        expect(isKnownSource(src), `${s.slug} ${name}: ${src}`).toBe(true);
        expect(String(src)).not.toMatch(new RegExp(`^${V}`));
      }
    }
    expect(isKnownSource(`${V}:x`)).toBe(false);
    expect(() => resolveSource(`${V}:x`)).toThrow(/unknown secret source/);
  });

  it("an env var wins; a 0600 file is read; missing, empty or loose files are named stops naming the file", () => {
    const dir = dirOf();
    expect(fileSecret("K", { env: { K: " from-env " }, dir })).toEqual({ value: "from-env" });
    const missing = fileSecret("K", { env: {}, dir });
    expect(missing.stop).toContain(path.join(dir, "K"));
    expect(missing.stop).toMatch(/chmod 600/);
    expect(missing.value).toBeUndefined();
    writeFileSync(path.join(dir, "K"), "", { mode: 0o600 });
    expect(fileSecret("K", { env: {}, dir }).stop).toMatch(/is empty/);
    writeFileSync(path.join(dir, "K"), "s3cret\n");
    chmodSync(path.join(dir, "K"), 0o644);
    const loose = fileSecret("K", { env: {}, dir });
    expect(loose.stop).toMatch(/readable by others/);
    expect(loose.value).toBeUndefined();
    chmodSync(path.join(dir, "K"), 0o600);
    expect(fileSecret("K", { env: {}, dir })).toEqual({ value: "s3cret" });
    expect(resolveSource("file?:K", { env: {}, dir })).toEqual({ value: "s3cret" });
    expect(resolveSource("literal:abc")).toEqual({ value: "abc" });
  });

  it("generated secrets are random, written 0600 under <slug>/, and reused on a re-run", () => {
    const dir = dirOf();
    const a = generatedSecret("s1", "SESSION_SECRET", "base64-32", { env: {}, dir });
    const file = path.join(dir, "s1", "SESSION_SECRET");
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(a);
    expect(generatedSecret("s1", "SESSION_SECRET", "base64-32", { env: {}, dir })).toBe(a);
    const h = generatedSecret("s2", "JOB_SHARED_SECRET", "hex-32", { env: {}, dir });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(generatedSecret("s3", "JOB_SHARED_SECRET", "hex-32", { env: {}, dir })).not.toBe(h);
  });
});
