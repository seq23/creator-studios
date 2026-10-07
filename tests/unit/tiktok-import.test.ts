// TikTok Studio export parsing (sections 4b, 17): the manual path for TikTok numbers.
import { describe, expect, it } from "vitest";
import { parseCount, parseCsv, parseDate, parseSeconds, parseTikTokExport, recentAverageViews, tiktokVideoId } from "@worker/domain/tiktokImport";

export const SAMPLE_CONTENT = `﻿Video title,Video link,Post time,Total likes,Total comments,Total shares,Total views,Average watch time
"Yacht day, white party",https://www.tiktok.com/@samplec11/video/7412345678901234567,2026-08-02 19:05:00,1.2K,48,31,"18,400",11.5
Gala arrivals,https://www.tiktok.com/@samplec11/video/7412345678901234999?lang=en,2026-08-09 20:10:00,640,12,9,9100,0:09
No link but a date,,08/16/2026 15:00,10,1,0,700,
,,,,,,,
Gala arrivals again,https://www.tiktok.com/@samplec11/video/7412345678901234999,2026-08-09 20:10:00,1,1,1,1,1
`;

describe("csv", () => {
  it("handles quotes, commas inside quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
  it("reads counts with separators and K/M suffixes", () => {
    expect(parseCount("18,400")).toBe(18400);
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("n/a")).toBe(0);
  });
  it("reads watch time as seconds or m:ss", () => {
    expect(parseSeconds("11.5")).toBe(11.5);
    expect(parseSeconds("1:05")).toBe(65);
    expect(parseSeconds("")).toBeNull();
  });
  it("reads the date shapes TikTok uses", () => {
    expect(parseDate("2026-08-02 19:05:00")).toBe("2026-08-02T19:05:00.000Z");
    expect(parseDate("08/16/2026 15:00")).toBe("2026-08-16T15:00:00.000Z");
    expect(parseDate("Aug 12, 2026")).toBe("2026-08-12T00:00:00.000Z");
    expect(parseDate("someday")).toBeNull();
  });
});

describe("TikTok Studio export", () => {
  it("content file → one row per video, deduped by video id, blank rows skipped", () => {
    const r = parseTikTokExport(SAMPLE_CONTENT);
    expect(r.kind).toBe("content");
    expect(r.videos).toHaveLength(3);
    expect(r.skipped).toBe(1); // the duplicate; the all-blank line never becomes a row
    expect(r.videos[0]).toMatchObject({ external_id: "7412345678901234567", title: "Yacht day, white party", views: 18400, likes: 1200, comments: 48, shares: 31, avg_watch_s: 11.5, posted_at: "2026-08-02T19:05:00.000Z" });
    expect(r.videos[1]).toMatchObject({ external_id: "7412345678901234999", avg_watch_s: 9 });
    expect(r.videos[2].external_id).toMatch(/^t:2026-08-16/);
  });
  it("followers file → the latest follower count", () => {
    const r = parseTikTokExport("Date,Followers\n2026-08-01,1000\n2026-08-20,1,250\n2026-08-10,1100\n".replace("1,250", '"1,250"'));
    expect(r).toMatchObject({ kind: "followers", followers: 1250, videos: [] });
  });
  it("anything else is refused as unknown", () => {
    expect(parseTikTokExport("name,email\nx,y\n").kind).toBe("unknown");
    expect(parseTikTokExport("").kind).toBe("unknown");
    expect(parseTikTokExport("Video link,Likes\nhttps://x/video/12345678,5\n").kind).toBe("unknown"); // no views column
  });
  it("video id from a TikTok link", () => {
    expect(tiktokVideoId("https://www.tiktok.com/@a/video/7412345678901234567?x=1")).toBe("7412345678901234567");
    expect(tiktokVideoId("https://example.com/")).toBeNull();
  });
  it("average views over the most recent videos", () => {
    expect(recentAverageViews([{ posted_at: "2026-01-01", views: 100 }, { posted_at: "2026-02-01", views: 300 }], 1)).toBe(300);
    expect(recentAverageViews([])).toBe(0);
  });
});
