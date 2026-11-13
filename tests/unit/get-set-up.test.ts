// First-run "Get set up" on Home (owner, 23 Oct 2026; worker/routes/home.ts getSetUp): three steps
// (the brief is the studio's own job since 13 Nov 2026: nothing waits for her to approve it), a
// tick on each one done, each linking to its screen and its help guide; gone once all are done.
// Connect Instagram & TikTok sits in the main menu, and the Buffer card says why Buffer, plainly.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSetUp } from "@worker/routes/home";
import { harness } from "./helpers/studio-fix-env";
import { WHY_BUFFER } from "@shared/whyBuffer";

describe("Get set up", () => {
  it("ticks what is done, links each step to its screen and guide, and goes away when all are done", async () => {
    const h = await harness();
    h.db.raw.exec("DELETE FROM research_briefs; DELETE FROM brand_profile");
    const first = await getSetUp(h.env, false);
    expect(first?.map((s) => [s.key, s.done, s.to])).toEqual([
      ["connect", false, "/settings/connections"],
      ["profile", false, "/brain"],
      ["videos", false, "/dump"],
    ]);
    // No step asks her to lock or approve anything: the studio does both by itself.
    expect(first?.map((s) => `${s.label} ${s.line}`).join(" ")).not.toMatch(/\b(lock|approve)/i);
    for (const s of first ?? []) expect(existsSync(`help/guides/${s.guide}.md`), s.guide).toBe(true);
    expect(first?.[0].line).toMatch(/Buffer \(free\).*add Instagram and TikTok inside Buffer.*paste your Buffer key/);

    // Her words are there (a draft, not locked by her): that step is done. No brief exists and none is asked for.
    h.db.raw.exec("INSERT INTO connections (service, status) VALUES ('buffer', 'ok'); INSERT INTO brand_profile (sections, locked) VALUES ('{}', 0);");
    expect((await getSetUp(h.env, false))?.map((s) => s.done)).toEqual([true, true, false]);
    await h.dumpWith("dmp_g", [{ id: "ast_g", name: "a.mp4", mime: "video/mp4" }]);
    expect(await getSetUp(h.env, true)).toBeNull();
    // A Buffer key that stopped working is not "done".
    h.db.raw.exec("UPDATE connections SET status = 'error' WHERE service = 'buffer'");
    expect((await getSetUp(h.env, true))?.[0].done).toBe(false);
  });

  it("Home sends it and shows it first", async () => {
    const home = readFileSync("worker/routes/home.ts", "utf8");
    expect(home).toMatch(/getSetUp: await getSetUp\(c\.env, !!profileLocked\)/);
    const page = readFileSync("app/pages/Home.tsx", "utf8");
    expect(page.indexOf("<GetSetUp")).toBeGreaterThan(0);
    expect(page.indexOf("<GetSetUp")).toBeLessThan(page.indexOf("<Skeleton"));
  });
});

describe("Connect Instagram & TikTok is easy to find", () => {
  it("is in the main menu (phone and laptop read the same list)", () => {
    const shell = readFileSync("app/components/Shell.tsx", "utf8");
    expect(shell).toContain('{ to: "/settings/connections", label: "Connect Instagram & TikTok"');
  });
  it("the Buffer card shows Why Buffer?, and its guide exists", () => {
    const connect = readFileSync("app/pages/Connect.tsx", "utf8");
    expect(connect).toMatch(/def\.service === "buffer" \? <WhyBuffer \/>/);
    expect(WHY_BUFFER.length).toBeGreaterThan(0);
    expect(existsSync("help/guides/why-we-post-through-buffer.md")).toBe(true);
  });
});
