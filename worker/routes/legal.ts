// The two public pages Google requires before a sign-in app can be published (Branding page:
// privacy policy + terms of service). Plain HTML from the Worker, no login, no JavaScript, so
// Google's reviewers, a crawler and a phone all read them the same way on staging and production.
//   GET /privacy   what the dashboard reads and uploads on her YouTube channel, how tokens are kept,
//                  how to disconnect and revoke, who to contact
//   GET /terms     the short terms of use
// Linked from the footer of every screen (app/components/Shell.tsx, app/pages/Login.tsx).
// Guard: scripts/validators/legal-pages.mjs, tests/unit/legal-pages.test.ts, tests/e2e/legal-pages.spec.ts.
import { Hono } from "hono";
import type { Env, Vars } from "../env";

export const legal = new Hono<{ Bindings: Env; Variables: Vars }>();

import { ownerEmail } from "../lib/auth";
import { kitName } from "./mediakit";

/** Who to write to about privacy, the terms or the data: the studio's own owner (claimed or registry address). */
export async function legalContact(env: Env): Promise<string> {
  return (await ownerEmail(env)) || "the studio owner";
}
/** Where anyone can remove the dashboard's access to their Google account at any time. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
/** The date both pages were last changed. Change it with the words. */
export const LEGAL_UPDATED = "26 September 2026";
/** Paths both deployments serve from the Worker first (wrangler.jsonc run_worker_first). */
export const LEGAL_PATHS = ["/privacy", "/terms"] as const;

