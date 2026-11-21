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
| Plan | `plans/<plan>.json`, `src/plan.ts` | What to make: format, pictures (`real:` our own job photos, shown as ours; `ai:` AI scenes, never captioned as a job we did), words, music, captions per platform, local time. Hard rules checked in code (no prices, request link in every caption, no "Made with AI" line on engine pieces, real-only formats, posting window, no picture in neighbouring pieces, the weekly service mix: every 7 days at least one romantic, one celebration and one event piece, porch at most 2 of 7, owner's ruling 20 Nov 2026). Real photos lead; an AI scene fills only what no real job shows. |
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

New photo-real idea scenes come from Cloudflare Workers AI (`engine/imagine.mjs`) on the free daily
allowance of two accounts, tried in order: the main one (studios share it, so the engine keeps to 1,500
neurons a day) and, when that is full, the second, engine-only account (`CF2_ACCOUNT_ID`,
`CF2_WORKERS_AI_TOKEN`; its cap is the account ceiling). Usage is read from analytics before every call,
no account passes 9,000 of its free 10,000 (overage is billed), and an account whose usage cannot be read
makes nothing. FLUX.2 [klein] 9B (`ENGINE_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b`, ~1,705
neurons a 768x1344 picture) looks best and can edit a reference picture (a `generate` entry
`{"prompt", "ref"}`: the same door with and without the garland); FLUX.1 [schnell] (~250, square) is the
default. Every prompt ends with the fixed line "A still, quiet scene, ready and waiting." (FLUX draws
what a prompt names, so people, writing and house numbers are checks on the result, not prompt words).
Before any picture is made, the plan's prompts are written out (`$ENGINE_OUT/<plan>/image-prompts.md`:
piece, slide, prompt, avoid list, size, crop) and pass a hostile review by a fresh `claude -p` session;
each picture is then checked against its avoid list before it is rendered (a hit: fix the prompt, never
a plain re-roll). Google's image models answer `limit: 0` on the free AI Studio tier (checked 20 Nov
2026), so they are not used.

```bash
# CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (usage), CLOUDFLARE_WORKERS_AI_TOKEN (runs the model);
# CF2_ACCOUNT_ID, CF2_WORKERS_AI_TOKEN (the second account, used when the main one is full)
node engine/imagine.mjs engine/plans/<plan>.json          # OUTPUT <n> images made
```

## A fresh session's runbook (from a clean Mac shell)

Everything below runs from a worktree of creator-studios `main`; secrets come only through the Boss
OS vault; rendered files and verdicts live in `~/Work/porch-and-party/engine-out` (`ENGINE_OUT`).

```bash
git -C ~/GitHub/creator-studios worktree add ~/GitHub/.wt-engine-run origin/main
WT=~/GitHub/.wt-engine-run; PLAN=$WT/engine/plans/pnp-2026-11-21.json
export ENGINE_OUT=~/Work/porch-and-party/engine-out
cd $WT/engine && npm ci

# 1. new scenes: prompts reviewed first (image-prompts.md, above); main account, then the second one
cd ~/GitHub/boss-os && npm run -s vault:run -- zsh -c "CLOUDFLARE_WORKERS_AI_TOKEN=\$T2R_CLOUDFLARE_WORKERS_AI_TOKEN ENGINE_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b node $WT/engine/imagine.mjs $PLAN"

# 2. render the pieces that changed: a HEAVY job (at most 2 of Codex builds, renders and the audio fill at
#    once; wait while `pgrep -f 'codex exec|engine/render.mjs|audio/fill.py' | wc -l` is 2 or more).
#    Run it by its engine/render.mjs path so that count sees it; nice, the Mac is shared.
cd $WT/engine && nice -n 15 node $WT/engine/render.mjs $PLAN --only=<id>,<id>

# 3. review: a fresh reviewer that is not the builder looks at $ENGINE_OUT/<plan>/<id>/sheet.jpg,
#    cover.jpg and every slide-N.jpg. A second opinion: node review.mjs $PLAN --only=<id> --again.
#    The verdict goes in $ENGINE_OUT/<plan>/<id>/review.json:
#    {"verdict":"PASS","by":"<who reviewed>","looked_at":"<files and frames>","fails":[],"at":"<ISO time>"}

# 4. queue PASS pieces (already-queued ones answer 409 and are skipped)
cd ~/GitHub/boss-os && npm run -s vault:run -- zsh -c "cd $WT && node scripts/studio.mjs engine-queue sample1 $PLAN --only=<id>"

# 5. clean up
git -C ~/GitHub/creator-studios worktree remove $WT
```

If the browser start times out, the Mac is overloaded: the renderer shares one browser for the whole
plan and tries its start (Remotion's fixed 25 s) up to 6 times; if all fail, wait for the load to drop
and run step 2 again.
