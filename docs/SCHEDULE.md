# Schedule

Every scheduled GitHub Actions job in this repo. Times are Central (America/Chicago): each
`schedule:` entry carries `timezone: America/Chicago`, which GitHub Actions honours, so the clock
change in March and November no longer moves a job. Rebalanced 1 Nov 2026 (owner-approved weekly
schedule); see the notes below for what moved.

| Job | Workflow | When | Cron |
|---|---|---|---|
| e2e | `e2e.yml` | every day 02:17 CT | `17 2 * * *` |
| golden-set | `golden-set.yml` | Mon 01:23 CT | `23 1 * * 1` |
| parity | `parity.yml` | every day 09:17 CT | `17 9 * * *` |

## Weekly windows

- **Saturday 04:00–08:00 CT is the weekly-upkeep window for every Spry Labs side business**
  (owner ruling, 1 Nov 2026): weekly maintenance, refresh and metrics jobs run there, staggered
  at least 15 minutes apart, never two in the same slot. Publishing, link checks and
  self-healing are not upkeep and keep their own days.

## Cloudflare crons (UTC)
- See docs/OPERATIONS.md "Schedule (cron lanes)": the Monday lane is staggered per studio at 05:00 /
  05:20 / 05:40 / 06:00 Central Standard Time (1 Nov 2026).
