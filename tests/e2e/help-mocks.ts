// Illustrative frames for help steps that happen on another site or app (Buffer, TikTok Studio,
// the Instagram app, ElevenLabs, Gmail…). Section 12c: the help pictures use demo data only, so a
// step outside the dashboard is never a screenshot of a real account or anyone's personal data.
// Each frame is a plain, clearly labelled sketch ("Illustration: not a real account") with the
// one thing to tap marked data-hl, which the screenshot job circles like any other target.
//
// A guide step asks for one with <!-- mock: name -->. The names are the keys of MOCKS; the
// validator help-pictures fails a mock name that is not here. Colours and sizes come from the
// app's own tokens (app/styles/tokens.css is injected), so nothing here holds a raw colour.
import { readFileSync } from "node:fs";
import path from "node:path";

/** One piece of a frame. `hl` marks the element the step is about. */
export type Block =
  | { k: "h"; v: string }
  | { k: "p"; v: string; hl?: boolean }
  | { k: "btn"; v: string; hl?: boolean; quiet?: boolean }
  | { k: "field"; label: string; value: string; hl?: boolean }
  | { k: "row"; v: string; meta?: string; action?: string; hl?: boolean; bad?: boolean }
  | { k: "check"; v: string; on?: boolean; hl?: boolean }
  | { k: "stat"; label: string; value: string; hl?: boolean }
  | { k: "dialog"; title: string; body: Block[] }
  | { k: "file"; v: string; meta: string; hl?: boolean }
  | { k: "email"; from: string; subject: string; body: string; hl?: string };

export interface Frame {
  /** The site or app, in words (never a logo). */
  site: string;
  /** Address bar text, or the app's name for phone apps. */
  url: string;
  /** Left menu (desktop) / top tabs (phone); `navOn` is the current one, `navHl` the one to tap. */
  nav?: string[];
  navOn?: string;
  navHl?: string;
  title: string;
  body: Block[];
}

const key = (prefix: string) => `${prefix}••••••••••••••••7f3a`;
const apiPage = (site: string, url: string, nav: string[], navOn: string, title: string, body: Block[]): Frame => ({ site, url, nav, navOn, title, body });
const createKey = (site: string, url: string, nav: string[], navOn: string, button: string): Frame =>
  apiPage(site, url, nav, navOn, "API keys", [
    { k: "p", v: "Keys let other apps use your account. Keep them private." },
    { k: "row", v: "No keys yet", meta: "" },
    { k: "btn", v: button, hl: true },
  ]);
const copyKey = (site: string, url: string, nav: string[], navOn: string, prefix: string): Frame =>
  apiPage(site, url, nav, navOn, "API keys", [
    {
      k: "dialog",
      title: "Your new key",
      body: [
        { k: "field", label: "Name", value: "Sample Studio" },
        { k: "field", label: "Key (shown once)", value: key(prefix) },
        { k: "btn", v: "Copy", hl: true },
      ],
    },
  ]);
const outOfCredits = (site: string, url: string, nav: string[], navOn: string, plan: string): Frame =>
  apiPage(site, url, nav, navOn, "Plan and credits", [
    { k: "stat", label: "Credits left this month", value: "0" },
    { k: "p", v: "Your credits renew on the 1st." },
    { k: "row", v: `Plan: ${plan}`, action: "Top up or change plan", hl: true },
    { k: "row", v: "API key: Sample Studio", meta: "Still active" },
  ]);

const BUFFER_NAV = ["Publish", "Channels", "Settings"];
const OR_NAV = ["Models", "Chat", "Keys", "Credits"];
const EL_NAV = ["Home", "Voices", "Text to speech", "API keys", "Subscription"];

