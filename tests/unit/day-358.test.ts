// Day 358 (docs/reviews/2026-09-26-day-358.md; owner, 26 Sep 2026: "a way to dismiss dumps that
// are old or whatever and cards that are stacking up" + "account for space and storage and maybe
// do not keep them long"). The rules (tidy ages, file ages, the budget), then a YEAR of demo data
// (scripts/seed-year.mjs) on the real schema: Home never over its caps, archive + Undo everywhere,
// long lists paged with true counts, the daily lane clearing storage and NEVER deleting anything
// unposted without the warning first. Validators `home-caps` and `tidy-warns-first` read this file.
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { fakeServices } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { memoryR2 } from "./helpers/r2-memory";
import { briefArchiveDue, budgetPlan, clipFileAction, dealArchiveDue, dumpArchiveDue, FILES, STORAGE, storageLight, TIDY, voiceArchiveDue, type ClipFileFacts } from "@worker/domain/tidy";
import { clipFileRules, enforceBudget, measureStorage, storageHealth, storageReport, tidyDaily } from "@worker/lib/storage";
import { home } from "@worker/routes/home";
import { archive } from "@worker/routes/archive";
import { dumps } from "@worker/routes/dumps";
import { clips as clipsRoute } from "@worker/routes/clips";
import { posts } from "@worker/routes/posts";
import { voice } from "@worker/routes/voice";
import { deals } from "@worker/routes/deals";
import { research } from "@worker/routes/research";
import { HOME_CAPS } from "@shared/constants";
// @ts-expect-error plain JS module (scripts/seed-year.mjs), no types
import { yearSql } from "../../scripts/seed-year.mjs";
import { ownerCookie } from "./helpers/owner-session";

const DAY = 86400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

// ---------------------------------------------------------------- the rules

describe("tidy ages: archive, never delete", () => {
  it("a finished dump archives at 30 days; one with clips still to review never does", () => {
    const d = { status: "reviewed", created_at: ago(40), ready_at: ago(29.9), visible_drafts: 0 };
    expect(dumpArchiveDue(d, NOW)).toBe(false);
    expect(dumpArchiveDue({ ...d, ready_at: ago(30) }, NOW)).toBe(true);
    expect(dumpArchiveDue({ ...d, status: "ready", ready_at: ago(200), visible_drafts: 3 }, NOW)).toBe(false);
    expect(dumpArchiveDue({ ...d, status: "failed", ready_at: null, created_at: ago(31) }, NOW)).toBe(true);
    expect(dumpArchiveDue({ ...d, status: "cutting", ready_at: ago(90) }, NOW)).toBe(false);
  });
  it("deals: finished at 60 days, gone quiet at 90, an unpaid invoice never", () => {
    expect(dealArchiveDue({ stage: "done", closed_at: ago(59), paid_at: null, updated_at: ago(59) }, NOW)).toBeNull();
    expect(dealArchiveDue({ stage: "lost", closed_at: ago(60), paid_at: null, updated_at: ago(60) }, NOW)).toBe("finished");
    expect(dealArchiveDue({ stage: "follow_up", closed_at: null, paid_at: null, updated_at: ago(89) }, NOW)).toBeNull();
    expect(dealArchiveDue({ stage: "negotiating", closed_at: null, paid_at: null, updated_at: ago(90) }, NOW)).toBe("quiet");
    expect(dealArchiveDue({ stage: "invoiced", closed_at: null, paid_at: null, updated_at: ago(400) }, NOW)).toBeNull();
  });
  it("briefs a newer one replaced at 90 days; voice overs failed at 14, unused at 60, attached never", () => {
    expect(briefArchiveDue({ status: "superseded", created_at: ago(90) }, NOW)).toBe(true);
    expect(briefArchiveDue({ status: "approved", created_at: ago(900) }, NOW)).toBe(false);
    expect(voiceArchiveDue({ status: "failed", clip_id: null, created_at: ago(14) }, NOW)).toBe(true);
    expect(voiceArchiveDue({ status: "ready", clip_id: null, created_at: ago(59) }, NOW)).toBe(false);
    expect(voiceArchiveDue({ status: "ready", clip_id: null, created_at: ago(60) }, NOW)).toBe(true);
    expect(voiceArchiveDue({ status: "ready", clip_id: "c1", created_at: ago(600) }, NOW)).toBe(false);
  });
});

