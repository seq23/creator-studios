#!/usr/bin/env node
// A realistic YEAR of demo data: day 358 of Sam using the dashboard (owner, 26 Sep 2026:
// "think about day 358 of using this"). Demo data only, never her real content, never production:
// every row id starts with `yr_` (versions 9101+ for briefs, the profile and kit versions), the
// CLI writes only to the LOCAL D1 (`--local`); any remote target (`--remote`, `--env`, the old
// `--remote-sample`) is refused, so no studio ever receives it, and nothing in worker/ or app/ imports it
// (validator `seed-year-local-only`). Deterministic: the same `now` gives the same rows, so the
// e2e suite, the unit tests and the day-358 screenshots all see the same year.
//
//   ~50 dumps (failed, held as someone else's, an abandoned upload, full videos for YouTube),
//   ~600 clips across every status and Look, ~300 posts (posted / failed / taken off), voice overs
//   (automatic and her own), 45 deals in every stage incl. declined and lost, 12 research briefs,
//   26 media kit versions, a year of health events and emails, and a storage bucket near 10 GB.
//
// Use:
//   node scripts/seed-year.mjs --apply          seed the local D1 the e2e Worker uses
//   node scripts/seed-year.mjs --clear          remove it again
//   node scripts/seed-year.mjs --out file.sql   write the SQL (for a look)
//   --before  leaves out the columns migration 0016 added (the "before" screenshots)
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const YEAR_PREFIX = "yr_";
const DAY = 86400_000;
const MB = 1024 ** 2;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(", ")}) VALUES (${Object.values(obj).map(q).join(", ")});`;

const LOOKS = ["clean", "bold_hook", "karaoke", "brand_card", "cinematic", "reaction", "split", "side_by_side", "grid_four", "grid_six", "grid_eight", "hero_strip"];
const RECIPES = ["talking_head", "hook_first", "story", "montage"];
const TOPICS = [
  "Sunday morning routine", "Fall weekend reset", "Thanksgiving week plan", "Christmas gift list", "New Year's goal setting",
  "Galentine's day out", "Valentine's day plan", "Spring clean checklist", "Mother's Day gift guide", "Garden day off",
  "Fourth of July road trip", "Summer travel packing", "Back-to-school week", "Harvest weekend plan", "Halloween week",
  "Weeknight wind-down", "Book club catch-up", "Baby shower gift list", "Bridal shower prep", "Cozy night in",
];
const HOOKS = [
  "My {t} in 60 seconds", "The one checklist everyone asks about", "Slow mornings, but make it {t}", "{t} on a budget",
  "Three steps that make a {t}", "How I reset after a long week", "The easiest habit ever", "Stop buying planners: do this",
  "My go-to trick for a {t}", "Thrifted finds, big results", "The five-minute rule for a {t}", "Small wins from the grocery store",
];
const BRANDS = [
  "Lark & Laurel", "Hearth & Honey Tea", "Glow Journal Co.", "Fieldnote Paper Co.", "Gilded Pen Supply", "Maison Crystal", "Oak & Olive Goods",
  "Daily Hub", "Bloom Box Market", "Sterling Travel Co.", "Velvet Notebook Studio", "Pine & Path", "Copper Kettle Goods", "Sunday Club",
  "Tidewater Wellness", "Magnolia Mornings", "Blue Willow Studio", "Feast Fine Paper", "Charm City Bags", "Harvest Loom", "Crème Skin Co.",
  "Lark & Lantern", "Plume Goods", "Rosewater Bottles", "Wren Supply", "Salt & Stone Co.", "The Butter Bar", "Gather Goods",
  "Pearl & Pine Studio", "Sunrise Tea", "Twine & Thread", "Silver Spoon Wellness", "Heirloom Habits", "Velvet Desk", "Bellwether Bags",
  "Parlor Paper", "Honeycomb Health", "Cedar Sprig", "Brass Bell Bottles", "Chateau Chalk", "Garland & Gold", "Sweet Tea Supply", "Hollow Oak",
  "Marigold Mercantile", "Ivy Lane Studio", "Juniper Journal", "Saffron Skin", "Dove Grey Goods", "Painted Bird Paper", "Seaside Supply", "Fig & Frond",
  "Morning Glory Mugs", "Evergreen Everyday", "Opal Outdoors", "Lavender Loft",
];
const DEAL_PLAN = [
  // [stage, count]
  ["find_contact", 2], ["pitch", 4], ["follow_up", 8], ["negotiating", 3], ["agreed", 2], ["delivering", 2],
  ["invoiced", 2], ["paid", 3], ["done", 8], ["declined", 5], ["lost", 6],
];
const DECLINED = ["Not a fit for my audience", "The fee was too low", "Perpetual usage rights", "Exclusivity with no pay", "Timeline too tight"];
const LOST = ["No reply after three follow-ups", "They went with another creator", "Budget was cut", "They wanted gifted only", "No reply after three follow-ups", "Went quiet after the offer"];

const briefBody = (v) =>
  JSON.stringify({
    audience: [{ text: `Most engaged viewers are women 30-55 (month ${v}).`, source_ids: ["s1"], basis: "her_data", confidence: "solid" }],
    themes: [{ title: "Morning routines", claims: [{ text: "Routine videos get the most saves.", source_ids: ["s1"], basis: "web", confidence: "solid" }] }],
    hooks: [{ text: "Open on the finished result, then rewind.", source_ids: ["s1"], basis: "web", confidence: "solid" }],
    cut_styles: [{ text: "Hook-first cuts under 30 seconds hold best.", source_ids: ["s1"], basis: "web", confidence: "solid" }],
    best_times: { tiktok: [], instagram: [], youtube: [] },
    comparable_creators: [{ handle: "@demo.routines", platform: "tiktok", why: { text: "Same niche, similar size.", source_ids: ["s1"], basis: "web", confidence: "solid" } }],
    shot_list: [{ text: "A 20-second desk reset before the day starts.", source_ids: ["s1"], basis: "web", confidence: "solid" }],
  });

function kitContent(showcase, version, photoKey = null) {
  return JSON.stringify({
    name: "Sample Creator",
    handles: { tiktok: "@demo.sample", instagram: "@demo.sample" },
    niche: "Routines · quick tips · everyday wins",
    location: "Mobile, Alabama",
    positioning: "Everyday routines that make busy days feel easy.",
    bio: `Morning routines, quick tips and everyday wins for women who love a plan. (kit v${version})`,
    photoKey,
    pillars: [{ title: "Morning routines", text: "Routines for every season" }, { title: "Quick tips", text: "Small changes without the stress" }],
    series: [{ title: "Sunday Reset", text: "A weekly 60-second reset" }],
    showcase,
    collabs: [],
    packages: [{ id: "pkg_tiktok", name: "1 TikTok video", items: [{ key: "tiktok_video", qty: 1 }], startingAt: 800, onRequest: false, floor: 650, target: 1000, note: "Concept, filming and editing.", showOnKit: true }],
    addons: { usagePctPer30d: 30, paidUsagePctPer30d: 40, exclusivityPctPerMonth: 25, rushPct: null, bundleDiscountPct: 10, killFeePct: 50, upfrontPct: 50, upfrontOver: 1000, netDays: 30, revisionRounds: 2 },
    testimonials: [],
    contactEmail: "partnerships@demo-creator.example",
    manual: [],
  });
}

/**
 * The sample's clean slate (sample mode only): every row the public sample holds goes, whatever
 * made it (a visitor, a fake cron, the days it was the owner's real twin), so the sample is demo
 * data only. Children before parents; the singleton rows (media_kit 1, voice 1) are reset in place;
 * settings go back to the migrations' defaults.
 */
export function sampleResetSql() {
  return [
    "DELETE FROM posts;", "DELETE FROM platform_videos;", "DELETE FROM metrics;", "DELETE FROM narrations;", "DELETE FROM youtube_uploads;", "DELETE FROM editor_jobs;",
    "DELETE FROM clips;", "DELETE FROM assets;", "DELETE FROM jobs;", "DELETE FROM dumps;",
    "DELETE FROM deal_emails;", "DELETE FROM deal_offers;", "DELETE FROM pitches;", "DELETE FROM deals;", "DELETE FROM brand_contacts;", "DELETE FROM brands;",
    "DELETE FROM research_uploads;", "DELETE FROM research_briefs;", "DELETE FROM brand_docs;", "DELETE FROM brand_profile;",
    "DELETE FROM kit_views;", "DELETE FROM media_kit_versions;", "DELETE FROM kit_slugs WHERE slug != 'studio';",
    "DELETE FROM account_stats;", "DELETE FROM emails_sent;", "DELETE FROM events;", "DELETE FROM music_tracks;", "DELETE FROM dismissals;", "DELETE FROM help_feedback;",
    "DELETE FROM connections;", "DELETE FROM health;", "DELETE FROM sessions;", "DELETE FROM login_codes;",
    "DELETE FROM settings WHERE key NOT IN ('weekly_caps', 'hard_cap_per_channel', 'runway_threshold_weeks', 'notify_emails', 'posting_slots_source', 'recycle_cooldown_days', 'helper_email', 'voice_engine_preference', 'editing', 'marketplaces_joined', 'tidy');",
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('features', '{"voice":true,"deeper_research":true,"weekly_recap":true,"help_ask":true}');`,
    "UPDATE media_kit SET bio = '', photo_r2_key = NULL, featured_clip_ids = '[]', past_partners = '[]', rates = NULL, public_slug = 'studio', contact_email = NULL, updated_at = NULL, draft = NULL, draft_saved_at = NULL WHERE id = 1;",
    "UPDATE voice SET sample_r2_key = NULL, consent_at = NULL, consent_text = NULL, model_r2_key = NULL, elevenlabs_voice_id = NULL, enabled = 0, updated_at = NULL WHERE id = 1;",
  ].join("\n");
}

