// Her originals' clean-up (owner, 20 Nov 2026): cleared RAW_RETENTION_DAYS after their clips are
// ready, emailed 14 and 3 days ahead with Download all / Keep them, a note when done; never a kept
// dump, never one still being cut, never unwarned (worker/domain/retention.ts, worker/lib/retention.ts).
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clearDate, originalsToken, readOriginalsToken, retentionStep, type RetentionDump } from "@worker/domain/retention";
import { originalsRetention } from "@worker/lib/retention";
import { originals } from "@worker/routes/originals";
import { RAW_RETENTION_DAYS } from "@shared/constants";
import { BASE_URL, harness } from "./helpers/studio-fix-env";

const DAY = 86400_000;
const READY = "2026-10-01T12:00:00.000Z";
const at = (days: number) => new Date(Date.parse(READY) + days * DAY);
const dump = (x: Partial<RetentionDump> = {}): RetentionDump => ({ id: "d", status: "ready", ready_at: READY, kept: 0, open_job: 0, sent14: null, sent3: null, ...x });

describe("the rule (pure)", () => {
  it("warns 14 days ahead, then 3 days ahead, then clears on the day", () => {
    expect(retentionStep(dump(), at(RAW_RETENTION_DAYS - 15)).do).toBe("none");
    expect(retentionStep(dump(), at(RAW_RETENTION_DAYS - 14))).toEqual({ do: "warn14", clears: at(RAW_RETENTION_DAYS).toISOString() });
    const sent14 = at(RAW_RETENTION_DAYS - 14).toISOString();
    expect(retentionStep(dump({ sent14 }), at(RAW_RETENTION_DAYS - 4)).do).toBe("none");
    expect(retentionStep(dump({ sent14 }), at(RAW_RETENTION_DAYS - 3)).do).toBe("warn3");
    const sent3 = at(RAW_RETENTION_DAYS - 3).toISOString();
    expect(retentionStep(dump({ sent14, sent3 }), at(RAW_RETENTION_DAYS - 0.5)).do).toBe("none");
    expect(retentionStep(dump({ sent14, sent3 }), at(RAW_RETENTION_DAYS))).toEqual({ do: "clear" });
  });

  it("a dump already past its day still gets the full 14 and 3 days from its first email", () => {
    const now = at(RAW_RETENTION_DAYS + 40);
    expect(retentionStep(dump(), now)).toEqual({ do: "warn14", clears: new Date(now.getTime() + 14 * DAY).toISOString() });
    const sent14 = now.toISOString();
    expect(retentionStep(dump({ sent14 }), new Date(now.getTime() + 10 * DAY)).do).toBe("none");
    expect(retentionStep(dump({ sent14 }), new Date(now.getTime() + 11 * DAY)).do).toBe("warn3");
    const sent3 = new Date(now.getTime() + 11 * DAY).toISOString();
    expect(retentionStep(dump({ sent14, sent3 }), new Date(now.getTime() + 13.9 * DAY)).do).toBe("none");
    expect(retentionStep(dump({ sent14, sent3 }), new Date(now.getTime() + 14 * DAY)).do).toBe("clear");
    // Never without the 3-day email, however late.
    expect(retentionStep(dump({ sent14 }), new Date(now.getTime() + 400 * DAY)).do).toBe("warn3");
  });

  it("never a kept dump, one still being cut, or one with a cut job open", () => {
    const late = at(RAW_RETENTION_DAYS + 100);
    const warned = { sent14: at(0).toISOString(), sent3: at(1).toISOString() };
    expect(retentionStep(dump({ ...warned }), late).do).toBe("clear");
    expect(retentionStep(dump({ ...warned, kept: 1 }), late)).toEqual({ do: "none", why: "kept" });
    expect(retentionStep(dump({ ...warned, open_job: 1 }), late)).toEqual({ do: "none", why: "open" });
    for (const status of ["uploading", "queued", "cutting", "failed"]) expect(retentionStep(dump({ ...warned, status }), late).do).toBe("none");
    expect(clearDate(dump({ kept: 1 }))).toBeNull();
  });
});

async function studio(extra = {}) {
  const h = await harness(extra);
  await h.dumpWith("dmp_r", [
    { id: "ast_r1", name: "IMG_1.MOV", mime: "video/quicktime", exif: 1 },
    { id: "ast_r2", name: "IMG_2.jpg", mime: "image/jpeg", exif: 1 },
  ]);
  await h.cut("dmp_r", undefined, 2);
  // The cut finished (the job callback marks it done; worker/crons/reapJobs.ts fails a stuck one).
  h.db.raw.exec(`UPDATE dumps SET ready_at = '${READY}' WHERE id = 'dmp_r'; UPDATE jobs SET status = 'done' WHERE ref_id = 'dmp_r'`);
  const page = new Hono().route("/originals", originals as unknown as Hono);
  const open = (p: string, method = "GET") => page.request(`${BASE_URL}${p}`, { method }, h.env);
  const emails = () => h.all<{ subject: string; ref_id: string }>("SELECT subject, ref_id FROM emails_sent WHERE kind = 'heads_up' ORDER BY sent_at, rowid");
  const stored = async () => [await h.r2.FILES.head("raw/dmp_r/ast_r1"), await h.r2.FILES.head("raw/dmp_r/ast_r2")].filter(Boolean).length;
  return { h, open, emails, stored };
}

