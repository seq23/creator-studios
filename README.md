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
| Hadiyah Studio | `hadiyah` | https://hadiyah-studio.spryexecutiveos.com | host-accounts | deploy-time `OWNER_EMAIL` (see "Owner email") |
| Sample 1 Studio | `sample1` | https://sample1-studio.spryexecutiveos.com | client | claimed with its first-login link |
| Sample 2 Studio | `sample2` | https://sample2-studio.spryexecutiveos.com | client | claimed with its first-login link |
| Sample 3 Studio | `sample3` | https://sample3-studio.spryexecutiveos.com | client | claimed with its first-login link |

**Domains.** Each studio answers on its own `hostname` (a field in its registry entry), attached to
its Worker as a **Workers Custom Domain** on the host's Cloudflare zone `spryexecutiveos.com`
(generated `routes: [{ pattern, custom_domain: true }]`; Cloudflare makes the DNS record and the
certificate). `PUBLIC_BASE_URL` (links in emails, the session cookie's host, every OAuth redirect URI)
is `https://<hostname>`, derived, never typed. The old `https://<worker>.seq-taylor.workers.dev`
addresses stay on and **301 to the hostname** for every page (`worker/lib/canonical-host.ts`; one
address means one login cookie and one OAuth redirect URI); `/api/*` on the old address is still
answered, never redirected, so a job dispatched before a move still calls back. `studio:deploy`'s
smoke proves the 301. Nothing else on the zone is touched (the apex site and the
`mail.spryexecutiveos.com` email records belong to other things).

- **Hadiyah Studio** has exactly Sheila Studio's features, on exactly Sheila's split of accounts
  (next section), with her own theme ("hadiyah" in `studios/themes.json`: malachite green and
  saffron on bone, Young Serif headings and wordmark, Hanken Grotesk text).
  **Owner email:** never in this public repo; see "Owner email" below.
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
| YouTube numbers key `YOUTUBE_API_KEY` | Host's (Sheila's key, same key; secret file `YOUTUBE_API_KEY`) | Worker secret on `sheilastudio`; Sheila `docs/YOUTUBE.md`: the Google project is "registered under the owner's account … the owner chose to keep it there" |
| Google sign-in app `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Host's Google project, a web client of Hadiyah's own Worker | Worker secrets on `sheilastudio`; Sheila RUNBOOK: each Worker has its own web client in the owner's project. Not yet created for Hadiyah: a NAMED STOP (RUNBOOK) |
| Login codes | Platform sender (host's Resend) | Studio brief §4 (the one shared piece) |
| Studio email (alerts, recaps) `RESEND_API_KEY` | **Hadiyah's own** (Setup → Email) | Sheila RUNBOOK: "RESEND_API_KEY on production is Sheila's own Resend account key", never a host key |
| Buffer (posting) | **Hadiyah's own** | Connected in Sheila's app (`connections.buffer` ok); Sheila BUILD_PLAN 4b: "She connects everything herself"; named by the host |
| OpenRouter (AI writing) | **Hadiyah's own** | Connected in Sheila's app (`connections.openrouter` ok). Sheila's repo also had a host `OPENROUTER_API_KEY` GitHub secret as a job fallback; not carried: jobs get the studio's own key in their signed spec |
| Firecrawl (web research) | **Hadiyah's own** | Connected in Sheila's app (`connections.firecrawl` ok) |
| Hunter (brand contacts) | **Hadiyah's own** | Connected in Sheila's app (`connections.hunter` ok) |
| YouTube channel (Connect YouTube, full videos) | **Hadiyah's own** | Sheila signs in with her own Google account in the app; named by the host |
| ElevenLabs, connected editors | **Hadiyah's own** | Pasted in Sheila's app (Settings → Connect accounts) |
| Instagram sign-in app (`META_APP_*`) | Not set (as Sheila); Setup if she wants it | No `META_APP_*` secret on `sheilastudio` |

## Platform sender (the only shared piece)

A new studio has no email service, yet its owner must get her login code. So **login codes, and only
login codes**, go through the PLATFORM sender: the host's own Resend account, sending from
**`Studio sign-in <login@mail.spryexecutiveos.com>`** (domain `mail.spryexecutiveos.com`, verified in
that Resend account; the name is neutral because every studio, client or not, sends through it;
`PLATFORM_FROM` in `scripts/studio.mjs`, the one place it is written). Worker secrets
`PLATFORM_RESEND_API_KEY` + `PLATFORM_EMAIL_FROM` on every studio (`worker/services/email.ts`
`senderFor`). Every other email a studio sends uses **that studio's own Resend** (Setup → Email);
until it has one, those emails are listed on its health board, never sent (practice mode). Nothing
else is shared between studios. Guard: `tests/unit/login.test.ts`.

To change the sender (a new key in the 0600 file `PLATFORM_RESEND_API_KEY`, or a new address in
`PLATFORM_FROM`): `node scripts/studio.mjs secrets --all --refresh --only=PLATFORM_RESEND_API_KEY,PLATFORM_EMAIL_FROM` re-puts both on every studio
(without `--only`, every secret with a source on this machine; generated ones such as `SECRETS_KEY`
are never rotated, and one with no source here is kept as the Worker has it).

## Owner email

The owner's login email is **never committed** (this repo is public): it is a deploy-time Worker
secret `OWNER_EMAIL`, set by `npm run studio:secrets <slug>` from the 0600 file
`~/.config/creator-studios/secrets/<slug>/OWNER_EMAIL` (or the env var `OWNER_EMAIL_<SLUG>`). A
host-run studio (Hadiyah) needs it: without the file, `studio:secrets`/`studio:create` stop, naming
the file. A client studio normally has none: its owner claims it with the first-login link (the
claimed address, in its D1, wins over `OWNER_EMAIL`). To change an owner email: write the file, then
`node scripts/studio.mjs secrets <slug> --refresh`; deleting a client's file and refreshing removes
the secret. Guard: validator `registry-no-emails` fails on any email address in `studios/*.json`
other than the placeholder `owner@studio.example` (used only by local dev), and on an `ownerEmail`
field; `tests/unit/studios.test.ts` proves it negatively. Validator `no-personal-emails` fails on a
real person's email address anywhere in the tracked files (only reserved example domains and a short
list of sender/placeholder addresses pass) and, on this machine, on the value of any local
`*EMAIL` secret file (`DEVELOPER_EMAIL`, `<slug>/OWNER_EMAIL`).

## Login

Every studio: email one-time code (6 digits, 10 minutes), never "open" (validator
`login-never-open`). A sample studio has no owner until its **first-login link** is used:
`npm run studio:invite <slug>` mints one (single use, 14 days; only its SHA-256 is stored), and the
address typed there becomes the owner login.

**Developer login.** Every studio (claimed or not) also lets the host developer in with the same
email code, full access: the Worker secret `DEVELOPER_EMAIL`, set by `npm run studio:secrets <slug>`
from the shared 0600 file `~/.config/creator-studios/secrets/DEVELOPER_EMAIL` (a per-studio
`<slug>/DEVELOPER_EMAIL` overrides it; env `DEVELOPER_EMAIL_<SLUG>` or `DEVELOPER_EMAIL` also work),
never committed. It never claims a studio or changes its owner: on an unclaimed sample she logs in
and the first-login link stays valid for the owner (typed into the link itself, it only sends her a
code). Any other address gets the same answer as before and no code. Changed address: rewrite the
file, then `node scripts/studio.mjs secrets --all --refresh --only=DEVELOPER_EMAIL`. Guards:
`tests/unit/login.test.ts`, `tests/unit/studios.test.ts`.

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
cp studios/sample1.json studios/<slug>.json   # edit slug, worker, hostname, appName, theme; drop d1.id
# 2. one command: creates its D1 + R2, migrates, deploys (attaching its hostname), sets its
#    secrets, smokes it, and prints its URL and (for a client) its first-login link
npm run studio:create <slug>
```

A host-run studio also needs its owner email file first (see "Owner email").

## Rename a studio (a sample taken by a client)

One registry change, one command. Edit `hostname` (and `appName`, `theme`, `ownerName` as wanted) in
`studios/<slug>.json`, then `npm run studio:deploy <slug>` (or merge it: green main deploys every
studio). The new hostname is attached on deploy and `PUBLIC_BASE_URL` follows it. Then: the old
hostname, if Cloudflare still lists it (Workers → the Worker → Settings → Domains), is removed there;
the studio's own Google/Meta sign-in clients need the new redirect URIs
`https://<hostname>/api/oauth/google/callback` and `/api/oauth/meta/callback` (Setup shows them).
The slug, Worker, D1 and R2 names never change (renaming them would orphan the data).

## Deploy

- Every PR: `check.yml` (typecheck, unit, validators, build, bundle scan; under 5 min).
- Green `main`: `deploy.yml` deploys **every studio** with `npm run deploy:all`.
- By hand: `npm run studio:deploy <slug>` or `npm run deploy:all` (build once → each studio's D1
  migrations → `wrangler deploy --env <slug>` → smoke). **Never a bare `wrangler deploy`.**
- No staging. The full browser suite (`e2e.yml`) runs nightly and on dispatch, post-merge.

## Secrets

Never in the repo. `npm run studio:secrets <slug>` sets what a studio is missing, values piped
straight into `wrangler secret put` on stdin, never printed and never from the macOS Keychain.
A value comes from an environment variable of the same name, else a 0600 file
`~/.config/creator-studios/secrets/<NAME>` (directory overridable with `CS_SECRETS_DIR`); a missing
one is a NAMED STOP naming the file to create. Generated secrets are made with crypto randomness and
kept in 0600 files `<secrets dir>/<slug>/<NAME>`. Files: `PLATFORM_RESEND_API_KEY` (all),
`<slug>/OWNER_EMAIL` (host-run studios; optional for a client), and for
Hadiyah `YOUTUBE_API_KEY`, `HADIYAH_GOOGLE_CLIENT_ID`, `HADIYAH_GOOGLE_CLIENT_SECRET` (optional). Per studio: `SESSION_SECRET`, `SECRETS_KEY`, `JOB_SHARED_SECRET`
(generated), `PLATFORM_RESEND_API_KEY` + `PLATFORM_EMAIL_FROM` (platform sender), `OWNER_EMAIL`, and for
host-accounts studios the `hostSecrets` in the entry. GitHub: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` (deploy), `JOB_SHARED_SECRET_<SLUG>` (host-run job runner).

## Guards

| Guard | Where | Negative proof |
| --- | --- | --- |
| (a) a client studio carries no host identifier (emails, names, the host's former business name, Sheila, the host's channel/account ids, host keys as secrets) | validator `sample-clean`, `scripts/bundle-scan.mjs` (built client + Worker bundle), live secret check in `studio:deploy` | `tests/unit/studios.test.ts` |
| (b) studio A's D1/R2 are never studio B's | validator `studio-isolation` | `tests/unit/studios.test.ts` |
| (c) login is never "open" | validator `login-never-open` | `tests/unit/login.test.ts` |
| (d) every feature without a key shows practice mode | `tests/unit/practice.test.ts` (an empty real studio through the real Worker: no 5xx, no vendor call) | `tests/unit/practice.test.ts` |
| nothing hidden, nothing switched off | validator `nothing-hidden` | (inherited) |
| no owner email committed in the registry | validator `registry-no-emails` | `tests/unit/studios.test.ts` |
| the host's former business name nowhere in the repo (every tracked file) | validator `no-host-brand` | `tests/unit/studios.test.ts` |
| an old workers.dev page 301s to the studio's hostname; the API is never redirected | `worker/lib/canonical-host.ts`, smoke in `studio:deploy` | `tests/unit/canonical-host.test.ts` |

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
