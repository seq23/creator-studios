// The media kit (worker/domain/kit.ts, worker/routes/public.ts, worker/domain/qr.ts): what she
// can save, what the public sees (only the newest PUBLISHED version, private rates stripped,
// every figure with its date and source), the Kit check, and the QR code.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@worker/env";
import { autoShowcase, cleanKit, emptyKit, isStale, kitCheck, publicPackages, sameKit, starterPackages, type KitContent, type PlatformFigures } from "@worker/domain/kit";
import { packageLabel } from "@worker/domain/ratecard";
import { qrEncode, qrSvg } from "@worker/domain/qr";
import { publicRoutes } from "@worker/routes/public";
import { showcaseIds } from "@worker/crons/daily";
import { sqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const fig = (p: Partial<PlatformFigures> = {}): PlatformFigures => ({ platform: "tiktok", followers: 12_400, avgViews: 3_100, asOf: "2026-09-24T12:00:00.000Z", source: "TikTok export you uploaded", avgSelfReported: false, engagement: null, bestTimes: [], topFormats: [], ...p });

function kit(p: Partial<KitContent> = {}): KitContent {
  return { ...emptyKit("Sample Creator"), photoKey: "kit/photo/upl_abcdef12", handles: { tiktok: "@sample" }, positioning: "Hosting that makes guests feel celebrated.", showcase: ["c1", "c2", "c3"], packages: starterPackages().map((x) => ({ ...x, startingAt: 300, floor: 250, target: 400 })), contactEmail: "partnerships@sample.example", testimonials: [{ quote: "Sold out.", name: "Maya", role: "Brand" }], ...p };
}

describe("what she can save", () => {
  it("cleans handles, keeps limits, and says what is wrong in plain words", () => {
    const ok = cleanKit({ name: "Sam", handles: { tiktok: "samplecreator", instagram: "@sample.creator" }, showcase: ["a", "a", "b"] }, "X");
    expect("kit" in ok && ok.kit.handles).toEqual({ tiktok: "@samplecreator", instagram: "@sample.creator" });
    expect("kit" in ok && ok.kit.showcase).toEqual(["a", "b"]);
    expect(cleanKit({ handles: { tiktok: "not a handle!" } }, "X")).toEqual({ problem: "That TikTok handle does not look right. Use letters, numbers, dots and underscores, like @samplecreator." });
    expect(cleanKit({ showcase: ["1", "2", "3", "4", "5", "6", "7"] }, "X")).toEqual({ problem: "Pick up to 6 clips." });
    expect(cleanKit({ contactEmail: "nope" }, "X")).toEqual({ problem: "That contact email does not look right." });
  });
  it("a package's floor above its target is refused; prices are whole dollars", () => {
    expect(cleanKit({ packages: [{ name: "A", items: [], floor: 900, target: 500 }] }, "X")).toMatchObject({ problem: expect.stringMatching(/floor .* above your target/) });
    expect(cleanKit({ packages: [{ name: "A", items: [], startingAt: "lots" }] }, "X")).toMatchObject({ problem: "A: prices are whole dollars, like 450." });
    const ok = cleanKit({ packages: [{ name: "A", items: [{ key: "tiktok_video", qty: 2 }, { key: "made_up", qty: 1 }], startingAt: "$1,200" }] }, "X");
    expect("kit" in ok && ok.kit.packages[0]).toMatchObject({ startingAt: 1200, items: [{ key: "tiktok_video", qty: 2 }] });
  });
  it("a self-reported figure must carry the date she read it", () => {
    expect(cleanKit({ manual: [{ label: "Women", value: "82%", asOf: "" }] }, "X")).toEqual({ problem: '"Women" needs the date you read that number (as of).' });
    const ok = cleanKit({ manual: [{ label: "Women", value: "82%", asOf: "2026-09-20", platform: "instagram" }] }, "X");
    expect("kit" in ok && ok.kit.manual[0]).toMatchObject({ label: "Women", value: "82%", asOf: "2026-09-20", platform: "instagram" });
  });
});

describe("the public view never shows private rates", () => {
  it("strips floor and target, says Starting at or Rates on request, hides unticked packages", () => {
    const k = kit({ packages: [{ ...starterPackages()[0], startingAt: 450, floor: 300, target: 600 }, { ...starterPackages()[1], onRequest: true }, { ...starterPackages()[2], showOnKit: false, startingAt: 900 }] });
    const { packages, addOns } = publicPackages(k, packageLabel);
    expect(packages.map((p) => p.price)).toEqual(["Starting at $450", "Rates on request"]);
    expect(JSON.stringify(packages)).not.toMatch(/300|600|floor|target/);
    expect(addOns).toContain("Category exclusivity");
  });
});

describe("Kit check", () => {
  const base = { figures: [fig()], approvedClipIds: ["c1", "c2", "c3", "c4"], wonDealsNotInKit: 0, ownerEmail: "owner@example.com", draftDiffers: false, published: true, now: NOW };
  it("a complete, published kit has nothing missing", () => {
    expect(kitCheck({ ...base, kit: kit() }).filter((i) => i.level !== "tip")).toEqual([]);
  });
  it("stats older than 30 days are stale, with the right one-tap fix per platform", () => {
    const issues = kitCheck({ ...base, kit: kit(), figures: [fig({ asOf: "2026-08-20T12:00:00.000Z" }), fig({ platform: "instagram", asOf: "2026-08-01T00:00:00.000Z" })] });
    expect(issues.filter((i) => i.level === "stale").map((i) => i.fix)).toEqual([
      { action: "refresh_stats", platform: "tiktok", how: "import" },
      { action: "refresh_stats", platform: "instagram", how: "sync" },
    ]);
    expect(isStale("2026-08-26T11:00:00.000Z", NOW)).toBe(true);
    expect(isStale("2026-08-27T12:00:00.000Z", NOW)).toBe(false);
  });
  it("no packages, no showcase, no email, not published: each is named with its fix", () => {
    const issues = kitCheck({ ...base, published: false, figures: [], kit: kit({ packages: [], showcase: ["gone"], contactEmail: null, photoKey: null }) });
    const by = Object.fromEntries(issues.map((i) => [i.key, i]));
    expect(by.packages.fix).toEqual({ action: "starter_packages" });
    expect(by.showcase.text).toBe("1 showcase clip is no longer available; you have 0 of at least 3.");
    expect(by.showcase.fix).toEqual({ action: "auto_showcase" });
    expect(by.email.fix).toEqual({ action: "use_owner_email", email: "owner@example.com" });
    expect(by.stats.fix).toEqual({ action: "connect_stats" });
    expect(by.photo.fix).toEqual({ action: "upload_photo" });
    expect(by.publish.fix).toEqual({ action: "publish" });
  });
  it("unpublished changes are flagged; auto-pick keeps her choices and fills from her best", () => {
    expect(kitCheck({ ...base, draftDiffers: true, kit: kit() }).find((i) => i.key === "publish")).toMatchObject({ level: "stale", fixLabel: "Publish changes" });
    expect(autoShowcase(["c3", "gone"], ["c1", "c2", "c3", "c4", "c5"])).toEqual(["c3", "c1", "c2", "c4"]);
    expect(sameKit(kit(), kit())).toBe(true);
    expect(sameKit(kit(), kit({ bio: "x" }))).toBe(false);
  });
});

describe("QR code (no dependency)", () => {
  it("encodes her kit link: the same matrix OpenCV decoded back to the link (re-proven 7 Oct 2026 for this link)", () => {
    const q = qrEncode("https://studio.example.workers.dev/kit/studio");
    expect(q).toMatchObject({ version: 4, size: 33 });
    const hash = createHash("sha256").update(q.modules.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex");
    expect(hash).toBe("476e2f5ae6665c3133365b181f52db97ccc24a04a253c8eb009e593bd4c366c4");
    expect(createHash("sha256").update(qrEncode("HELLO").modules.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex")).toBe("c346c75add5698735afe3f7eb4f3e6c57ccefd9563f45f65c6d76aa518fb6f91");
  });
  it("has the three finder patterns, timing lines and the dark module", () => {
    const q = qrEncode("https://x.example/kit/a");
    const m = q.modules;
    const n = q.size;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let i = 0; i < 7; i++) {
        expect(m[y][x + i]).toBe(true);
        expect(m[y + 6][x + i]).toBe(true);
      }
      expect(m[y + 3][x + 3]).toBe(true);
      expect(m[y + 1][x + 1]).toBe(false);
    }
    for (let i = 8; i < n - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    expect(m[n - 8][8]).toBe(true);
  });
  it("grows with the text, refuses what does not fit, and renders an SVG with a quiet zone", () => {
    expect(qrEncode("x".repeat(150)).version).toBeGreaterThanOrEqual(7);
    expect(() => qrEncode("x".repeat(400))).toThrow(RangeError);
    const svg = qrSvg("https://x.example/kit/a", { dark: "#211713", light: "#fffaf1" });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 33 33"/);
    expect(svg).toContain('aria-label="QR code for https://x.example/kit/a"');
  });
});

describe("the public link: newest published version only (real schema)", () => {
  let env: Env;
  let raw: ReturnType<typeof sqliteD1>["raw"];
  beforeEach(() => {
    const d = sqliteD1();
    raw = d.raw;
    env = { DB: d.DB, FAKE_SERVICES: "1", OWNER_EMAIL: "owner@example.com", PUBLIC_BASE_URL: "https://studio.example", AUDIENCE_TIMEZONE: "America/New_York", ENV_NAME: "dev" } as unknown as Env;
  });
  const get = (path: string, ua = "Mozilla/5.0 (iPhone)") => publicRoutes.request(path, { headers: { "user-agent": ua } }, env);
  const views = () => (raw.prepare("SELECT COUNT(*) AS n FROM kit_views").get() as { n: number }).n;

  it("a draft is never public: nothing until she publishes", async () => {
    raw.prepare("UPDATE media_kit SET draft = ? WHERE id = 1").run(JSON.stringify(kit({ bio: "draft only" })));
    const r = await get("/kit/studio");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "This media kit isn't published yet." });
  });
  it("serves the newest version, strips private rates, dates every figure, counts real views only", async () => {
    raw.prepare("INSERT INTO media_kit_versions (version, content, slug, published_at) VALUES (1, ?, 'studio', '2026-09-01T00:00:00Z')").run(JSON.stringify(kit({ bio: "old" })));
    raw.prepare("INSERT INTO media_kit_versions (version, content, slug, published_at) VALUES (2, ?, 'studio', '2026-09-20T00:00:00Z')").run(JSON.stringify(kit({ bio: "new" })));
    raw.prepare("UPDATE media_kit SET draft = ? WHERE id = 1").run(JSON.stringify(kit({ bio: "unpublished edit" })));
    raw.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES ('a1', 'tiktok', '2026-09-24T12:00:00.000Z', 12400, 3100, 'import')").run();
    const r = await get("/kit/studio");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { bio: string; version: number; figures: PlatformFigures[]; packages: unknown[]; qrSvg: string; url: string };
    expect(body.bio).toBe("new");
    expect(body.version).toBe(2);
    expect(body.figures).toEqual([expect.objectContaining({ platform: "tiktok", followers: 12400, asOf: "2026-09-24T12:00:00.000Z", source: "TikTok export you uploaded" })]);
    expect(JSON.stringify(body.packages)).not.toMatch(/"floor"|"target"|:250|:400/);
    expect(body.url).toBe("https://studio.example/kit/studio");
    expect(body.qrSvg).toContain("<svg");
    expect(views()).toBe(1);
    await get("/kit/studio?preview=1");
    await get("/kit/studio", "Mozilla/5.0 (compatible; Googlebot/2.1)");
    expect(views()).toBe(1);
  });
  it("numbers she typed on Stats are self-reported on the kit, never a verified figure", async () => {
    raw.prepare("INSERT INTO media_kit_versions (version, content, slug) VALUES (1, ?, 'studio')").run(JSON.stringify(kit()));
    raw.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES ('m1', 'instagram', '2026-09-20T12:00:00.000Z', 8200, 1900, 'manual')").run();
    raw.prepare("INSERT INTO account_stats (id, platform, captured_at, followers, avg_views, source) VALUES ('y1', 'youtube', '2026-09-24T12:00:00.000Z', 2100, 900, 'api')").run();
    const body = (await (await get("/kit/studio")).json()) as { figures: PlatformFigures[]; manual: { platform: string; label: string; value: string; asOf: string; selfReported: boolean }[] };
    expect(body.figures.map((f) => f.platform)).toEqual(["youtube"]);
    expect(body.figures[0].source).toBe("YouTube Shorts, read by the dashboard");
    expect(body.manual).toContainEqual(expect.objectContaining({ platform: "instagram", label: "Followers", value: "8,200", asOf: "2026-09-20", selfReported: true }));
  });
  it("an old link name forwards to the current one; an unknown one is a 404", async () => {
    raw.prepare("INSERT INTO media_kit_versions (version, content, slug) VALUES (1, ?, 'studio')").run(JSON.stringify(kit()));
    raw.prepare("UPDATE media_kit SET public_slug = 'samplecreator' WHERE id = 1").run();
    raw.prepare("INSERT INTO kit_slugs (slug) VALUES ('samplecreator')").run();
    expect(await (await get("/kit/studio")).json()).toEqual({ moved: "samplecreator" });
    expect((await get("/kit/samplecreator")).status).toBe(200);
    expect((await get("/kit/nobody")).status).toBe(404);
  });
  it("only images the published kit uses are served", async () => {
    raw.prepare("INSERT INTO media_kit_versions (version, content, slug) VALUES (1, ?, 'studio')").run(JSON.stringify(kit({ photoKey: "kit/photo/upl_pubphoto1" })));
    const files = new Map<string, string>([["kit/photo/upl_pubphoto1", "img"], ["kit/photo/upl_draftonly", "img"]]);
    env = { ...env, FILES: { get: async (k: string) => (files.has(k) ? { body: files.get(k), httpEtag: "e", writeHttpMetadata: () => undefined } : null) } } as unknown as Env;
    expect((await get("/kit/studio/image/upl_pubphoto1")).status).toBe(200);
    expect((await get("/kit/studio/image/upl_draftonly")).status).toBe(404);
  });
});

describe("kit clips keep their media link", () => {
  it("reads the showcase from a draft, a published version, or a kit saved before versions", () => {
    expect(showcaseIds(JSON.stringify({ showcase: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(showcaseIds(JSON.stringify({ legacy: 1, featured_clip_ids: ["c"] }))).toEqual(["c"]);
    expect(showcaseIds("not json")).toEqual([]);
    expect(showcaseIds(null)).toEqual([]);
  });
});
