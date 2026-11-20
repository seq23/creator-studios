# The content engine

Short-form reels and photo sets made on the host's Mac at $0, reviewed on their real frames, then
queued into a studio's photo posts (the Studio stays the posting backbone: queue, calendar, Buffer,
storage). Ruling: spry and porch-and-party brains, "CONTENT ENGINE", 19 Nov 2026; Porch & Party first.

## The parts

| Part | File | What it does |
|---|---|---|
| Format library | `src/library.ts` | 15 proven formats, each a recipe (first-second hook, beats, length, text, music feel, ending, source). Refreshed monthly from free public sources; a format that stops earning its place is replaced, never kept beside its successor. |
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
live in `engine/out/` (ignored). Licences: Remotion's free licence (companies of up to 3 people);
Fraunces and Figtree under the SIL Open Font License (`public/fonts/OFL-*.txt`); music CC0.

## Free image making

Google's image models answer `limit: 0` on the free AI Studio tier (checked 20 Nov 2026 on the shared
free key: gemini-3.1-flash-image, gemini-2.5-flash-image, gemini-3.1-flash-lite-image), so new
photo-real scenes are not free today. The engine uses the studio's real job photos and the site's
existing AI scenes; a new free image route goes in here when one is measured.
