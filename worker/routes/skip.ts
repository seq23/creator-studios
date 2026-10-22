// The Skip link in the heads-up email (/skip/<postId>.<signature>). Opening the link only SHOWS
// what would be skipped (mail scanners open links); the "Yes, skip it" button does it. No login
// needed: the link is signed for that one post and can only stop it, never post or change it.
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { readSkipToken, whenLine } from "../domain/photoPosts";
import { skipPost } from "../lib/photoPosts";
import { readSettings } from "./settings";
import { ITEM_LABEL, SOCIAL_LABEL, type ItemKind, type Social } from "@shared/photoPosts";

export const skipPage = new Hono<{ Bindings: Env; Variables: Vars }>();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(appName: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(appName)}</title>
<link rel="stylesheet" href="/studio-theme.css"><style>
body{margin:0;font-family:var(--font-body,Helvetica,Arial,sans-serif);background:var(--bg,#f5f5f2);color:var(--ink,#1b1d21)}
main{max-width:480px;margin:0 auto;padding:24px 16px}h1{font-size:26px;margin:0 0 16px}p{font-size:18px;line-height:1.5;margin:0 0 14px}
.card{background:var(--surface,#fff);border-radius:16px;padding:16px;margin:0 0 20px}
button,a.btn{display:block;width:100%;box-sizing:border-box;min-height:52px;font-size:18px;font-weight:700;border-radius:999px;border:0;margin:0 0 12px;text-align:center;text-decoration:none;line-height:52px;padding:0 16px;cursor:pointer}
button{background:var(--ink,#1f2328);color:var(--bg,#fff)}a.btn{background:transparent;color:var(--ink,#1f2328);border:2px solid currentColor;line-height:48px}
</style></head><body><main>${body}</main></body></html>`;
}

async function load(env: Env, token: string) {
  const id = await readSkipToken(env.SESSION_SECRET, token);
  if (!id) return null;
  return env.DB.prepare("SELECT id, platform, item_kind, caption, scheduled_at, status FROM social_posts WHERE id = ?").bind(id).first<{ id: string; platform: Social; item_kind: ItemKind; caption: string; scheduled_at: string; status: string }>();
}

const back = (env: Env) => `<a class="btn" href="${esc(env.PUBLIC_BASE_URL)}/photos">← Go to Photos in my studio</a>`;

skipPage.get("/:token", async (c) => {
  const p = await load(c.env, c.req.param("token"));
  const app = c.env.APP_NAME;
  if (!p) return c.html(page(app, "Link not found", `<h1>This link does not work</h1><p>Open Photos in your studio to see your posts.</p>${back(c.env)}`), 404);
  const tz = (await readSettings(c.env).catch(() => null))?.audience_timezone || c.env.AUDIENCE_TIMEZONE || "America/New_York";
  const what = `<div class="card"><p><strong>${esc(SOCIAL_LABEL[p.platform])}</strong> · ${esc(ITEM_LABEL[p.item_kind])}</p><p>${esc(whenLine(p.scheduled_at, tz))}</p><p>“${esc(p.caption)}”</p></div>`;
  if (p.status === "skipped") return c.html(page(app, "Already skipped", `<h1>Already skipped</h1>${what}<p>This post will not go out.</p>${back(c.env)}`));
  if (p.status === "posted" || p.status === "sending") return c.html(page(app, "Already posted", `<h1>This post already went out</h1>${what}${back(c.env)}`));
  return c.html(
    page(
      app,
      "Skip this post?",
      `<h1>Skip this post?</h1>${what}<p>If you skip it, it will not go out.</p><form method="post"><button type="submit">Yes, skip it</button></form><a class="btn" href="${esc(c.env.PUBLIC_BASE_URL)}/photos">← No, keep it</a>`,
    ),
  );
});

skipPage.post("/:token", async (c) => {
  const p = await load(c.env, c.req.param("token"));
  const app = c.env.APP_NAME;
  if (!p) return c.html(page(app, "Link not found", `<h1>This link does not work</h1><p>Open Photos in your studio to see your posts.</p>${back(c.env)}`), 404);
  const done = await skipPost(c.env, p.id, "email-link");
  if (!done && p.status !== "skipped") return c.html(page(app, "Already posted", `<h1>This post already went out</h1><p>It could not be skipped.</p>${back(c.env)}`), 409);
  return c.html(page(app, "Skipped", `<h1>Done. It is skipped.</h1><p>This post will not go out. Nothing else changed.</p>${back(c.env)}`));
});