export const MOCKS: Record<string, Frame> = {
  // ---- Buffer (posting)
  "buffer-sign-up": apiPage("Buffer", "publish.buffer.com", BUFFER_NAV, "Publish", "Welcome to Buffer", [
    { k: "p", v: "The free plan posts to 3 channels, which is all the dashboard needs." },
    { k: "btn", v: "Get started for free", hl: true },
    { k: "btn", v: "Log in", quiet: true },
  ]),
  "buffer-settings-api": apiPage("Buffer", "publish.buffer.com/settings/api", ["Profile", "Channels", "Billing", "API"], "Profile", "Settings", [
    { k: "p", v: "Your account, your channels and the keys other apps use." },
    { k: "row", v: "API", meta: "Keys for other apps", action: "Open", hl: true },
  ]),
  "buffer-create-key": apiPage("Buffer", "publish.buffer.com/settings/api", ["Profile", "Channels", "Billing", "API"], "API", "API", [
    {
      k: "dialog",
      title: "Create key",
      body: [
        { k: "field", label: "Name", value: "Dashboard" },
        { k: "field", label: "Key", value: key("buf_") },
        { k: "btn", v: "Copy", hl: true },
      ],
    },
  ]),
  "buffer-new-key": apiPage("Buffer", "publish.buffer.com/settings/api", ["Profile", "Channels", "Billing", "API"], "API", "API", [
    { k: "row", v: "Dashboard", meta: "Stopped working", action: "Delete", bad: true },
    { k: "btn", v: "Create key", hl: true },
    { k: "p", v: "The free plan allows one key: delete the old one first." },
  ]),
  "buffer-channels": apiPage("Buffer", "publish.buffer.com/channels", BUFFER_NAV, "Channels", "Channels", [
    { k: "p", v: "0 of 3 channels on the free plan" },
    { k: "btn", v: "Connect a channel", hl: true },
  ]),
  "buffer-pick-tiktok": apiPage("Buffer", "publish.buffer.com/channels/connect", BUFFER_NAV, "Channels", "Connect a channel", [
    { k: "row", v: "TikTok", action: "Connect", hl: true },
    { k: "row", v: "Instagram", action: "Connect" },
    { k: "row", v: "YouTube", action: "Connect" },
  ]),
  "buffer-pick-instagram": apiPage("Buffer", "publish.buffer.com/channels/connect", BUFFER_NAV, "Channels", "Connect Instagram", [
    { k: "p", v: "Pick the account to post to. It needs to be a professional (creator or business) account." },
    { k: "check", v: "@your.instagram · Creator account", on: true, hl: true },
    { k: "btn", v: "Allow" },
  ]),
  "buffer-pick-youtube": apiPage("Buffer", "publish.buffer.com/channels/connect", BUFFER_NAV, "Channels", "Connect YouTube", [
    { k: "p", v: "Google asks which channel Buffer may post Shorts to." },
    { k: "check", v: "Your YouTube channel", on: true },
    { k: "btn", v: "Allow", hl: true },
  ]),
  "buffer-reconnect": apiPage("Buffer", "publish.buffer.com/channels", BUFFER_NAV, "Channels", "Channels", [
    { k: "row", v: "TikTok", meta: "Connected" },
    { k: "row", v: "Instagram", meta: "Disconnected: log in again", action: "Reconnect", hl: true, bad: true },
    { k: "row", v: "YouTube", meta: "Connected" },
  ]),

  // ---- OpenRouter (the AI writer)
  "openrouter-keys": apiPage("OpenRouter", "openrouter.ai/settings/keys", OR_NAV, "Keys", "API keys", [
    { k: "p", v: "Free models cost nothing. No credit card needed." },
    { k: "btn", v: "Create Key", hl: true },
  ]),
  "openrouter-create": apiPage("OpenRouter", "openrouter.ai/settings/keys", OR_NAV, "Keys", "API keys", [
    { k: "dialog", title: "Create a key", body: [{ k: "field", label: "Name", value: "Sample Studio" }, { k: "field", label: "Credit limit (optional)", value: "" }, { k: "btn", v: "Create", hl: true }] },
  ]),
  "openrouter-copy": copyKey("OpenRouter", "openrouter.ai/settings/keys", OR_NAV, "Keys", "sk-or-v1-"),
  "openrouter-reconnect": apiPage("OpenRouter", "openrouter.ai/settings/keys", OR_NAV, "Keys", "API keys", [
    { k: "row", v: "Sample Studio", meta: "Disabled", bad: true, action: "Delete" },
    { k: "btn", v: "Create Key", hl: true },
  ]),

  // ---- Firecrawl (optional faster web research)
  "firecrawl-sign-up": apiPage("Firecrawl", "firecrawl.dev", ["Home", "Pricing", "Docs"], "Home", "Firecrawl", [
    { k: "p", v: "Free plan: 1,000 credits a month." },
    { k: "btn", v: "Sign up free", hl: true },
  ]),
  "firecrawl-keys": apiPage("Firecrawl", "firecrawl.dev/app/api-keys", ["Overview", "API Keys", "Usage"], "API Keys", "API Keys", [
    { k: "row", v: "Default key", meta: key("fc-"), action: "Copy", hl: true },
  ]),
  "firecrawl-usage": apiPage("Firecrawl", "firecrawl.dev/app/usage", ["Overview", "API Keys", "Usage"], "Usage", "Usage", [
    { k: "stat", label: "Credits used this month", value: "1,000 of 1,000", hl: true },
    { k: "p", v: "Credits reset on Oct 1. Until then the dashboard uses its free search." },
  ]),

  // ---- Hunter (optional brand contacts)
  "hunter-sign-up": apiPage("Hunter", "hunter.io", ["Home", "Pricing"], "Home", "Hunter", [
    { k: "p", v: "Free plan: 50 searches a month." },
    { k: "btn", v: "Sign up", hl: true },
  ]),
  "hunter-api": apiPage("Hunter", "hunter.io/api-keys", ["Dashboard", "API", "Usage"], "API", "API", [
    { k: "row", v: "Your API key", meta: key(""), action: "Copy", hl: true },
  ]),
  "hunter-new-key": apiPage("Hunter", "hunter.io/api-keys", ["Dashboard", "API", "Usage"], "API", "API", [
    { k: "row", v: "Old key", meta: "Revoked", bad: true },
    { k: "btn", v: "Generate a new key", hl: true },
  ]),

  // ---- ElevenLabs (optional premium voice)
  "elevenlabs-home": apiPage("ElevenLabs", "elevenlabs.io/app", EL_NAV, "Home", "Welcome back", [
    { k: "p", v: "Starter and above include instant voice cloning." },
    { k: "row", v: "Your profile", meta: "bottom left", action: "API keys", hl: true },
  ]),
  "elevenlabs-create": apiPage("ElevenLabs", "elevenlabs.io/app/settings/api-keys", EL_NAV, "API keys", "API keys", [
    { k: "dialog", title: "Create API key", body: [{ k: "field", label: "Name", value: "Sample Studio" }, { k: "p", v: "Leave the access as it is." }, { k: "btn", v: "Create", hl: true }] },
  ]),
  "elevenlabs-copy": copyKey("ElevenLabs", "elevenlabs.io/app/settings/api-keys", EL_NAV, "API keys", "sk_"),
  "elevenlabs-credits": apiPage("ElevenLabs", "elevenlabs.io/app/subscription", EL_NAV, "Subscription", "Subscription", [
    { k: "stat", label: "Characters used this month", value: "30,000 of 30,000" },
    { k: "row", v: "Plan: Starter", action: "Upgrade or wait for renewal", hl: true },
  ]),

  // ---- connected editors (optional)
  "opusclip-api": createKey("Opus Clip", "opus.pro/dashboard/api", ["Projects", "Brand kit", "API"], "API", "Create API key"),
  "opusclip-credits": outOfCredits("Opus Clip", "opus.pro/dashboard/billing", ["Projects", "Brand kit", "API", "Billing"], "Billing", "Pro"),
  "vizard-api": createKey("Vizard", "vizard.ai/workspace/api", ["Projects", "Workspace settings", "API"], "API", "Generate API key"),
  "vizard-credits": outOfCredits("Vizard", "vizard.ai/workspace/billing", ["Projects", "Workspace settings", "API", "Billing"], "Billing", "Creator"),
  "klap-api": createKey("Klap", "klap.app/settings/api", ["Videos", "REST API", "Billing"], "REST API", "Create key"),
  "klap-credits": outOfCredits("Klap", "klap.app/settings/billing", ["Videos", "REST API", "Billing"], "Billing", "Pro"),
  "submagic-api": createKey("Submagic", "app.submagic.co/settings/api", ["Projects", "Settings", "API"], "API", "Create API key"),
  "submagic-credits": outOfCredits("Submagic", "app.submagic.co/settings/billing", ["Projects", "Settings", "API", "Billing"], "Billing", "Business + API"),
  "descript-api": createKey("Descript", "web.descript.com/settings/api", ["Projects", "Settings", "API tokens"], "API tokens", "Create token"),
  "descript-credits": outOfCredits("Descript", "web.descript.com/settings/billing", ["Projects", "Settings", "API tokens", "Billing"], "Billing", "Creator"),

  // ---- set up by her helper (server secrets)
  "resend-key": apiPage("Resend", "resend.com/api-keys", ["Emails", "Domains", "API Keys"], "API Keys", "API Keys", [
    { k: "dialog", title: "Create API key", body: [{ k: "field", label: "Name", value: "Sample Studio" }, { k: "field", label: "Permission", value: "Sending access" }, { k: "btn", v: "Add", hl: true }] },
  ]),
  "resend-domains": apiPage("Resend", "resend.com/domains", ["Emails", "Domains", "API Keys"], "Domains", "Domains", [
    { k: "p", v: "Optional: send from your own website's address." },
    { k: "btn", v: "Add domain", hl: true },
  ]),
  "resend-new-key": apiPage("Resend", "resend.com/api-keys", ["Emails", "Domains", "API Keys"], "API Keys", "API Keys", [
    { k: "row", v: "Sample Studio", meta: "Revoked", bad: true },
    { k: "btn", v: "Create API key", hl: true },
  ]),
  "github-token": apiPage("GitHub", "github.com/settings/personal-access-tokens", ["Profile", "Developer settings", "Fine-grained tokens"], "Fine-grained tokens", "Fine-grained tokens", [
    { k: "field", label: "Repository access", value: "Only this dashboard's repository" },
    { k: "field", label: "Contents", value: "Read and write" },
    { k: "btn", v: "Generate token", hl: true },
  ]),
  "github-token-expired": apiPage("GitHub", "github.com/settings/personal-access-tokens", ["Profile", "Developer settings", "Fine-grained tokens"], "Fine-grained tokens", "Fine-grained tokens", [
    { k: "row", v: "Sample Studio jobs", meta: "Expired", bad: true, action: "Regenerate token", hl: true },
  ]),

  // ---- TikTok Studio (numbers)
  "tiktok-studio": apiPage("TikTok Studio", "tiktok.com/tiktokstudio", ["Home", "Posts", "Analytics", "Comments"], "Home", "TikTok Studio", [
    { k: "p", v: "Open it on a computer: the download is on the web version." },
    { k: "row", v: "Analytics", meta: "Your views and followers", action: "Open", hl: true },
  ]),
  "tiktok-download": apiPage("TikTok Studio", "tiktok.com/tiktokstudio/analytics", ["Home", "Posts", "Analytics", "Comments"], "Analytics", "Analytics", [
    { k: "field", label: "Date range", value: "Last 60 days" },
    { k: "btn", v: "Download data", hl: true },
  ]),
  "tiktok-csv": apiPage("TikTok Studio", "tiktok.com/tiktokstudio/analytics", ["Home", "Posts", "Analytics", "Comments"], "Analytics", "Analytics", [
    { k: "dialog", title: "Download data", body: [{ k: "check", v: "CSV", on: true, hl: true }, { k: "check", v: "Excel (not this one)" }, { k: "btn", v: "Download" }] },
  ]),
  "tiktok-zip": apiPage("Downloads", "Downloads folder", ["Recent", "Downloads"], "Downloads", "Downloads", [
    { k: "file", v: "Content_yourname.zip", meta: "just now · from TikTok", hl: true },
    { k: "p", v: "No need to open it: upload the zip as it is." },
  ]),

  // ---- the Instagram app (phone)
  "instagram-profile": apiPage("Instagram app", "Instagram · your profile", ["Home", "Search", "Reels", "Profile"], "Profile", "your.instagram", [
    { k: "stat", label: "Followers", value: "8,200" },
    { k: "btn", v: "Professional dashboard", hl: true },
  ]),
  "instagram-insights": apiPage("Instagram app", "Instagram · Professional dashboard", ["Home", "Search", "Reels", "Profile"], "Profile", "Insights · Last 30 days", [
    { k: "stat", label: "Accounts reached", value: "1,900", hl: true },
    { k: "stat", label: "Followers", value: "8,200" },
  ]),
  "instagram-account-type": apiPage("Instagram app", "Instagram · Settings", ["Home", "Search", "Reels", "Profile"], "Profile", "Account type and tools", [
    { k: "row", v: "Switch to professional account", meta: "Free", action: "Switch", hl: true },
  ]),
  "instagram-paid-label": apiPage("Instagram app", "Instagram · Edit post", ["Home", "Search", "Reels", "Profile"], "Profile", "Advanced settings", [
    { k: "check", v: "Add paid partnership label", on: true, hl: true },
    { k: "p", v: "Pick the brand as your partner." },
  ]),
  "meta-consent": apiPage("Meta", "instagram.com/oauth/authorize", [], "", "Sample Studio would like to", [
    { k: "p", v: "Meta may say the app is not reviewed yet. That is expected; this is optional." },
    { k: "check", v: "Read your profile and insights", on: true },
    { k: "btn", v: "Allow", hl: true },
  ]),
  "meta-login-again": apiPage("Meta", "instagram.com/accounts/login", [], "", "Log in to continue", [
    { k: "field", label: "Username", value: "your.instagram" },
    { k: "btn", v: "Log in", hl: true },
  ]),

  // ---- Google / YouTube
  "google-account": apiPage("Google", "accounts.google.com", [], "", "Choose an account", [
    { k: "row", v: "The account that owns your YouTube channel", action: "Pick", hl: true },
  ]),
  "google-consent": apiPage("Google", "accounts.google.com/consent", [], "", "Sample Studio wants to", [
    { k: "check", v: "View your YouTube account", on: true, hl: true },
    { k: "check", v: "View YouTube Analytics reports", on: true },
    { k: "btn", v: "Continue" },
  ]),
  "google-unverified": apiPage("Google", "accounts.google.com", [], "", "Google hasn't verified this app", [
    { k: "p", v: "Expected: the app is waiting for Google's review. It can only read your numbers." },
    { k: "row", v: "Advanced", action: "Go to Sample Studio", hl: true },
  ]),
  // Connect YouTube (full videos): the same Google pages, with the upload permission she allows.
  "youtube-account": apiPage("Google", "accounts.google.com", [], "", "Choose an account to continue to workers.dev", [
    { k: "row", v: "The Google account your YouTube channel is on", action: "Pick", hl: true },
  ]),
  "youtube-unverified": apiPage("Google", "accounts.google.com", [], "", "Google hasn't verified this app", [
    { k: "p", v: "The app is requesting access to sensitive info in your Google Account." },
    { k: "btn", v: "BACK TO SAFETY", quiet: true },
    { k: "row", v: "Advanced", action: "Tap", hl: true },
  ]),
  "youtube-unsafe": apiPage("Google", "accounts.google.com", [], "", "Google hasn't verified this app", [
    { k: "p", v: "Continue only if you understand the risks and trust the developer." },
    { k: "row", v: "Go to workers.dev (unsafe)", action: "Tap", hl: true },
  ]),
  "youtube-allow": apiPage("Google", "accounts.google.com/consent", [], "", "workers.dev wants access to your Google Account", [
    { k: "check", v: "Manage your YouTube videos", on: true },
    { k: "check", v: "See, edit, and permanently delete your YouTube videos, ratings, comments and captions", on: true },
    { k: "p", v: "The dashboard only uploads, moves and hides your videos. It never deletes one." },
    { k: "btn", v: "Continue", hl: true },
  ]),
  "youtube-channel": apiPage("YouTube", "youtube.com", ["Home", "Shorts", "You"], "You", "Your channel", [
    { k: "field", label: "Handle", value: "@yourchannel", hl: true },
    { k: "p", v: "Copy the name that starts with @, or the channel link." },
  ]),

  // YouTube Studio: the two things Buffer can't send (a custom thumbnail, tags), and her own upload
  "youtube-studio-details": apiPage("YouTube Studio", "studio.youtube.com/video/…/edit", ["Dashboard", "Content", "Analytics"], "Content", "Video details", [
    { k: "field", label: "Title", value: "Sunday brunch table, start to finish" },
    { k: "file", v: "Thumbnail", meta: "Upload file: the one you downloaded", hl: true },
    { k: "field", label: "Tags", value: "tablescape, brunch, hosting" },
    { k: "btn", v: "Save" },
  ]),
  "youtube-upload": apiPage("YouTube Studio", "youtube.com/upload", ["Dashboard", "Content", "Analytics"], "Content", "Upload videos", [
    { k: "p", v: "Drag and drop the video you downloaded, or pick it." },
    { k: "btn", v: "Select files", hl: true },
    { k: "p", v: "Then paste the title and description from the dashboard, pick Public, Unlisted or Private, and publish." },
  ]),

  // ---- editing apps without a connection
  "phone-share-sheet": apiPage("Your phone", "Share", [], "", "Share clip", [
    { k: "row", v: "CapCut", action: "Open in", hl: true },
    { k: "row", v: "InShot", action: "Open in" },
    { k: "row", v: "Save Video", action: "Save" },
  ]),
  "capcut-export": apiPage("CapCut", "CapCut · your clip", ["Edit", "Text", "Audio", "Ratio"], "Ratio", "Ratio 9:16", [
    { k: "p", v: "Keep it tall (9:16) and under the time the platforms allow." },
    { k: "btn", v: "Export", hl: true },
  ]),
  "voice-memos": apiPage("Voice Memos", "Voice Memos app", [], "", "New Recording", [
    { k: "row", v: "New Recording · 3:05", action: "••• › Save to Files", hl: true },
  ]),

  // ---- email
  "email-login-code": apiPage("Your email", "Inbox", ["Inbox", "Spam"], "Inbox", "Inbox", [
    { k: "email", from: "Sample Studio", subject: "Your login code", body: "Your login code is 482 913. It works for 10 minutes.", hl: "482 913" },
  ]),
  "email-spam": apiPage("Your email", "Spam folder", ["Inbox", "Spam"], "Spam", "Spam", [
    { k: "row", v: "Sample Studio · Your clips are ready", action: "Not spam", hl: true },
  ]),
  "gmail-send": apiPage("Gmail", "mail.google.com · New message", ["Inbox", "Sent", "Drafts"], "Inbox", "New message", [
    { k: "field", label: "To", value: "partnerships@brand.example" },
    { k: "field", label: "Subject", value: "An idea for your brand: table styling content" },
    { k: "p", v: "Hi team, I'm Sam, a table styling and easy entertaining creator…" },
    { k: "btn", v: "Send", hl: true },
  ]),
};

