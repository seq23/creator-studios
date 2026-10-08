// The Setup screen's steps: one per outside service a studio runs on. The ONE list both the
// Worker (worker/lib/practice.ts: which services are in practice mode, which secrets back them)
// and the app (app/pages/Setup.tsx: the guided screen) read. A service with no key runs in
// practice mode (clearly labelled, never an error) until its key is pasted here.
//
// Keys pasted on Setup are checked live (read-only), then stored AES-GCM encrypted in D1
// (connections.secret_enc, SECRETS_KEY). At runtime the encrypted key is read FIRST, then the
// Worker secret named in `secrets` (how a studio the host runs on the host's own accounts gets them).

export type SetupServiceId = "resend" | "buffer" | "openrouter" | "firecrawl" | "hunter" | "youtube_api" | "google_app" | "meta_app" | "github" | "elevenlabs";

export interface SetupField {
  /** Key inside the stored value. A one-field step stores the bare key; a multi-field step stores JSON. */
  name: string;
  label: string;
  placeholder: string;
  /** Not secret (shown back on the card, kept in meta): a repo name, a From address. */
  plain?: boolean;
  optional?: boolean;
}

export interface SetupStep {
  id: SetupServiceId;
  title: string;
  /** What it powers, in plain words. */
  powers: string;
  /** What practice mode does until the key is set. */
  practice: string;
  /** Where to get the key: short numbered steps. */
  where: string[];
  /** The vendor page that opens in a new tab. */
  link: { label: string; url: string };
  fields: SetupField[];
  /** Worker secrets that back this service when no key is stored (read second). */
  secrets: string[];
  /** Help guide slug (help/guides/<slug>.md). */
  guide: string;
  /** Free plan is enough. */
  free: boolean;
}

const KEY: SetupField = { name: "key", label: "API key", placeholder: "Paste the key" };

