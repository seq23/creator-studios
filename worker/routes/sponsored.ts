// Get it sponsored (owner-approved mock-up, 23 Oct 2026): a page inside Brand deals, opened from
// the card at the top of it. She types an experience (a business studio: an event); the $0
// sponsor job (worker/jobs/sponsor.ts, jobs/sponsor.py) finds the brands, videos and to-do list.
// "Pitch this brand" opens a deal with the first email written; she sends every pitch herself.
//   GET    /api/sponsored                       her experiences (newest first, paged, true total)
//   POST   /api/sponsored                       {title, whenMonth, who, notes} → start the research
//   GET    /api/sponsored/film?from&to          "To film" days for Calendar
//   POST   /api/sponsored/film/:fid/done        filmed it (or undo with {done:false})
//   GET    /api/sponsored/:id                   one experience: status, progress, rules, brands, videos, to-do
//   POST   /api/sponsored/:id/run               Run it again / Try again (keeps ticks, hidden cards, pitches)
//   POST   /api/sponsored/:id/brands/:key/pitch the brand + a drafted first email into Deals
//   POST   /api/sponsored/:id/brands/:key/hide  {hidden} "Not for me" (brought back any time)
//   POST   /api/sponsored/:id/ticks             {id, done}
//   POST   /api/sponsored/:id/calendar          {videoId, day} a day to film it, on Calendar
//   POST   /api/sponsored/:id/archive           {archived} nothing is deleted
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { dispatchJob } from "../services/github";
import { brandKey, contactProblem, offLimitsTerms, violatesOffLimits, type ContactKind } from "../domain/brandfit";
import { lockedProfile } from "./mediakit";
import { openPitch, type C } from "./deals";
import { sponsorKind, storedResult } from "../jobs/sponsor";
import { MEDICAL_RULES, isMedical, monthLabel, pitchBy, todoPlan, validMonth, type SponsorAskView, type SponsorBrand, type SponsorResult } from "@shared/sponsored";

export const sponsored = new Hono<{ Bindings: Env; Variables: Vars }>();
sponsored.use("*", requireUser);

export const SPONSOR_PAGE = 20;

interface AskDb {
  id: string;
  title: string;
  when_month: string;
  who: string;
  notes: string;
  medical: number;
  status: "researching" | "ready" | "failed";
  result: string | null;
  ticks: string;
  hidden: string;
  pitched: string;
  job_id: string | null;
  safe_error: string | null;
  ready_at: string | null;
  archived_at: string | null;
  created_at: string;
}
const COLS = "id, title, when_month, who, notes, medical, status, result, ticks, hidden, pitched, job_id, safe_error, ready_at, archived_at, created_at";

const today = () => nowIso().slice(0, 10);
const askById = (env: Env, id: string) => env.DB.prepare(`SELECT ${COLS} FROM sponsor_asks WHERE id = ?`).bind(id).first<AskDb>();

function planOf(env: Env, a: AskDb) {
  return todoPlan({ whenMonth: a.when_month, today: (a.created_at || nowIso()).slice(0, 10), medical: !!a.medical, kind: sponsorKind(env), title: a.title });
}

function viewOf(env: Env, a: AskDb): SponsorAskView {
  const result = storedResult(a.result);
  const hidden = new Set(parseJson<string[]>(a.hidden, []));
  return {
    id: a.id,
    title: a.title,
    whenMonth: a.when_month,
    whenLabel: monthLabel(a.when_month),
    who: a.who,
    notes: a.notes,
    medical: !!a.medical,
    status: a.status,
    error: a.status === "failed" ? a.safe_error ?? "The search didn't finish. Tap Try again." : null,
    readyAt: a.ready_at,
    createdAt: a.created_at,
    counts: {
      brands: result ? result.brands.filter((b) => !hidden.has(b.key)).length : 0,
      videos: result?.videos.length ?? 0,
      todo: result ? planOf(env, a).length + result.todo.length : 0,
    },
    pitchBy: result ? (result.firstMove?.by ?? pitchBy({ whenMonth: a.when_month, today: a.created_at.slice(0, 10), medical: !!a.medical, kind: sponsorKind(env), title: a.title })) : null,
  };
}

/** A job that failed or was reaped without telling us: the experience says so (never "researching" forever). */
async function settle(env: Env, a: AskDb): Promise<AskDb> {
  if (a.status !== "researching" || !a.job_id) return a;
  const job = await env.DB.prepare("SELECT status, safe_error FROM jobs WHERE id = ?").bind(a.job_id).first<{ status: string; safe_error: string | null }>();
  if (job?.status !== "failed") return a;
  const err = "The search didn't finish. Nothing was lost. Tap Try again.";
  await env.DB.prepare("UPDATE sponsor_asks SET status = 'failed', safe_error = ?, updated_at = ? WHERE id = ?").bind(err, nowIso(), a.id).run();
  return { ...a, status: "failed", safe_error: err };
}

