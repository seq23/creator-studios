# creator-studios — working rules

Read `README.md` first (what this is, the studios, adding one, deploy). `RUNBOOK.md` is the
operational reference ("runbook creator-studios" opens it).

## What this repo is

- **One codebase, deployed as separate studios.** Each studio is one registry entry,
  `studios/<slug>.json`: its own Worker, its own D1, its own R2 (full data isolation), its own
  owner email, its own theme. `wrangler.jsonc` is GENERATED from the registry
  (`npm run studio:gen`; validator `studios-generated`). Never hand-edit it.
- Copied from `seq23/sheila-creator-dashboard` (no history, see README). That repo and its
  deployments are never touched from here.
- **Public repo** (free Actions minutes for video cutting). No secrets, no client data, no host
  identifiers in anything a client studio ships (validator `sample-clean`, `scripts/bundle-scan.mjs`).
- Two kinds of studio: **host-accounts** (Hadiyah: the services the host gave Sheila on the host's
  own accounts, and nothing more; README "Hadiyah: whose account runs what") and **client**
  (Sample 1/2/3: none of the host's software, keys, data, emails or links; every service is the
  client's own, pasted on Setup).

## Locked decisions you do not reopen

Real footage only (no AI video) · two-door Dump · nothing posts without approval · hard cap 10
posts per channel per week · Buffer free plan for posting · OpenRouter free models default ·
**nothing hidden, nothing switched off**: every Settings switch defaults ON and no switch ever
hides a screen, nav item or button (validator `nothing-hidden`) · research brief approved before
the first cut · public business contacts only for deals, she sends every pitch herself ·
**every studio logs in with the email one-time code, never "open"** (validator
`login-never-open`) · **no staging**.

## Rules

- **Nothing waits on the owner.** A finding becomes an action with a measurement and an
  automatic fallback, never a question or a "waiting on the owner" stop. Only a secret or an
  account she alone holds may stop, and it stops as a NAMED stop (a health light + fix guide, or
  a line under "Named stops" in RUNBOOK) with the paste-ready command. `tests/unit/studios.test.ts`
  reads this line.
- **Practice mode, never an error.** A service with no key runs on its stand-in, labelled on every
  screen (Shell banner) and on Setup. Keys are read from encrypted storage FIRST (Setup, AES-GCM
  in D1 with `SECRETS_KEY`), then Worker secrets (`worker/lib/practice.ts`). Guard:
  `tests/unit/practice.test.ts`.
- **The platform sender is the ONLY shared piece**: login codes go through the host's Resend
  (`PLATFORM_RESEND_API_KEY`, `PLATFORM_EMAIL_FROM`); every other email from a studio uses that
  studio's own Resend. Do not add a second shared piece.
- **Secrets**: through the vault (`~/repo-tools/agent`, its keychain adapter) piped straight into
  `wrangler secret put` / `gh secret set` on stdin (`scripts/studio.mjs`). Never the macOS
  `security` command, never a value on a command line or on screen. Never rotate `SECRETS_KEY`
  on a live studio (it decrypts every pasted key).
- **Fakes first.** A vendor call goes behind `worker/services/<vendor>.ts` with a fake that
  returns the failure shapes too.
- **Never log content.** `log.*` in the Worker, `log()` in jobs (validator `no-content-in-logs`).
- **Every screen has a `?`** and every `fix_guide` slug is a guide in `help/guides/`.
- **Plain words. Phone first** for Dump and Review (44 px targets).
- **Design**: one theme per studio in `studios/themes.json`, served as `/studio-theme.css` over
  the token defaults in `app/styles/tokens.css` (the only file with raw colours; validator
  `design-tokens`). A studio's look is config, never a code fork.
- Tests: strengthen, never weaken. Guards are proven negatively (break, red, restore).

## Layout

```
studios/    the registry: <slug>.json per studio + themes.json (the one list)
app/        React + Vite (pages/ one file per screen, routed in App.tsx — the route ledger)
worker/     Hono Worker: routes/ (mounted in index.ts), domain/, services/ (real + fake per vendor),
            lib/practice.ts (stored keys first, practice mode), jobs/, crons/
shared/     constants.ts, types.ts, setup.ts (the Setup steps: one list for Worker and app)
migrations/ D1, numbered; never edit a migration that has run in a studio
jobs/       Python jobs for GitHub Actions (signed calls, safe log, storage only through the Worker)
help/       guides/*.md + index.json + screenshots/
scripts/    studio.mjs (gen / create / deploy / secrets / invite), validate.mjs + validators/,
            bundle-scan.mjs, lib/owner-identifiers.mjs
tests/      unit/ (vitest), e2e/ (Playwright, phone + desktop, local fakes)
```

Collision slots (fill a line, never restructure): `app/App.tsx` routes · `worker/index.ts`
app.route lines · `worker/jobs/registry.ts` · `scripts/validate.mjs` REGISTER ·
`help/index.json` · `migrations/00NN_*.sql` · `package.json` deps (union merge only).

## Deploy

- Merge gate: `check.yml` on every PR (typecheck, unit, validators, build, bundle scan; under 5 min).
- On green `main`: `deploy.yml` deploys **every studio in the registry** with
  `npm run deploy:all` (build once → each studio's D1 migrations → `wrangler deploy --env <slug>` →
  smoke). By hand: `npm run studio:deploy <slug>` or `npm run deploy:all`. **Never a bare
  `wrangler deploy`** (the top-level config is local dev with fakes and is never deployed).
- `e2e.yml`: the full browser suite, nightly + on dispatch, post-merge, never a merge gate;
  `timeout-minutes` ~4x a normal run (a fault detector, not a budget).
- Adding a studio: one registry entry + `npm run studio:create <slug>` (README "Add a studio").
