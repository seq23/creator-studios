// TikTok Studio export → her video results (BUILD_PLAN.md sections 4b, 6, 17: "TikTok stats not
// reachable for free → manual export upload on the Stats page"). Pure: CSV text in, rows out.
//
// Expected files (TikTok Studio → Analytics → Download data → CSV). Header names vary by
// export version and language setting, so each column accepts the aliases below, matched
// without case, spaces or punctuation:
//
//   Content file (one row per video) — required: a link OR a post time, plus views.
//     link       "Video link" | "Link" | "URL" | "Video URL"
//     posted     "Post time" | "Posted" | "Date posted" | "Create time" | "Publish time" | "Date"
//     views      "Total views" | "Video views" | "Views" | "Total play" | "Plays"
//     likes      "Total likes" | "Likes"
//     comments   "Total comments" | "Comments"
//     shares     "Total shares" | "Shares"
//     saves      "Total saves" | "Saves" | "Favorites" | "Total favorites"
//     watch      "Average watch time" | "Avg watch time" | "Average time watched" (seconds, or m:ss)
//     title      "Video title" | "Title" | "Caption" | "Description"
//   Followers file — "Date" + "Followers" | "Total followers": the latest row is her follower count.
//
// Numbers may carry thousands separators or K / M suffixes ("1.2K"). Dates may be ISO,
// "YYYY-MM-DD HH:MM", "MM/DD/YYYY" or "Aug 12, 2026".

export interface ImportedVideo {
  external_id: string;
  url: string | null;
  title: string | null;
  posted_at: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avg_watch_s: number | null;
}

export interface ImportResult {
  kind: "content" | "followers" | "unknown";
  videos: ImportedVideo[];
  followers: number | null;
  skipped: number;
}

const ALIASES = {
  link: ["videolink", "link", "url", "videourl"],
  posted: ["posttime", "posted", "dateposted", "createtime", "publishtime", "date", "postdate"],
  views: ["totalviews", "videoviews", "views", "totalplay", "plays"],
  likes: ["totallikes", "likes"],
  comments: ["totalcomments", "comments"],
  shares: ["totalshares", "shares"],
  saves: ["totalsaves", "saves", "favorites", "totalfavorites"],
  watch: ["averagewatchtime", "avgwatchtime", "averagetimewatched"],
  title: ["videotitle", "title", "caption", "description"],
  followers: ["followers", "totalfollowers"],
} as const;
type Col = keyof typeof ALIASES;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** RFC-4180-ish CSV: quoted fields, doubled quotes, commas/newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export function parseCount(v: string | undefined): number {
  if (!v) return 0;
  const t = v.trim().replace(/,/g, "").replace(/\s/g, "");
  const m = t.match(/^(-?\d+(?:\.\d+)?)([kKmMbB]?)$/);
  if (!m) return 0;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "" | "k" | "m" | "b"];
  return Math.max(0, Math.round(Number(m[1]) * mult));
}

export function parseSeconds(v: string | undefined): number | null {
  if (!v || !v.trim()) return null;
  const t = v.trim().replace(/s$/i, "");
  const mm = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Returns an ISO string (UTC) or null. Times without a zone are read as UTC. */
export function parseDate(v: string | undefined): string | null {
  if (!v || !v.trim()) return null;
  const t = v.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    if (m[7]) {
      const d = new Date(t.replace(" ", "T"));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))).toISOString();
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] ?? 0), +(m[5] ?? 0))).toISOString();
  m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return new Date(Date.UTC(+m[3], mi, +m[2])).toISOString();
  }
  return null;
}

/**
 * The post time a TikTok video id carries: its top 32 bits are the Unix seconds it was posted
 * (every TikTok id is a snowflake). The real Studio export (25 Sep 2026) writes "Post time" as
 * "September 4", with no year and no hour, so the id is the exact time. Null for an id that is
 * not a plausible TikTok id (before 2016 or in the future).
 */
export function tiktokIdTime(id: string | null, now = Date.now()): string | null {
  if (!id || !/^\d{15,20}$/.test(id)) return null;
  const secs = Number(BigInt(id) >> 32n);
  const ms = secs * 1000;
  if (ms < Date.UTC(2016, 0, 1) || ms > now + 86_400_000) return null;
  return new Date(ms).toISOString();
}

export function tiktokVideoId(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/video\/(\d{6,})/);
  return m ? m[1] : null;
}

export function parseTikTokExport(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { kind: "unknown", videos: [], followers: null, skipped: 0 };
  const header = rows[0].map(norm);
  const idx = {} as Record<Col, number>;
  for (const col of Object.keys(ALIASES) as Col[]) {
    idx[col] = -1;
    for (const alias of ALIASES[col]) {
      const i = header.indexOf(alias);
      if (i >= 0) {
        idx[col] = i;
        break;
      }
    }
  }
  const cell = (r: string[], c: Col) => (idx[c] >= 0 ? r[idx[c]] : undefined);

  // Followers file: Date + Followers and no per-video columns.
  if (idx.followers >= 0 && idx.views < 0) {
    let latest: { at: string; n: number } | null = null;
    for (const r of rows.slice(1)) {
      const at = parseDate(cell(r, "posted")) ?? "";
      const n = parseCount(cell(r, "followers"));
      if (!latest || at >= latest.at) latest = { at, n };
    }
    return { kind: "followers", videos: [], followers: latest?.n ?? null, skipped: 0 };
  }

  if (idx.views < 0 || (idx.link < 0 && idx.posted < 0)) return { kind: "unknown", videos: [], followers: null, skipped: 0 };

  const videos: ImportedVideo[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const url = cell(r, "link")?.trim() || null;
    // The written date when it is a full date; otherwise ("September 4", no year) the time the
    // video's own id carries, exact to the second.
    const posted_at = parseDate(cell(r, "posted")) ?? tiktokIdTime(tiktokVideoId(url));
    const title = cell(r, "title")?.trim() || null;
    if (!url && !posted_at) {
      skipped++;
      continue;
    }
    const external_id = tiktokVideoId(url) ?? (url ? url.split("?")[0].replace(/\/$/, "") : `t:${posted_at}:${(title ?? "").slice(0, 40)}`);
    if (seen.has(external_id)) {
      skipped++;
      continue;
    }
    seen.add(external_id);
    videos.push({
      external_id,
      url,
      title,
      posted_at,
      views: parseCount(cell(r, "views")),
      likes: parseCount(cell(r, "likes")),
      comments: parseCount(cell(r, "comments")),
      shares: parseCount(cell(r, "shares")),
      saves: parseCount(cell(r, "saves")),
      avg_watch_s: parseSeconds(cell(r, "watch")),
    });
  }
  const followers = idx.followers >= 0 ? Math.max(0, ...rows.slice(1).map((r) => parseCount(cell(r, "followers")))) : null;
  return { kind: "content", videos, followers, skipped };
}

/** Average views over the most recent `n` videos (the media kit's "average views"). */
export function recentAverageViews(videos: { posted_at: string | null; views: number }[], n = 30): number {
  const sorted = [...videos].sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? "")).slice(0, n);
  if (!sorted.length) return 0;
  return Math.round(sorted.reduce((s, v) => s + v.views, 0) / sorted.length);
}
