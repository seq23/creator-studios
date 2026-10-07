// Public, unauthenticated API for the media kit (section 12b.1): the newest PUBLISHED version
// (a draft is never public), its images, and the view counter. The page itself is the React
// route /kit/:slug and the printable one /kit/:slug/print (the browser saves it as a PDF).
//   GET /api/public/kit/:slug                 the kit; an old link name answers {moved: newSlug}
//   GET /api/public/kit/:slug/image/:id       a photo or logo the published kit uses (nothing else)
//   GET /api/public/kit/:slug/photo           the published photo (links sent before 26 Sep 2026)
//   GET /api/public/kit/:slug/print           → /kit/:slug/print
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { newId } from "../lib/ids";
import { buildPublicKit, latestVersion, readKit } from "./mediakit";

export const publicRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const BOT = /(bot|crawler|spider|preview|slurp|facebookexternalhit|embedly|googleimageproxy|curl|wget|headless)/i;

publicRoutes.get("/kit/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await readKit(c.env);
  if (slug !== row.public_slug) {
    const old = await c.env.DB.prepare("SELECT slug FROM kit_slugs WHERE slug = ?").bind(slug).first();
    if (old) return c.json({ moved: row.public_slug }, 200, { "cache-control": "no-store" });
    return c.json({ error: "No media kit at this address." }, 404);
  }
  const pub = await latestVersion(c.env);
  if (!pub) return c.json({ error: "This media kit isn't published yet." }, 404);
  // Count a view: not her own preview (?preview=1), not link-preview bots.
  if (c.req.query("preview") !== "1" && !BOT.test(c.req.header("user-agent") ?? "")) {
    await c.env.DB.prepare("INSERT INTO kit_views (id, version) VALUES (?, ?)").bind(newId("kv"), pub.version).run();
  }
  const kit = await buildPublicKit(c.env, pub.content, row.public_slug, pub.version, pub.published_at);
  return c.json(kit, 200, { "cache-control": "no-store" });
});

async function servePublishedImage(env: Env, key: string | null) {
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

publicRoutes.get("/kit/:slug/image/:id", async (c) => {
  const row = await readKit(c.env);
  const id = c.req.param("id");
  if (c.req.param("slug") !== row.public_slug || !/^upl_[a-z0-9]{6,40}$/.test(id)) return c.text("Not found", 404);
  const key = `kit/photo/${id}`;
  // Only images the published kit uses; a draft's images are served to her alone (/api/mediakit/file/:id).
  const pub = await latestVersion(c.env);
  const used = !!pub && (pub.content.photoKey === key || pub.content.collabs.some((x) => x.logoKey === key));
  return used ? servePublishedImage(c.env, key) : c.text("Not found", 404);
});

publicRoutes.get("/kit/:slug/photo", async (c) => {
  const row = await readKit(c.env);
  if (c.req.param("slug") !== row.public_slug) return c.text("Not found", 404);
  const pub = await latestVersion(c.env);
  return servePublishedImage(c.env, pub?.content.photoKey ?? null);
});

publicRoutes.get("/kit/:slug/print", (c) => c.redirect(`/kit/${encodeURIComponent(c.req.param("slug"))}/print${c.req.query("autoprint") === "1" ? "?autoprint=1" : ""}`, 302));