const facts = (o: Partial<ClipFileFacts>): ClipFileFacts => ({ status: "approved", full_video: 0, created_at: ago(100), file_deleted_at: null, last_posted_at: null, waiting_post: false, in_kit: false, keep_until: null, delete_warned_at: null, ...o });

describe("clip files: posted after 30 days, drafts after 60 with the warning first", () => {
  it("a posted clip's file goes 30 days after posting, unless it is in the kit or posting again", () => {
    expect(clipFileAction(facts({ last_posted_at: ago(29) }), NOW)).toEqual({ do: "keep" });
    expect(clipFileAction(facts({ last_posted_at: ago(30) }), NOW)).toEqual({ do: "delete", why: "posted" });
    expect(clipFileAction(facts({ last_posted_at: ago(300), in_kit: true }), NOW)).toEqual({ do: "keep", why: "kit" });
    expect(clipFileAction(facts({ last_posted_at: ago(300), waiting_post: true }), NOW)).toEqual({ do: "keep", why: "waiting" });
  });
  it("an approved clip waiting to post is kept forever", () => {
    expect(clipFileAction(facts({ created_at: ago(1000) }), NOW)).toEqual({ do: "keep", why: "approved" });
  });
  it("never deletes an unposted draft without the warning first (tidy-warns-first)", () => {
    const draft = facts({ status: "draft" });
    // 52 days: nothing yet; 53: the warning (7 days before 60)
    expect(clipFileAction({ ...draft, created_at: ago(52) }, NOW)).toEqual({ do: "keep" });
    expect(clipFileAction({ ...draft, created_at: ago(53) }, NOW).do).toBe("warn");
    // 300 days old but never warned: warned now, cleared no earlier than 7 days from now
    const late = clipFileAction({ ...draft, created_at: ago(300) }, NOW);
    expect(late.do).toBe("warn");
    expect(late.do === "warn" && Date.parse(late.deleteOn) - NOW.getTime()).toBeGreaterThanOrEqual(FILES.warnDays * DAY - 1000);
    // warned 6 days ago: still a warning; 7 days: cleared
    expect(clipFileAction({ ...draft, created_at: ago(300), delete_warned_at: ago(6) }, NOW).do).toBe("warn");
    expect(clipFileAction({ ...draft, created_at: ago(300), delete_warned_at: ago(7) }, NOW)).toEqual({ do: "delete", why: "draft" });
  });
  it("Keep moves the date 60 days out", () => {
    const kept = facts({ status: "draft", created_at: ago(300), keep_until: new Date(NOW.getTime() + FILES.keepDays * DAY).toISOString() });
    expect(clipFileAction(kept, NOW)).toEqual({ do: "keep" });
  });
  it("full videos and rejected clips keep their own rules here", () => {
    expect(clipFileAction(facts({ full_video: 1, status: "draft", created_at: ago(900) }), NOW)).toEqual({ do: "keep" });
    expect(clipFileAction(facts({ status: "rejected", created_at: ago(900) }), NOW)).toEqual({ do: "keep" });
  });
});

describe("the meter and the hard budget", () => {
  it("green, yellow at 70%, red at 90% of 10 GB", () => {
    expect(storageLight(STORAGE.limitBytes * 0.69)).toBe("green");
    expect(storageLight(STORAGE.limitBytes * 0.7)).toBe("yellow");
    expect(storageLight(STORAGE.limitBytes * 0.9)).toBe("red");
  });
  it("over budget: originals first, then rejected, then posted, oldest first, and it stops at the budget", () => {
    const GB = 1024 ** 3;
    const c = [
      { kind: "posted_clip" as const, id: "p1", bytes: 1 * GB, at: ago(10) },
      { kind: "raw" as const, id: "r2", bytes: 0.5 * GB, at: ago(2) },
      { kind: "raw" as const, id: "r1", bytes: 0.5 * GB, at: ago(5) },
      { kind: "rejected_clip" as const, id: "x1", bytes: 0.2 * GB, at: ago(3) },
    ];
    const plan = budgetPlan(STORAGE.budgetBytes + 0.8 * GB, c);
    expect(plan.clear.map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(plan.enough).toBe(true);
    const short = budgetPlan(STORAGE.budgetBytes + 5 * GB, c);
    expect(short.clear.map((x) => x.id)).toEqual(["r1", "r2", "x1", "p1"]);
    expect(short.enough).toBe(false);
    expect(budgetPlan(STORAGE.budgetBytes - 1, c).clear).toEqual([]);
  });
});

// ---------------------------------------------------------------- a year, on the real schema

const BASE = "http://w.example";
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("fake", fakeServices(c.env));
  c.set("user", { id: "usr_owner", email: "owner@example.com", role: "owner" } as Vars["user"]);
  await next();
});
app.route("/api/home", home);
app.route("/api/archive", archive);
app.route("/api/dumps", dumps);
app.route("/api/clips", clipsRoute);
app.route("/api/posts", posts);
app.route("/api/voice", voice);
app.route("/api/deals", deals);
app.route("/api/research", research);

