# The content engine

Short-form reels and photo sets made on the host's Mac at $0, reviewed on their real frames, then
queued into a studio's photo posts (the Studio stays the posting backbone: queue, calendar, Buffer,
storage). Ruling: spry and porch-and-party brains, "CONTENT ENGINE", 19 Nov 2026; Porch & Party first.

## The parts

| Part | File | What it does |
|---|---|---|
| Format library | `src/library.ts` | 15 proven formats, each a recipe (first-second hook, beats, length, text, music feel, ending, source). Refreshed monthly from free public sources; a format that stops earning its place is replaced, never kept beside its successor. |
| New scenes | `imagine.mjs` | Photo-real idea scenes on Workers AI's free allowance, metered and fail closed (below). |
| Renderer | `src/formats.tsx`, `src/parts.tsx`, `render.mjs` | Remotion on the Mac: brand fonts and colours (`src/brand.ts`), the hook readable on frame 0, cuts on the music's beat (CC0 tracks in `jobs/music`, tempo in `library.json`), captions inside the platforms' safe area, end card with the one next step. Also renders ad sizes (`--sizes=feed,story,pin`). |
| Plan | `plans/<plan>.json`, `src/plan.ts` | What to make: format, pictures (`real:` our own job photos, shown as ours; `ai:` AI scenes, never captioned as a job we did), words, music, captions per platform, local time. Hard rules checked in code (no prices, request link in every caption, no "Made with AI" line on engine pieces, real-only formats, posting window, no picture in neighbouring pieces). |
| Fresh reviewer | `review.mjs` | A new `claude -p` session with no stake sees only the real output (one frame a second, the cover, every slide), the brand note and the ship-ready checklist; PASS needs no failed item and a hook score of 6+. |
| Queue | `node scripts/studio.mjs engine-queue <slug> engine/plans/<plan>.json` | PASS pieces only: files up through the signed `engine-file` door, then `engine-pack` makes a ready photo pack with its posts at the plan's times. The studio refuses a piece without PASS, with a broken content rule or over 10 posts a channel a week, and holds one at posting if its PASS is gone. |

Labels (risk R-END-03, P&P filler exception, 19 Nov 2026): engine pieces never carry a "Made with AI"
caption line; TikTok's own AI switch is set on any piece with an AI scene. The studio's own photo
maker keeps R-END-03 as written. Pinned by `tests/unit/engine-packs.test.ts`.

## Run it

```bash
cd engine && npm ci                                      # once (Remotion; Chrome Headless Shell downloads on first render)
node engine/render.mjs engine/plans/<plan>.json          # OUTPUT <n> pieces rendered → engine/out/<plan>/<id>/
node engine/review.mjs engine/plans/<plan>.json          # OUTPUT <n> of <m> pieces passed review
# a FAIL: fix the plan or the format, render --only=<id>, review --only=<id> --again; a second FAIL is dropped
node scripts/studio.mjs engine-queue sample1 engine/plans/<plan>.json   # OUTPUT <n> pieces queued
```

Pictures are read from the plan's `sources` folders on the Mac and never committed. Rendered files
live in `$ENGINE_OUT` (for P&P: `~/Work/porch-and-party/engine-out`, kept on the Mac), else `engine/out/` (ignored). Licences: Remotion's free licence (companies of up to 3 people);
Fraunces and Figtree under the SIL Open Font License (`public/fonts/OFL-*.txt`); music CC0.

## Free image making

New photo-real idea scenes come from Cloudflare Workers AI (`engine/imagine.mjs`, FLUX.2 [klein] 9B) on
the account's free daily allowance: today's usage is read from analytics before every call, the engine
stops at 1,500 neurons a day of its model and before the account passes 9,000 of its free 10,000
(studios hold 8,500; overage is billed), and makes nothing when usage cannot be read. Every prompt
carries the fixed rules (no people, faces, text, house numbers or balloon garlands); every image still
goes through the plan check and the review. Google's image models answer `limit: 0` on the free AI
Studio tier (checked 20 Nov 2026), so they are not used.

```bash
# CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (usage), CLOUDFLARE_WORKERS_AI_TOKEN (runs the model)
node engine/imagine.mjs engine/plans/<plan>.json          # OUTPUT <n> images made
```
