// Client Brain (BUILD_PLAN.md section 5): her brand docs and the Brand Profile.
//
// Docs upload through /api/uploads with kind "brand_doc" (inserts brand_docs as pending). Then:
//   POST   /api/brain/extract                 read every doc not read yet (one extract job)
//   POST   /api/brain/docs/:id/extract        read (or re-read) one doc
//   DELETE /api/brain/docs/:id                remove a doc, its file and its extracted text
// Extracted text lives only in R2 at brain/text/<doc_id>.txt; D1 keeps a character count.
//
// Profile (versions kept; the locked version is what every AI step reads):
//   GET    /api/brain                         docs + current profile + versions + running job
//   POST   /api/brain/profile/draft           draft from all read docs (Worker model call when the
//                                             text is small, else the extract job drafts)
//   PATCH  /api/brain/profile                 her edits → new version (source "edited")
//   POST   /api/brain/profile/lock | unlock
//   POST   /api/brain/profile/rollback/:v     copy version v → new version (source "rollback")
// Rule: the profile only changes while unlocked, and only the newest version can be locked.
import { monthlyNicheRefresh, nicheView } from "../lib/niche";
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { getConnectionSecret } from "../lib/connections";
import { getSetting, parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { PAST_READ_KEY, type PastVideosRead } from "../jobs/pastvideos";
import { PAST_VIDEOS_MAX, PAST_VIDEOS_MIN } from "@shared/constants";
import { PROFILE_IN_USE } from "../lib/profileInUse";
import { researchAfterLock } from "../lib/setupWait";
import { sendWaitingDumps } from "./dumps";
import { dispatchJob } from "../services/github";
import { getLlm } from "../services/openrouter";
import type { BrandDocRow, BrandProfileView } from "@shared/types";
import { cleanSections, FAKE_PROFILE, keepVideoFeel, filledCount, parseProfileAnswer, PROFILE_SYSTEM, profileUserPrompt, WORKER_DRAFT_MAX_CHARS } from "../domain/profile";
import { markExtracting, textKey } from "../jobs/extract";

export const brain = new Hono<{ Bindings: Env; Variables: Vars }>();
brain.use("*", requireUser);

interface ProfileDb {
  version: number;
  sections: string;
  locked: number;
  locked_at: string | null;
  source: BrandProfileView["source"];
  created_at: string;
}

const toView = (r: ProfileDb): BrandProfileView => ({ version: r.version, sections: cleanSections(parseJson(r.sections, {})), locked: !!r.locked, locked_at: r.locked_at, source: r.source, created_at: r.created_at });

async function latest(env: Env): Promise<ProfileDb | null> {
  return env.DB.prepare("SELECT version, sections, locked, locked_at, source, created_at FROM brand_profile ORDER BY version DESC LIMIT 1").first<ProfileDb>();
}

async function latestJob(env: Env) {
  return env.DB.prepare("SELECT id, status, ref_id, safe_error, created_at FROM jobs WHERE type = 'extract' ORDER BY created_at DESC LIMIT 1").first<{ id: string; status: string; ref_id: string | null; safe_error: string | null; created_at: string }>();
}

brain.get("/", async (c) => {
  const { results: docs } = await c.env.DB.prepare(
    "SELECT id, file_name, mime_type, size_bytes, extract_status, extract_error, uploaded_at, char_count FROM brand_docs ORDER BY uploaded_at DESC",
  ).all<BrandDocRow & { char_count: number | null }>();
  const cur = await latest(c.env);
  const { results: versions } = await c.env.DB.prepare("SELECT version, locked, locked_at, source, created_at FROM brand_profile ORDER BY version DESC LIMIT 30").all<Omit<ProfileDb, "sections">>();
  const job = await latestJob(c.env);
  return c.json({
    docs,
    profile: cur ? toView(cur) : null,
    pastVideos: await pastVideosView(c.env),
    inUse: (await c.env.DB.prepare(`SELECT version, locked_at FROM brand_profile ${PROFILE_IN_USE}`).first<{ version: number; locked_at: string | null }>()) ?? null,
    versions: versions.map((v) => ({ ...v, locked: !!v.locked })),
    job,
    totalChars: docs.filter((d) => d.extract_status === "done").reduce((s, d) => s + (d.char_count ?? 0), 0),
  });
});

async function startExtract(env: Env, refId: string, actor: string) {
  const n = await markExtracting(env, refId === "draft_profile" ? "pending" : refId);
  const r = await dispatchJob(env, "extract", refId);
  if (!r.dispatched) {
    await env.DB.prepare("UPDATE brand_docs SET extract_status = 'failed', extract_error = ? WHERE extract_status = 'extracting'").bind("Reading could not start. Press Try again in a minute.").run();
    return { ok: false as const, error: r.error };
  }
  await recordEvent(env.DB, "brain.extract", refId, { docs: n }, actor);
  log.info("brain.extract", { docs: n });
  return { ok: true as const, jobId: r.jobId, docs: n };
}

brain.post("/extract", async (c) => {
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM brand_docs WHERE extract_status = 'pending'").first<{ n: number }>();
  if (!pending?.n) return c.json({ ok: true, jobId: null, docs: 0 });
  const r = await startExtract(c.env, "pending", c.get("user").email);
  if (!r.ok) return fail(c, 502, r.error ?? "Reading your docs could not start.", "upload-brand-docs");
  return c.json(r);
});

brain.post("/docs/:id/extract", async (c) => {
  const id = c.req.param("id");
  const doc = await c.env.DB.prepare("SELECT id, r2_key FROM brand_docs WHERE id = ?").bind(id).first<{ id: string; r2_key: string }>();
  if (!doc) return fail(c, 404, "That doc is no longer here.");
  if (!(await c.env.FILES.head(doc.r2_key))) {
    await c.env.DB.prepare("UPDATE brand_docs SET extract_status = 'unreadable', extract_error = ? WHERE id = ?").bind("The upload didn't finish. Remove this file and upload it again.", id).run();
    return fail(c, 409, "The upload didn't finish. Remove this file and upload it again.", "upload-brand-docs");
  }
  await c.env.DB.prepare("UPDATE brand_docs SET extract_status = 'pending', extract_error = NULL WHERE id = ?").bind(id).run();
  const r = await startExtract(c.env, id, c.get("user").email);
  if (!r.ok) return fail(c, 502, r.error ?? "Reading this doc could not start.", "upload-brand-docs");
  return c.json(r);
});

brain.delete("/docs/:id", async (c) => {
  const id = c.req.param("id");
  const doc = await c.env.DB.prepare("SELECT r2_key FROM brand_docs WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!doc) return fail(c, 404, "That doc is no longer here.");
  await c.env.FILES.delete([doc.r2_key, textKey(id)]);
  await c.env.DB.prepare("DELETE FROM brand_docs WHERE id = ?").bind(id).run();
  await recordEvent(c.env.DB, "brain.doc_removed", id, {}, c.get("user").email);
  return c.json({ ok: true });
});

brain.get("/profile", async (c) => {
  const cur = await latest(c.env);
  const { results } = await c.env.DB.prepare("SELECT version, sections, locked, locked_at, source, created_at FROM brand_profile ORDER BY version DESC LIMIT 30").all<ProfileDb>();
  return c.json({ current: cur ? toView(cur) : null, versions: results.map(toView) });
});

async function refuseIfLocked(env: Env): Promise<string | null> {
  const cur = await latest(env);
  return cur?.locked ? "Your profile is locked. Press Unlock to edit it; the AI keeps using the locked version until you lock again." : null;
}

brain.post("/profile/draft", async (c) => {
  const locked = await refuseIfLocked(c.env);
  if (locked) return fail(c, 409, locked, "upload-brand-docs");
  const { results: docs } = await c.env.DB.prepare("SELECT id, char_count FROM brand_docs WHERE extract_status = 'done' ORDER BY uploaded_at").all<{ id: string; char_count: number | null }>();
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM brand_docs WHERE extract_status IN ('pending', 'extracting')").first<{ n: number }>();
  if (!docs.length && !pending?.n) return fail(c, 409, "Upload at least one brand doc first, then we can draft your profile.", "upload-brand-docs");
  const total = docs.reduce((s, d) => s + (d.char_count ?? 0), 0);

  // Big piles of text (or docs still waiting to be read) are drafted by the extract job.
  if (total > WORKER_DRAFT_MAX_CHARS || pending?.n) {
    const r = await startExtract(c.env, "draft_profile", c.get("user").email);
    if (!r.ok) return fail(c, 502, r.error ?? "Drafting could not start.", "upload-brand-docs");
    return c.json({ ok: true, queued: true, jobId: r.jobId });
  }

  let sections;
  if (c.get("fake")) {
    sections = FAKE_PROFILE;
  } else {
    if (!(await getConnectionSecret(c.env, "openrouter"))) return fail(c, 409, "Connect the AI (OpenRouter) first; it writes the draft.", "connect-openrouter");
    const texts: { n: number; text: string }[] = [];
    for (const [i, d] of docs.entries()) {
      const obj = await c.env.FILES.get(textKey(d.id));
      if (obj) texts.push({ n: i + 1, text: await obj.text() });
    }
    if (!texts.length) return fail(c, 409, "We couldn't find the text of your docs. Press Try again on each doc.", "upload-brand-docs");
    const llm = await getLlm(c.env);
    const answer = await llm.complete({ system: PROFILE_SYSTEM, user: profileUserPrompt(texts), json: true, maxTokens: 2500, accept: (t) => !!parseProfileAnswer(t) });
    if (!answer.ok) return fail(c, 502, answer.error ?? "The AI did not answer. Try again in a minute.", "reconnect-openrouter");
    sections = parseProfileAnswer(answer.text);
    if (!sections) return fail(c, 502, "The AI's draft came back incomplete. Press Draft again.", "upload-brand-docs");
  }
  const prev = await latest(c.env);
  sections = keepVideoFeel(sections, prev ? cleanSections(parseJson(prev.sections, {})) : null);
  const res = await c.env.DB.prepare("INSERT INTO brand_profile (sections, locked, source) VALUES (?, 0, 'draft')").bind(JSON.stringify(sections)).run();
  await recordEvent(c.env.DB, "profile.drafted", String(res.meta.last_row_id), { via: "worker", filled: filledCount(sections) }, c.get("user").email);
  log.info("profile.drafted", { filled: filledCount(sections) });
  return c.json({ ok: true, queued: false, version: res.meta.last_row_id });
});

brain.patch("/profile", async (c) => {
  const locked = await refuseIfLocked(c.env);
  if (locked) return fail(c, 409, locked, "upload-brand-docs");
  const body = await readJson<{ sections?: Record<string, unknown> }>(c);
  if (!body?.sections || typeof body.sections !== "object") return fail(c, 400, "Nothing to save.");
  const cur = await latest(c.env);
  const merged = cleanSections({ ...(cur ? parseJson<Record<string, unknown>>(cur.sections, {}) : {}), ...body.sections });
  const res = await c.env.DB.prepare("INSERT INTO brand_profile (sections, locked, source) VALUES (?, 0, 'edited')").bind(JSON.stringify(merged)).run();
  await recordEvent(c.env.DB, "profile.edited", String(res.meta.last_row_id), {}, c.get("user").email);
  return c.json({ ok: true, version: res.meta.last_row_id });
});

// ---- Learn from my past videos (owner's plan, 23 Oct 2026; worker/jobs/pastvideos.ts) ----
// Her 3 to 10 old FINISHED videos upload through /api/uploads with kind "past_video" (R2
// pastvideos/, never footage, never cut). "Watch my videos" starts the pastvideos job, which writes
// "How my videos feel" into a new unlocked version of the profile.

async function pastVideosView(env: Env) {
  const { results: files } = await env.DB.prepare("SELECT id, file_name, size_bytes, upload_status, read_at, created_at FROM past_videos WHERE upload_status != 'aborted' ORDER BY created_at").all<{ id: string; file_name: string; size_bytes: number; upload_status: string; read_at: string | null; created_at: string }>();
  const job = await env.DB.prepare("SELECT id, status, progress, safe_error, created_at FROM jobs WHERE type = 'pastvideos' ORDER BY created_at DESC LIMIT 1").first<{ id: string; status: string; progress: string | null; safe_error: string | null; created_at: string }>();
  return {
    files,
    job: job ? { ...job, progress: parseJson(job.progress, null) } : null,
    read: await getSetting<PastVideosRead | null>(env.DB, PAST_READ_KEY, null),
    min: PAST_VIDEOS_MIN,
    max: PAST_VIDEOS_MAX,
  };
}

const pastRunning = (env: Env) =>
  env.DB.prepare("SELECT id FROM jobs WHERE type = 'pastvideos' AND status IN ('queued', 'dispatched', 'running') AND created_at > ? LIMIT 1")
    .bind(new Date(Date.now() - 90 * 60_000).toISOString())
    .first<{ id: string }>();

brain.post("/past-videos/read", async (c) => {
  const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM past_videos WHERE upload_status = 'uploaded'").first<{ n: number }>())?.n ?? 0;
  if (n < PAST_VIDEOS_MIN) return fail(c, 409, `Add at least ${PAST_VIDEOS_MIN} of your past videos first (you have ${n}).`, "learn-from-past-videos");
  const running = await pastRunning(c.env);
  if (running) return c.json({ ok: true, jobId: running.id, already: true });
  // $0 always: the free models when a key is there, else the job's own rules write the section.
  const r = await dispatchJob(c.env, "pastvideos", null);
  if (!r.dispatched) return fail(c, 502, r.error ?? "Watching your videos could not start. Try again in a minute.", "learn-from-past-videos");
  await recordEvent(c.env.DB, "brain.past_videos", r.jobId, { videos: n }, c.get("user").email);
  log.info("brain.past_videos", { videos: n });
  return c.json({ ok: true, jobId: r.jobId });
});

brain.delete("/past-videos/:id", async (c) => {
  if (await pastRunning(c.env)) return fail(c, 409, "Your videos are being watched right now. Remove it once that is done.", "learn-from-past-videos");
  const row = await c.env.DB.prepare("SELECT r2_key FROM past_videos WHERE id = ? AND upload_status != 'aborted'").bind(c.req.param("id")).first<{ r2_key: string }>();
  if (!row) return fail(c, 404, "That video is no longer here.");
  // Only when she taps Remove: the file goes, the row stays as a record.
  await c.env.FILES.delete(row.r2_key);
  await c.env.DB.prepare("UPDATE past_videos SET upload_status = 'aborted' WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

brain.post("/profile/lock", async (c) => {
  const cur = await latest(c.env);
  if (!cur) return fail(c, 409, "Draft your profile first, then lock it.", "upload-brand-docs");
  if (filledCount(cleanSections(parseJson(cur.sections, {}))) < 3) return fail(c, 422, "Fill in at least a few sections before locking.", "upload-brand-docs");
  await c.env.DB.batch([
    // locked_at stays on older versions as history (lib/profileInUse.ts); only this one is locked.
    c.env.DB.prepare("UPDATE brand_profile SET locked = 0 WHERE version != ?").bind(cur.version),
    c.env.DB.prepare("UPDATE brand_profile SET locked = 1, locked_at = ? WHERE version = ?").bind(nowIso(), cur.version),
  ]);
  await recordEvent(c.env.DB, "profile.locked", String(cur.version), {}, c.get("user").email);
  // Setup runs by itself: the research starts (no Refresh to press), and if the brief is already
  // approved every dump waiting for setup goes now.
  const research = await researchAfterLock(c.env, c.get("fake"), c.get("user").email);
  // The niche research is redone for the new profile at once (clip quality, 23 Oct 2026); never blocks the lock.
  await monthlyNicheRefresh(c.env).catch(() => log.warn("brain.niche_refresh_failed", {}));
  const sent = await sendWaitingDumps(c.env, c.get("user").email);
  return c.json({ ok: true, version: cur.version, researchStarted: !!(research && research.ok && !research.already), researchJobId: research && research.ok ? research.jobId : null, sent: sent.length });
});

brain.post("/profile/unlock", async (c) => {
  // locked_at is kept: while she edits, the clips keep using the version she locked last.
  await c.env.DB.prepare("UPDATE brand_profile SET locked = 0 WHERE locked = 1").run();
  await recordEvent(c.env.DB, "profile.unlocked", null, {}, c.get("user").email);
  return c.json({ ok: true });
});

brain.post("/profile/rollback/:version", async (c) => {
  const locked = await refuseIfLocked(c.env);
  if (locked) return fail(c, 409, locked, "upload-brand-docs");
  const v = Number(c.req.param("version"));
  const old = await c.env.DB.prepare("SELECT sections FROM brand_profile WHERE version = ?").bind(v).first<{ sections: string }>();
  if (!old) return fail(c, 404, "That version is no longer here.");
  const res = await c.env.DB.prepare("INSERT INTO brand_profile (sections, locked, source) VALUES (?, 0, 'rollback')").bind(old.sections).run();
  await recordEvent(c.env.DB, "profile.rollback", String(res.meta.last_row_id), { from: v }, c.get("user").email);
  return c.json({ ok: true, version: res.meta.last_row_id });
});

/** "What's working in your niche" (studio fix): the newest monthly research, in plain lines. */
brain.get("/niche", async (c) => c.json(await nicheView(c.env)));