const TOKENS = readFileSync(path.join(process.cwd(), "app", "styles", "tokens.css"), "utf8");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hl = (on?: boolean) => (on ? " data-hl" : "");

function block(b: Block): string {
  switch (b.k) {
    case "h":
      return `<h3>${esc(b.v)}</h3>`;
    case "p":
      return `<p${hl(b.hl)}>${esc(b.v)}</p>`;
    case "btn":
      return `<div><span class="m-btn${b.quiet ? " quiet" : ""}"${hl(b.hl)}>${esc(b.v)}</span></div>`;
    case "field":
      return `<label class="m-field"><span>${esc(b.label)}</span><span class="m-input"${hl(b.hl)}>${esc(b.value) || "&nbsp;"}</span></label>`;
    case "row":
      return `<div class="m-row${b.bad ? " bad" : ""}"${b.action ? "" : hl(b.hl)}><span class="m-grow"><strong>${esc(b.v)}</strong>${b.meta ? `<small>${esc(b.meta)}</small>` : ""}</span>${b.action ? `<span class="m-btn small"${hl(b.hl)}>${esc(b.action)}</span>` : ""}</div>`;
    case "check":
      return `<div class="m-check"${hl(b.hl)}><span class="m-box${b.on ? " on" : ""}">${b.on ? "✓" : ""}</span>${esc(b.v)}</div>`;
    case "stat":
      return `<div class="m-stat"${hl(b.hl)}><small>${esc(b.label)}</small><strong>${esc(b.value)}</strong></div>`;
    case "file":
      return `<div class="m-row"${hl(b.hl)}><span class="m-file">ZIP</span><span class="m-grow"><strong>${esc(b.v)}</strong><small>${esc(b.meta)}</small></span></div>`;
    case "email": {
      const body = b.hl ? esc(b.body).replace(esc(b.hl), `<mark data-hl>${esc(b.hl)}</mark>`) : esc(b.body);
      return `<div class="m-mail"><small>From ${esc(b.from)}</small><strong>${esc(b.subject)}</strong><p>${body}</p></div>`;
    }
    case "dialog":
      return `<div class="m-dialog"><h3>${esc(b.title)}</h3>${b.body.map(block).join("")}</div>`;
  }
}