export const SETUP_STEPS: SetupStep[] = [
  {
    id: "resend",
    title: "Email",
    powers: "Your alerts, weekly recap and “clips are ready” emails, sent from your own Resend account.",
    practice: "Emails are written and listed on the health board, but not sent.",
    where: ["Make a free account at resend.com.", "Open API Keys and tap Create API key (Full access lets the check read your domains).", "Copy the key and paste it here. Add a From address on a domain you verified in Resend, or leave it empty to use Resend's test sender."],
    link: { label: "Open Resend API keys", url: "https://resend.com/api-keys" },
    fields: [KEY, { name: "from", label: "From address (optional)", placeholder: "Studio <hello@yourdomain.com>", plain: true, optional: true }],
    secrets: ["RESEND_API_KEY"],
    guide: "setup-email",
    free: true,
  },
  {
    id: "buffer",
    title: "Posting (Buffer)",
    powers: "Posts your approved clips to TikTok, Instagram and YouTube on the schedule.",
    practice: "Approved clips are planned on the Calendar and wait safely. Nothing is posted until Buffer is set up.",
    where: ["Log in at buffer.com and add your TikTok, Instagram and YouTube channels.", "Open Settings, then API, and create a key.", "Copy it and paste it here."],
    link: { label: "Open Buffer", url: "https://buffer.com" },
    fields: [KEY],
    secrets: [],
    guide: "connect-buffer",
    free: true,
  },
  {
    id: "openrouter",
    title: "AI writing (OpenRouter)",
    powers: "Writes captions, the research brief, pitch drafts and voice-over scripts with free AI models.",
    practice: "Starter text is used instead of AI drafts, marked as a practice draft.",
    where: ["Make a free account at openrouter.ai.", "Open Keys and tap Create Key; leave the credit limit empty.", "Copy the key and paste it here."],
    link: { label: "Open OpenRouter keys", url: "https://openrouter.ai/settings/keys" },
    fields: [KEY],
    // Read only on a host-accounts studio (worker/lib/hostKeys.ts); a client studio never has it.
    secrets: ["OPENROUTER_API_KEY"],
    guide: "connect-openrouter",
    free: true,
  },
  {
    id: "firecrawl",
    title: "Web research (Firecrawl)",
    powers: "Reads brand and niche websites for the research brief and the brand finder.",
    practice: "Research uses the free keyless search instead.",
    where: ["Make a free account at firecrawl.dev.", "Open the dashboard and copy your API key.", "Paste it here."],
    link: { label: "Open Firecrawl", url: "https://www.firecrawl.dev/app/api-keys" },
    fields: [KEY],
    // Read only on a host-accounts studio (worker/lib/hostKeys.ts); a client studio never has it.
    secrets: ["FIRECRAWL_API_KEY"],
    guide: "connect-firecrawl",
    free: true,
  },
  {
    id: "hunter",
    title: "Brand contacts (Hunter)",
    powers: "Finds public partnership emails on a brand's website for Deals.",
    practice: "Deals shows where to look by hand; no contact search runs.",
    where: ["Make a free account at hunter.io.", "Open API and copy your key.", "Paste it here."],
    link: { label: "Open Hunter API", url: "https://hunter.io/api-keys" },
    fields: [KEY],
    // Read only on a host-accounts studio (worker/lib/hostKeys.ts); a client studio never has it.
    secrets: ["HUNTER_API_KEY"],
    guide: "connect-hunter",
    free: true,
  },
  {
    id: "youtube_api",
    title: "YouTube numbers",
    powers: "Reads your public YouTube channel and video numbers for Stats. No Google sign-in.",
    practice: "Stats says YouTube numbers are waiting for this key; everything else on Stats works.",
    where: ["Open console.cloud.google.com and make a project.", "APIs & Services → Library → YouTube Data API v3 → Enable.", "Credentials → Create credentials → API key; restrict it to the YouTube Data API v3.", "Copy it and paste it here."],
    link: { label: "Open Google Cloud credentials", url: "https://console.cloud.google.com/apis/credentials" },
    fields: [KEY],
    secrets: ["YOUTUBE_API_KEY"],
    guide: "setup-youtube-numbers",
    free: true,
  },
  {
    id: "google_app",
    title: "Google sign-in (YouTube uploads)",
    powers: "Lets you connect your YouTube channel so full videos upload straight to it.",
    practice: "Connect YouTube makes a practice connection; uploads are simulated.",
    where: ["In console.cloud.google.com, APIs & Services → OAuth consent screen: make it External.", "Credentials → Create credentials → OAuth client ID → Web application.", "Add the redirect address shown below, then copy the Client ID and Client secret here."],
    link: { label: "Open Google Cloud credentials", url: "https://console.cloud.google.com/apis/credentials" },
    fields: [
      { name: "client_id", label: "Client ID", placeholder: "…apps.googleusercontent.com", plain: true },
      { name: "client_secret", label: "Client secret", placeholder: "GOCSPX-…" },
    ],
    secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    guide: "setup-google-sign-in",
    free: true,
  },
  {
    id: "meta_app",
    title: "Instagram sign-in (stats)",
    powers: "Lets you connect Instagram for extra stats detail.",
    practice: "Connect Instagram makes a practice connection with sample numbers.",
    where: ["Open developers.facebook.com → My Apps → Create app (Business).", "Add Instagram (Instagram Login) and add the redirect address shown below.", "App settings → Basic: copy the App ID and App secret here."],
    link: { label: "Open Meta for Developers", url: "https://developers.facebook.com/apps" },
    fields: [
      { name: "app_id", label: "App ID", placeholder: "1234567890", plain: true },
      { name: "app_secret", label: "App secret", placeholder: "Paste the app secret" },
    ],
    secrets: ["META_APP_ID", "META_APP_SECRET"],
    guide: "setup-instagram-sign-in",
    free: true,
  },
  {
    id: "github",
    title: "Clip cutting (job runner)",
    powers: "Cuts your footage into clips, makes full videos and voice overs on GitHub Actions (free for public repositories).",
    practice: "Clips are cut by the practice cutter: sample clips appear so you can try Review.",
    where: ["Make a free account at github.com and copy the studio job repository your host gives you (Use this template).", "In that copy: Settings → Secrets and variables → Actions → New secret JOB_SHARED_SECRET with the value shown below.", "github.com → Settings → Developer settings → Fine-grained tokens: only that repository, Contents read and write.", "Paste the token and the repository (owner/name) here."],
    link: { label: "Open GitHub tokens", url: "https://github.com/settings/personal-access-tokens/new" },
    fields: [
      { name: "token", label: "Token", placeholder: "github_pat_…" },
      { name: "repo", label: "Repository", placeholder: "your-name/your-studio-jobs", plain: true },
    ],
    secrets: ["GITHUB_DISPATCH_TOKEN"],
    guide: "setup-job-runner",
    free: true,
  },
  {
    id: "elevenlabs",
    title: "Premium voice (ElevenLabs)",
    powers: "Voice overs in your own cloned voice, in seconds.",
    practice: "The built-in voice is used.",
    where: ["Make an account at elevenlabs.io (cloning needs a paid plan).", "Profile → API keys → Create API key.", "Copy it and paste it here."],
    link: { label: "Open ElevenLabs keys", url: "https://elevenlabs.io/app/settings/api-keys" },
    fields: [KEY],
    secrets: [],
    guide: "connect-elevenlabs",
    free: false,
  },
];

export const SETUP_IDS: SetupServiceId[] = SETUP_STEPS.map((s) => s.id);
export const setupStep = (id: string): SetupStep | undefined => SETUP_STEPS.find((s) => s.id === id);

/** One step's state as GET /api/setup reports it. */
export interface SetupStatus {
  id: SetupServiceId;
  /** "live": a key you pasted works · "provided": your studio host set it up for you · "practice": no key yet · "error": the stored key stopped working. */
  state: "live" | "provided" | "practice" | "error";
  /** Non-secret parts of the stored value (repo, From address, client id). */
  shown: Record<string, string>;
  last_error: string | null;
}

export interface SetupView {
  steps: SetupStatus[];
  /** Where Google / Meta send the owner back after sign-in: registered on the app. */
  redirects: { google: string; meta: string };
  /** The value the job repository's JOB_SHARED_SECRET must hold (owner only). */
  job_secret: string | null;
}
