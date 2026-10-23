// The host developer's signed operations (23 Oct 2026): what an agent working for the host needs to
// do on a live studio without a browser login. Each call is signed like a job call, with the
// studio's own JOB_SHARED_SECRET (a 0600 file on the host's Mac, a GitHub secret for the jobs),
// over "ops:<body>" so a job signature can never be replayed here, and is valid for 10 minutes.
// Only one action, the studio's own Start over (optionally with a "Change" pick first): its New
// clips go, approved/posted/rejected clips and her uploads stay, the same code path as the button.
// Run it with `node scripts/studio.mjs start-over <slug> <dumpId> [--service=…] [--shape=…]`.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { verifyJobMessage } from "../lib/crypto";
import { fail } from "../lib/http";
import { parseJson } from "../lib/db";
import { log } from "../lib/log";
import { cleanOverride, type PlanOverride } from "@shared/looksLike";
import { servicesOf } from "@shared/services";
import { startOver } from "./dumps";
import { PROFILE_IN_USE } from "../lib/profileInUse";

export const ops = new Hono<{ Bindings: Env; Variables: Vars }>();

export const OPS_ACTOR = "host developer (signed)";

ops.post("/start-over", async (c) => {
  const text = await c.req.text();
  const ok = c.env.JOB_SHARED_SECRET ? await verifyJobMessage(c.env.JOB_SHARED_SECRET, `ops:${text}`, c.req.header("x-ops-timestamp") ?? null, c.req.header("x-ops-signature") ?? null) : false;
  if (!ok) {
    log.warn("ops.refused", {});
    return fail(c, 401, "Bad signature.");
  }
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
