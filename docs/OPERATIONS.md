# Operations notes

Gotchas moved here from assistant memory on 31 Oct 2026. The rules are in `CLAUDE.md`; the studio
list and setup are in `README.md`.

## Free AI capacity
- Model calls run on free capacity only. Two free sources are laddered: the studio's free
  OpenRouter key, then **Workers AI** through the Worker's AI binding.
- **A free-tier OpenRouter key is 50 requests/day**, shared by cut, critic and golden-set jobs; one
  footage dump has needed ~45. Batch calls and lean on the second free source rather than buying
  credits. (An account that once bought $10 of credit gets 1,000/day; a studio's own key may not.)
- Each studio's Workers AI share is set in its registry entry; the shares must sum to **≤ 8,500 of
  the account's free 10,000 daily neurons** (`tests/unit/free-ai.test.ts`).

## Hostnames
- A studio's old hostname stays attached via the registry's previous-hostnames list and **301s
  pages only, never the API** (`worker/lib/canonical-host.ts`).

## One codebase
- Every studio — client studios included — deploys from this repo's green `main`. Fix a studio by
  fixing it here; never port a change into another studio repo by hand.

## Schedule (cron lanes)
- Cloudflare crons are UTC only. Each studio runs three lanes (`scripts/studio.mjs cronsFor`,
  generated into `wrangler.jsonc`): buffer-sync hourly, the daily lane at `30 13 * * *` (07:30 CST /
  08:30 CDT), and the **Monday lane** (recap email, stats, brand finder, brief adjust).
- **The Monday lane is staggered per studio** (schedule rebalance, 1 Nov 2026), from each studio's
  `weeklyCron` in `studios/<slug>.json`: Hadiyah `0 11 * * 1` (05:00 CST), Mercedes `20 11 * * 1`
  (05:20), Sheila `40 11 * * 1` (05:40), Porch & Party `0 12 * * 1` (06:00). Times are Central
  Standard Time; while daylight time is on they run an hour later by the clock. Studios without a
  `weeklyCron` stay on `0 12 * * 1`. Pinned by `tests/unit/weekly-stagger.test.ts`.
- GitHub Actions schedules (`e2e`, `parity`, `golden-set`) carry `timezone: America/Chicago`, so their
  times are Central all year: e2e 02:17, parity 09:17, golden-set Monday 01:23.

## Who gets studio email
- **No studio notice goes to the host developer** (the `DEVELOPER_EMAIL` address), from any studio
  (owner's ruling 1 Nov 2026: "I don't need creator studio emails at all, not even pnp studio").
  `worker/services/email.ts routeRecipients` takes that address off every notice after the
  Porch & Party `NOTIFY_EMAIL` re-addressing; Porch & Party's `NOTIFY_EMAIL` is that same address, so
  P&P Studio's brief, clips-ready, weekly recap and posting-problem mail now goes to nobody (a logged
  `email.suppressed`, never a red Email light).
- **Kept:** login codes (she still signs in), a `[Test]` heads-up she presses for herself, and every
  email to the studio's own owner and notify list (Mercedes, Sheila, Hadiyah get theirs as before).
- Pinned by `tests/unit/notify-override.test.ts` ("the host developer gets no studio notices").
- The Porch & Party Monday lane keeps its cron: it also refreshes stats, the brand finder and the
  brief, so only its recap email stops, not the lane.

## Schedule
- Every scheduled job, in Central time, is listed in `docs/SCHEDULE.md` (rebalanced 1 Nov 2026).
