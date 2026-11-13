// First-run "Get set up" on Home (owner, 23 Oct 2026; worker/routes/home.ts getSetUp): three steps
// (the brief is the studio's own job since 13 Nov 2026: nothing waits for her to approve it), a
// tick on each one done, each linking to its screen and its help guide; gone once all are done.
// Connect Instagram & TikTok sits in the main menu, and the Buffer card says why Buffer, plainly.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSetUp } from "@worker/routes/home";
import { homeRows, postsLeftLine } from "@shared/home";
import type { HomeSummary } from "@shared/types";
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

  it("Home lists what needs her: Get set up first and the only primary; then looking, adding more, and red lights only", () => {
    const base = {
      runway: { weeks: 0.5, approvedClips: 3, thresholdWeeks: 2, weeklyNeed: 10 },
      thisWeek: { posted: 16, toGo: 10, plannedThrough: "2026-11-22", tz: "America/Chicago", perPlatform: {} },
      waiting: { clips: 12, clipsThisWeek: 12, dumpsCutting: 0, making: null },
      followups: { items: [{ key: "f1", dealId: "dl_1", brand: "Brightside", dueAt: "2026-11-14", what: "Send follow-up 1" }], total: 3 },
      health: { items: [{ name: "Buffer", label: "Buffer", light: "red" }, { name: "Email (Resend)", label: "Email", light: "grey" }, { name: "Storage", label: "Storage", light: "yellow" }], total: 3 },
    };
    const setting = homeRows({ ...base, getSetUp: [{ key: "connect", done: false }, { key: "profile", done: true }, { key: "videos", done: false }] } as unknown as HomeSummary);
    expect(setting[0]).toMatchObject({ key: "get-set-up", to: "/start", primary: true });
    expect(setting[0].why).toMatch(/^2 steps left/);
    expect(setting.filter((r) => r.primary)).toHaveLength(1);
    expect(setting.map((r) => r.key)).not.toContain("add-more"); // while setting up, Get set up is the way to add
    const running = homeRows({ ...base, getSetUp: null } as unknown as HomeSummary);
    expect(running.map((r) => r.key)).toEqual(["look", "add-more", "followups", "fix-Buffer"]); // grey and yellow lights are not hers
    expect(running[2]).toMatchObject({ title: "Brightside: Send follow-up 1", to: "/deals?deal=dl_1" });
    expect(running[2].why).toMatch(/^2 more due after it\. Why: /);
    expect(running.every((r) => /Why: /.test(r.why) && r.action && r.to.startsWith("/"))).toBe(true);
    expect(running[1].why).toMatch(/^10 posts left\. Why: nothing is planned after /);
    expect(homeRows({ ...base, getSetUp: null, waiting: { ...base.waiting, clips: 0 }, runway: { ...base.runway, weeks: 4 }, health: { items: [], total: 0 }, followups: { items: [], total: 0 } } as unknown as HomeSummary)).toEqual([]);
    expect(postsLeftLine({ ...base, getSetUp: null } as unknown as HomeSummary)).toBe("Less than a week of posts left.");
    expect(postsLeftLine({ ...base, runway: { ...base.runway, weeks: 1.2 } } as unknown as HomeSummary)).toBe("About a week of posts left.");
    expect(postsLeftLine({ ...base, thisWeek: { ...base.thisWeek, toGo: 0 } } as unknown as HomeSummary)).toBe("No posts left to go out.");
  });
});

describe("Connect Instagram & TikTok is easy to find", () => {
  it("the Buffer card shows Why Buffer?, and its guide exists", () => {
    const connect = readFileSync("app/pages/Connect.tsx", "utf8");
    expect(connect).toMatch(/def\.service === "buffer" \? <WhyBuffer \/>/);
    expect(WHY_BUFFER.length).toBeGreaterThan(0);
    expect(existsSync("help/guides/why-we-post-through-buffer.md")).toBe(true);
  });
});
