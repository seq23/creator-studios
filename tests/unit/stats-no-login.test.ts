// Stats with no login (owner decision 25 Sep 2026): YouTube public numbers with an API key,
// Instagram public numbers or her typed ones (never a blank panel), and the TikTok export as
// the zip TikTok actually hands her. Every path runs against the real schema on fakes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { stats, uploadToCsv } from "@worker/routes/stats";
import { csvEntries, isZip, listZip, looksLikeXlsx, readZipEntry } from "@worker/lib/unzip";
import { instagramReminderLine, parseChannelInput, refreshInstagramPublic, refreshPublicStats, refreshYouTubePublic } from "@worker/lib/publicStats";
import { igCount, parseProfilePage } from "@worker/services/instagramPublic";
import { saveConnection } from "@worker/lib/connections";
import { getSetting, setSetting } from "@worker/lib/db";
import { parseTikTokExport, tiktokIdTime } from "@worker/domain/tiktokImport";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { ownerCookie } from "./helpers/owner-session";

const FIX = path.resolve(__dirname, "fixtures");
const bytes = (f: string) => new Uint8Array(readFileSync(path.join(FIX, f)));

const BASE_URL = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  await next();
});
app.route("/api/stats", stats);

let env: Env;
let db: ReturnType<typeof sqliteD1>;

