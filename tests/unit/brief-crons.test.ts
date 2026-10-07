// Section 6 brief crons: the monthly refresh and the weekly adjustment. Pure rules first
// (domain/brief.ts), then the lanes against the real schema (every migration applied to Node's
// SQLite) with FAKE_SERVICES=1, so dispatch and email are recorded, not sent.
import { beforeEach, describe, expect, it } from "vitest";
import {
  adjustBrief,
  allClaims,
  briefNoticeRef,
  draftNoticeDue,
  MONTHLY_REFRESH_LAST_DAY,
  monthlyRefreshDecision,
  summarizeWeek,
  WEEKLY_SOURCE_ID,
  weeklyClaim,
  type LiveBrief,
  type MonthlyRefreshInput,
} from "@worker/domain/brief";
import { buildFakeBrief } from "@worker/jobs/research_fake";
import { briefDraftNotice, monthlyBriefRefresh, MONTHLY_HEALTH, weeklyBriefAdjust, WEEKLY_HEALTH } from "@worker/crons/brief";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-10-01T13:30:00Z");
const base = (x: Partial<MonthlyRefreshInput> = {}): MonthlyRefreshInput => ({ now: NOW, hasApproved: true, profileLocked: true, aiReady: true, researchJobs: [], ...x });

describe("monthlyRefreshDecision", () => {
  it("runs on the 1st with an approved brief, and never waits for approval to do it", () => {
    const d = monthlyRefreshDecision(base());
    expect(d.run).toBe(true);
    expect(d.light).toBe("green");
    expect(d.note).toContain("approved brief stays live");
  });

  it("retries on the 2nd and 3rd, then waits for next month", () => {
    for (let day = 2; day <= MONTHLY_REFRESH_LAST_DAY; day++) expect(monthlyRefreshDecision(base({ now: new Date(`2026-10-0${day}T13:30:00Z`) })).run).toBe(true);
    const later = monthlyRefreshDecision(base({ now: new Date("2026-10-04T13:30:00Z") }));
    expect(later).toEqual({ run: false, note: "Next refresh on Nov 1.", light: "green", fix_guide: null });
  });

  it("runs once a month: a queued, running or finished research job this month stops it; last month's does not", () => {
    for (const status of ["queued", "dispatched", "running", "done"]) expect(monthlyRefreshDecision(base({ researchJobs: [{ status, created_at: "2026-10-01T00:05:00.000Z" }] })).run).toBe(false);
    expect(monthlyRefreshDecision(base({ researchJobs: [{ status: "done", created_at: "2026-09-30T23:59:00.000Z" }] })).run).toBe(true);
    // a failed attempt this month is retried
    expect(monthlyRefreshDecision(base({ researchJobs: [{ status: "failed", created_at: "2026-10-01T13:30:05.000Z" }] })).run).toBe(true);
  });

  it("a missing AI key is a named stop: yellow light with the OpenRouter guide, the approved brief stays live", () => {
    const d = monthlyRefreshDecision(base({ aiReady: false }));
    expect(d).toMatchObject({ run: false, light: "yellow", fix_guide: "connect-openrouter" });
    expect(d.note).toContain("approved brief stays live");
    expect(monthlyRefreshDecision(base({ profileLocked: false }))).toMatchObject({ run: false, light: "yellow", fix_guide: "upload-brand-docs" });
  });

  it("before the first approved brief there is nothing to refresh (green, says why)", () => {
    const d = monthlyRefreshDecision(base({ hasApproved: false }));
    expect(d.run).toBe(false);
    expect(d.light).toBe("green");
    expect(d.note).toMatch(/first one is made on Research/);
  });
});

describe("draftNoticeDue", () => {
  it("emails once for a draft newer than the approved brief, never twice, never for the first brief", () => {
    expect(draftNoticeDue({ draftVersion: 5, approvedVersion: 4, notifiedRefs: [] })).toBe("brief_v5");
    expect(draftNoticeDue({ draftVersion: 5, approvedVersion: 4, notifiedRefs: [briefNoticeRef(5)] })).toBeNull();
    expect(draftNoticeDue({ draftVersion: 3, approvedVersion: 4, notifiedRefs: [] })).toBeNull();
    expect(draftNoticeDue({ draftVersion: 1, approvedVersion: null, notifiedRefs: [] })).toBeNull();
    expect(draftNoticeDue({ draftVersion: null, approvedVersion: 4, notifiedRefs: [] })).toBeNull();
  });
});

