// The proven-format library (spry brain, CONTENT ENGINE, 19 Nov 2026): each short-form format the
// engine can make, as a recipe: the first-second hook, the beats, the length, how the text works, the
// music feel and the ending, plus where the pattern comes from. Pure data: the renderer (formats.tsx)
// draws each one, the plan check (plan.ts) and the tests read it. Refreshed monthly from free public
// sources (TikTok Creative Center top ads and trends, Meta Ad Library, the top home-decor and event
// accounts): a format that stops earning its place is replaced here, never kept beside its successor.
export type FormatId =
  | "wait-for-it"
  | "pov"
  | "which-one"
  | "rate-it"
  | "three-ideas"
  | "quick-tip"
  | "how-it-works"
  | "checklist"
  | "countdown"
  | "real-montage"
  | "detail-zoom"
  | "this-or-that"
  | "do-dont"
  | "office-party"
  | "carousel";

export interface Recipe {
  id: FormatId;
  name: string;
  kind: "reel" | "carousel";
  hook: string;
  beats: string;
  length: string;
  text: string;
  music: "upbeat" | "warm";
  ending: string;
  source: string;
  /** How many pictures it takes, and how many text lines after the hook. */
  pics: [number, number];
  lines: [number, number];
  /** Real work only: the format shows our own jobs as ours (never an AI setup). */
  realOnly?: boolean;
}

export const FORMATS: Recipe[] = [
  { id: "wait-for-it", name: "Wait for the lights", kind: "reel", hook: "A promise on frame 0 (\"wait for the lights\"), the scene dim", beats: "dim 2 s → lights come up on the beat → hold the payoff → end card", length: "8–10 s", text: "hook on top, one payoff line after the reveal", music: "warm", ending: "end card with the one next step", source: "TikTok Creative Center: before/after 'wait for it' reveals, the top home-decor pattern of 2025–26", pics: [1, 1], lines: [1, 1] },
  { id: "pov", name: "POV", kind: "reel", hook: "\"POV:\" line that puts the viewer in the moment", beats: "one or two scenes, slow push, second line on beat 3", length: "8–11 s", text: "POV line on top, a turn line mid-frame", music: "warm", ending: "end card", source: "TikTok POV text-on-scene format (faceless, music only), top event-decor accounts", pics: [1, 2], lines: [1, 1] },
  { id: "which-one", name: "Which one?", kind: "reel", hook: "\"Which one are you, 1 or 2?\" over a split screen", beats: "split → 1 full → 2 full → split with the comment ask", length: "10–12 s", text: "numbered badges, the ask at the end", music: "upbeat", ending: "comment prompt, then end card", source: "Meta Ad Library + TikTok: 'pick one' comparisons drive comments in home and party niches", pics: [2, 2], lines: [1, 1] },
  { id: "rate-it", name: "Rate it", kind: "reel", hook: "\"Rate this … 1 to 10\" on frame 0", beats: "one to three looks, 4 beats each, the ask on the last", length: "8–12 s", text: "hook on top, the ask at the bottom", music: "upbeat", ending: "\"be honest\" ask, then end card", source: "TikTok 'rate this setup' engagement format (comments as the signal)", pics: [1, 3], lines: [1, 1] },
  { id: "three-ideas", name: "3 ideas", kind: "reel", hook: "\"3 … ideas for …\" title on the first picture", beats: "title → idea 1 → idea 2 → idea 3, numbered, on the beat", length: "12–15 s", text: "numbered badge + a 2–4 word label per idea", music: "upbeat", ending: "end card", source: "TikTok Creative Center + Pinterest Trends: numbered seasonal idea lists (save-driven)", pics: [3, 3], lines: [0, 0] },
  { id: "quick-tip", name: "Quick tip", kind: "reel", hook: "the tip's headline (a mistake or a number)", beats: "headline → 2–3 short lines, one per 3 beats", length: "9–12 s", text: "headline on top, short lines stacked below", music: "warm", ending: "end card", source: "top home-styling accounts: one-tip reels (saves and shares)", pics: [1, 2], lines: [2, 3] },
  { id: "how-it-works", name: "How it works", kind: "reel", hook: "the buyer's problem in one line", beats: "hook → 3 numbered steps over pictures → end card", length: "13–15 s", text: "badge + one step line each", music: "upbeat", ending: "end card with the request link", source: "Meta Ad Library: local-service '3 steps' ads (the most-run service ad shape)", pics: [3, 3], lines: [3, 3] },
  { id: "checklist", name: "Checklist", kind: "reel", hook: "\"Hosting …? Do these before …\"", beats: "hook → a ticked list, one line per 2 beats", length: "10–13 s", text: "cotton panel with drawn ticks", music: "warm", ending: "end card", source: "TikTok holiday-prep checklists (saves)", pics: [1, 2], lines: [3, 5] },
  { id: "countdown", name: "Countdown", kind: "reel", hook: "a big number of days left on frame 0", beats: "number ticks down → the picture → the nudge line", length: "9–11 s", text: "huge numeral, then one line", music: "upbeat", ending: "end card", source: "Meta Ad Library: seasonal deadline ads ('X days until …')", pics: [1, 2], lines: [1, 1] },
  { id: "real-montage", name: "Real setups", kind: "reel", hook: "\"Real setups\" title on the first real photo", beats: "a cut every 2 beats, a small label each", length: "10–14 s", text: "title, then one small label per photo", music: "upbeat", ending: "end card", source: "top event-decor accounts: beat-synced portfolio montages", pics: [4, 6], lines: [0, 0], realOnly: true },
  { id: "detail-zoom", name: "The details", kind: "reel", hook: "\"The details make it\" on the whole picture", beats: "whole → zoom to 3 details with labels → pull back", length: "13–16 s", text: "a small label per detail", music: "warm", ending: "end card", source: "TikTok 'notice the details' decor format (rewatches)", pics: [1, 1], lines: [0, 0] },
  { id: "this-or-that", name: "This or that", kind: "reel", hook: "\"A or B?\" over a split screen", beats: "rounds of two, 4 beats each, the ask at the end", length: "10–13 s", text: "a label on each half", music: "upbeat", ending: "\"which one is you?\" then end card", source: "TikTok 'this or that' style rounds (comments)", pics: [2, 4], lines: [1, 1] },
  { id: "do-dont", name: "Do / don't", kind: "reel", hook: "\"Porch mistake …\" or \"Don't …\"", beats: "the don't with a cross → the do with a tick", length: "9–11 s", text: "one line each, drawn cross and tick", music: "warm", ending: "end card", source: "home-styling 'do this, not that' reels (shares)", pics: [2, 2], lines: [2, 2] },
  { id: "office-party", name: "Office party", kind: "reel", hook: "the office organiser's problem", beats: "hook → three quick answers over pictures → end card", length: "12–14 s", text: "one answer line per picture", music: "upbeat", ending: "end card with the request link", source: "Meta Ad Library: corporate holiday-party caterer and decor ads (Nov–Dec)", pics: [3, 3], lines: [3, 3] },
  { id: "carousel", name: "Photo set", kind: "carousel", hook: "a cover slide with the headline", beats: "cover → one picture per slide with a label → closing slide", length: "4–7 slides", text: "cover headline, small labels, the request link last", music: "warm", ending: "closing slide with the one next step", source: "Instagram carousel guides (saves) and TikTok photo mode", pics: [2, 5], lines: [0, 0] },
];

export const formatById = (id: string): Recipe | undefined => FORMATS.find((f) => f.id === id);