const call = async (method: string, p: string, body?: unknown) => {
  const res = await app.request(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const upload = async (name: string, data: Uint8Array, type = "application/zip") => {
  const form = new FormData();
  form.append("file", new File([data], name, { type }));
  const res = await app.request(`${BASE_URL}/api/stats/tiktok-import`, { method: "POST", body: form, headers: { cookie: await ownerCookie(env) } }, env);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const light = (name: string) => db.raw.prepare("SELECT light, note, fix_guide FROM health WHERE name = ?").get(name) as { light: string; note: string; fix_guide: string | null } | undefined;
const latest = (platform: string) => db.raw.prepare("SELECT followers, avg_views, source FROM account_stats WHERE platform = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1").get(platform) as { followers: number; avg_views: number; source: string } | undefined;

async function connectBuffer(channels: Record<string, unknown>[]) {
  await saveConnection(env, "buffer", "good-key", "ok", { channels });
}
const YT_CH = { id: "ch_youtube", platform: "youtube", handle: "Sample Creator", connected: true, service_id: "UCfakeSampleCreator0001", link: null };
const IG_CH = (handle: string) => ({ id: "ch_instagram", platform: "instagram", handle, connected: true, service_id: "1784", link: `https://instagram.com/${handle}` });

beforeEach(async () => {
  db = sqliteD1();
  env = {
    DB: db.DB,
    OWNER_EMAIL: "owner@studio.example",
    SESSION_SECRET: "session-secret-for-tests",
    SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=",
    APP_NAME: "Sample Studio",
    FAKE_SERVICES: "1",
    AUTH_MODE: "code",
    PUBLIC_BASE_URL: BASE_URL,
    GITHUB_REPO: "example/studio-jobs",
    YOUTUBE_API_KEY: "fake-youtube-key",
  } as unknown as Env;
});

// ------------------------------------------------------------------ TikTok: the zip TikTok hands her

describe("zip reader", () => {
  it("reads a deflated and a stored Content.csv byte for byte the same", async () => {
    const a = bytes("tiktok-content.zip");
    const b = bytes("tiktok-content-stored.zip");
    expect(isZip(a) && isZip(b)).toBe(true);
    const [ea] = listZip(a);
    const [eb] = listZip(b);
    expect(ea).toMatchObject({ name: "Content.csv", method: 8, encrypted: false });
    expect(eb).toMatchObject({ name: "Content.csv", method: 0 });
    const ta = new TextDecoder().decode(await readZipEntry(a, ea));
    expect(ta).toBe(new TextDecoder().decode(await readZipEntry(b, eb)));
    expect(ta).toContain('"Time","Video title","Video link","Post time","Total likes","Total comments","Total shares","Total views"');
  });
  it("tells an Excel workbook from a zip of CSVs, and skips macOS shadow files", () => {
    expect(looksLikeXlsx(listZip(bytes("tiktok-export.xlsx")))).toBe(true);
    expect(looksLikeXlsx(listZip(bytes("tiktok-content.zip")))).toBe(false);
    expect(csvEntries(listZip(bytes("tiktok-two-files.zip"))).map((e) => e.name)).toEqual(["Overview.csv", "Content.csv"]);
  });
  it("refuses bytes that only start like a zip", () => {
    const fake = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(isZip(fake)).toBe(true);
    expect(() => listZip(fake)).toThrow();
  });
});

describe("TikTok export upload", () => {
  it("the ZIP TikTok Studio hands her imports every video (the defect: it was refused as Excel)", async () => {
    const r = await upload("Content_samplec11.zip", bytes("tiktok-content.zip"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, kind: "content", videos: 3, zipped: true });
    const rows = db.raw.prepare("SELECT posted_at, views FROM platform_videos WHERE platform = 'tiktok' ORDER BY posted_at DESC").all() as { posted_at: string; views: number }[];
    // "September 4" has no year: the post time comes from the video id, exact to the second.
    expect(rows).toEqual([
      { posted_at: "2026-09-04T16:16:52.000Z", views: 35 },
      { posted_at: "2026-09-01T16:30:51.000Z", views: 680 },
      { posted_at: "2026-07-03T14:04:53.000Z", views: 7016 },
    ]);
    expect(light("TikTok stats")).toMatchObject({ light: "green", note: "Imported · 3 videos" });
  });
  it("a stored (uncompressed) zip and a zip with several CSVs both find the Content file", async () => {
    expect((await upload("a.zip", bytes("tiktok-content-stored.zip"))).json).toMatchObject({ videos: 3, zipped: true });
    expect((await upload("b.zip", bytes("tiktok-two-files.zip"))).json).toMatchObject({ kind: "content", videos: 3 });
  });
  it("the CSV itself still works, as a file and as JSON", async () => {
    const csv = new TextDecoder().decode(await readZipEntry(bytes("tiktok-content.zip"), listZip(bytes("tiktok-content.zip"))[0]));
    expect((await upload("Content.csv", new TextEncoder().encode(csv), "text/csv")).json).toMatchObject({ videos: 3, zipped: false });
    expect((await call("POST", "/api/stats/tiktok-import", { csv })).json).toMatchObject({ videos: 3 });
  });
  it("only a real Excel file gets the Excel message; a zip with no CSV and a broken zip say so", async () => {
    const x = await upload("export.xlsx", bytes("tiktok-export.xlsx"));
    expect(x).toMatchObject({ status: 422, json: { fix_guide: "upload-your-tiktok-export" } });
    expect(x.json.error).toMatch(/^That is an Excel file/);
    const n = await upload("n.zip", bytes("no-csv.zip"));
    expect(n.status).toBe(422);
    expect(n.json.error).toMatch(/no CSV file inside/);
    expect(n.json.error).not.toMatch(/Excel file\./);
    const broken = await uploadToCsv({ bytes: new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(30).fill(0)]) });
    expect(broken).toMatchObject({ status: 422, error: expect.stringMatching(/could not be opened/) });
  });
  it("the id time: a TikTok id carries its post time; junk ids give null", () => {
    expect(tiktokIdTime("7681714846173356608")).toBe("2026-09-04T16:16:52.000Z");
    expect(tiktokIdTime("12345")).toBeNull();
    expect(tiktokIdTime("99999999999999999999")).toBeNull(); // far future
    expect(parseTikTokExport('Video link,Post time,Total views\nhttps://www.tiktok.com/@a/video/7681714846173356608,September 4,5\n').videos[0].posted_at).toBe("2026-09-04T16:16:52.000Z");
  });
});

// ------------------------------------------------------------------ YouTube: public numbers, API key

describe("YouTube public numbers (no sign-in)", () => {
  it("finds the channel through Buffer's serviceId and stores subscribers, videos and the light", async () => {
    await connectBuffer([YT_CH]);
    const r = await refreshYouTubePublic(env);
    expect(r).toMatchObject({ state: "ok", subscribers: 1260, videos: 12, read: 12 });
    expect(latest("youtube")).toMatchObject({ followers: 1260, source: "api" });
    expect(latest("youtube")!.avg_views).toBeGreaterThan(0);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM platform_videos WHERE platform = 'youtube' AND source = 'api'").get() as { n: number }).n).toBe(12);
    expect(light("YouTube stats")).toMatchObject({ light: "green", note: "Public numbers · 1,260 subscribers · 12 videos", fix_guide: null });
    expect(await getSetting(env.DB, "youtube_channel", null)).toMatchObject({ id: "UCfakeSampleCreator0001", source: "buffer" });
  });
  it("a channel she types wins; one that does not exist says so with the guide", async () => {
    await connectBuffer([YT_CH]);
    const ok = await call("POST", "/api/stats/youtube-channel", { channel: "https://www.youtube.com/@SampleChannel" });
    expect(ok.status).toBe(200);
    expect(ok.json.channel).toMatchObject({ source: "typed", handle: "@samplechannel" });
    const missing = await call("POST", "/api/stats/youtube-channel", { channel: "@missingchannel" });
    expect(missing).toMatchObject({ status: 422, json: { fix_guide: "your-youtube-numbers" } });
    expect(light("YouTube stats")).toMatchObject({ light: "yellow", fix_guide: "your-youtube-numbers" });
    const junk = await call("POST", "/api/stats/youtube-channel", { channel: "not a channel!!" });
    expect(junk.status).toBe(422);
  });
  it("no key is a grey practice light; no channel, a refused key and quota each name their state and a yellow light, never a blank", async () => {
    const noKey = await refreshYouTubePublic({ ...env, FAKE_SERVICES: "0", YOUTUBE_API_KEY: undefined } as Env);
    expect(noKey.state).toBe("no_key");
    expect(light("YouTube stats")).toMatchObject({ light: "grey", fix_guide: "your-youtube-numbers" });
    expect((await refreshYouTubePublic(env)).state).toBe("no_channel"); // no Buffer, nothing typed
    expect(light("YouTube stats")).toMatchObject({ light: "yellow", fix_guide: "your-youtube-numbers" });
    await setSetting(env.DB, "youtube_channel_typed", "@quotaland");
    expect((await refreshYouTubePublic(env)).state).toBe("quota");
    expect((await refreshYouTubePublic({ ...env, YOUTUBE_API_KEY: "badkey" } as Env)).state).toBe("key_refused");
  });
  it("a connected Google sign-in keeps its own light; the public numbers still land", async () => {
    await connectBuffer([YT_CH]);
    await saveConnection(env, "google", JSON.stringify({ access_token: "t" }), "ok", {});
    db.raw.prepare("INSERT INTO health (name, light, note) VALUES ('YouTube stats', 'green', 'Synced · 4 videos')").run();
    expect((await refreshYouTubePublic(env)).state).toBe("ok");
    expect(light("YouTube stats")!.note).toBe("Synced · 4 videos");
    expect(latest("youtube")).toMatchObject({ followers: 1260 });
  });
  it("channel input: UC id, link, @handle", () => {
    expect(parseChannelInput("UC7O1lQikHSc77s7gNnj9htQ")).toEqual({ id: "UC7O1lQikHSc77s7gNnj9htQ" });
    expect(parseChannelInput("https://www.youtube.com/channel/UC7O1lQikHSc77s7gNnj9htQ")).toEqual({ id: "UC7O1lQikHSc77s7gNnj9htQ" });
    expect(parseChannelInput("youtube.com/@demohandle5498")).toEqual({ handle: "@demohandle5498" });
    expect(parseChannelInput("@sample")).toEqual({ handle: "@sample" });
    expect(parseChannelInput("   ")).toBeNull();
  });
});

// ------------------------------------------------------------------ Instagram: public or typed

describe("Instagram numbers (no sign-in)", () => {
  it("login-walled (what staging measured): the form path, a yellow light with the guide, logged", async () => {
    await connectBuffer([IG_CH("samplechannel")]);
    const r = await refreshInstagramPublic(env, { force: true });
    expect(r).toMatchObject({ path: "manual", handle: "samplechannel", why: "login_wall", status: 302, api_status: 401 });
    expect(light("Instagram stats")).toMatchObject({ light: "yellow", fix_guide: "update-instagram-numbers" });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'stats.instagram.path'").get()).toEqual({ n: 1 });
  });
  it("her typed numbers show at once and turn the light green", async () => {
    await connectBuffer([IG_CH("samplechannel")]);
    const bad = await call("POST", "/api/stats/instagram-numbers", { followers: "lots", avg_reach: 10 });
    expect(bad).toMatchObject({ status: 422, json: { fix_guide: "update-instagram-numbers" } });
    const ok = await call("POST", "/api/stats/instagram-numbers", { followers: "4,820", avg_reach: "1500" });
    expect(ok.status).toBe(200);
    expect(latest("instagram")).toEqual({ followers: 4820, avg_views: 1500, source: "manual" });
    expect(light("Instagram stats")).toMatchObject({ light: "green", fix_guide: null });
    // A later walled re-read keeps the light green on her numbers.
    await refreshInstagramPublic(env, { force: true });
    expect(light("Instagram stats")!.light).toBe("green");
  });
  it("public when Instagram answers: followers read on their own, her reach kept, cached for a day", async () => {
    await connectBuffer([IG_CH("sample.public")]);
    await call("POST", "/api/stats/instagram-numbers", { followers: 100, avg_reach: 900 });
    const r = await refreshInstagramPublic(env, { force: true });
    expect(r).toMatchObject({ path: "public", via: "profile_page", followers: 4820 });
    expect(latest("instagram")).toEqual({ followers: 4820, avg_views: 900, source: "api" });
    const again = await refreshInstagramPublic(env);
    expect(again.checked_at).toBe(r.checked_at); // the daily cache
  });
  it("an Instagram sign-in in use: path oauth, nothing written over it", async () => {
    await saveConnection(env, "meta", JSON.stringify({ access_token: "t" }), "ok", {});
    expect((await refreshInstagramPublic(env, { force: true })).path).toBe("oauth");
    expect(latest("instagram")).toBeUndefined();
  });
  it("no handle anywhere: the form path, and a typed handle is used next", async () => {
    expect(await refreshInstagramPublic(env, { force: true })).toMatchObject({ path: "manual", why: "no_handle" });
    const r = await call("POST", "/api/stats/instagram-handle", { handle: "@sample.public" });
    expect(r.json.instagram).toMatchObject({ path: "public", handle: "sample.public" });
  });
  it("reads counts from the profile page's description", () => {
    expect(parseProfilePage('<meta property="og:description" content="1,417 Followers, 7,317 Following, 63 Posts - See Instagram photos" />')).toEqual({ followers: 1417, posts: 63 });
    expect(parseProfilePage('<meta name="description" content="12.3K Followers, 5 Following, 1,002 Posts" />')).toEqual({ followers: 12300, posts: 1002 });
    expect(parseProfilePage("<html>Log in</html>")).toBeNull();
    expect(igCount("1.2M")).toBe(1_200_000);
  });
  it("remind me monthly: one line in the Monday recap when her numbers are 30+ days old, then quiet for 4 weeks", async () => {
    expect(await instagramReminderLine(env)).toBeNull(); // off by default until she taps it
    expect((await call("POST", "/api/stats/instagram-reminder", { on: true })).json).toEqual({ ok: true, on: true });
    const now = new Date("2026-10-05T12:00:00Z");
    expect(await instagramReminderLine(env, now)).toMatch(/update your Instagram numbers/);
    expect(await instagramReminderLine(env, new Date("2026-10-12T12:00:00Z"))).toBeNull();
    await setSetting(env.DB, "instagram_manual", { followers: 1, avg_reach: 1, updated_at: "2026-10-20T00:00:00Z" });
    expect(await instagramReminderLine(env, new Date("2026-11-03T12:00:00Z"))).toBeNull(); // fresh numbers
    expect(await instagramReminderLine(env, new Date("2026-11-20T12:00:00Z"))).toMatch(/Instagram/);
  });
});

// ------------------------------------------------------------------ Update numbers never waits on a sign-in

describe("Update numbers", () => {
  it("works with no sign-in at all: YouTube read, Instagram path named, no job needed", async () => {
    await connectBuffer([YT_CH, IG_CH("samplechannel")]);
    const r = await call("POST", "/api/stats/sync");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, youtube: { state: "ok" }, instagram: { path: "manual" }, jobId: null });
    const view = await call("GET", "/api/stats");
    expect(view.json.public).toMatchObject({ youtube: { state: "ok" }, instagram: { path: "manual" }, instagramReminder: false });
    expect(view.json.accounts.map((a: { platform: string }) => a.platform)).toEqual(["youtube"]);
  });
  it("the daily + weekly refresh reaches the same state", async () => {
    await connectBuffer([YT_CH]);
    const r = await refreshPublicStats(env, { force: true });
    expect(r.youtube.state).toBe("ok");
    expect(r.instagram.path).toBe("manual");
  });
});

