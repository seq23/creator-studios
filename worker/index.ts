// Creator Studios Worker (one per studio, studios/<slug>.json): API under /api, media links under
// /media, the studio's theme at /studio-theme.css, the React app from static assets for everything
// else, and three cron lanes. Every request and cron tick first reads the studio's stored keys
// (worker/lib/practice.ts hydrate): encrypted storage first, then Worker secrets.
import { Hono } from "hono";
import type { Env, Vars } from "./env";
import { envName, fakeServices, studioSlug } from "./env";
import { hydrate, practice } from "./lib/practice";
import { drainPracticeJobs } from "./services/github";
import { log, safeError } from "./lib/log";
import { auth } from "./routes/auth";
import { studio, themeCss } from "./routes/studio";
import { setup } from "./routes/setup";
import { me } from "./routes/me";
import { home } from "./routes/home";
import { dumps } from "./routes/dumps";
import { uploads } from "./routes/uploads";
import { jobs } from "./routes/jobs";
import { settings } from "./routes/settings";
import { connections } from "./routes/connections";
import { clips } from "./routes/clips";
import { posts } from "./routes/posts";
import { brain } from "./routes/brain";
import { research } from "./routes/research";
import { stats } from "./routes/stats";
import { voice } from "./routes/voice";
import { deals } from "./routes/deals";
import { mediakit } from "./routes/mediakit";
import { help } from "./routes/help";
import { media } from "./routes/media";
import { oauth } from "./routes/oauth";
import { editing } from "./routes/editing";
import { archive } from "./routes/archive";
import { publicRoutes } from "./routes/public";
import { kitPage } from "./routes/kitpage";
import { legal } from "./routes/legal";
import { runCron } from "./crons/index";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", async (c, next) => {
  // "fake": the AI writer runs on its stand-in (local fakes, or OpenRouter still in practice mode).
  c.set("fake", fakeServices(c.env) || practice(c.env, "openrouter"));
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

app.get("/healthz", (c) => c.json({ ok: true, fake: fakeServices(c.env), env: envName(c.env), studio: studioSlug(c.env), login: "code" }));

// ROUTE LEDGER (collision slot): every route module is mounted here, one line each.
// scripts/validators/routes-mounted.mjs checks that every file in worker/routes is mounted.
app.route("/api/auth", auth);
app.route("/api/studio", studio);
app.route("/api/setup", setup);
app.route("/studio-theme.css", themeCss);
app.route("/api/me", me);
app.route("/api/home", home);
app.route("/api/dumps", dumps);
app.route("/api/uploads", uploads);
app.route("/api/jobs", jobs);
app.route("/api/settings", settings);
app.route("/api/connections", connections);
app.route("/api/clips", clips);
app.route("/api/posts", posts);
app.route("/api/brain", brain);
app.route("/api/research", research);
app.route("/api/stats", stats);
app.route("/api/voice", voice);
app.route("/api/deals", deals);
app.route("/api/mediakit", mediakit);
app.route("/api/help", help);
app.route("/api/public", publicRoutes);
app.route("/media", media);
app.route("/api/oauth", oauth);
app.route("/api/editing", editing);
app.route("/api/archive", archive);
app.route("/kit", kitPage);
app.route("/", legal);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  log.error("unhandled", { name: err.name, message: safeError(err), path: c.req.path.split("/").slice(0, 3).join("/") });
  return c.json({ error: "Something went wrong on our side. Try again in a moment.", fix_guide: "i-didnt-get-an-email" }, 500);
});

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    const e = await hydrate(env);
    const res = await app.fetch(req, e, ctx);
    if (e.PRACTICE_JOBS?.length) ctx.waitUntil(drainPracticeJobs(e));
    return res;
  },
  scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      hydrate(env).then(async (e) => {
        await runCron(e, controller.cron);
        await drainPracticeJobs(e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
