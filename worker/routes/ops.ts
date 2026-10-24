// The host developer's signed operations (23 Oct 2026): what an agent working for the host needs to
// do on a live studio without a browser login. Each call is signed like a job call, with the
// studio's own JOB_SHARED_SECRET (a 0600 file on the host's Mac, a GitHub secret for the jobs),
// over "ops:<body>" so a job signature can never be replayed here, and is valid for 10 minutes.
// Two actions:
//   start-over  the studio's own Start over (optionally with a "Change" pick first): its New clips
//               go, approved/posted/rejected clips and her uploads stay, the same code path as the button.
//               `node scripts/studio.mjs start-over <slug> <dumpId> [--service=…] [--shape=…]`
//   finish-cut  a dump whose latest cut SAVED its clips but was then marked failed (a callback that
//               timed out after the save): back to ready with nothing deleted, and the cut's own
//               follow-on (light, "Clips ready" email, editors, voice overs) run (worker/jobs/cut.ts
//               cutFollowOn). Refuses a dump whose clips were not saved by its latest cut.
//               `node scripts/studio.mjs finish-cut <slug> <dumpId>`
import { Hono, type Context } from "hono";
import type { Env, Vars } from "../env";
import { verifyJobMessage } from "../lib/crypto";
import { fail } from "../lib/http";
import { parseJson, recordEvent } from "../lib/db";
import { cutFollowOn, FOLLOW_ON_BUILT_IN, savedByThisJob } from "../jobs/cut";
import { log } from "../lib/log";
import { cleanOverride, type PlanOverride } from "@shared/looksLike";
import { servicesOf } from "@shared/services";
import { startOver } from "./dumps";
import { PROFILE_IN_USE } from "../lib/profileInUse";

export const ops = new Hono<{ Bindings: Env; Variables: Vars }>();

export const OPS_ACTOR = "host developer (signed)";

type OpsContext = Context<{ Bindings: Env; Variables: Vars }>;

/** The signed body, or null after answering 401. */
async function signedBody(c: OpsContext): Promise<string | null> {
  const text = await c.req.text();
  const ok = c.env.JOB_SHARED_SECRET ? await verifyJobMessage(c.env.JOB_SHARED_SECRET, `ops:${text}`, c.req.header("x-ops-timestamp") ?? null, c.req.header("x-ops-signature") ?? null) : false;
  if (!ok) {
    log.warn("ops.refused", {});
    return null;
  }
  return text;
}

ops.post("/start-over", async (c) => {
  const text = await signedBody(c);
  if (text === null) return fail(c, 401, "Bad signature.");
  const body = parseJson<{ dump_id?: string; service?: string; shape?: string }>(text, {});
  const id = String(body.dump_id ?? "");
  if (!id) return fail(c, 400, "Which dump?");
  if (body.service || body.shape) {
    const profile = await c.env.DB.prepare(`SELECT sections FROM brand_profile ${PROFILE_IN_USE}`).first<{ sections: string }>();
    const pick = cleanOverride({ service: body.service, shape: body.shape }, servicesOf(profile ? parseJson<Record<string, string>>(profile.sections, {}) : null));
    if ((body.service && !pick.service) || (body.shape && !pick.shape)) return fail(c, 400, "That service or shape is not one this studio knows.");
    const now = await c.env.DB.prepare("SELECT plan_override FROM dumps WHERE id = ?").bind(id).first<{ plan_override: string | null }>();
    await c.env.DB.prepare("UPDATE dumps SET plan_override = ? WHERE id = ?").bind(JSON.stringify({ ...parseJson<PlanOverride>(now?.plan_override ?? null, {}), ...pick }), id).run();
  }
  c.set("user", { id: "ops", email: OPS_ACTOR, role: "owner" } as Vars["user"]);
  return startOver(c, id, "", "dump.start_over");
});

ops.post("/finish-cut", async (c) => {
  const text = await signedBody(c);
  if (text === null) return fail(c, 401, "Bad signature.");
  const id = String(parseJson<{ dump_id?: string }>(text, {}).dump_id ?? "");
  if (!id) return fail(c, 400, "Which dump?");
  const job = await c.env.DB.prepare("SELECT id FROM jobs WHERE type = 'cut' AND ref_id = ? ORDER BY created_at DESC LIMIT 1").bind(id).first<{ id: string }>();
  const dump = await c.env.DB.prepare("SELECT status, follow_on_pending FROM dumps WHERE id = ?").bind(id).first<{ status: string; follow_on_pending: number }>();
  if (!dump || !job) return fail(c, 404, "No such dump, or it was never cut.");
  if (dump.status !== "failed" && dump.status !== "ready") return fail(c, 409, "This dump is not finished cutting.");
  if (dump.status === "failed") {
    // Exactly the state a saved cut leaves (the dump's own columns were written in the same batch as
    // its clips); checked through the same test onFailure uses, with the status set back first.
    await c.env.DB.prepare("UPDATE dumps SET status = 'ready' WHERE id = ? AND status = 'failed'").bind(id).run();
    if (!(await savedByThisJob(c.env, job.id, id))) {
      await c.env.DB.prepare("UPDATE dumps SET status = 'failed' WHERE id = ? AND status = 'ready'").bind(id).run();
      return fail(c, 409, "Its latest cut did not save its clips: use start-over.");
    }
    await c.env.DB.prepare("UPDATE dumps SET error_summary = NULL, follow_on_pending = CASE WHEN follow_on_pending = 0 THEN ? ELSE follow_on_pending END WHERE id = ?").bind(FOLLOW_ON_BUILT_IN, id).run();
  }
  await recordEvent(c.env.DB, "dump.finish_cut", id, { was: dump.status }, OPS_ACTOR);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN hidden = 0 AND style_of IS NULL THEN 1 ELSE 0 END) AS visible FROM clips WHERE dump_id = ? AND status = 'draft'").bind(id).first<{ n: number; visible: number | null }>();
  log.info("ops.finish_cut", { was: dump.status, clips: Number(n?.n ?? 0) });
  const work = () => cutFollowOn(c.env, id, { reclaim: true }).then(() => undefined);
  try {
    c.executionCtx.waitUntil(work().catch(() => log.warn("ops.finish_cut.follow_on_failed", {})));
  } catch {
    await work(); // no execution context (unit tests)
  }
  return c.json({ ok: true, was: dump.status, clips: Number(n?.n ?? 0), visible: Number(n?.visible ?? 0) });
});