describe("Monday lane", () => {
  it("reads the no-login numbers, starts no sign-in job without a sign-in, and carries the monthly reminder", async () => {
    const { weekly } = await import("@worker/crons/weekly");
    await connectBuffer([YT_CH, IG_CH("samplechannel")]);
    db.raw.prepare("INSERT INTO brand_profile (version, sections, locked, source) VALUES (1, '{}', 1, 'draft')").run();
    await setSetting(env.DB, "features", { voice: true, deeper_research: true, weekly_recap: true, help_ask: true });
    await setSetting(env.DB, "notify_emails", ["owner@studio.example"]);
    await setSetting(env.DB, "instagram_reminder", { on: true, last_sent_at: null });
    await weekly(env);
    expect(await getSetting(env.DB, "youtube_public", null)).toMatchObject({ state: "ok", subscribers: 1260 });
    expect(await getSetting(env.DB, "instagram_public", null)).toMatchObject({ path: "manual" });
    expect(db.raw.prepare("SELECT type FROM jobs ORDER BY type").all().map((r) => (r as { type: string }).type)).not.toContain("metrics");
    expect((await getSetting<{ last_sent_at: string | null }>(env.DB, "instagram_reminder", { last_sent_at: null })).last_sent_at).not.toBeNull();
  });
});
