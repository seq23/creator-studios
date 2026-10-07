// Research Brief (BUILD_PLAN.md section 6).
//   GET   /api/research            newest brief (truth rules applied) + versions + uploads + job
//   POST  /api/research/refresh    start the research job (needs a locked Brand Profile)
//   POST  /api/research/approve    approve the newest draft; the previous approved → superseded
//   PATCH /api/research            edit the newest draft's sections (truth rules re-applied)
//   DELETE /api/research/uploads/:id  remove an outside report
// Outside reports upload through /api/uploads with kind "research_upload".
// The gate that stops cutting until a brief is approved lives in routes/dumps.ts briefGate().
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { getConnectionSecret } from "../lib/connections";
import { parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { dispatchJob } from "../services/github";
import type { BriefBody, BriefSource, BriefView } from "@shared/types";
import { briefCounts, enforceTruth, shapeProblems, WEB_SKIPPED_SOURCE_ID } from "../domain/brief";

export const research = new Hono<{ Bindings: Env; Variables: Vars }>();
research.use("*", requireUser);

interface BriefDb {
  version: number;
  body: string;
  sources: string;
  status: BriefView["status"];
  approved_at: string | null;
  created_at: string;
}

/** Every brief leaves the Worker with the truth rules applied: uncited → uncertain. */
function toView(r: BriefDb): BriefView {
  const sources = parseJson<BriefSource[]>(r.sources, []);
  const body = enforceTruth(parseJson<BriefBody>(r.body, { audience: [], themes: [], hooks: [], cut_styles: [], best_times: { tiktok: [], instagram: [], youtube: [] }, comparable_creators: [], shot_list: [] }), sources);
  return { version: r.version, body, sources, status: r.status, approved_at: r.approved_at, created_at: r.created_at };
}

const COLS = "version, body, sources, status, approved_at, created_at";

research.get("/", async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM research_briefs WHERE status != 'superseded' ORDER BY version DESC LIMIT 1`).first<BriefDb>();
  // Day 358: old briefs are archived (a tap, or the tidy rules at 90 days); "Show archived" lists them.
  const archived = c.req.query("archived") === "1";
  const { results: versions } = await c.env.DB.prepare(`SELECT version, status, approved_at, created_at, archived_at FROM research_briefs WHERE ${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"} ORDER BY version DESC LIMIT 50`).all();
  const archivedTotal = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM research_briefs WHERE archived_at IS NOT NULL").first<{ n: number }>())?.n ?? 0;
  const { results: uploads } = await c.env.DB.prepare("SELECT id, file_name, uploaded_at FROM research_uploads ORDER BY uploaded_at DESC").all();
  const job = await c.env.DB.prepare("SELECT id, status, safe_error, created_at, finished_at FROM jobs WHERE type = 'research' ORDER BY created_at DESC LIMIT 1").first();
  const approved = await c.env.DB.prepare("SELECT version, approved_at FROM research_briefs WHERE status = 'approved' ORDER BY version DESC LIMIT 1").first<{ version: number; approved_at: string }>();
  const profileLocked = !!(await c.env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first());
  const brief = row ? toView(row) : null;
  return c.json({
    brief,
    counts: brief ? briefCounts(brief.body, brief.sources) : null,
    webSkipped: brief ? brief.sources.some((s) => s.id === WEB_SKIPPED_SOURCE_ID) : false,
    approved: approved ?? null,
    versions,
    archivedVersions: archivedTotal,
    uploads,
    job,
    profileLocked,
    firecrawlConnected: !!(await getConnectionSecret(c.env, "firecrawl")),
  });
});

research.post("/refresh", async (c) => {
  const profile = await c.env.DB.prepare("SELECT version FROM brand_profile WHERE locked = 1 LIMIT 1").first();
  if (!profile) return fail(c, 409, "Lock your Brand Profile first. The research starts from it.", "upload-brand-docs");
  const running = await c.env.DB.prepare("SELECT id FROM jobs WHERE type = 'research' AND status IN ('queued', 'dispatched', 'running') AND created_at > ? LIMIT 1")
    .bind(new Date(Date.now() - 45 * 60_000).toISOString())
    .first<{ id: string }>();
  if (running) return c.json({ ok: true, jobId: running.id, already: true });
  if (!c.get("fake") && !(await getConnectionSecret(c.env, "openrouter"))) return fail(c, 409, "Connect the AI (OpenRouter) first; it writes the brief.", "connect-openrouter");
  const r = await dispatchJob(c.env, "research", null);
  if (!r.dispatched) return fail(c, 502, r.error ?? "The research could not start.", "approve-research-brief");
  await recordEvent(c.env.DB, "brief.refresh", r.jobId, {}, c.get("user").email);
  log.info("research.refresh");
  return c.json({ ok: true, jobId: r.jobId });
});

research.post("/approve", async (c) => {
  const draft = await c.env.DB.prepare("SELECT version FROM research_briefs WHERE status = 'draft' ORDER BY version DESC LIMIT 1").first<{ version: number }>();
  if (!draft) return fail(c, 409, "There is no new draft to approve. Press Refresh research to make one.", "approve-research-brief");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE research_briefs SET status = 'superseded' WHERE status = 'approved'"),
    c.env.DB.prepare("UPDATE research_briefs SET status = 'approved', approved_at = ? WHERE version = ?").bind(now, draft.version),
  ]);
  await recordEvent(c.env.DB, "brief.approved", String(draft.version), {}, c.get("user").email);
  log.info("research.approved");
  return c.json({ ok: true, version: draft.version, approved_at: now });
});

research.patch("/", async (c) => {
  const body = await readJson<{ body?: unknown }>(c);
  const draft = await c.env.DB.prepare(`SELECT ${COLS} FROM research_briefs WHERE status = 'draft' ORDER BY version DESC LIMIT 1`).first<BriefDb>();
  if (!draft) return fail(c, 409, "Only a draft can be edited. Press Refresh research for a new draft.", "approve-research-brief");
  const problems = shapeProblems(body?.body);
  if (problems.length) return fail(c, 422, "That edit could not be saved; reload the page and try again.");
  const sources = parseJson<BriefSource[]>(draft.sources, []);
  const next = enforceTruth(body!.body as BriefBody, sources);
  await c.env.DB.prepare("UPDATE research_briefs SET body = ? WHERE version = ?").bind(JSON.stringify(next), draft.version).run();
  await recordEvent(c.env.DB, "brief.edited", String(draft.version), {}, c.get("user").email);
  return c.json({ ok: true, brief: toView({ ...draft, body: JSON.stringify(next) }) });
});

research.delete("/uploads/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM research_uploads WHERE id = ?").bind(c.req.param("id")).first<{ r2_key: string }>();
  if (!row) return fail(c, 404, "That report is no longer here.");
  await c.env.FILES.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM research_uploads WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
