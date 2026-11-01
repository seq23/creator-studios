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