let env: Env;
let db: ReturnType<typeof sqliteD1>;
let r2: ReturnType<typeof memoryR2>;
const one = <T>(sql: string, ...a: (string | number | null)[]) => db.raw.prepare(sql).get(...a) as T;
const n = (sql: string, ...a: (string | number | null)[]) => (db.raw.prepare(sql).get(...a) as { n: number }).n;
const call = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: await ownerCookie(env) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
};
type Section = { items: { key: string }[]; total: number };

beforeEach(() => {
  db = sqliteD1();
  r2 = memoryR2();
  env = { DB: db.DB, FILES: r2.FILES, OWNER_EMAIL: "owner@example.com", SESSION_SECRET: "s", SECRETS_KEY: "YcLVEjArFviauClfN6thsYumeyr3wqfUT9D2VnMNTm0=", APP_NAME: "Sample Studio", FAKE_SERVICES: "1", AUTH_MODE: "code", PUBLIC_BASE_URL: BASE, GITHUB_REPO: "example/studio-jobs" } as unknown as Env;
  db.raw.exec(yearSql(NOW).sql);
});

describe("the year loads: the demo data is what the review walked", () => {
  it("~50 dumps, ~600 clips, ~300 posts, 45 deals in every stage, 12 briefs, and storage near 10 GB", async () => {
    expect(n("SELECT COUNT(*) AS n FROM dumps")).toBe(50);
    expect(n("SELECT COUNT(*) AS n FROM clips")).toBeGreaterThan(550);
    expect(n("SELECT COUNT(*) AS n FROM posts")).toBeGreaterThan(250);
    expect(n("SELECT COUNT(DISTINCT stage) AS n FROM deals")).toBe(11);
    expect(n("SELECT COUNT(*) AS n FROM research_briefs")).toBe(12);
    expect(n("SELECT COUNT(*) AS n FROM narrations WHERE auto = 1")).toBeGreaterThan(20);
    const r = await storageReport(env);
    expect(r.used_bytes / STORAGE.limitBytes).toBeGreaterThan(0.85);
    expect(r.light).not.toBe("green");
  });
});

describe("Home never exceeds its caps (home-caps)", () => {
  it("every Home list is at most its cap, with the true total, on a year of data", async () => {
    const h = (await call<Record<string, unknown>>("GET", "/api/home")).json;
    for (const [key, cap] of Object.entries(HOME_CAPS)) {
      const s = h[key] as Section;
      expect(s, key).toBeTruthy();
      expect(s.items.length, key).toBeLessThanOrEqual(cap);
      expect(s.total, key).toBeGreaterThanOrEqual(s.items.length);
    }
    // the totals are true: every dump that is not archived or dismissed
    expect((h.recentDumps as Section).total).toBe(n("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NULL"));
    expect((h.recentDumps as Section).total).toBeGreaterThan(HOME_CAPS.recentDumps);
    expect((h.notices as Section).total).toBeGreaterThan(HOME_CAPS.notices);
  });
  it("dismiss hides a card from Home (the next one shows); Undo brings it back", async () => {
    const before = (await call<{ notices: Section; recentDumps: Section }>("GET", "/api/home")).json;
    const first = before.notices.items[0].key;
    expect((await call("POST", "/api/home/dismiss", { key: first })).status).toBe(200);
    const after = (await call<{ notices: Section; recentDumps: Section }>("GET", "/api/home")).json;
    expect(after.notices.items[0].key).not.toBe(first);
    expect(after.notices.total).toBe(before.notices.total - 1);
    const dump = before.recentDumps.items[0].key;
    await call("POST", "/api/home/dismiss", { key: dump });
    const afterDump = (await call<{ recentDumps: Section }>("GET", "/api/home")).json;
    expect(afterDump.recentDumps.items.map((x) => x.key)).not.toContain(dump);
    expect(afterDump.recentDumps.total).toBe(before.recentDumps.total - 1);
    await call("POST", "/api/home/restore", { key: first });
    await call("POST", "/api/home/restore", { key: dump });
    const back = (await call<{ notices: Section; recentDumps: Section }>("GET", "/api/home")).json;
    expect(back.notices.items[0].key).toBe(first);
    expect(back.recentDumps.total).toBe(before.recentDumps.total);
    expect((await call("POST", "/api/home/dismiss", { key: "<script>" })).status).toBe(400);
  });
});

