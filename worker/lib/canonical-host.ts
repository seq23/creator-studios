// Each studio answers on its own hostname (studios/<slug>.json `hostname`, a Workers Custom Domain;
// PUBLIC_BASE_URL). Its old workers.dev address stays on so nothing in flight breaks, but a person
// landing there is sent to the hostname with a 301 (one address: one cookie, one OAuth redirect).
// The API is never redirected: a job dispatched before the move still calls back on the old
// address (POST, or a GET whose signed headers a cross-host redirect could drop), and it works.
//
// For this the Worker runs first for every path but the hashed build files (wrangler
// run_worker_first ["/*", "!/assets/*"], scripts/studio.mjs); a path it has no route for goes on
// to the static assets (worker/index.ts notFound), exactly as before.

/** The 301 to the studio's own hostname for a page request on its old workers.dev address, else null. */
export function canonicalRedirect(req: Request, publicBaseUrl: string | undefined): Response | null {
  if (!publicBaseUrl || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const url = new URL(req.url);
  if (!url.hostname.endsWith(".workers.dev")) return null;
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (base.hostname === url.hostname || base.hostname.endsWith(".workers.dev")) return null;
  if (url.pathname.startsWith("/api/")) return null;
  return new Response(null, { status: 301, headers: { location: `${base.origin}${url.pathname}${url.search}`, "cache-control": "max-age=3600" } });
}