/** The clean-up block: everything the year adds, removed (run before inserting and by --clear). */
export function clearYearSql({ before = false } = {}) {
  return [
    "DELETE FROM metrics WHERE id LIKE 'yr_%';",
    "DELETE FROM platform_videos WHERE id LIKE 'yr_%';",
    "DELETE FROM posts WHERE id LIKE 'yr_%';",
    "DELETE FROM narrations WHERE id LIKE 'yr_%';",
    "DELETE FROM clips WHERE id LIKE 'yr_%';",
    "DELETE FROM assets WHERE id LIKE 'yr_%';",
    "DELETE FROM jobs WHERE id LIKE 'yr_%';",
    "DELETE FROM dumps WHERE id LIKE 'yr_%';",
    "DELETE FROM deal_emails WHERE id LIKE 'yr_%';",
    "DELETE FROM deal_offers WHERE id LIKE 'yr_%';",
    "DELETE FROM deals WHERE id LIKE 'yr_%';",
    "DELETE FROM pitches WHERE id LIKE 'yr_%';",
    "DELETE FROM brand_contacts WHERE id LIKE 'yr_%';",
    "DELETE FROM brands WHERE id LIKE 'yr_%';",
    "DELETE FROM research_briefs WHERE version BETWEEN 9101 AND 9199;",
    "DELETE FROM brand_profile WHERE version = 9101;",
    "DELETE FROM media_kit_versions WHERE version BETWEEN 9101 AND 9199;",
    "DELETE FROM kit_views WHERE id LIKE 'yr_%';",
    "DELETE FROM account_stats WHERE id LIKE 'yr_%';",
    "DELETE FROM emails_sent WHERE id LIKE 'yr_%';",
    "DELETE FROM events WHERE id LIKE 'yr_%';",
    "DELETE FROM music_tracks WHERE id LIKE 'yr_%';",
    "DELETE FROM brand_docs WHERE id LIKE 'yr_%';",
    "DELETE FROM health WHERE name IN ('Storage', 'Runway', 'Buffer', 'TikTok (via Buffer)', 'Instagram (via Buffer)', 'YouTube (via Buffer)', 'Clip cutting', 'Email (Resend)', 'Job runner (GitHub)', 'Voice', 'Brand finder', 'Last daily run', 'Last buffer-sync run', 'Last weekly run');",
    "DELETE FROM settings WHERE key IN ('storage_used', 'storage_report', 'home_dismissed');",
    "UPDATE media_kit SET draft = NULL, draft_saved_at = NULL WHERE id = 1 AND draft LIKE '%yr_dump_%';",
    ...(before ? [] : ["DELETE FROM dismissals;", "UPDATE clips SET delete_warned_at = NULL, keep_until = NULL WHERE delete_warned_at IS NOT NULL OR keep_until IS NOT NULL;"]),
  ].join("\n");
}

