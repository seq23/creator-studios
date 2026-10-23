// Studio parity (owner, 23 Oct 2026): every studio runs the same commit. scripts/parity-check.mjs.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { checkParity } from "../../scripts/parity-check.mjs";

const studios = [{ slug: "a", url: "https://a.example" }, { slug: "b", url: "https://b.example" }];
const ok = (slug: string, build = "abc1234def") => ({ ok: true, studio: slug, login: "code", build });

describe("studio parity", () => {
  it("passes when every studio answers as itself on the deployed commit", () => {
    expect(checkParity(studios, { a: ok("a"), b: ok("b") }, "abc1234def")).toEqual([]);
  });
  it("negative proof: old code, no answer, wrong studio, open login, zero studios, no expected commit each fail", () => {
    const text = checkParity(studios, { a: ok("a", "old0000"), b: null }, "abc1234def").join("\n");
    expect(text).toMatch(/a: runs old0000, main deployed abc1234/);
    expect(text).toMatch(/b: https:\/\/b\.example\/healthz did not answer/);
    expect(checkParity(studios, { a: { ...ok("a"), studio: "b" }, b: { ...ok("b"), login: "open" } }, "abc1234def").join("\n")).toMatch(/a: answers as studio "b"[\s\S]*b: login is "open"/);
    expect(checkParity([], {}, "abc1234def")).toEqual(["no studios in the registry (Rule 0)"]);
    expect(checkParity(studios, { a: ok("a"), b: ok("b") }, "").join("\n")).toMatch(/no expected commit/);
  });
});