describe("the daily clean-up on a real studio", () => {
  it("warns twice by email, the link downloads, then clears and says so; clips stay", async () => {
    const { h, open, emails, stored } = await studio();
    const clipsBefore = h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = 'dmp_r' AND status != 'deleted'").n;
    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 15))).warned14).toBe(0);
    const r14 = await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 14));
    expect(r14).toMatchObject({ checked: 1, warned14: 1, cleared_files: 0 });
    expect(emails().map((e) => e.subject)).toEqual([expect.stringMatching(/^Your original files clear in 14 days \(/)]);
    // Once only.
    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 13))).warned14).toBe(0);
    // The email's link: the files, a Download all, a Keep; each file downloads.
    const batch = emails()[0].ref_id;
    const link = `/originals/${await originalsToken(h.env.SESSION_SECRET, batch)}`;
    expect(await readOriginalsToken(h.env.SESSION_SECRET, link.split("/")[2])).toBe(batch);
    const pageHtml = await (await open(link)).text();
    expect(pageHtml).toContain("Download all");
    expect(pageHtml).toContain("IMG_1.MOV");
    expect(pageHtml).toContain("Keep them");
    const file = await open(`${link}/file/ast_r1`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="IMG_1.MOV"');
    expect((await file.arrayBuffer()).byteLength).toBe(100);
    // A forged link opens nothing.
    expect((await open(`/originals/${batch}.${"0".repeat(32)}`)).status).toBe(404);

    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 3))).warned3).toBe(1);
    expect(emails()[1].subject).toMatch(/^Your original files clear in 3 days/);
    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 1))).cleared_files).toBe(0);
    expect(await stored()).toBe(2);
    const done = await originalsRetention(h.env, at(RAW_RETENTION_DAYS));
    expect(done).toMatchObject({ cleared_dumps: 1, cleared_files: 2, cleared_bytes: 0 });
    expect(await stored()).toBe(0);
    expect(emails()[2].subject).toBe("Your original files were cleared");
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM assets WHERE dump_id = 'dmp_r' AND raw_deleted_at IS NOT NULL").n).toBe(2);
    expect(h.one<{ n: number }>("SELECT COUNT(*) AS n FROM clips WHERE dump_id = 'dmp_r' AND status != 'deleted'").n).toBe(clipsBefore);
    // Nothing more to do, no more emails.
    expect(await originalsRetention(h.env, at(RAW_RETENTION_DAYS + 30))).toMatchObject({ checked: 0, cleared_files: 0 });
    expect(emails()).toHaveLength(3);
    expect((await open(`${link}/file/ast_r1`)).status).toBe(404);
  });

  it("Keep them from the email link: never cleared", async () => {
    const { h, open, emails, stored } = await studio();
    await originalsRetention(h.env, at(RAW_RETENTION_DAYS - 14));
    const link = `/originals/${await originalsToken(h.env.SESSION_SECRET, emails()[0].ref_id)}`;
    expect((await open(`${link}/keep`, "POST")).status).toBe(200);
    expect(await (await open(link)).text()).toContain("These files will not be cleared");
    for (const d of [-3, 0, 30, 400]) await originalsRetention(h.env, at(RAW_RETENTION_DAYS + d));
    expect(await stored()).toBe(2);
    expect(emails()).toHaveLength(1);
  });

  it("a dump with a cut job running is never cleared", async () => {
    const { h, stored } = await studio();
    h.db.raw.exec(`INSERT INTO file_notices (dump_id, stage, batch_id, sent_at) VALUES ('dmp_r', '14', 'fnb_aaaaaaaa', '${at(0).toISOString()}'), ('dmp_r', '3', 'fnb_bbbbbbbb', '${at(1).toISOString()}')`);
    h.db.raw.exec("UPDATE jobs SET status = 'running' WHERE ref_id = 'dmp_r'");
    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS + 5))).cleared_files).toBe(0);
    expect(await stored()).toBe(2);
    h.db.raw.exec("UPDATE jobs SET status = 'done' WHERE ref_id = 'dmp_r'");
    expect((await originalsRetention(h.env, at(RAW_RETENTION_DAYS + 5))).cleared_files).toBe(2);
  });

  it("NAMED STOP: with no studio email nothing is warned or cleared, and the light says why", async () => {
    const { h, stored } = await studio({ FAKE_SERVICES: "0", PRACTICE: ["resend"] });
    const r = await originalsRetention(h.env, at(RAW_RETENTION_DAYS + 200));
    expect(r).toMatchObject({ paused: true, warned14: 0, cleared_files: 0 });
    expect(await stored()).toBe(2);
    expect(h.one<{ light: string; fix_guide: string }>("SELECT light, fix_guide FROM health WHERE name = 'File clean-up'")).toEqual({ light: "yellow", fix_guide: "setup-email" });
  });
});