function page(app: string, title: string, body: string, contact: string, owner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${app}</title>
<meta name="description" content="${title} for ${app}, ${owner}'s creator dashboard.">
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f5f2; color: #1b1d21; font: 16px/1.6 "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 32px 16px 48px; }
  h1, h2 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; line-height: 1.25; }
  h1 { font-size: 2rem; margin: 0 0 4px; }
  h2 { font-size: 1.25rem; margin: 28px 0 8px; }
  .updated { color: #5b6068; margin: 0 0 24px; }
  a { color: #2c5470; }
  ul { padding-left: 1.25rem; }
  footer { border-top: 1px solid rgba(27,29,33,.12); margin-top: 40px; padding-top: 16px; color: #5b6068; font-size: .9rem; }
  footer a { margin-right: 16px; }
</style>
</head>
<body>
<main>
${body}
<footer>
  <a href="/">${app}</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${contact}">${contact}</a>
</footer>
</main>
</body>
</html>`;
}

export const privacyHtml = (app: string, owner: string, contact: string): string =>
  page(
  app,
  "Privacy policy",
  `<h1>Privacy policy</h1>
<p class="updated">${app} · last updated ${LEGAL_UPDATED}</p>
<p>${app} is a private dashboard that ${owner} uses to turn her own videos into posts and
to put her full-length videos on her own YouTube channel. It has one user: ${owner}. It is not sold,
it shows no ads, and it never sells or shares anyone's data.</p>

<h2>What it reads and does on YouTube</h2>
<p>Only when ${owner} taps <strong>Connect YouTube</strong> and allows it on Google's own page, the
dashboard uses her Google account's permission for her YouTube channel to:</p>
<ul>
  <li><strong>Upload</strong> the full-length videos she chooses to her channel, with the title,
  description, chapters, tags and thumbnail she approved, as private, unlisted or scheduled to go
  public at the time she put on her Calendar.</li>
  <li><strong>Change a video it uploaded</strong> when she moves it on her Calendar (a new publish
  time) or takes it off (it is set to private and kept; the dashboard never deletes a video).</li>
  <li><strong>Read</strong> her channel's name, id and those videos' status back, to check each
  upload landed the way she asked, and her public video numbers for her Stats screen.</li>
</ul>
<p>Google's consent page words the second permission as "see, edit, and permanently delete your YouTube
videos"; YouTube only offers the right to change a video's publish time together with that wording. The
dashboard uses it only to read back, reschedule and make private the videos it uploaded.</p>
<p>It does not read her email, contacts, comments, messages or anything outside her YouTube channel,
and it does nothing on YouTube she did not ask for in the dashboard.</p>

<h2>How the permission is kept</h2>
<ul>
  <li>Google gives the dashboard a sign-in token. It is stored <strong>encrypted</strong> (AES-GCM)
  in the dashboard's own database and is never written to logs, email or the code.</li>
  <li>The machine that uploads a large video gets a short-lived access token that expires within an
  hour, never the long-lived sign-in token.</li>
  <li>Videos and the files made from them are kept in the dashboard's own private storage
  (Cloudflare) and cleared on a schedule once posted.</li>
</ul>

<h2>Google user data</h2>
<p>${app}'s use and transfer of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User
Data Policy</a>, including the Limited Use requirements. Google data is used only to provide the
features above to ${owner}, is not used for advertising, is not sold, is not used to train any AI
model, and is not read by a person except to fix a problem she asks about.</p>

<h2>Other services it works with</h2>
<p>Short clips are posted through Buffer with the key ${owner} pastes in. Email notices go through
Resend. Optional services she chooses to connect (for example ElevenLabs for voice overs) receive
only what that feature needs. Each connection can be removed on the Connect screen.</p>

<h2>How to disconnect and remove access</h2>
<ul>
  <li>In the dashboard: <strong>Settings → Connections → YouTube → Disconnect</strong>. The stored
  token is deleted at once.</li>
  <li>At Google, at any time: <a href="${GOOGLE_PERMISSIONS_URL}">${GOOGLE_PERMISSIONS_URL}</a> →
  ${app} → Remove access. The dashboard then stops and shows "Reconnect YouTube".</li>
  <li>Videos already on her channel stay hers, in YouTube Studio, whatever happens to the dashboard.</li>
</ul>

<h2>Contact</h2>
<p>Questions or a request to delete data: <a href="mailto:${contact}">${contact}</a>.</p>`,
  contact,
  owner,
);

export const termsHtml = (app: string, owner: string, contact: string): string =>
  page(
  app,
  "Terms of service",
  `<h1>Terms of service</h1>
<p class="updated">${app} · last updated ${LEGAL_UPDATED}</p>
<p>${app} is a private dashboard for one creator, ${owner}. By using it you agree to these
short terms.</p>

<h2>What it is</h2>
<p>A tool that helps cut, schedule and post ${owner}'s own videos: short clips through Buffer, and
full-length videos uploaded to her own YouTube channel when she connects it. Nothing is posted or
uploaded without her approval in the dashboard.</p>

<h2>Her content stays hers</h2>
<p>Every video, picture and word belongs to ${owner}. The dashboard only moves it where she tells it
to. She is responsible for having the rights to what she posts and for following YouTube's Terms of
Service (<a href="https://www.youtube.com/t/terms">youtube.com/t/terms</a>) and Community
Guidelines. Using the YouTube features also means agreeing to the
<a href="https://policies.google.com/privacy">Google Privacy Policy</a>.</p>

<h2>Connections</h2>
<p>Connections to YouTube, Buffer and other services use her own accounts and can be removed at any
time on the Connect screen or, for Google, at
<a href="${GOOGLE_PERMISSIONS_URL}">${GOOGLE_PERMISSIONS_URL}</a>. How data is handled is in the
<a href="/privacy">privacy policy</a>.</p>

<h2>No warranty</h2>
<p>The dashboard is provided as is. Uploads and posts depend on YouTube, Buffer and other services
that can be slow, refuse a request or change; when that happens the dashboard says so and shows
what to do. It is not liable for anything those services do.</p>

<h2>Changes and contact</h2>
<p>These terms may change; the date above says when. Questions:
<a href="mailto:${contact}">${contact}</a>.</p>`,
  contact,
  owner,
);

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" };

legal.get("/privacy", async (c) => c.body(privacyHtml(c.env.APP_NAME, kitName(c.env), await legalContact(c.env)), 200, HEADERS));
legal.get("/terms", async (c) => c.body(termsHtml(c.env.APP_NAME, kitName(c.env), await legalContact(c.env)), 200, HEADERS));
