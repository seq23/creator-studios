# RUNBOOK — creator-studios

"runbook creator-studios" opens this. What it is and why: `README.md`. Rules: `CLAUDE.md`.

## Named stops

Only a secret or an account the host alone holds stops anything; each one is here with the
paste-ready command, and nothing else waits on it (the feature runs in practice mode meanwhile).

1. **Hadiyah's Google sign-in client** (YouTube uploads straight to her channel). It lives in the
   host's Google Cloud project, like Sheila's, and a web OAuth client can only be created in the
   console with the host's Google login. Until then Hadiyah's Connect YouTube is a practice
   connection. In console.cloud.google.com → project `sheilastudio-staging-p0` → APIs & Services →
   Credentials → Create credentials → OAuth client ID → Web application, name "hadiyahstudio",
   authorized redirect URI `https://hadiyah-studio.spryexecutiveos.com/api/oauth/google/callback`
   (the studio's own hostname; it is also shown on Hadiyah's Setup → Google sign-in),
   then either paste the Client ID and secret on Hadiyah's Setup → Google sign-in, or put them in
   0600 secret files (README "Secrets") and set them:
   ```bash
   D=${CS_SECRETS_DIR:-~/.config/creator-studios/secrets}; mkdir -p "$D" && chmod 700 "$D"
   (umask 077; read -rs -p 'Client ID: ' V && printf '%s' "$V" > "$D/HADIYAH_GOOGLE_CLIENT_ID"); echo
   (umask 077; read -rs -p 'Client secret: ' V && printf '%s' "$V" > "$D/HADIYAH_GOOGLE_CLIENT_SECRET"); echo
   cd ~/GitHub/creator-studios && npm run studio:secrets hadiyah
   ```

## The studios

`node scripts/studio.mjs list`. One registry entry each in `studios/`; `wrangler.jsonc` is
generated (`npm run studio:gen`).

| Studio | Address (Workers Custom Domain, zone `spryexecutiveos.com`) | Old address |
| --- | --- | --- |
| Hadiyah | https://hadiyah-studio.spryexecutiveos.com | https://hadiyahstudio.seq-taylor.workers.dev → 301 |
| Sample 1 | https://sample1-studio.spryexecutiveos.com | https://sample1studio.seq-taylor.workers.dev → 301 |
| Sample 2 | https://sample2-studio.spryexecutiveos.com | https://sample2studio.seq-taylor.workers.dev → 301 |
| Sample 3 | https://sample3-studio.spryexecutiveos.com | https://sample3studio.seq-taylor.workers.dev → 301 |

The hostname is the `hostname` field of the registry entry; renaming a studio is that field plus
`npm run studio:deploy <slug>` (README "Rename a studio"). Only these four names on the zone belong
to this repo: the apex site and the `mail.` email records are not ours and are never touched.

Platform sender (login codes only): `Studio sign-in <login@mail.spryexecutiveos.com>`, the host's own
Resend account (sending-only key in the 0600 file `PLATFORM_RESEND_API_KEY`). Change it on every
studio: `node scripts/studio.mjs secrets --all --refresh --only=PLATFORM_RESEND_API_KEY,PLATFORM_EMAIL_FROM`.

D1 `creator-studios-<slug>-db`, R2 `creator-studios-<slug>-files`, Worker `<slug>studio`, all on the host's Cloudflare account `8d147e242033699dd37c6f5a451f48d2`.

## Common tasks

```bash
npm run studio:create <slug>        # new studio: D1 + R2, migrate, deploy, secrets, smoke, URL + link
npm run studio:deploy <slug>        # one studio (build, migrate, deploy, smoke)
npm run deploy:all                  # every studio (what deploy.yml runs on green main)
npm run studio:secrets <slug>       # set the secrets it is missing (never rotates SECRETS_KEY)
npm run studio:invite <slug>        # a new first-login link for a client studio (single use, 14 days)

# read a studio's D1 (example: who owns sample1, which services are set up; never secret values)
npx wrangler d1 execute creator-studios-sample1-db --remote --env sample1 --json \
  --command "SELECT key, value FROM settings WHERE key = 'owner_email'"
npx wrangler d1 execute creator-studios-sample1-db --remote --env sample1 --json \
  --command "SELECT service, status, updated_at FROM connections"

# live logs of one studio
npx wrangler tail --env hadiyah --format pretty
```

### Prove a login code went out (without reading anyone's inbox)

```bash
# 1. ask for a code through the real form's endpoint
curl -s -X POST https://hadiyah-studio.spryexecutiveos.com/api/auth/request \
  -H 'content-type: application/json' -d "{\"email\":\"$(cat ~/.config/creator-studios/secrets/hadiyah/OWNER_EMAIL)\"}"
# 2. the provider id the Worker recorded for it
npx wrangler d1 execute creator-studios-hadiyah-db --remote --env hadiyah --json \
  --command "SELECT provider_id, sent_at FROM emails_sent WHERE kind = 'login_code' ORDER BY sent_at DESC LIMIT 1"
# 3. Resend's own record of it (platform key from its 0600 secret file, piped, never shown)
cat "${CS_SECRETS_DIR:-$HOME/.config/creator-studios/secrets}/PLATFORM_RESEND_API_KEY" \
  | (read -r K; curl -s "https://api.resend.com/emails/<provider_id>" -H "Authorization: Bearer $K") | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("last_event"), d.get("created_at"))'
```

