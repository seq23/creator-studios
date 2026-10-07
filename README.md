# Creator Studios

One codebase, deployed as **separate creator studios**. Each studio is a full creator dashboard:
she dumps footage, it cuts vertical clips, she approves them, they post through Buffer to TikTok,
Instagram and YouTube on a researched schedule, and Deals finds brands and drafts pitches she sends
herself. Nothing posts unless she approves it.

Copied from `sheila-creator-dashboard` at `9b3841492a0dbf85b62ea959b9b6a5660d9b1ecb` (code only, no
git history). That repo and its deployments are never changed from here.

## The studios

Each studio has its **own Worker, its own D1 and its own R2** (full data isolation), configured by one
entry in the registry, `studios/<slug>.json`. `wrangler.jsonc` is generated from the registry.

| Studio | Slug | URL | Kind | Owner login |
| --- | --- | --- | --- | --- |
| Hadiyah Studio | `hadiyah` | https://hadiyahstudio.seq-taylor.workers.dev | host-accounts | `ownerEmail` in `studios/hadiyah.json` (see below) |
| Sample 1 Studio | `sample1` | https://sample1studio.seq-taylor.workers.dev | client | claimed with its first-login link |
| Sample 2 Studio | `sample2` | https://sample2studio.seq-taylor.workers.dev | client | claimed with its first-login link |
| Sample 3 Studio | `sample3` | https://sample3studio.seq-taylor.workers.dev | client | claimed with its first-login link |

Custom domains come later: change `url` in the entry, add the domain to the Worker, deploy.

- **Hadiyah Studio** has exactly Sheila Studio's features, on exactly Sheila's split of accounts
  (next section), with her own theme ("hadiyah" in `studios/themes.json`: malachite green and
  saffron on bone, Young Serif headings and wordmark, Hanken Grotesk text).
  **Owner email:** `ownerEmail` in `studios/hadiyah.json` is set to the host's
  `sequoia@westpeek.ventures`, as Sheila's was, until Hadiyah gives hers. To change it, edit the
  value and run `npm run studio:deploy hadiyah` (or merge it: main deploys every studio).
- **Sample 1/2/3** carry **none of the host's software**: no host API keys, data, emails or links.
  Neutral "slate" theme. Every service is the client's own, pasted on **Setup** (below).

## Hadiyah: whose account runs what

Set up exactly like Sheila Studio: **only** the services where the host gave Sheila the HOST's own
account are the host's here. Everything Sheila connected or holds in her own name is Hadiyah's own,
through the same Setup screen the samples use (stored encrypted, practice mode until connected).
Evidence was read from the Sheila repo's docs, the secret NAMES bound on the `sheilastudio` Worker
(`wrangler secret list`, names only) and the services connected in Sheila's app (her D1
`connections` table, service and status only).