describe("summarizeWeek + weeklyClaim", () => {
  it("counts only the 7 days before now, per platform, with the average views", () => {
    const obs = [
      { platform: "tiktok" as const, posted_at: "2026-09-30T10:00:00Z", views: 1000 },
      { platform: "tiktok" as const, posted_at: "2026-09-25T10:00:00Z", views: 2000 },
      { platform: "tiktok" as const, posted_at: "2026-09-23T10:00:00Z", views: 99999 }, // 8 days ago
      { platform: "youtube" as const, posted_at: "2026-10-01T14:00:00Z", views: 5 }, // after now
      { platform: "instagram" as const, posted_at: "not a date", views: 5 },
    ];
    expect(summarizeWeek(obs, NOW)).toEqual([{ platform: "tiktok", videos: 2, avg_views: 1500 }]);
  });

  it("a claim from fewer than 3 videos is uncertain; 3 or more is solid; it cites only the weekly source", () => {
    expect(weeklyClaim({ platform: "tiktok", videos: 2, avg_views: 1500 })).toEqual({ text: "Last 7 days on TikTok: 2 videos, 1,500 views on average.", source_ids: [WEEKLY_SOURCE_ID], basis: "her_data", confidence: "uncertain" });
    expect(weeklyClaim({ platform: "youtube", videos: 3, avg_views: 12 }).confidence).toBe("solid");
    expect(weeklyClaim({ platform: "instagram", videos: 1, avg_views: 7 }).text).toBe("Last 7 days on Instagram: 1 video, 7 views on average.");
  });
});

function liveBrief(over: Partial<LiveBrief> = {}): LiveBrief {
  const { body, sources } = buildFakeBrief({ stats: { tiktok: { videos: 4 } }, uploads: [{ id: "u1", title: "Deep research.pdf" }] });
  // one web claim, so "never touches web claims" has something to protect
  body.hooks.push({ text: "Open on the payoff in the first second.", source_ids: ["b_buffer_all"], basis: "web", confidence: "solid" });
  return { version: 7, status: "approved", approved_at: "2026-09-02T12:00:00.000Z", adjusted_at: null, body, sources, ...over };
}
const nonWeekly = (b: LiveBrief) => allClaims(b.body).filter((c) => !c.claim.source_ids.includes(WEEKLY_SOURCE_ID));

describe("adjustBrief (weekly)", () => {
  const week = [{ platform: "tiktok" as const, videos: 4, avg_views: 1800 }];

  it("adds her last-7-days claim + source and stamps adjusted_at", () => {
    const { brief, changed } = adjustBrief(liveBrief(), week, NOW);
    expect(changed).toBe(true);
    expect(brief.adjusted_at).toBe(NOW.toISOString());
    expect(brief.body.audience.at(-1)).toEqual(weeklyClaim(week[0]));
    expect(brief.sources.filter((s) => s.id === WEEKLY_SOURCE_ID)).toHaveLength(1);
  });

  it("never flips approval: status and approved_at come back exactly as they went in, for every status", () => {
    for (const status of ["approved", "draft", "superseded"] as const) {
      const input = liveBrief({ status, approved_at: status === "draft" ? null : "2026-09-02T12:00:00.000Z" });
      const { brief } = adjustBrief(input, week, NOW);
      expect(brief.status).toBe(input.status);
      expect(brief.approved_at).toBe(input.approved_at);
      expect(brief.version).toBe(input.version);
    }
  });

  it("never touches web, upload or other her-data claims, and never drops a source it does not own", () => {
    const input = liveBrief();
    const { brief } = adjustBrief(input, week, NOW);
    expect(nonWeekly(brief)).toEqual(nonWeekly(input));
    const web = (b: LiveBrief) => allClaims(b.body).filter((c) => c.claim.basis === "web" || c.claim.basis === "upload");
    expect(web(input).length).toBeGreaterThan(0);
    expect(web(brief)).toEqual(web(input));
    for (const s of input.sources) expect(brief.sources).toContainEqual(s);
  });

  it("updates only where the data changed: same week again → unchanged, adjusted_at kept", () => {
    const first = adjustBrief(liveBrief(), week, NOW).brief;
    const again = adjustBrief(first, week, new Date("2026-10-08T12:00:00Z"));
    expect(again.changed).toBe(false);
    expect(again.brief.adjusted_at).toBe(NOW.toISOString());
    const moved = adjustBrief(first, [{ platform: "tiktok", videos: 5, avg_views: 2100 }], new Date("2026-10-08T12:00:00Z"));
    expect(moved.changed).toBe(true);
    expect(moved.brief.body.audience.filter((c) => c.source_ids.includes(WEEKLY_SOURCE_ID)).map((c) => c.text)).toEqual(["Last 7 days on TikTok: 5 videos, 2,100 views on average."]);
  });

  it("a week with no results takes last week's numbers off (claim and source), nothing else", () => {
    const first = adjustBrief(liveBrief(), week, NOW).brief;
    const { brief, changed } = adjustBrief(first, [], new Date("2026-10-08T12:00:00Z"));
    expect(changed).toBe(true);
    expect(allClaims(brief.body).some((c) => c.claim.source_ids.includes(WEEKLY_SOURCE_ID))).toBe(false);
    expect(brief.sources.some((s) => s.id === WEEKLY_SOURCE_ID)).toBe(false);
    expect(nonWeekly(brief)).toEqual(nonWeekly(liveBrief()));
  });
});

// ---- lanes against the real schema ------------------------------------------------------------

