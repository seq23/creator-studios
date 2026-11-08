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
  the account's free 10,000 daily neurons** (`tests/unit/free-ai.test.ts`). Since 2 Nov 2026: Hadiyah
  3,000, Porch & Party 2,500, Sheila 1,000, Mercedes 1,000, Ashly 1,000.
- **When both free sources are spent for the day** every studio shows a calm note on every screen
  (Setup included): "Today's free AI is used up. To keep going, connect your own OpenRouter account",
  with the steps (`worker/lib/freeAiState.ts`, `app/components/FreeAiNote.tsx`; owner, 2 Nov 2026). A
  studio's own pasted key is used first, at its own cost; the host's key never pays (free models only).
- The hourly words pass takes `WORDS_PER_RUN` = 3 clips per studio (five studios carry the host's
  OpenRouter key; validator `free-quota-budgeted`).

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
  (05:20), Sheila `40 11 * * 1` (05:40), Porch & Party `0 12 * * 1` (06:00), Ashly `20 12 * * 1` (06:20, from 2 Nov 2026). Times are Central
  Standard Time; while daylight time is on they run an hour later by the clock. Studios without a
  `weeklyCron` stay on `0 12 * * 1`. Pinned by `tests/unit/weekly-stagger.test.ts`.
- GitHub Actions schedules (`parity`, `golden-set`) carry `timezone: America/Chicago`, so their
  times are Central all year: parity 09:17, golden-set Monday 01:23. `e2e` has no schedule (owner,
  8 Nov 2026): it runs on a push to main that changes app code (`app/`, `worker/`, `shared/`, build
  inputs) and on dispatch.

## Who gets studio email
- **No studio notice goes to the host developer** (the `DEVELOPER_EMAIL` address, in any Gmail spelling),
  from any studio but Porch & Party, and none names her as the reply-to (owner's rulings 1 Nov 2026: "I
  don't need creator studio emails at all, not even pnp studio", and 2 Nov 2026: "pnp is different since
  im running it u can keep that one"; `worker/lib/mailbox.ts`). A host-accounts studio's reply-to is its
  own owner. **Porch & Party (sample1) mails her again** (its `NOTIFY_EMAIL`), replies to her.
  `worker/services/email.ts routeRecipients` takes that mailbox off every notice of every other studio
  (a studio left with nobody logs `email.suppressed`, never a red Email light).
- **Kept:** login codes (she still signs in), a `[Test]` heads-up she presses for herself, and every
  email to the studio's own owner and notify list (Mercedes, Sheila, Hadiyah, Ashly get theirs).
- Pinned by `tests/unit/notify-override.test.ts` ("who mails the host developer").

## Schedule
- Every scheduled job, in Central time, is listed in `docs/SCHEDULE.md` (rebalanced 1 Nov 2026).