describe("archive is not delete: one tap, Undo, Show archived, Restore", () => {
  it("a dump leaves Your dumps, waits under Show archived, and comes back", async () => {
    const list = (await call<{ items: { id: string }[]; total: number; archived: number }>("GET", "/api/dumps")).json;
    const id = list.items[0].id;
    expect((await call("POST", `/api/archive/dump/${id}`)).status).toBe(200);
    const after = (await call<{ items: { id: string }[]; total: number; archived: number }>("GET", "/api/dumps")).json;
    expect(after.items.map((d) => d.id)).not.toContain(id);
    expect(after.total).toBe(list.total - 1);
    expect(after.archived).toBe(list.archived + 1);
    const arch = (await call<{ items: { id: string }[] }>("GET", "/api/dumps?archived=1")).json;
    expect(arch.items.map((d) => d.id)).toContain(id);
    expect(n("SELECT COUNT(*) AS n FROM clips WHERE dump_id = ? AND status != 'deleted'", id)).toBeGreaterThan(0); // nothing deleted
    await call("POST", `/api/archive/dump/${id}/restore`);
    expect((await call<{ total: number }>("GET", "/api/dumps")).json.total).toBe(list.total);
  });
  it("a deal leaves Do this next and Home's follow-ups; Restore puts it back", async () => {
    const h = (await call<{ followups: { items: { key: string }[]; total: number } }>("GET", "/api/home")).json;
    const dealId = h.followups.items[0].key.split(":")[1];
    await call("POST", `/api/archive/deal/${dealId}`);
    const d = (await call<{ deals: { dealId: string }[]; dealsTotal: number; archivedTotal: number }>("GET", "/api/deals?all=1")).json;
    expect(d.deals.map((x) => x.dealId)).not.toContain(dealId);
    expect(d.archivedTotal).toBeGreaterThan(0);
    const h2 = (await call<{ followups: { total: number } }>("GET", "/api/home")).json;
    expect(h2.followups.total).toBe(h.followups.total - 1);
    await call("POST", `/api/archive/deal/${dealId}/restore`);
    expect((await call<{ followups: { total: number } }>("GET", "/api/home")).json.followups.total).toBe(h.followups.total);
  });
  it("research briefs and voice overs archive and restore; an unknown kind is refused", async () => {
    await call("POST", "/api/archive/brief/9101");
    const r = (await call<{ versions: { version: number }[]; archivedVersions: number }>("GET", "/api/research")).json;
    expect(r.versions.map((v) => v.version)).not.toContain(9101);
    expect(r.archivedVersions).toBe(1);
    const v = (await call<{ narrations: { id: string }[]; narrations_page: { total: number } }>("GET", "/api/voice")).json;
    await call("POST", `/api/archive/voice/${v.narrations[0].id}`);
    const v2 = (await call<{ narrations_page: { total: number; archived: number } }>("GET", "/api/voice")).json;
    expect(v2.narrations_page.total).toBe(v.narrations_page.total - 1);
    expect(v2.narrations_page.archived).toBe(1);
    await call("POST", `/api/archive/voice/${v.narrations[0].id}/restore`);
    expect((await call<{ narrations_page: { total: number } }>("GET", "/api/voice")).json.narrations_page.total).toBe(v.narrations_page.total);
    expect((await call("POST", "/api/archive/clip/x")).status).toBe(404);
    expect((await call("POST", "/api/archive/dump/nope")).status).toBe(404);
  });
});