| Service | Hadiyah | Evidence from Sheila Studio |
| --- | --- | --- |
| Hosting: Worker, D1, R2 | Host's Cloudflare account | `sheilastudio` runs on the host's account; studio brief: hosted on the owner's Cloudflare |
| Job runner: GitHub Actions + `GITHUB_DISPATCH_TOKEN` | Host's | Worker secret on `sheilastudio`; Sheila RUNBOOK: "GITHUB_DISPATCH_TOKEN … is Sequoia's own GitHub token"; jobs run in the host's repo |
| YouTube numbers key `YOUTUBE_API_KEY` | Host's (vault `sheila-youtube-api-key`, same key) | Worker secret on `sheilastudio`; Sheila `docs/YOUTUBE.md`: the Google project is "registered under the owner's account … the owner chose to keep it there" |
| Google sign-in app `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Host's Google project, a web client of Hadiyah's own Worker | Worker secrets on `sheilastudio`; Sheila RUNBOOK: each Worker has its own web client in the owner's project. Not yet created for Hadiyah: a NAMED STOP (RUNBOOK) |
| Login codes | Platform sender (host's Resend) | Studio brief §4 (the one shared piece) |
| Studio email (alerts, recaps) `RESEND_API_KEY` | **Hadiyah's own** (Setup → Email) | Sheila RUNBOOK: "RESEND_API_KEY on production is Sheila's own Resend account key … never a West Peek key" |
| Buffer (posting) | **Hadiyah's own** | Connected in Sheila's app (`connections.buffer` ok); Sheila BUILD_PLAN 4b: "She connects everything herself"; named by the host |
| OpenRouter (AI writing) | **Hadiyah's own** | Connected in Sheila's app (`connections.openrouter` ok). Sheila's repo also had a host `OPENROUTER_API_KEY` GitHub secret as a job fallback; not carried: jobs get the studio's own key in their signed spec |
| Firecrawl (web research) | **Hadiyah's own** | Connected in Sheila's app (`connections.firecrawl` ok) |
| Hunter (brand contacts) | **Hadiyah's own** | Connected in Sheila's app (`connections.hunter` ok) |
| YouTube channel (Connect YouTube, full videos) | **Hadiyah's own** | Sheila signs in with her own Google account in the app; named by the host |
| ElevenLabs, connected editors | **Hadiyah's own** | Pasted in Sheila's app (Settings → Connect accounts) |
| Instagram sign-in app (`META_APP_*`) | Not set (as Sheila); Setup if she wants it | No `META_APP_*` secret on `sheilastudio` |

## Platform sender (the only shared piece)

A new studio has no email service, yet its owner must get her login code. So **login codes, and only
login codes**, go through the PLATFORM sender: the host's Resend, Worker secrets
`PLATFORM_RESEND_API_KEY` + `PLATFORM_EMAIL_FROM` on every studio (`worker/services/email.ts`
`senderFor`). Every other email a studio sends uses **that studio's own Resend** (Setup → Email);
until it has one, those emails are listed on its health board, never sent (practice mode). Nothing
else is shared between studios. Guard: `tests/unit/login.test.ts`.

## Login

Every studio: email one-time code (6 digits, 10 minutes), never "open" (validator
`login-never-open`). A sample studio has no owner until its **first-login link** is used:
`npm run studio:invite <slug>` mints one (single use, 14 days; only its SHA-256 is stored), and the
address typed there becomes the owner login.

## Setup and practice mode

Each studio has a **Setup** screen: one card per service (Email, Posting, AI writing, Web research,
Brand contacts, YouTube numbers, Google sign-in, Instagram sign-in, Clip cutting, Premium voice) with
where to get the key, **Test key** (one live read-only request, nothing saved) and **Save** (checked
again, then stored AES-GCM encrypted in D1 with the studio's `SECRETS_KEY`). At runtime a key is read
from encrypted storage FIRST, then from Worker secrets (`worker/lib/practice.ts`). A service with no
key runs in **practice mode**: labelled on every screen and on Setup, never an error (posting waits
safely on the Calendar, AI writes starter drafts, the practice cutter makes sample clips, emails are
listed not sent, sign-ins are practice connections, YouTube numbers wait with a named light).

## Add a studio

```bash
# 1. one registry entry (copy studios/sample1.json; kind "client" for a client)
cp studios/sample1.json studios/<slug>.json   # edit slug, worker, url, appName, theme
# 2. one command: creates its D1 + R2, migrates, deploys, sets its secrets, smokes it,
#    and prints its URL and (for a client) its first-login link
npm run studio:create <slug>
```

## Deploy

- Every PR: `check.yml` (typecheck, unit, validators, build, bundle scan; under 5 min).
- Green `main`: `deploy.yml` deploys **every studio** with `npm run deploy:all`.
- By hand: `npm run studio:deploy <slug>` or `npm run deploy:all` (build once → each studio's D1
  migrations → `wrangler deploy --env <slug>` → smoke). **Never a bare `wrangler deploy`.**
- No staging. The full browser suite (`e2e.yml`) runs nightly and on dispatch, post-merge.

## Secrets

Never in the repo. `npm run studio:secrets <slug>` sets what a studio is missing, values piped from
the vault (Keychain, through the vault's keychain adapter) or generated, straight into
`wrangler secret put` on stdin. Per studio: `SESSION_SECRET`, `SECRETS_KEY`, `JOB_SHARED_SECRET`
(generated), `PLATFORM_RESEND_API_KEY` + `PLATFORM_EMAIL_FROM` (platform sender), and for
host-accounts studios the `hostSecrets` in the entry. GitHub: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` (deploy), `JOB_SHARED_SECRET_<SLUG>` (host-run job runner).

## Guards

| Guard | Where | Negative proof |
| --- | --- | --- |
| (a) a client studio carries no host identifier (emails, names, West Peek, Sheila, the host's channel/account ids, host keys as secrets) | validator `sample-clean`, `scripts/bundle-scan.mjs` (built client + Worker bundle), live secret check in `studio:deploy` | `tests/unit/studios.test.ts` |
| (b) studio A's D1/R2 are never studio B's | validator `studio-isolation` | `tests/unit/studios.test.ts` |
| (c) login is never "open" | validator `login-never-open` | `tests/unit/login.test.ts` |
| (d) every feature without a key shows practice mode | `tests/unit/practice.test.ts` (an empty real studio through the real Worker: no 5xx, no vendor call) | `tests/unit/practice.test.ts` |
| nothing hidden, nothing switched off | validator `nothing-hidden` | (inherited) |

## Run it locally

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run build && npm run dev        # http://localhost:8787, fakes on, the code shows on the login screen
npm run check                       # the merge gate
npm run e2e                         # Playwright, phone + desktop, fake services
```

## Public-repo rules

Logs carry step names, counts and pass/fail only (`worker/lib/log.ts`, `jobs/common.py`). A studio's
data lives only in its own D1 and R2. Keys live only in Worker secrets, GitHub secrets and each
studio's encrypted D1. Jobs start only from a studio's Worker with a signed payload and reach storage
only through that Worker.
