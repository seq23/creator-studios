// The check before the push (her photo check, 24 Nov 2026): `node scripts/studio.mjs engine-push` refuses a
// plan naming any never-use photo, under any prefix, before a byte leaves the Mac (exit 1, a NAMED STOP).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const NEVER = JSON.parse(readFileSync(path.join(ROOT, "engine", "never-use.json"), "utf8")).photos as string[];
const push = (src: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "push-"));
  const file = path.join(dir, "push-check.json");
  writeFileSync(file, JSON.stringify({ studio: "sample1", sources: { ai: dir, real: dir, gen: dir }, pieces: [{ id: "p1", pics: [{ src }] }] }));
  // No studio token in the env: a plan that got past the check would fail on the network, never exit with this stop.
  return spawnSync("node", ["scripts/studio.mjs", "engine-push", "sample1", file], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
};

describe("engine-push refuses her never-use photos", () => {
  it("holds all seven", () => expect(NEVER.length).toBe(7));
  for (const f of NEVER) for (const k of ["ai", "real"]) {
    it(`${k}:${f} → NAMED STOP [NEVER_USE_PHOTO], exit 1`, () => {
      const r = push(`${k}:${f}`);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("NAMED STOP [NEVER_USE_PHOTO]");
    });
  }
  it("a photo she allowed is not stopped by this check", () => {
    const r = push("ai:porch/bartlett-small-front-porch-styling-under-500.jpg");
    expect(r.stdout).not.toContain("NEVER_USE_PHOTO");
  });
});
