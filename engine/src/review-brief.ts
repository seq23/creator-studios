// The fresh reviewer's brief (engine/review.mjs sends it to a new `claude -p` session): the brand
// note, the checklist and the piece's pictures, words and captions. Pure, so the tests read the same
// brief the reviewer gets (tests/unit/engine-photo-note.test.ts).
import path from "node:path";
import { BRANDS } from "./brand";
import type { Plan, PlanPiece } from "./plan";

const BRAND_NOTE = `Porch & Party (Memphis, porchandparty901.com): porch decorating, celebration setups (birthdays, anniversaries, showers, hotel-room surprises), grazing tables, giant yard game rentals. Idea: "Memphis porches & parties, set up for you." Voice: a friendly Memphis neighbour, plain words. Palette: Cotton #FBF6EE ground, Porch-step plum #2A1A28 ink, Marigold #F2B01E ONLY on the one call-to-action button, Haint blue #CFE8E6 for the 901 plaque and tags. Fonts: Fraunces (soft, heavy) for headings and the wordmark, Figtree for body. Logo: "Porch & Party" wordmark with "901" on a haint-blue plaque. Do not: pastel balloon-garland look, script fonts, stock-photo feel, customer faces or names, house numbers, prices, "insured"/"licensed"/guarantees, "Book now".`;


/** The checklist; `note` is the brand's photo note (brand.ts), checked on every frame and slide. */
export const checklist = (note: string | undefined): string =>
  `Judge it as a 20-year social video veteran would before shipping (bar: "nothing looks and feels and sounds like AI created it"):
1. First second: is the hook readable and does it give a reason to keep watching? Is frame 0 a usable cover?
2. Text: readable at phone size, inside the safe area (not under the platform's top bar, right-hand buttons or bottom caption block), no awkward line breaks or orphan words, no typos, no clipped or overlapping text.
3. Pictures: no AI tells (warped text or letters, melted objects, impossible light, extra or fused parts), no faces, no house numbers, no stretched, blurry or badly cropped pictures, no picture repeated inside the piece.
4. Brand: on-palette, the brand fonts, one marigold thing per screen, the end card with the wordmark and one next step.
5. Honesty (hard rule): a picture marked REAL is our own job (it may be touched up); words over it may say "our real setup". A picture marked AI SCENE is framed as what we can set up for you, never as a past job (words like "we did this", "our client", "this job", "our real setup" over an AI scene are a FAIL). Ideas, looks, questions and "we can set this up for you" are fine.${note ? ` Every frame and slide carries the small note "${note}" in a bottom corner: a frame or slide without it is a FAIL, and a note that is big, hard to read, or in the way (over the hook, a label or the setup itself, or under the platform's buttons or caption block) is a FAIL.` : ""}
6. Words and captions: no AI tells ("elevate", "delve", "unlock", "seamless", empty hype, triplets for rhythm), no prices, no invented customers, reviews or counts, no claims we cannot back, plain friendly voice, the request link present.
7. Overall: would a real person in Memphis stop, understand it in 3 seconds, and trust it? Anything that would make them scroll past, cringe or distrust it is a FAIL.`;

/** The whole brief for one piece: what to look at and what to judge. */
export function brief(plan: Plan, piece: PlanPiece, dir: string, files: string[]): string {
  const note = BRANDS[plan.brand]?.photoNote;
  const pics = piece.pics.map((p, i) => `  ${i + 1}. ${p.src.startsWith("real:") ? "REAL (our own job; may be touched up; call it our real setup)" : "AI SCENE (what we can set up for you, never our job)"}${p.label ? ` — label "${p.label}"` : ""}`).join("\n");
  const words = [`hook: ${JSON.stringify(piece.hook)}`, ...(piece.lines ?? []).map((l) => `line: ${JSON.stringify(l)}`), ...(piece.spots ?? []).map((s) => `label: ${JSON.stringify(s.label)}`), piece.endLine ? `end line: ${JSON.stringify(piece.endLine)}` : ""].filter(Boolean).join("\n");
  const caps = Object.entries(piece.captions).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
  return `You are a fresh, independent reviewer. You did not make this. Look at the REAL rendered output with the Read tool (each file below), then judge it.

Piece: ${piece.id} — format "${piece.format}" — ${piece.format === "carousel" ? "a photo set (swipe post)" : "a vertical short video (TikTok / Reels / Facebook), music only, no voice"}.
Files to look at (absolute paths):
${files.map((f) => `  ${path.join(dir, f)}`).join("\n")}
${piece.format === "carousel" ? "" : "sheet.jpg holds one frame per second in reading order (left to right, top to bottom); cover.jpg is frame 0 at full size."}

Brand: ${BRAND_NOTE}

Pictures in it:
${pics}

On-screen words:
${words}

Captions (posted with it):
${caps}

${checklist(note)}

Answer with ONE JSON object and nothing else:
{"verdict":"PASS" or "FAIL","hook_score":<1-10, how likely a scroller stops in the first second>,"looked_at":"<which files and frames you actually looked at>","fails":[{"item":"<what>","feel":"<what a real person would feel>","fix":"<the concrete fix>"}]}
PASS only when nothing on the checklist fails.`;
}