describe("long lists page, search and filter; counts stay true", () => {
  it("Review: 12 at a time, total true, search by hook", async () => {
    const approved = n("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved'");
    const p1 = (await call<{ groups: { clips: { id: string }[] }[]; total: number; counts: { approved: number } }>("GET", "/api/clips?tab=approved")).json;
    const ids1 = p1.groups.flatMap((g) => g.clips.map((c) => c.id));
    expect(ids1).toHaveLength(12);
    expect(p1.total).toBe(approved);
    expect(p1.counts.approved).toBe(approved);
    const p2 = (await call<{ groups: { clips: { id: string }[] }[] }>("GET", "/api/clips?tab=approved&offset=12")).json;
    const ids2 = p2.groups.flatMap((g) => g.clips.map((c) => c.id));
    expect(ids2.some((x) => ids1.includes(x))).toBe(false);
    const q = (await call<{ total: number }>("GET", "/api/clips?tab=approved&q=napkin")).json;
    expect(q.total).toBe(n("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved' AND (hook_text LIKE '%napkin%' OR caption LIKE '%napkin%' OR hashtags LIKE '%napkin%')"));
    expect(q.total).toBeGreaterThan(0);
  });
  it("Dump: 20 at a time of 50, the filter and search count true", async () => {
    const d = (await call<{ items: unknown[]; total: number }>("GET", "/api/dumps")).json;
    expect(d.items).toHaveLength(20);
    expect(d.total).toBe(50);
    expect((await call<{ total: number }>("GET", "/api/dumps?status=failed")).json.total).toBe(3);
    expect((await call<{ total: number }>("GET", "/api/dumps?status=held")).json.total).toBe(2);
    expect((await call<{ total: number }>("GET", "/api/dumps?q=Easter")).json.total).toBe(n("SELECT COUNT(*) AS n FROM dumps WHERE notes LIKE '%Easter%'"));
  });
  it("Calendar history: every post that already happened, paged, with true counts", async () => {
    const h = (await call<{ items: unknown[]; total: number; counts: { posted: number; failed: number } }>("GET", "/api/posts/history")).json;
    expect(h.items).toHaveLength(20);
    expect(h.counts.posted).toBe(n("SELECT COUNT(*) AS n FROM posts WHERE status = 'posted'"));
    expect(h.counts.failed).toBe(n("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed'"));
    expect((await call<{ total: number }>("GET", "/api/posts/history?status=failed")).json.total).toBe(h.counts.failed);
  });
  it("Deals: Do this next capped with its true total; Closed a page at a time", async () => {
    const d = (await call<{ deals: unknown[]; dealsTotal: number; closed: unknown[]; closedTotal: number }>("GET", "/api/deals")).json;
    expect(d.deals.length).toBeLessThanOrEqual(8);
    expect(d.dealsTotal).toBeGreaterThan(d.deals.length);
    expect((await call<{ deals: unknown[] }>("GET", "/api/deals?all=1")).json.deals).toHaveLength(d.dealsTotal);
    expect(d.closedTotal).toBe(n("SELECT COUNT(*) AS n FROM deals WHERE stage IN ('declined','lost') AND archived_at IS NULL"));
  });
});