async function start(env: Env, askId: string): Promise<{ ok: boolean; error: string | null }> {
  const job = await dispatchJob(env, "sponsor", askId);
  if (!job.dispatched) {
    await env.DB.prepare("UPDATE sponsor_asks SET status = 'failed', job_id = ?, safe_error = ?, updated_at = ? WHERE id = ?").bind(job.jobId, "The search could not start. Tap Try again in a minute.", nowIso(), askId).run();
    return { ok: false, error: job.error };
  }
  await env.DB.prepare("UPDATE sponsor_asks SET status = 'researching', job_id = ?, safe_error = NULL, updated_at = ? WHERE id = ?").bind(job.jobId, nowIso(), askId).run();
  return { ok: true, error: null };
}

sponsored.get("/", async (c) => {
  const archived = c.req.query("archived") === "1";
  const offset = Math.max(0, Math.floor(Number(c.req.query("offset")) || 0));
  const where = archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sponsor_asks WHERE ${where}`).first<{ n: number }>())?.n ?? 0;
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM sponsor_asks WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(SPONSOR_PAGE, offset).all<AskDb>();
  const settled = await Promise.all(results.map((a) => settle(c.env, a)));
  const archivedTotal = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sponsor_asks WHERE archived_at IS NOT NULL").first<{ n: number }>())?.n ?? 0;
  return c.json({ kind: sponsorKind(c.env), today: today(), asks: settled.map((a) => viewOf(c.env, a)), total, archivedTotal, profileLocked: !!(await lockedProfile(c.env)) });
});

sponsored.post("/", async (c) => {
  const body = await readJson<{ title?: string; whenMonth?: string; who?: string; notes?: string }>(c);
  const title = (body?.title ?? "").replace(/\s+/g, " ").trim();
  if (title.length < 3) return fail(c, 400, "Type what you want sponsored, in a few words.", "get-it-sponsored");
  if (title.length > 160) return fail(c, 400, "Keep it short: one line is plenty.", "get-it-sponsored");
  const whenMonth = validMonth(body?.whenMonth) ? body!.whenMonth! : "";
  const who = (body?.who ?? "").trim().slice(0, 60);
  const notes = (body?.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const id = newId("spn");
  await c.env.DB.prepare("INSERT INTO sponsor_asks (id, title, when_month, who, notes, medical) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, title, whenMonth, who, notes, isMedical(title, notes) ? 1 : 0)
    .run();
  await recordEvent(c.env.DB, "sponsor.asked", id, {}, c.get("user").email);
  const r = await start(c.env, id);
  log.info("sponsor.asked", { started: r.ok });
  return c.json({ id, started: r.ok });
});

// ---------- To film (Calendar)

sponsored.get("/film", async (c) => {
  const from = /^\d{4}-\d\d-\d\d$/.test(c.req.query("from") ?? "") ? c.req.query("from")! : today();
  const to = /^\d{4}-\d\d-\d\d$/.test(c.req.query("to") ?? "") ? c.req.query("to")! : from;
  const { results } = await c.env.DB.prepare("SELECT id, day, title, note, ask_id, done_at FROM film_plans WHERE day >= ? AND day <= ? ORDER BY day, created_at").bind(from, to).all<{ id: string; day: string; title: string; note: string; ask_id: string | null; done_at: string | null }>();
  return c.json({ items: results.map((r) => ({ id: r.id, day: r.day, title: r.title, note: r.note, askId: r.ask_id, done: !!r.done_at })) });
});

sponsored.post("/film/:fid/done", async (c) => {
  const body = await readJson<{ done?: boolean }>(c);
  const done = body?.done !== false;
  const r = await c.env.DB.prepare("UPDATE film_plans SET done_at = ? WHERE id = ?").bind(done ? nowIso() : null, c.req.param("fid")).run();
  if (!r.meta.changes) return fail(c, 404, "That day is no longer on your Calendar.");
  return c.json({ ok: true, done });
});

// ---------- one experience

sponsored.get("/:id", async (c) => {
  const row = await askById(c.env, c.req.param("id"));
  if (!row) return fail(c, 404, "That one is gone. Go back to Get it sponsored.", "get-it-sponsored");
  const a = await settle(c.env, row);
  const result = storedResult(a.result);
  const job = a.job_id ? await c.env.DB.prepare("SELECT status, progress, created_at FROM jobs WHERE id = ?").bind(a.job_id).first<{ status: string; progress: string | null; created_at: string }>() : null;
  const { results: film } = await c.env.DB.prepare("SELECT id, day, title FROM film_plans WHERE ask_id = ? ORDER BY day").bind(a.id).all<{ id: string; day: string; title: string }>();
  return c.json({
    kind: sponsorKind(c.env),
    ask: viewOf(c.env, a),
    // Medical or cosmetic: the rules box shows FIRST, the fixed rules then anything the research added.
    rules: a.medical ? [...MEDICAL_RULES, ...(result?.rules ?? [])] : [],
    result,
    plan: result ? [...planOf(c.env, a), ...result.todo] : [],
    ticks: parseJson<Record<string, string>>(a.ticks, {}),
    hidden: parseJson<string[]>(a.hidden, []),
    pitched: parseJson<Record<string, string>>(a.pitched, {}),
    film,
    job: job ? { status: job.status, progress: parseJson(job.progress, null), startedAt: job.created_at } : null,
    profileLocked: !!(await lockedProfile(c.env)),
  });
});

sponsored.post("/:id/run", async (c) => {
  const a = await askById(c.env, c.req.param("id"));
  if (!a) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  if (a.status === "researching") {
    const job = a.job_id ? await c.env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(a.job_id).first<{ status: string }>() : null;
    if (job && ["queued", "dispatched", "running"].includes(job.status)) return c.json({ ok: true, already: true });
  }
  const r = await start(c.env, a.id);
  if (!r.ok) return fail(c, 502, "The search could not start just now. Try again in a minute.", "get-it-sponsored");
  return c.json({ ok: true });
});

async function brandOf(c: C, id: string, key: string): Promise<{ a: AskDb; result: SponsorResult; b: SponsorBrand } | Response> {
  const a = await askById(c.env, id);
  if (!a) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  const result = storedResult(a.result);
  const b = result?.brands.find((x) => x.key === key);
  if (!result || !b) return fail(c, 404, "That brand is no longer in this list. Tap Run it again.", "get-it-sponsored");
  return { a, result, b };
}

/** The brand into her Deals: an existing brand is reused, its public way in kept with its page. */
async function upsertBrand(c: C, b: SponsorBrand): Promise<string | Response> {
  const key = brandKey({ name: b.name, website: b.website });
  const { results: existing } = await c.env.DB.prepare("SELECT id, name, website FROM brands").all<{ id: string; name: string; website: string | null }>();
  const dup = existing.find((x) => brandKey(x) === key);
  let id: string;
  if (dup) {
    id = dup.id;
    await c.env.DB.prepare("UPDATE brands SET status = 'saved' WHERE id = ? AND status = 'hidden'").bind(id).run();
  } else {
    const profile = await lockedProfile(c.env);
    const hit = violatesOffLimits({ name: b.name, website: b.website }, offLimitsTerms(profile?.off_limits));
    if (hit) return fail(c, 422, `"${hit}" is on your off-limits list in your Brand Profile, so this brand can't be added.`, "get-it-sponsored");
    id = newId("brd");
    const fit = b.fit === "best" ? 0.85 : b.fit === "good" ? 0.7 : 0.55;
    await c.env.DB.prepare(
      "INSERT INTO brands (id, name, website, program_url, fit_score, fit_reasons, why_now, source_links, origin, status, kind, budget_signal, why_sourced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finder', 'saved', 'brand', ?, ?)",
    )
      .bind(
        id,
        b.name,
        b.website,
        b.wayIn.kind === "form" ? b.wayIn.value : null,
        fit,
        JSON.stringify([b.why || b.what].filter(Boolean)),
        b.firstStep,
        JSON.stringify(b.proof.map((p) => p.url)),
        JSON.stringify({ level: "likely", evidence: b.proof }),
        JSON.stringify(b.proof.slice(0, 2)),
      )
      .run();
  }
  if (b.wayIn.kind !== "none" && b.wayIn.value && b.wayIn.foundOn) {
    const kind: ContactKind = b.wayIn.kind === "email" ? "role_email" : "form";
    const cand = { kind, value: b.wayIn.value, found_on_url: b.wayIn.foundOn };
    const has = await c.env.DB.prepare("SELECT id FROM brand_contacts WHERE brand_id = ? AND value = ?").bind(id, cand.value).first();
    if (!has && !contactProblem(cand)) {
      await c.env.DB.prepare("INSERT INTO brand_contacts (id, brand_id, kind, value, found_on_url) VALUES (?, ?, ?, ?, ?)").bind(newId("bct"), id, cand.kind, cand.value, cand.found_on_url).run();
    }
  }
  return id;
}

