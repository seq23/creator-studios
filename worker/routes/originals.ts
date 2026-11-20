// The "Download all or keep them" link in the file clean-up emails (/originals/<batchId>.<signature>,
// worker/lib/retention.ts). No login needed: the link is signed for the dumps in that one email and
// can only download their originals or keep them; it never deletes or changes anything else.
// Opening it only shows the files (mail scanners open links); Keep them is a button.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { readOriginalsToken } from "../domain/retention";
import { signedDownload } from "../services/s3files";
import { gbWords } from "@shared/bytes";
import { log } from "../lib/log";

export const originals = new Hono<{ Bindings: Env; Variables: Vars }>();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(appName: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(appName)}</title>
<link rel="stylesheet" href="/studio-theme.css"><style>
body{margin:0;font-family:var(--font-body,Helvetica,Arial,sans-serif);background:var(--bg,#f5f5f2);color:var(--ink,#1b1d21)}
main{max-width:480px;margin:0 auto;padding:24px 16px}h1{font-size:26px;margin:0 0 16px}h2{font-size:18px;margin:0 0 8px}p{font-size:18px;line-height:1.5;margin:0 0 14px}
.card{background:var(--surface,#fff);border-radius:16px;padding:16px;margin:0 0 20px}
.card a{display:flex;justify-content:space-between;gap:12px;min-height:44px;align-items:center;color:inherit;font-size:16px;border-top:1px solid rgba(0,0,0,.08);text-decoration:none}
.card a span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card a span:last-child{flex:none;font-weight:700;text-decoration:underline}
button,a.btn{display:block;width:100%;box-sizing:border-box;min-height:52px;font-size:18px;font-weight:700;border-radius:999px;border:0;margin:0 0 12px;text-align:center;text-decoration:none;line-height:52px;padding:0 16px;cursor:pointer}
button{background:var(--ink,#1f2328);color:var(--bg,#fff)}button.alt,a.btn{background:transparent;color:var(--ink,#1f2328);border:2px solid currentColor;line-height:48px}
</style></head><body><main>${body}</main></body></html>`;
}

interface Row {
  dump_id: string;
  dump_created_at: string;
  kept: number;
  id: string;
  file_name: string;
  size_bytes: number;
  raw_deleted_at: string | null;
}

async function load(env: Env, token: string): Promise<Row[] | null> {
  const batch = await readOriginalsToken(env.SESSION_SECRET, token);
  if (!batch) return null;
  const { results } = await env.DB.prepare(
    `SELECT d.id AS dump_id, d.created_at AS dump_created_at, d.originals_kept AS kept, a.id, a.file_name, a.size_bytes, a.raw_deleted_at
     FROM file_notices n JOIN dumps d ON d.id = n.dump_id JOIN assets a ON a.dump_id = d.id AND a.upload_status = 'uploaded'
     WHERE n.batch_id = ? ORDER BY d.created_at, a.created_at`,
  )
    .bind(batch)
    .all<Row>();
  return results;
}

const back = (env: Env) => `<a class="btn" href="${esc(env.PUBLIC_BASE_URL)}">← Go to my studio</a>`;
const notFound = (env: Env) => page(env.APP_NAME, "Link not found", `<h1>This link does not work</h1><p>Open your studio to see your dumps.</p>${back(env)}`);

originals.get("/:token", async (c) => {
  const token = c.req.param("token");
  const rows = await load(c.env, token);
  if (!rows?.length) return c.html(notFound(c.env), 404);
  const tz = c.env.AUDIENCE_TIMEZONE || "America/New_York";
  const live = rows.filter((r) => !r.raw_deleted_at);
  const kept = rows.every((r) => r.kept);
  const byDump = new Map<string, Row[]>();
  for (const r of live) byDump.set(r.dump_id, [...(byDump.get(r.dump_id) ?? []), r]);
  const cards = [...byDump.values()]
    .map((files) => {
      const day = new Date(files[0].dump_created_at.endsWith("Z") ? files[0].dump_created_at : `${files[0].dump_created_at}Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
      return `<div class="card"><h2>Your dump from ${esc(day)}</h2>${files.map((f) => `<a class="dl" href="/originals/${esc(token)}/file/${esc(f.id)}" download="${esc(f.file_name)}"><span>${esc(f.file_name)}</span><span>${esc(gbWords(f.size_bytes))} · Download</span></a>`).join("")}</div>`;
    })
    .join("");
  if (!live.length) return c.html(page(c.env.APP_NAME, "Already cleared", `<h1>These files were already cleared</h1><p>Your clips, covers and posts are all still in your studio.</p>${back(c.env)}`));
  const keep = kept
    ? `<p><strong>Kept.</strong> These files will not be cleared.</p>`
    : `<form method="post" action="/originals/${esc(token)}/keep"><button class="alt" type="submit">Keep them (never clear these)</button></form>`;
  // Download all: one tap starts each file's download in turn (a phone asks once per file).
  const script = `<script>document.getElementById("all").addEventListener("click",function(){var l=document.querySelectorAll("a.dl"),i=0;(function n(){if(i>=l.length)return;l[i++].click();setTimeout(n,1500)})()});</script>`;
  return c.html(
    page(
      c.env.APP_NAME,
      "Your original files",
      `<h1>Your original files</h1><p>${live.length} ${live.length === 1 ? "file" : "files"}, ${esc(gbWords(live.reduce((s, r) => s + (r.size_bytes ?? 0), 0)))}. Save them to your phone or computer, or keep them in your studio.</p><button id="all" type="button">Download all</button>${keep}${cards}${back(c.env)}${script}`,
    ),
  );
});

originals.get("/:token/file/:assetId", async (c) => {
  const rows = await load(c.env, c.req.param("token"));
  const row = rows?.find((r) => r.id === c.req.param("assetId") && !r.raw_deleted_at);
  if (!row) return c.html(notFound(c.env), 404);
  const a = await c.env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(row.id).first<{ r2_key: string }>();
  if (!a) return c.html(notFound(c.env), 404);
  // Files on another account: a signed link straight to the bucket (a big video never streams through the Worker).
  const signed = await signedDownload(c.env.FILES, a.r2_key, 6 * 3600, row.file_name);
  if (signed) return c.redirect(signed, 302);
  const obj = await c.env.FILES.get(a.r2_key);
  if (!obj) return c.html(notFound(c.env), 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename="${row.file_name.replace(/["\\\r\n]/g, "_")}"`);
  headers.set("content-length", String(obj.size));
  headers.set("cache-control", "private, no-store");
  return new Response(obj.body, { headers });
});

originals.post("/:token/keep", async (c) => {
  const rows = await load(c.env, c.req.param("token"));
  if (!rows?.length) return c.html(notFound(c.env), 404);
  const ids = [...new Set(rows.map((r) => r.dump_id))];
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("UPDATE dumps SET originals_kept = 1 WHERE id = ?").bind(id)));
  log.info("originals.kept", { dumps: ids.length });
  return c.html(page(c.env.APP_NAME, "Kept", `<h1>Done. They are kept.</h1><p>These original files will not be cleared. You can still download them from this link.</p><a class="btn" href="/originals/${esc(c.req.param("token"))}">← Back to the files</a>${back(c.env)}`));
});