/** The whole page for one frame. */
export function mockHtml(name: string): string {
  const f = MOCKS[name];
  if (!f) throw new Error(`no help mock named '${name}' (tests/e2e/help-mocks.ts)`);
  const nav = f.nav?.length
    ? `<nav>${f.nav.map((n) => `<span class="${n === f.navOn ? "on" : ""}"${hl(n === f.navHl)}>${esc(n)}</span>`).join("")}</nav>`
    : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${TOKENS}
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-body); font-size: var(--text-base); color: var(--text); background: var(--surface-sunk); }
    .m-label { background: var(--espresso); color: var(--on-dark); font-size: var(--text-sm); padding: var(--space-2xs) var(--space-sm); letter-spacing: 0.02em; }
    .m-label strong { color: var(--gold); }
    .m-bar { display: flex; gap: var(--space-xs); align-items: center; padding: var(--space-xs) var(--space-sm); background: var(--surface); border-bottom: 1px solid var(--line); }
    .m-site { font-weight: 700; }
    .m-url { flex: 1; background: var(--surface-sunk); border-radius: var(--pill); padding: var(--space-3xs) var(--space-xs); color: var(--text-muted); font-size: var(--text-sm); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .m-wrap { display: flex; min-height: calc(100vh - 100px); }
    nav { width: 220px; padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-3xs); border-right: 1px solid var(--line); background: var(--surface-2); }
    nav span { padding: var(--space-2xs) var(--space-xs); border-radius: var(--radius-sm); color: var(--text-soft); }
    nav span.on { background: var(--surface-sunk); color: var(--text); font-weight: 700; }
    main { flex: 1; padding: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-sm); max-width: 760px; }
    h1 { font-family: var(--font-display); font-size: var(--text-xl); margin: 0; }
    h3 { margin: 0; font-size: var(--text-md); }
    p { margin: 0; color: var(--text-soft); }
    .m-btn { display: inline-block; background: var(--primary); color: var(--primary-text); border-radius: var(--pill); padding: var(--space-xs) var(--space-md); font-weight: 700; }
    .m-btn.quiet { background: transparent; color: var(--text); border: 1px solid var(--line-strong); }
    .m-btn.small { padding: var(--space-2xs) var(--space-sm); font-size: var(--text-sm); }
    .m-field { display: flex; flex-direction: column; gap: var(--space-3xs); font-size: var(--text-sm); color: var(--text-muted); }
    .m-input { background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: var(--space-xs); color: var(--text); font-family: var(--font-mono); font-size: var(--text-base); }
    .m-row { display: flex; gap: var(--space-xs); align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-xs) var(--space-sm); }
    .m-row.bad { border-color: var(--danger); }
    .m-row.bad small { color: var(--danger); }
    .m-grow { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    small { color: var(--text-muted); font-size: var(--text-sm); }
    .m-check { display: flex; gap: var(--space-xs); align-items: center; background: var(--surface); border-radius: var(--radius-sm); padding: var(--space-xs); }
    .m-box { width: 24px; height: 24px; border: 2px solid var(--line-strong); border-radius: var(--radius-xs); display: inline-flex; align-items: center; justify-content: center; }
    .m-box.on { background: var(--primary); color: var(--primary-text); border-color: var(--primary); }
    .m-stat { background: var(--surface); border-radius: var(--radius); padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-3xs); }
    .m-stat strong { font-size: var(--text-xl); }
    .m-dialog { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow); padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm); max-width: 460px; }
    .m-file { background: var(--gold-faint); border-radius: var(--radius-xs); padding: var(--space-2xs); font-weight: 700; font-size: var(--text-xs); }
    .m-mail { background: var(--surface); border-radius: var(--radius); padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-2xs); }
    mark { background: var(--gold-faint); padding: 0 var(--space-3xs); font-weight: 700; }
    @media (max-width: 700px) {
      .m-wrap { flex-direction: column; }
      nav { width: auto; flex-direction: row; overflow: hidden; border-right: 0; border-bottom: 1px solid var(--line); padding: var(--space-2xs); }
      nav span { white-space: nowrap; font-size: var(--text-sm); }
      main { padding: var(--space-sm); }
    }
  </style></head><body>
    <div class="m-label"><strong>Illustration</strong> of ${esc(f.site)}: what you'll see there, not a real account. Yours may look a little different.</div>
    <div class="m-bar"><span class="m-site">${esc(f.site)}</span><span class="m-url">${esc(f.url)}</span></div>
    <div class="m-wrap">${nav}<main><h1>${esc(f.title)}</h1>${f.body.map(block).join("")}</main></div>
  </body></html>`;
}
