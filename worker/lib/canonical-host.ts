// Each studio answers on its own hostname (studios/<slug>.json `hostname`, a Workers Custom Domain;
// PUBLIC_BASE_URL). Its old workers.dev address stays on so nothing in flight breaks, but a person
// landing there is sent to the hostname with a 301 (one address: one cookie, one OAuth redirect).
// A studio that was renamed (a sample taken by a client) keeps its old custom hostname attached
// (studios/<slug>.json `previousHostnames`, var PREVIOUS_HOSTNAMES), and a page there 301s the same way.
// The API is never redirected: a job dispatched before the move still calls back on the old
// address (POST, or a GET whose signed headers a cross-host redirect could drop), and it works.
//
// For this the Worker runs first for every path but the hashed build files (wrangler
// run_worker_first ["/*", "!/assets/*"], scripts/studio.mjs); a path it has no route for goes on
// to the static assets (worker/index.ts notFound), exactly as before.

/** The previous hostnames from the PREVIOUS_HOSTNAMES var (comma separated), lower-cased. */
export function previousHostnames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The 301 to the studio's own hostname for a page request on its old workers.dev address or on one
 * of its previous hostnames, else null.
 */
export function canonicalRedirect(req: Request, publicBaseUrl: string | undefined, previous?: string): Response | null {
  if (!publicBaseUrl || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const url = new URL(req.url);
  if (!url.hostname.endsWith(".workers.dev") && !previousHostnames(previous).includes(url.hostname.toLowerCase())) return null;
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
