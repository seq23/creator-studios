// Schedule rebalance approved 1 Nov 2026: the live studios' Monday lanes are staggered 20 minutes
// apart (05:00 / 05:20 / 05:40 / 06:00 Central Standard Time) instead of all firing at 12:00 UTC.
// Cloudflare crons are UTC; the registry carries each studio's weeklyCron, gen writes it into
// wrangler.jsonc, and the Worker reads every such Monday cron as the weekly lane.
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { laneFor } from "@worker/crons/index";
// @ts-expect-error plain .mjs module
import { cronsFor, loadRegistry } from "../../scripts/studio.mjs";

const WANT: Record<string, string> = { hadiyah: "0 11 * * 1", mercedes: "20 11 * * 1", sheila: "40 11 * * 1", sample1: "0 12 * * 1" };

describe("Monday lanes, staggered", () => {
  const reg = loadRegistry(path.resolve(__dirname, "../.."));
  const wrangler = JSON.parse(readFileSync(path.resolve(__dirname, "../../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));

  it("each live studio carries its own weekly cron, in the registry and in wrangler.jsonc", () => {
    for (const [slug, cron] of Object.entries(WANT)) {
      const s = reg.studios.find((x: { slug: string }) => x.slug === slug);
      expect(s, slug).toBeTruthy();
      expect(cronsFor(s), slug).toEqual(["0 * * * *", "30 13 * * *", cron]);
      expect(wrangler.env[slug].triggers.crons, slug).toEqual(["0 * * * *", "30 13 * * *", cron]);
    }
  });

  it("no two live studios share a Monday minute, and each is at least 20 minutes from the next", () => {
    const mins = Object.values(WANT).map((c) => Number(c.split(" ")[1]) * 60 + Number(c.split(" ")[0])).sort((a, b) => a - b);
    for (let i = 1; i < mins.length; i++) expect(mins[i] - mins[i - 1]).toBeGreaterThanOrEqual(20);
  });

  it("the Worker reads every staggered cron as the weekly lane, and nothing else as weekly", () => {
    for (const cron of Object.values(WANT)) expect(laneFor(cron), cron).toBe("weekly");
    expect(laneFor("0 * * * *")).toBe("buffer-sync");
    expect(laneFor("30 13 * * *")).toBe("daily");
    expect(laneFor("0 12 * * 2")).toBe("unknown");
    expect(laneFor("0 12 * * *")).toBe("unknown");
  });

  it("a malformed weeklyCron is refused at gen time, never deployed", () => {
    expect(() => cronsFor({ slug: "x", weeklyCron: "0 12 * * *" })).toThrow(/not a Monday/);
  });
});