/** The idea the first email leads with: her experience, its month, and the video for this brand. */
export function pitchIdea(a: Pick<AskDb, "title" | "when_month">, b: SponsorBrand, result: SponsorResult): string {
  const video = result.videos.find((v) => v.forBrand && v.forBrand.toLowerCase() === b.name.toLowerCase());
  const when = validMonth(a.when_month) ? ` in ${monthLabel(a.when_month)}` : "";
  const how = video ? `, filmed as “${video.title}” and clearly labelled` : ", with honest, clearly labelled videos of it";
  return `${b.name} sponsoring my ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}${when}${how}`.slice(0, 300);
}

sponsored.post("/:id/brands/:key/pitch", async (c) => {
  const got = await brandOf(c, c.req.param("id"), c.req.param("key"));
  if (got instanceof Response) return got;
  const { a, result, b } = got;
  const pitched = parseJson<Record<string, string>>(a.pitched, {});
  const brandId = await upsertBrand(c, b);
  if (brandId instanceof Response) return brandId;
  const res = await openPitch(c, brandId, { idea: pitchIdea(a, b, result), from: "sponsored" });
  if (!res.ok) return res;
  const j = (await res.json()) as { dealId: string; emailId: string | null; note: string | null };
  pitched[b.key] = j.dealId;
  await c.env.DB.prepare("UPDATE sponsor_asks SET pitched = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(pitched), nowIso(), a.id).run();
  log.info("sponsor.pitched", { way_in: b.wayIn.kind });
  return c.json({ dealId: j.dealId, emailId: j.emailId, note: j.note, needsWayIn: b.wayIn.kind === "none" });
});

sponsored.post("/:id/brands/:key/hide", async (c) => {
  const a = await askById(c.env, c.req.param("id"));
  if (!a) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  const body = await readJson<{ hidden?: boolean }>(c);
  const key = c.req.param("key");
  const hidden = new Set(parseJson<string[]>(a.hidden, []));
  if (body?.hidden === false) hidden.delete(key);
  else hidden.add(key);
  await c.env.DB.prepare("UPDATE sponsor_asks SET hidden = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify([...hidden]), nowIso(), a.id).run();
  return c.json({ ok: true, hidden: [...hidden] });
});

sponsored.post("/:id/ticks", async (c) => {
  const a = await askById(c.env, c.req.param("id"));
  if (!a) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  const body = await readJson<{ id?: string; done?: boolean }>(c);
  const tid = (body?.id ?? "").trim();
  if (!/^[a-z0-9_-]{1,24}$/i.test(tid)) return fail(c, 400, "Pick a line to tick.");
  const ticks = parseJson<Record<string, string>>(a.ticks, {});
  if (body?.done === false) delete ticks[tid];
  else ticks[tid] = today();
  await c.env.DB.prepare("UPDATE sponsor_asks SET ticks = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(ticks), nowIso(), a.id).run();
  return c.json({ ok: true, ticks });
});

sponsored.post("/:id/calendar", async (c) => {
  const a = await askById(c.env, c.req.param("id"));
  if (!a) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  const body = await readJson<{ videoId?: string; day?: string }>(c);
  const video = storedResult(a.result)?.videos.find((v) => v.id === body?.videoId);
  if (!video) return fail(c, 404, "That video idea is no longer here. Tap Run it again.", "get-it-sponsored");
  const day = body?.day ?? "";
  if (!/^20\d\d-\d\d-\d\d$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return fail(c, 400, "Pick the day you will film it.");
  const id = newId("flm");
  const note = [`Hook: ${video.hook}`, video.shots.length ? `Shots: ${video.shots.join(" · ")}` : ""].filter(Boolean).join("\n");
  await c.env.DB.prepare("INSERT INTO film_plans (id, day, title, note, ask_id) VALUES (?, ?, ?, ?, ?)").bind(id, day, video.title, note, a.id).run();
  return c.json({ ok: true, id, day });
});

sponsored.post("/:id/archive", async (c) => {
  const body = await readJson<{ archived?: boolean }>(c);
  const on = body?.archived !== false;
  const r = await c.env.DB.prepare("UPDATE sponsor_asks SET archived_at = ?, updated_at = ? WHERE id = ?").bind(on ? nowIso() : null, nowIso(), c.req.param("id")).run();
  if (!r.meta.changes) return fail(c, 404, "That one is gone.", "get-it-sponsored");
  return c.json({ ok: true, archived: on });
});