## Secrets per studio

| Name | Where from | Studios |
| --- | --- | --- |
| `SESSION_SECRET`, `JOB_SHARED_SECRET` | generated at create | all |
| `SECRETS_KEY` | generated at create; **never rotate** (it decrypts every key pasted on Setup) | all |
| `PLATFORM_RESEND_API_KEY` | secret file `PLATFORM_RESEND_API_KEY` (host's own Resend, sending-only, domain `mail.spryexecutiveos.com`) | all (login codes only) |
| `PLATFORM_EMAIL_FROM` | `Studio sign-in <login@mail.spryexecutiveos.com>` (`PLATFORM_FROM`, `scripts/studio.mjs`) | all |
| `OWNER_EMAIL` | secret file `<slug>/OWNER_EMAIL` (never committed; README "Owner email") | hadiyah (required); a client only if set |
| `DEVELOPER_EMAIL` | shared secret file `DEVELOPER_EMAIL` (`<slug>/DEVELOPER_EMAIL` overrides; never committed; README "Login"): the host developer's email-code login, full access, never claims a studio | all (required) |
| `GITHUB_DISPATCH_TOKEN` | `gh auth token` (host's GitHub) | hadiyah |
| `YOUTUBE_API_KEY` | secret file `YOUTUBE_API_KEY` (host's Google project, Sheila's key) | hadiyah |
| `OPENROUTER_API_KEY` | secret file `hadiyah/OPENROUTER_API_KEY` (host's personal OpenRouter, key `creator-studios-hadiyah`, $10 credit limit) | hadiyah only |
| `RESEND_API_KEY` | secret file `hadiyah/RESEND_API_KEY` (host's personal Resend, sending-only key `creator-studios-hadiyah-email`, domain `mail.spryexecutiveos.com`) | hadiyah only |
| `STUDIO_EMAIL_FROM` | secret file `hadiyah/STUDIO_EMAIL_FROM` (the studio sender `Hadiyah Studio` on `mail.spryexecutiveos.com`; replies go to `DEVELOPER_EMAIL`) | hadiyah only |
| `FIRECRAWL_API_KEY` | secret file `hadiyah/FIRECRAWL_API_KEY` (host's personal Firecrawl) | hadiyah only |
| `HUNTER_API_KEY` | secret file `hadiyah/HUNTER_API_KEY` (host's personal Hunter) | hadiyah only |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secret files `HADIYAH_GOOGLE_CLIENT_ID` / `HADIYAH_GOOGLE_CLIENT_SECRET` when present (named stop 1) | hadiyah |

The five host-key files live in `~/.config/creator-studios/secrets/hadiyah/` (0600). A client studio
never carries them: `secretPlan` refuses them and the Worker strips them on a client even if set
(`worker/lib/hostKeys.ts`, owner decision 7 Oct 2026). To rotate one: write the new value to its file,
then `node scripts/studio.mjs secrets hadiyah --refresh --only=<NAME>`.

GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (already set; the deploy token),
`CLOUDFLARE_ACCOUNT_ID`, `JOB_SHARED_SECRET_HADIYAH` (set by `studio:create`; the job workflows pick
`JOB_SHARED_SECRET_<STUDIO>` from the dispatch). A client studio's jobs run in the client's own
repository (Setup → Clip cutting), never here; until then its practice cutter runs in the Worker.

## Deploy pipeline

`check.yml` on every PR and push (merge gate, under 5 min) → on a green `check` of a push to main,
`deploy.yml` runs `npm run deploy:all`. `e2e.yml` (Playwright + help pictures) runs nightly at
07:17 UTC and on dispatch: `gh workflow run e2e.yml --ref main`. A red e2e is fixed first.

## When something is red

- **A studio's smoke failed** (`studio:deploy` says which check): `/healthz` must say
  `{"fake":false,"studio":"<slug>","login":"code"}`, `/api/me` must be 401 without a login, `/`
  200, `/studio-theme.css` a theme, `/api/studio` the registry's name. `npx wrangler tail --env <slug>`.
- **bundle-scan failed**: a host identifier reached shipped code. Remove it at the source; never
  add an exception for a client-shipped file.
- **A client studio has a host key bound** (`studio:deploy` refuses): `npx wrangler secret delete <NAME> --env <slug>`.
- **Login code not arriving**: the Email light does not cover login codes (platform sender). Check
  step 2 above: no `provider_id` means Resend refused it; `npx wrangler tail --env <slug>` shows
  `email.send` with `ok:false`.
