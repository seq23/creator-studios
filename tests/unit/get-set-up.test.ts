// First-run "Get set up" on Home (owner, 23 Oct 2026; worker/routes/home.ts getSetUp): four steps, a
// tick on each one done, each linking to its screen and its help guide; gone once all are done.
// Connect Instagram & TikTok sits in the main menu, and the Buffer card says why Buffer, plainly.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSetUp } from "@worker/routes/home";
import { harness } from "./helpers/studio-fix-env";
import { WHY_BUFFER } from "@shared/whyBuffer";

describe("Get set up", () => {
  it("ticks what is done, links each step to its screen and guide, and goes away when all four are done", async () => {
    const h = await harness();
    h.db.raw.exec("DELETE FROM research_briefs; UPDATE brand_profile SET locked = 0, locked_at = NULL");
    const first = await getSetUp(h.env, false);
    expect(first?.map((s) => [s.key, s.done, s.to])).toEqual([
      ["connect", false, "/settings/connections"],
      ["profile", false, "/brain"],
      ["brief", false, "/research"],
      ["videos", false, "/dump"],
    ]);
    expect(first?.map((s) => s.label)).toEqual(["Connect Instagram & TikTok", "Lock your Brand Profile", "Approve your Research Brief", "Upload your first videos"]);
    for (const s of first ?? []) expect(existsSync(`help/guides/${s.guide}.md`), s.guide).toBe(true);
    expect(first?.[0].line).toMatch(/Buffer \(free\).*add Instagram and TikTok inside Buffer.*paste your Buffer key/);

    h.db.raw.exec("INSERT INTO connections (service, status) VALUES ('buffer', 'ok'); INSERT INTO research_briefs (body, status) VALUES ('{}', 'approved');");
    expect((await getSetUp(h.env, true))?.map((s) => s.done)).toEqual([true, true, true, false]);
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
  it("the Buffer card's first line says why Buffer, and Why Buffer? says the six things", () => {
    const connect = readFileSync("app/pages/Connect.tsx", "utf8");
    expect(connect).toContain("This is how your clips post to Instagram, TikTok and YouTube. Instagram and TikTok don’t let apps post directly without a long approval, so Buffer (free) does the posting.");
    expect(connect).toMatch(/def\.service === "buffer" \? <WhyBuffer \/>/);
    expect(WHY_BUFFER).toHaveLength(6);
    expect(WHY_BUFFER.join(" ")).toMatch(/weeks to months.*post today.*3 channels.*never see your passwords.*disconnect any time.*nothing for you to redo/);
    expect(existsSync("help/guides/why-we-post-through-buffer.md")).toBe(true);
  });
});
