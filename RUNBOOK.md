# RUNBOOK — creator-studios

"runbook creator-studios" opens this. What it is and why: `README.md`. Rules: `CLAUDE.md`.

## Named stops

Only a secret or an account the host alone holds stops anything; each one is here with the
paste-ready command, and nothing else waits on it (the feature runs in practice mode meanwhile).

1. **Porch & Party Studio's own OpenRouter key** (AI writing; owner's word 22 Oct 2026). Creating
   an API key needs the host's logged-in OpenRouter page and shows the key once, so only the host
   can copy it. Until then AI writing on Porch & Party runs on starter text (practice). At
   openrouter.ai → Keys → New Key: name `creator-studios-pnp`, Expiration 180 days, Credit limit →
   Custom amount `0` (free models only; $0 can never be spent), Create, Copy. Then in Terminal:
   `pbpaste > ~/.config/creator-studios/secrets/sample1/OPENROUTER_API_KEY && chmod 600 ~/.config/creator-studios/secrets/sample1/OPENROUTER_API_KEY && npm run studio:secrets sample1 -- --only=OPENROUTER_API_KEY`
2. **Porch & Party Studio's own Resend key** (studio email). It sends today with the host's
   sending-only studio key (the same Resend account and domain as Hadiyah's, from its own
   From address in the 0600 file STUDIO_EMAIL_FROM). A key of its own needs the host's Resend login: resend.com →
   API Keys → Create API key, name `creator-studios-pnp-email`, Sending access, domain
   mail.spryexecutiveos.com, Add, Copy. Then:
   `pbpaste > ~/.config/creator-studios/secrets/sample1/RESEND_API_KEY && chmod 600 ~/.config/creator-studios/secrets/sample1/RESEND_API_KEY && npm run studio:secrets sample1 -- --refresh --only=RESEND_API_KEY`
3. **Hadiyah's Google sign-in client** (YouTube uploads straight to her channel). It lives in the
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

4. **Photo posts: the platform tokens** (Porch & Party `sample1` and Hadiyah; shared/photoPosts.ts).
   Posts are planned, get their heads-up and Skip, then WAIT ("Connect Facebook" on Photos, a grey
   "Photo posts (<platform>)" light) until each token exists. None is in the vault or the secrets
   folder yet (checked by name 22 Oct 2026). Each is the account owner's own:
   - **Facebook** `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_TOKEN`: a long-lived Page token with
     `pages_manage_posts`, pasted on that studio's Setup → Facebook Page (checked live, stored
     encrypted; the Worker secrets of the same names are read second).
   - **Pinterest** `PINTEREST_ACCESS_TOKEN` + `PINTEREST_BOARD_ID` (Setup → Pinterest). Porch &
     Party has no Pinterest business account yet; creating one is the owner's.
   - **Instagram / TikTok** go through the studio's own **Buffer** key (Setup → Posting).
   - **The photo maker** (videos and the face / house-number check) runs on the studio's job
     runner (Setup → Clip cutting). Until then the photo set posts as the uploads are (JPG/PNG), the
     videos wait, and a studio with face/address rules (Porch & Party) holds every post until the
     check has run.

## The studios

`node scripts/studio.mjs list`. One registry entry each in `studios/`; `wrangler.jsonc` is
generated (`npm run studio:gen`).

| Studio | Address (Workers Custom Domain, zone `spryexecutiveos.com`) | Old address |
| --- | --- | --- |
| Hadiyah | https://hadiyah-studio.spryexecutiveos.com | https://hadiyahstudio.seq-taylor.workers.dev → 301 |
| Porch & Party (slug sample1) | https://pnpstudio.spryexecutiveos.com | https://sample1-studio.spryexecutiveos.com and https://sample1studio.seq-taylor.workers.dev → 301 |
| Sample 2 | https://sample2-studio.spryexecutiveos.com | https://sample2studio.seq-taylor.workers.dev → 301 |
| Sample 3 | https://sample3-studio.spryexecutiveos.com | https://sample3studio.seq-taylor.workers.dev → 301 |

The hostname is the `hostname` field of the registry entry; renaming a studio is that field plus
`npm run studio:deploy <slug>` (README "Rename a studio"). Only these four names on the zone belong
to this repo: the apex site and the `mail.` email records are not ours and are never touched.

Platform sender (login codes only): `Studio sign-in <login@mail.spryexecutiveos.com>`, the host's own
Resend account (sending-only key in the 0600 file `PLATFORM_RESEND_API_KEY`). Change it on every
studio: `node scripts/studio.mjs secrets --all --refresh --only=PLATFORM_RESEND_API_KEY,PLATFORM_EMAIL_FROM`.