describe("the daily lane on day 358: storage back under control, nothing unposted lost unwarned", () => {
  it("posted clip files go (not kit clips), covers stay, drafts are warned not deleted, then cleared a week later", async () => {
    const kit = (JSON.parse(one<{ content: string }>("SELECT content FROM media_kit_versions ORDER BY version DESC LIMIT 1").content).showcase as string[])[0];
    const oldPosted = one<{ id: string; cover_r2_key: string }>(
      "SELECT c.id, c.cover_r2_key FROM clips c WHERE c.status = 'approved' AND c.id != ? AND EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted' AND p.posted_at < ?) AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('planned','in_buffer')) LIMIT 1",
      kit,
      ago(31),
    );
    await r2.FILES.put(oldPosted.cover_r2_key, new Uint8Array(10));
    const draftsBefore = n("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND full_video = 0");
    const waitingBefore = n("SELECT COUNT(*) AS n FROM clips c WHERE status = 'approved' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')");
    const usedBefore = (await storageReport(env)).used_bytes;

    await measureStorage(env);
    const r = await clipFileRules(env, NOW);
    expect(r.posted).toBeGreaterThan(100);
    expect(r.drafts).toBe(0); // first day: warned, never deleted
    expect(r.warned).toBeGreaterThan(0);
    expect(one<{ file_deleted_at: string | null }>("SELECT file_deleted_at FROM clips WHERE id = ?", oldPosted.id).file_deleted_at).not.toBeNull();
    expect(one<{ file_deleted_at: string | null }>("SELECT file_deleted_at FROM clips WHERE id = ?", kit).file_deleted_at).toBeNull();
    expect(r2.objects.has(oldPosted.cover_r2_key)).toBe(true); // the cover stays
    expect(n("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND full_video = 0")).toBe(draftsBefore);
    // Home says which drafts go and when; Keep is one tap
    const h = (await call<{ notices: { items: { kind: string }[]; total: number } }>("GET", "/api/home")).json;
    expect(h.notices.total).toBeGreaterThan(0);
    await storageHealth(env);
    expect((await storageReport(env)).used_bytes).toBeLessThan(usedBefore - 2 * 1024 ** 3);

    // a week later: the warned drafts go (the warning showed 7 days); approved clips waiting to post never
    db.raw.prepare("UPDATE clips SET delete_warned_at = ? WHERE delete_warned_at IS NOT NULL").run(ago(7));
    const later = await clipFileRules(env, NOW);
    expect(later.drafts).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) AS n FROM clips c WHERE status = 'approved' AND file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')")).toBe(waitingBefore);
    // no draft was ever deleted without a warning at least 7 days old
    expect(n("SELECT COUNT(*) AS n FROM clips WHERE file_deleted_at IS NOT NULL AND full_video = 0 AND status = 'deleted' AND (delete_warned_at IS NULL OR delete_warned_at > ?)", ago(7))).toBe(0);
  });
  it("Keep: the warned drafts are kept 60 more days and their warning starts over", async () => {
    await clipFileRules(env, NOW);
    const warned = n("SELECT COUNT(*) AS n FROM clips WHERE delete_warned_at IS NOT NULL");
    expect(warned).toBeGreaterThan(0);
    const k = (await call<{ kept: number }>("POST", "/api/clips/keep", {})).json;
    expect(k.kept).toBe(warned);
    expect(n("SELECT COUNT(*) AS n FROM clips WHERE delete_warned_at IS NOT NULL")).toBe(0);
    db.raw.prepare("UPDATE clips SET delete_warned_at = ? WHERE keep_until IS NOT NULL").run(ago(30)); // even an old warning
    expect((await clipFileRules(env, NOW)).drafts).toBe(0); // kept: not due until keep_until
  });
  it("the hard budget clears only originals, rejected and posted clips; never waiting, kit or drafts", async () => {
    // make the waiting clips and drafts huge: the budget cannot get under by the allowed kinds
    db.raw.prepare("UPDATE clips SET file_bytes = 200 * 1048576 WHERE status IN ('draft','approved') AND file_deleted_at IS NULL AND full_video = 0").run();
    const waiting = n("SELECT COUNT(*) AS n FROM clips c WHERE status = 'approved' AND file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')");
    const drafts = n("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND file_deleted_at IS NULL");
    const b = await enforceBudget(env, NOW);
    expect(b.cleared).toBeGreaterThan(0);
    expect(b.enough).toBe(false);
    expect(n("SELECT COUNT(*) AS n FROM clips c WHERE status = 'approved' AND file_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status = 'posted')")).toBe(waiting);
    expect(n("SELECT COUNT(*) AS n FROM clips WHERE status = 'draft' AND file_deleted_at IS NULL")).toBe(drafts);
    const h = await storageHealth(env);
    expect(h.light).toBe("red");
    expect(one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'Storage'")).toEqual({ light: "red", fix_guide: "storage-almost-full" });
  });
  it("tidy archives what is finished (and never deletes); off = nothing moves", async () => {
    const clipsBefore = n("SELECT COUNT(*) AS n FROM clips");
    const t = await tidyDaily(env, NOW);
    expect(t!.dumps).toBeGreaterThan(20);
    expect(t!.deals).toBeGreaterThan(5);
    expect(t!.briefs).toBeGreaterThan(5);
    expect(n("SELECT COUNT(*) AS n FROM clips")).toBe(clipsBefore);
    expect(n("SELECT COUNT(*) AS n FROM deals WHERE stage = 'invoiced' AND archived_at IS NOT NULL")).toBe(0);
    // Home's lists after tidy: short, and still capped
    const h = (await call<{ recentDumps: Section; followups: Section }>("GET", "/api/home")).json;
    expect(h.recentDumps.total).toBeLessThan(15);
    db.raw.exec("UPDATE dumps SET archived_at = NULL, archived_by = NULL; UPDATE settings SET value = '{\"on\":false}' WHERE key = 'tidy'");
    expect(await tidyDaily(env, NOW)).toBeNull();
    expect(n("SELECT COUNT(*) AS n FROM dumps WHERE archived_at IS NOT NULL")).toBe(0);
    expect(TIDY.dumpArchiveDays).toBe(30);
  });
});