/**
 * The year as SQL. `now` is "today" (day 358). `before` leaves out the columns migration 0016
 * added (clips/narrations file sizes), so the same year can be loaded on the old schema. `sample`
 * (the public demo): the clean slate first, file sizes at 40% so the Storage light sits green, the
 * sample's own health board, a saved voice, and `media` = every R2 key a row points at with what it
 * shows.
 */
export function yearSql(now = new Date(), { before = false, sample = false } = {}) {
  const r = rng(358);
  const MBs = sample ? Math.round(MB * 0.4) : MB;
  const media = [];
  const file = (key, kind, look = null) => {
    if (sample) media.push({ key, kind, look });
    return key;
  };
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  const iso = (t) => new Date(t).toISOString();
  const T = now.getTime();
  const day0 = T - 358 * DAY;
  const out = [...(sample ? [sampleResetSql()] : []), clearYearSql({ before })];
  const stats = { dumps: 0, clips: 0, posts: 0, narrations: 0, deals: 0, bytes: 0 };
  let tok = 0;
  const token = () => `yr${String(++tok).padStart(6, "0")}${"x".repeat(32)}`;
  let ev = 0;
  const event = (kind, ref, at, detail = {}) => out.push(row("events", { id: `yr_ev_${++ev}`, kind, ref_id: ref, detail: JSON.stringify(detail), actor: "owner", created_at: iso(at) }));
  let em = 0;
  const email = (kind, subject, at, ref = null) => out.push(row("emails_sent", { id: `yr_em_${++em}`, kind, to_email: "owner@demo-creator.example", subject, ref_id: ref, provider_id: `demo-${em}`, sent_at: iso(at) }));

  // The locked profile and the approved brief behind it (no "first things first" on day 358).
  out.push(row("brand_profile", { version: 9101, sections: JSON.stringify({ who: "Demo creator: an everyday lifestyle creator.", audience: "Women 30-55 who love practical routines.", goals: "10 clips a week, 2 paid partnerships a quarter.", voice: "Warm, gracious, a little playful.", themes: "Morning routines\nQuick tips\nWeekly resets", do_dont: "Do: real days. Don't: hard selling.", off_limits: "Alcohol brands, diet pills", deal_fit: "Everyday essentials, wellness, stationery.", ctas: "Save this for your next reset." }), locked: 1, locked_at: iso(day0 + 2 * DAY), source: "edited", created_at: iso(day0 + 2 * DAY) }));

  // 12 research briefs, one a month; the newest is this month's draft, the one before is live.
  for (let m = 0; m < 12; m++) {
    const v = 9101 + m;
    const at = day0 + 3 * DAY + m * 30 * DAY;
    const status = m === 11 ? "draft" : m === 10 ? "approved" : "superseded";
    out.push(row("research_briefs", { version: v, body: briefBody(m + 1), sources: JSON.stringify([{ id: "s1", url: "https://example.org/demo-source", title: "Demo source", kind: "web" }]), status, approved_at: status === "draft" ? null : iso(at + DAY), created_at: iso(at) }));
    if (m > 0) email("brief_ready", "New brief draft ready", at + 3600_000, String(v));
  }

  // ---------------------------------------------------------------- dumps, clips, posts
  const FULL = new Set([10, 22, 35, 46, 48]);
  const FAILED = new Map([[5, "The cutter could not read this video (it stopped halfway through uploading)."], [17, "Clip cutting took too long and stopped. Tap Try again."], [31, "No speech or movement found in these videos."]]);
  const HELD = new Set([27, 44]);
  const ABANDONED = 38;
  const LEFT_OPEN = new Set([8, 13, 19, 24, 29, 33, 40, 43]); // she skipped some clips: old visible drafts stay in Review
  const approvedPool = [];
  const postedClips = [];
  const clipLook = new Map();
  let pv = 0;
  for (let i = 0; i < 50; i++) {
    const id = `yr_dump_${String(i).padStart(2, "0")}`;
    const created = i === 49 ? T - 1 * DAY : i === 48 ? T - 12 * DAY : i === 47 ? T - 5 * DAY : day0 + i * 7 * DAY + between(0, 2) * DAY + 15 * 3600_000;
    const ready = created + between(8, 40) * 60_000;
    const full = FULL.has(i);
    const door = !full && i % 6 === 5 ? "recycle" : "new";
    const topic = TOPICS[i % TOPICS.length];
    let status = "reviewed";
    if (FAILED.has(i)) status = "failed";
    else if (i === ABANDONED) status = "uploading";
    else if (LEFT_OPEN.has(i) || HELD.has(i) || i >= 48) status = "ready";
    stats.dumps++;
    out.push(row("dumps", { id, door, kind: full ? "full_video" : "clips", notes: full ? `Full video: ${topic} start to finish` : `${topic}${i % 3 === 0 ? ", keep it cosy" : ""}`, status, error_summary: FAILED.get(i) ?? null, clips_made: 0, created_at: iso(created), dumped_at: status === "uploading" ? null : iso(created + 5 * 60_000), ready_at: ["reviewed", "ready", "failed"].includes(status) ? iso(ready) : null }));
    if (status !== "uploading") email(status === "failed" ? "posting_problem" : "clips_ready", status === "failed" ? "A dump needs a look" : "Your clips are ready", ready, id);
    event("dump.sent", id, created + 5 * 60_000, { door, files: 1 });
    // The sample keeps the job behind each dump, so "Clip cutting" reads the last cut, not "No clips cut yet".
    if (sample && status !== "uploading") out.push(row("jobs", { id: `yr_job_${String(i).padStart(2, "0")}`, type: full ? "fullvideo" : "cut", status: status === "failed" ? "failed" : "done", ref_id: id, nonce: `yr_nonce_${i}`, safe_error: FAILED.get(i) ?? null, created_at: iso(created + 5 * 60_000), started_at: iso(created + 6 * 60_000), finished_at: iso(ready) }));

    const nAssets = full ? 1 : between(1, 4);
    const assets = [];
    for (let a = 0; a < nAssets; a++) {
      const aid = `${id}_a${a}`;
      const size = full ? between(1400, 2600) * MBs : between(120, 480) * MBs;
      const rawGone = status !== "uploading" && T - ready > 7 * DAY;
      const upload = status === "uploading" ? "uploading" : "uploaded";
      assets.push(aid);
      out.push(row("assets", { id: aid, dump_id: id, file_name: `${topic.toLowerCase().replace(/[^a-z]+/g, "-")}-${a + 1}.mov`, mime_type: "video/quicktime", size_bytes: size, r2_key: `raw/${id}/${aid}`, upload_status: upload, duration_s: full ? between(540, 1500) : between(40, 300), content_hash: `yrhash${i}_${a}`, raw_deleted_at: rawGone || full ? iso(ready + 7 * DAY) : null, created_at: iso(created), source_owner: HELD.has(i) ? "other" : "hers", source_note: HELD.has(i) ? "This video shows the name @another.creator, which is not one of your accounts, so its clips are held off your calendar." : null }));
      if (!rawGone && !full && upload === "uploaded") stats.bytes += size;
    }
    if (status === "uploading" || status === "failed") continue;

    if (full) {
      const cid = `${id}_full`;
      const size = between(1400, 2600) * MBs;
      const title = `${topic}: the whole thing, start to finish`;
      const age = T - ready;
      const unapproved = i === 48;
      const posted = !unapproved;
      const postedAt = ready + 5 * DAY;
      const fileGone = posted && T - postedAt > 7 * DAY;
      const details = { title, description: `Everything for a ${topic.toLowerCase()}.`, chapters: [{ t: 0, title: "Intro" }, { t: 60, title: "The plan" }, { t: 240, title: "Finishing touches" }], tags: ["routine", "dailytips"], thumbnails: [{ key: file(`full/${id}/t1.jpg`, "thumb", LOOKS[i % LOOKS.length]), t: 20 }, { key: file(`full/${id}/t2.jpg`, "thumb", LOOKS[(i + 1) % LOOKS.length]), t: 50 }, { key: file(`full/${id}/t3.jpg`, "thumb", LOOKS[(i + 2) % LOOKS.length]), t: 80 }], thumb_pick: 0, privacy: "public", width: 1920, height: 1080, duration_s: 900, size_bytes: size, studio_done_at: posted && i !== 46 ? iso(postedAt + DAY) : null, handoff: false };
      out.push(row("clips", { id: cid, asset_id: assets[0], dump_id: id, start_s: 0, end_s: 900, recipe: "story", hook_text: title, caption: details.description, hashtags: "#routine", platforms: '["youtube"]', score: 0.9, r2_key: fileGone ? `full/${id}/video.mp4` : file(`full/${id}/video.mp4`, "full", LOOKS[i % LOOKS.length]), cover_r2_key: null, media_token: fileGone ? null : token(), status: unapproved ? "draft" : "approved", reviewed_at: unapproved ? null : iso(ready + DAY), created_at: iso(ready), full_video: 1, youtube: JSON.stringify(details), file_deleted_at: fileGone ? iso(postedAt + 7 * DAY) : null, ...(before ? {} : { file_bytes: fileGone ? 0 : size }) }));
      stats.clips++;
      if (!fileGone) stats.bytes += size;
      if (posted) {
        const pid = `yr_post_${cid}`;
        out.push(row("posts", { id: pid, clip_id: cid, platform: "youtube", scheduled_at: iso(postedAt), status: "posted", url: `https://www.youtube.com/watch?v=yrfull${String(i).padStart(5, "0")}`, posted_at: iso(postedAt), created_at: iso(ready + DAY) }));
        stats.posts++;
      }
      void age;
      continue;
    }

    const n = between(12, 19);
    let made = 0;
    for (let k = 0; k < n; k++) {
      const cid = `${id}_c${String(k).padStart(2, "0")}`;
      const score = Math.round((0.36 + r() * 0.62) * 100) / 100;
      const hidden = score < 0.45 ? 1 : 0;
      const created = ready;
      const age = T - created;
      const x = r();
      let st;
      if (i >= 48) st = hidden ? "draft" : k < 3 ? "approved" : "draft";
      else if (HELD.has(i)) st = "draft";
      else if (hidden) st = x < 0.15 ? "rejected" : "draft"; // under the bar: mostly never looked at
      else if (LEFT_OPEN.has(i) && x < 0.3) st = "draft";
      else if (x < 0.66) st = "approved";
      else if (x < 0.82) st = "rejected";
      else st = "deleted";
      // rejected and 7 days old: the daily lane has already removed it (status 'deleted')
      const reviewedAt = st === "draft" ? null : created + between(1, 3) * DAY;
      if (st === "rejected" && T - reviewedAt > 7 * DAY) st = "deleted";
      const look = LOOKS[(i * 7 + k) % LOOKS.length];
      const hook = pick(HOOKS).replace("{t}", topic.toLowerCase());
      const bytes = st === "deleted" ? 0 : between(9, 16) * MBs + between(150, 400) * 1024;
      const c = {
        id: cid, asset_id: assets[k % assets.length], dump_id: id, start_s: k * 30, end_s: k * 30 + between(15, 45), recipe: door === "recycle" ? "recycle" : pick(RECIPES),
        hook_text: hook, caption: `${hook}. Save this for your next reset.`, hashtags: "#routine #dailytips", platforms: '["tiktok","instagram","youtube"]', score,
        r2_key: st === "deleted" ? `clips/${id}/${cid}.mp4` : file(`clips/${id}/${cid}.mp4`, "clip", look), cover_r2_key: st === "deleted" ? `clips/${id}/${cid}.jpg` : file(`clips/${id}/${cid}.jpg`, "cover", look), media_token: st === "deleted" ? null : token(), status: st,
        reject_reason: st === "rejected" || (st === "deleted" && x < 0.82) ? pick(["Boring start", "Bad framing", "Off-brand", "Too long", null]) : null,
        hidden, reviewed_at: reviewedAt ? iso(reviewedAt) : null, created_at: iso(created), look, parts: `[[${k * 30},${k * 30 + 25}]]`,
        speech: r() < 0.3 ? 0.05 : 0.7,
        ...(before ? {} : { file_bytes: bytes }),
      };
      out.push(row("clips", c));
      stats.clips++;
      made++;
      if (st !== "deleted") stats.bytes += bytes;
      if (st === "approved") approvedPool.push({ id: cid, at: reviewedAt, age, bytes, hook });
      clipLook.set(cid, look);
      event(st === "draft" ? "clip.made" : `clip.${st === "deleted" ? "rejected" : st}`, cid, reviewedAt ?? created, { recipe: c.recipe, score });
    }
    out.push(`UPDATE dumps SET clips_made = ${made} WHERE id = '${id}';`);
  }

  // Posts: most approved clips went out on one or two platforms; a few failed or were taken off.
  const PLAT = ["tiktok", "instagram", "youtube"];
  for (const c of approvedPool) {
    const x = r();
    const ageDays = (T - c.at) / DAY;
    if (ageDays < 4) continue; // the newest approved clips are the runway
    if (x < 0.14) continue; // approved, never scheduled: runway
    const count = x > 0.78 ? 2 : 1;
    for (let p = 0; p < count; p++) {
      const plat = PLAT[(p + Math.floor(r() * 3)) % 3];
      const at = c.at + between(1, 6) * DAY + 19 * 3600_000;
      const pid = `yr_post_${c.id}_${p}`;
      const y = r();
      // The sample shows no failed posts: three red "posts did not go out" lights read as broken to a visitor.
      let status = at > T ? "planned" : y < 0.07 ? (sample ? "posted" : "failed") : y < 0.13 ? "unscheduled" : "posted";
      if (status === "planned" && at - T < 7 * DAY) status = r() < 0.5 ? "in_buffer" : "planned";
      out.push(row("posts", { id: pid, clip_id: c.id, platform: plat, scheduled_at: iso(at), status, url: status === "posted" ? `https://www.tiktok.com/@demo.sample/video/7${String(++pv).padStart(18, "0")}` : null, error: status === "failed" ? pick(["Instagram did not accept the video. Reconnect Instagram in Buffer.", "Buffer was busy and the post was not sent. Tap Try again.", "TikTok said this video is too long."]) : null, retries: status === "failed" ? 2 : 0, posted_at: status === "posted" ? iso(at) : null, created_at: iso(c.at) }));
      stats.posts++;
      if (status === "failed") email("posting_problem", "A post did not go out", at + 3600_000, pid);
      if (status === "posted") {
        postedClips.push({ id: c.id, at });
        out.push(row("platform_videos", { id: `yr_pv_${pv}`, platform: plat, external_id: `yr${plat}${pv}`, url: `https://example.org/${plat}/${pv}`, title: c.hook, posted_at: iso(at), views: between(300, 48000), likes: between(10, 3000), comments: between(0, 200), shares: between(0, 400), saves: between(0, 1200), source: "import", post_id: pid, captured_at: iso(Math.min(T, at + 7 * DAY)) }));
      }
    }
  }
  // Clips posted over 30 days ago lost their public link (the current rule); the kit's showcase kept theirs.
  const showcase = postedClips.slice(0, 3).map((p) => p.id);
  for (const p of postedClips) if (T - p.at > 30 * DAY && !showcase.includes(p.id)) out.push(`UPDATE clips SET media_token = NULL WHERE id = '${p.id}';`);

  // ---------------------------------------------------------------- voice overs
  let nv = 0;
  const attachable = approvedPool.filter((_, j) => j % 7 === 0).slice(0, 38);
  for (const [j, c] of attachable.entries()) {
    const auto = j < 30 ? 1 : 0;
    const failed = j % 13 === 12;
    const nid = `yr_narr_${++nv}`;
    const bytes = failed ? 0 : between(120, 400) * 1024 + (auto || j % 2 ? between(14, 26) * MBs : 0);
    out.push(row("narrations", { id: nid, script: `Three things make a morning feel special, part ${nv}.`, r2_key: failed ? null : file(`narrations/${nid}.mp3`, "narration"), clip_id: failed ? null : c.id, status: failed ? "failed" : "ready", engine: j % 5 === 0 ? "elevenlabs" : "built-in", duration_s: failed ? null : 8 + (j % 9), mixed_r2_key: failed ? null : file(`narrations/${nid}-mix.mp4`, "mix", clipLook.get(c.id) ?? LOOKS[0]), mix_status: failed ? "failed" : "ready", auto, ai_generated: 1, batch: auto ? `auto/b${Math.floor(j / 3)}` : null, created_at: iso(c.at + DAY), ...(before ? {} : { file_bytes: bytes }) }));
    stats.narrations++;
    stats.bytes += bytes;
  }
  for (let j = 0; j < 6; j++) {
    const nid = `yr_narr_${++nv}`;
    const at = day0 + between(20, 350) * DAY;
    out.push(row("narrations", { id: nid, script: `A voice over I never used, number ${j + 1}.`, r2_key: j === 5 ? null : file(`narrations/${nid}.mp3`, "narration"), clip_id: null, status: j === 5 ? "failed" : "ready", engine: "built-in", duration_s: j === 5 ? null : 7, auto: 0, ai_generated: 1, created_at: iso(at), ...(before ? {} : { file_bytes: j === 5 ? 0 : 240 * 1024 }) }));
    stats.narrations++;
  }

  // ---------------------------------------------------------------- deals
  let b = 0;
  let dn = 0;
  for (const [stage, count] of DEAL_PLAN) {
    for (let k = 0; k < count; k++) {
      const name = BRANDS[b++ % BRANDS.length];
      const bid = `yr_brand_${b}`;
      const created = day0 + between(10, 340) * DAY;
      out.push(row("brands", { id: bid, name, website: `https://${name.toLowerCase().replace(/[^a-z]+/g, "")}.example/`, fit_score: 0.6 + r() * 0.35, fit_reasons: JSON.stringify(["Fits your Morning routines theme"]), source_links: JSON.stringify([`https://${name.toLowerCase().replace(/[^a-z]+/g, "")}.example/creators`]), origin: k % 3 ? "finder" : "her_list", status: "saved", kind: "brand", budget_signal: JSON.stringify({ level: "paying", evidence: [{ text: "Runs a creator program", url: "https://example.org/program" }] }), created_at: iso(created) }));
      if (stage !== "find_contact") out.push(row("brand_contacts", { id: `yr_ct_${b}`, brand_id: bid, kind: "role_email", value: `creators@${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, found_on_url: "https://example.org/contact" }));
      const did = `yr_deal_${++dn}`;
      const pitched = ["find_contact", "pitch"].includes(stage) ? null : created + DAY;
      const closedStage = ["paid", "done", "declined", "lost"].includes(stage);
      const closedAt = closedStage ? Math.min(T - between(2, 200) * DAY, created + between(20, 90) * DAY) : null;
      const fee = ["negotiating", "agreed", "delivering", "invoiced", "paid", "done"].includes(stage) ? between(4, 24) * 100 : null;
      out.push(row("deals", { id: did, brand_id: bid, stage, terms: JSON.stringify(fee ? { fee, deliverables: "1 TikTok video" } : {}), outcome_reason: stage === "declined" ? DECLINED[k % DECLINED.length] : stage === "lost" ? LOST[k % LOST.length] : null, pitched_at: pitched ? iso(pitched) : null, replied_at: ["negotiating", "agreed", "delivering", "invoiced", "paid", "done", "declined"].includes(stage) ? iso(created + 6 * DAY) : null, agreed_at: ["agreed", "delivering", "invoiced", "paid", "done"].includes(stage) ? iso(created + 12 * DAY) : null, delivered_at: ["invoiced", "paid", "done"].includes(stage) ? iso(created + 25 * DAY) : null, invoiced_at: ["invoiced", "paid", "done"].includes(stage) ? iso(created + 26 * DAY) : null, invoice_due_at: ["invoiced", "paid", "done"].includes(stage) ? iso(created + 56 * DAY) : null, paid_at: ["paid", "done"].includes(stage) ? iso(closedAt) : null, closed_at: closedAt ? iso(closedAt) : null, created_at: iso(created), updated_at: iso(closedAt ?? created + 2 * DAY) }));
      stats.deals++;
      if (pitched) {
        out.push(row("pitches", { id: `yr_pitch_${dn}`, brand_id: bid, contact_id: `yr_ct_${b}`, subject: `An idea for ${name}`, body: `Hi ${name} team, an idea for a video...`, status: stage === "follow_up" ? "sent" : "replied", sent_at: iso(pitched), next_followup_at: stage === "follow_up" ? iso(pitched + 5 * DAY) : null, created_at: iso(created) }));
      }
      event(`deal.${stage}`, did, closedAt ?? created, {});
    }
  }
  // Prospects the finder found and she never pitched.
  for (let k = 0; k < 15; k++) {
    const name = BRANDS[b++ % BRANDS.length];
    out.push(row("brands", { id: `yr_brand_${b}`, name: `${name} ${k + 2}`, website: `https://prospect${k}.example/`, fit_score: 0.5 + r() * 0.4, fit_reasons: JSON.stringify(["Home brand"]), source_links: "[]", origin: "finder", status: "suggested", kind: "brand", created_at: iso(T - between(1, 60) * DAY) }));
  }

  // ---------------------------------------------------------------- the kit, stats, a year of email and health
  // The sample's kit carries a photo (the brand mark), so the Kit check and the public kit read as complete.
  const kitPhoto = sample ? file("kit/photo/upl_yrsample01", "kitphoto") : null;
  for (let v = 0; v < 26; v++) out.push(row("media_kit_versions", { version: 9101 + v, content: kitContent(showcase, v + 1, kitPhoto), slug: "studio", published_at: iso(day0 + 5 * DAY + v * 13 * DAY) }));
  out.push(`UPDATE media_kit SET draft = ${q(kitContent(showcase, 27, kitPhoto))}, draft_saved_at = ${q(iso(T - DAY))} WHERE id = 1;`);
  for (let v = 0; v < 400; v++) out.push(row("kit_views", { id: `yr_kv_${v}`, version: 9101 + Math.min(25, Math.floor(v / 16)), viewed_at: iso(day0 + 6 * DAY + Math.floor(v * 0.88) * DAY) }));
  for (let w = 0; w < 51; w++) {
    const at = day0 + (w + 1) * 7 * DAY;
    for (const [p, f] of [["tiktok", 4000], ["instagram", 2600], ["youtube", 600]]) out.push(row("account_stats", { id: `yr_st_${p}_${w}`, platform: p, captured_at: iso(at), followers: f + w * (p === "tiktok" ? 170 : p === "instagram" ? 110 : 30), avg_views: 900 + w * 40, source: "import" }));
    email("weekly_recap", "Your week", at + 12 * 3600_000);
    if (w % 4 === 1) email("time_to_dump", "Time to dump: under 2 weeks of clips left", at + 13 * 3600_000);
    if (w % 13 === 7) email("connection_needs_you", "Buffer needs you", at + 14 * 3600_000);
    event("health.recheck", null, at, {});
  }
  for (let t = 0; t < 5; t++) out.push(row("music_tracks", { id: `yr_track_${t}`, file_name: `my-song-${t + 1}.mp3`, r2_key: file(`music/yr_track_${t}.mp3`, "music"), mime_type: "audio/mpeg", size_bytes: between(3, 8) * MBs, created_at: iso(day0 + t * 60 * DAY) }));
  out.push(row("brand_docs", { id: "yr_doc_1", file_name: "brand-guide.pdf", mime_type: "application/pdf", size_bytes: 2 * MBs, r2_key: file("docs/yr_doc_1.pdf", "doc"), extract_status: "done", char_count: 6400, uploaded_at: iso(day0 + DAY) }));
  if (sample) {
    // Her saved voice (consent given), so the Voice screen and the automatic voice overs read as ready.
    out.push(`UPDATE voice SET sample_r2_key = ${q(file("voice/yr_sample.mp3", "voice"))}, consent_at = ${q(iso(day0 + 4 * DAY))}, consent_text = 'This is my own voice and I consent to it being cloned for my narration', model_r2_key = 'voice/yr_model.pt', enabled = 1, updated_at = ${q(iso(day0 + 4 * DAY))} WHERE id = 1;`);
  }

  // The health board on day 358 (the daily lane rewrites Storage and Runway on its next run).
  const lights = [
    ["Buffer", "green", "Connected: 3 channels", null],
    ["TikTok (via Buffer)", "green", "Posting OK", null],
    ["Instagram (via Buffer)", "green", "Posting OK", null],
    ["YouTube (via Buffer)", "green", "Posting OK", null],
    ["Clip cutting", "green", "Last dump cut in 12 minutes", null],
    ["Email (Resend)", "green", "Ready to send", null],
    ["Job runner (GitHub)", "green", "Ready", null],
    ["Voice", "green", "Your built-in voice is ready", null],
    ["Last daily run", "green", `OK · ${new Date(T - 3600_000).toUTCString()}`, null],
    ["Last buffer-sync run", "green", `OK · ${new Date(T - 1800_000).toUTCString()}`, null],
    // The sample's full board (the local e2e server leaves these to the lanes; on the sample the
    // fake lanes keep them green from here on).
    ...(sample
      ? [
          ["Last weekly run", "green", `OK · ${new Date(T - 5 * DAY).toUTCString()}`, null],
          ["Storage", "green", `${(stats.bytes / 1024 ** 3).toFixed(1)} GB of 10 GB used · ${(10 - stats.bytes / 1024 ** 3).toFixed(1)} GB free`, null],
          ["Runway", "green", "4.5 weeks of approved clips", null],
          ["TikTok stats", "green", "Imported · 5 videos from your TikTok export", null],
          ["YouTube stats", "green", "Public numbers, no sign-in", null],
          ["Instagram stats", "green", "Your numbers · 8,120 followers", null],
          ["Brand finder", "green", "Last run found 4 new, refreshed 11", null],
          ["Daily brand refresh", "green", "Ran this morning: 8 searches, 1 new brand", null],
          ["Monthly brief refresh", "green", "Next refresh on the 1st.", null],
          ["Weekly brief adjustment", "green", "Updated your numbers from 9 videos in the last 7 days.", null],
        ]
      : []),
  ];
  for (const [name, light, note, fix] of lights) out.push(`INSERT OR REPLACE INTO health (name, light, note, fix_guide, checked_at) VALUES (${q(name)}, ${q(light)}, ${q(note)}, ${q(fix)}, ${q(iso(T - 3600_000))});`);

  return { sql: out.join("\n"), stats, media };
}

// ---------------------------------------------------------------- CLI (local only)
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed-year.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  if (args.some((a) => a === "--remote" || a === "--remote-sample" || a.startsWith("--env"))) {
    process.stderr.write("seed-year: demo data goes only into the local database (never a studio).\n");
    process.exit(2);
  }
  const target = { db: "creator-studios-dev-db", wranglerArgs: ["--local"] };
  const before = args.includes("--before");
  const outIdx = args.indexOf("--out");
  const { sql, stats, media } = args.includes("--clear") ? { sql: clearYearSql(), stats: null, media: [] } : yearSql(new Date(), { before });
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], sql);
  if (args.includes("--apply") || args.includes("--clear")) {
    const dir = mkdtempSync(path.join(tmpdir(), "seed-year-"));
    const file = path.join(dir, "year.sql");
    writeFileSync(file, sql);
    // The local D1 can answer "internal error" while a just-started wrangler dev opens it: try again.
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync("npx", ["wrangler", "d1", "execute", target.db, ...target.wranglerArgs, "--file", file], { stdio: "pipe", env: { ...process.env, CI: "1" } });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        execFileSync("sleep", [String(attempt * 2)]);
      }
    }
  }
  if (stats) process.stdout.write(`${JSON.stringify({ ...stats, media: media.length })}\n`);
}