D1 `creator-studios-<slug>-db`, R2 `creator-studios-<slug>-files`, Worker `<slug>studio`, all on the host's Cloudflare account `8d147e242033699dd37c6f5a451f48d2`.

## Held clips are redone on their own

Owner's standing rule (23 Oct 2026): a clip that is not up to par, or was held by something broken,
is redone by the studio itself, never by asking her. The hourly lane runs `worker/lib/autoRedo.ts`
in every studio: up to 3 held clips an hour go through Try another version (a different moment, a
different look, the cause's one-tap fixes), at most 2 times per clip per check version, never a
clip she approved, rejected or put on the Calendar, her own edit, or one whose video was cleared.
No email; the redone clip appears in Review. The **Clip redo** light says what each run did.

**When a build fixes a check that held clips** (a bug in the face check, the critic, the bar): bump
that cause's `check` in `shared/holdCauses.ts` and add its `history` line. Clips held under the
older version are redone automatically on the next hourly run, with a fresh allowance of 2.

## Common tasks

```bash
npm run studio:create <slug>        # new studio: D1 + R2, migrate, deploy, secrets, smoke, URL + link
npm run studio:deploy <slug>        # one studio (build, migrate, deploy, smoke)
npm run deploy:all                  # every studio (what deploy.yml runs on green main)
npm run studio:secrets <slug>       # set the secrets it is missing (never rotates SECRETS_KEY)
npm run studio:invite <slug>        # a new first-login link for a client studio (single use, 14 days)
node scripts/studio.mjs start-over <slug> <dumpId> [--service="<a Brand Profile service>"] [--shape=transformation|walkthrough|talking|montage]
                                    # the studio's own Start over, signed with its 0600 JOB_SHARED_SECRET (worker/routes/ops.ts):
                                    # New clips go, approved/posted/rejected clips and uploads stay; no browser login needed
node scripts/studio.mjs finish-cut <slug> <dumpId>
                                    # a cut that SAVED its clips but was marked failed after (a timed-out callback):
                                    # back to ready, nothing deleted, its light/email/editors/voice overs run;
                                    # refuses (409) when its latest cut did not save clips, then use start-over
node scripts/studio.mjs niche <slug>
                                    # the niche research now, when due (no playbook yet, or the Brand Profile changed):
                                    # the daily lane's rule (worker/lib/niche.ts); the clips' default style until past videos exist

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

## Free-model quota (studio intelligence)

The host OpenRouter key (Hadiyah, Porch & Party Studio, and the golden set's `GOLDEN_OPENROUTER_API_KEY`)
is the owner's $0-routing account since 24 Oct 2026: not free tier, so 1,000 free-model calls a day,
reset 00:00 UTC, with a $0 key limit (a paid model can never bill). The 1,000 is shared with her other
repos; the studios keep to about 500 (`STUDIOS_DAILY_CEILING`, jobs/ai.py). Before that it was a
free-tier key at 50 a day. A dump needs about 11 (3 batched shot-sheet calls, 1 copy call, 3 batched
critic calls, re-cuts; a 19-video dump about 25), capped at 40 per job (`OPENROUTER_JOB_BUDGET`,
jobs/ai.py) with 10 kept for the hooks and words check (`OPENROUTER_WORDS_RESERVE`). The Worker's
hourly words pass writes at most 8 clips a run per studio. The key lives in each studio's 0600 file
`<secrets dir>/<slug>/OPENROUTER_API_KEY` (`npm run studio:secrets <slug> --refresh
--only=OPENROUTER_API_KEY`); Mercedes and Sheila carry no host OpenRouter key (only one pasted on their own Setup). When the
day's quota is used, a 429 "free-models-per-day" stops further calls at once and the local open
vision model (Qwen2-VL-2B, Apache-2.0, on the runner's CPU, about 1 to 2 minutes a picture) reads the
footage instead; the words fall back to the grounded neutral lines and the critic to its rules.
Every cut logs `ai.calls` per provider. Ruled out 23 Oct 2026: Workers AI (the account's included
neurons were already used that day by other Workers; more is billed), Hugging Face (no credits left,
the account cannot pay), GitHub Models (no longer answers).

## Niche research (monthly, $0)

The daily lane starts `job-niche` (jobs/niche_research.py) once a month per studio, as soon as its
Brand Profile is locked: free web search (common.Web) and at most 2 free AI calls
(`OPENROUTER_JOB_BUDGET=2`), else the baseline playbook with the studio's own words. The result is
stored in `niche_playbooks`, sent once as a short note (email kind `niche_note`; Porch & Party's goes
only to NOTIFY_EMAIL) and shown on the Brand page. Health light: "What's working in your niche". A
failed run retries after 3 days; the clips use the last playbook meanwhile.

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