let env: Env;
let raw: ReturnType<typeof sqliteD1>["raw"];
beforeEach(() => {
  const d = sqliteD1();
  raw = d.raw;
  env = { DB: d.DB, FAKE_SERVICES: "1", OWNER_EMAIL: "owner@example.com", PUBLIC_BASE_URL: "https://example.test", APP_NAME: "Sample Studio", GITHUB_REPO: "x/y", AUDIENCE_TIMEZONE: "America/New_York", ENV_NAME: "dev" } as unknown as Env;
});
const q = <T>(sql: string) => raw.prepare(sql).all() as T[];
const seedApproved = () => {
  const b = liveBrief();
  raw.prepare("INSERT INTO brand_profile (sections, locked) VALUES ('{}', 1)").run();
  raw.prepare("INSERT INTO research_briefs (body, sources, status, approved_at) VALUES (?, ?, 'approved', '2026-09-02T12:00:00.000Z')").run(JSON.stringify(b.body), JSON.stringify(b.sources));
};

describe("monthly lane", () => {
  // The first of the real current month, so jobs rows (created "now") fall inside the month.
  const today = new Date();
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 13, 30));

  it("starts one research job on the 1st, leaves the approved brief live, and does not start a second", async () => {
    seedApproved();
    expect((await monthlyBriefRefresh(env, first)).dispatched).toBe(true);
    expect((await monthlyBriefRefresh(env, first)).dispatched).toBe(false);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'research'")[0].n).toBe(1);
    expect(q<{ status: string }>("SELECT status FROM research_briefs")).toEqual([{ status: "approved" }]);
    expect(q<{ light: string }>(`SELECT light FROM health WHERE name = '${MONTHLY_HEALTH}'`)[0].light).toBe("green");
  });

  it("without OpenRouter on a real deployment it names the stop instead of silently skipping", async () => {
    seedApproved();
    env = { ...env, FAKE_SERVICES: "0" } as Env;
    expect((await monthlyBriefRefresh(env, first)).dispatched).toBe(false);
    expect(q<{ light: string; fix_guide: string }>(`SELECT light, fix_guide FROM health WHERE name = '${MONTHLY_HEALTH}'`)[0]).toEqual({ light: "yellow", fix_guide: "connect-openrouter" });
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")[0].n).toBe(0);
  });

  it("the new draft gets one 'New brief draft ready' email; approving stays hers", async () => {
    seedApproved();
    raw.prepare("INSERT INTO research_briefs (body, sources, status) VALUES ('{}', '[]', 'draft')").run();
    expect(await briefDraftNotice(env)).toBe("brief_v2");
    expect(await briefDraftNotice(env)).toBeNull();
    expect(q<{ kind: string; subject: string; to_email: string; ref_id: string }>("SELECT kind, subject, to_email, ref_id FROM emails_sent")).toEqual([
      { kind: "brief_ready", subject: "New brief draft ready", to_email: "owner@example.com", ref_id: "brief_v2" },
    ]);
    expect(q<{ version: number; status: string }>("SELECT version, status FROM research_briefs ORDER BY version")).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "draft" },
    ]);
  });
});

describe("weekly lane", () => {
  it("rewrites the approved brief's weekly claims from platform_videos, stamps adjusted_at, keeps approval", async () => {
    seedApproved();
    const now = new Date();
    for (const [i, v] of [1200, 1800, 2400].entries())
      raw.prepare("INSERT INTO platform_videos (id, platform, external_id, posted_at, views, source, captured_at) VALUES (?, 'tiktok', ?, ?, ?, 'import', '2026-10-01T00:00:00Z')").run(`pv${i}`, `ext${i}`, new Date(now.getTime() - (i + 1) * 86_400_000).toISOString(), v);
    const r = await weeklyBriefAdjust(env, now);
    expect(r).toEqual({ changed: true, version: 1 });
    const row = q<{ status: string; approved_at: string; adjusted_at: string; body: string }>("SELECT status, approved_at, adjusted_at, body FROM research_briefs")[0];
    expect(row.status).toBe("approved");
    expect(row.approved_at).toBe("2026-09-02T12:00:00.000Z");
    expect(row.adjusted_at).toBe(now.toISOString());
    expect(JSON.parse(row.body).audience.at(-1).text).toBe("Last 7 days on TikTok: 3 videos, 1,800 views on average.");
    expect(q<{ light: string }>(`SELECT light FROM health WHERE name = '${WEEKLY_HEALTH}'`)[0].light).toBe("green");
    // same data next run: nothing rewritten
    expect((await weeklyBriefAdjust(env, now)).changed).toBe(false);
  });

  it("with no approved brief it says so on the health board and writes nothing", async () => {
    expect(await weeklyBriefAdjust(env)).toEqual({ changed: false, version: null });
    expect(q<{ note: string }>(`SELECT note FROM health WHERE name = '${WEEKLY_HEALTH}'`)[0].note).toMatch(/No approved brief yet/);
  });
});
