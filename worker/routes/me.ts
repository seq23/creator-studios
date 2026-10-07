// GET /api/me: who is using the dashboard, in both auth modes. The app reads this on load:
// in open mode it is always the owner (no login); in code mode a missing session is a 401 and
// the app shows the login page. Lives outside /api/auth because open mode 404s that whole prefix.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { meFor, requireUser } from "../lib/auth";

export const me = new Hono<{ Bindings: Env; Variables: Vars }>();
me.use("*", requireUser);

me.get("/", async (c) => c.json(await meFor(c.env, c.get("user"))));
