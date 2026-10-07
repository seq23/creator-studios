// The public kit page's HTML (/kit/:slug and /kit/:slug/print): the app's index.html with the
// published kit's title, description and share-preview tags filled in, so a kit link pasted into
// Gmail or iMessage shows her name and positioning instead of a bare URL (review K23). The page
// itself is still the React app (app/pages/MediaKit.tsx). Nothing here is shown for a draft.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { latestVersion, readKit } from "./mediakit";

export const kitPage = new Hono<{ Bindings: Env; Variables: Vars }>();

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function kitMeta(k: { name: string; positioning: string; niche: string }, url: string): string {
  const title = `${k.name} · media kit`;
  const desc = [k.positioning, k.niche].filter(Boolean).join(" · ") || `${k.name}'s media kit: numbers, recent work and rates.`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta name="twitter:card" content="summary">`,
  ].join("");
}

kitPage.get("/:slug/*", (c) => serve(c.env, c.req.raw, c.req.param("slug")));
kitPage.get("/:slug", (c) => serve(c.env, c.req.raw, c.req.param("slug")));

async function serve(env: Env, req: Request, slug: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL("/", req.url).toString(), { headers: req.headers }));
  const row = await readKit(env);
  const pub = slug === row.public_slug ? await latestVersion(env) : null;
  if (!pub || !page.ok) return page;
  const meta = kitMeta(pub.content, `${env.PUBLIC_BASE_URL}/kit/${row.public_slug}`);
  return new HTMLRewriter()
    .on("title", { element: (e) => void e.remove() })
    .on("head", { element: (e) => void e.append(meta, { html: true }) })
    .transform(page);
}
