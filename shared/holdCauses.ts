// Why a clip is held (hidden in Review), as a cause key, and what the studio does about it on its own
// (owner's standing rule, 23 Oct 2026: "if its not up to par or something is broken it should re do
// those clips"). The studio redoes held clips itself, never asking her (worker/lib/autoRedo.ts, the
// hourly lane):
//   - a cause with `redoOnHold` is redone as soon as it is held: a genuinely different version (a
//     different moment of the footage, a different look, the cause's one-tap fixes);
//   - every cause has a CHECK VERSION. When a build fixes the check behind a cause (a bug in it, a
//     better check), that build bumps `check` and adds a line to `history`. A clip held under an older
//     version of the check is then redone automatically, with a fresh allowance of redos;
//   - at most MAX_AUTO_REDOS automatic redos per clip per check version: no loops.
// Guard: tests/unit/auto-redo.test.ts (history matches check; every reason the engine writes maps to a cause).
import type { FixKey } from "./fixes";

export interface HoldCause {
  /** The version of the check behind this cause. Bump it (and add a history line) when a build fixes it. */
  check: number;
  /** Redo as soon as a clip is held for this (true), or only once a newer check version lands (false). */
  redoOnHold: boolean;
  /** The one-tap fixes (shared/fixes.ts) the redo asks for, besides a different moment and look. */
  fixes: FixKey[];
  /** One line per check version, oldest first: the build marker. history.length === check. */
  history: { check: number; date: string; what: string }[];
}

export const HOLD_CAUSES = {
  // Scored under the studio's review bar (shared/studioRules.ts bar; jobs/cut.py SCORE).
  under_bar: { check: 1, redoOnHold: true, fixes: ["less_blur", "end_on_finished"], history: [{ check: 1, date: "2026-10-23", what: "studio fix score 0..100, bar per studio" }] },
  // The critic (jobs/critic.py REASON_WORDS): words that did not match the picture.
  text_mismatch: { check: 1, redoOnHold: true, fixes: ["different_opening"], history: [{ check: 1, date: "2026-10-22", what: "critic pass, layer 6" }] },
  // The critic: an unfinished shot shown as the finished result.
  before_as_finished: { check: 1, redoOnHold: true, fixes: ["end_on_finished"], history: [{ check: 1, date: "2026-10-22", what: "critic pass, layer 6" }] },
  // The critic: background talk in the captions.
  noise_captions: { check: 1, redoOnHold: true, fixes: [], history: [{ check: 1, date: "2026-10-22", what: "critic pass, layer 6" }] },
  // The studio's content rules (worker/jobs/cut.ts RULES_HIDDEN): the redo writes new words.
  rules: { check: 1, redoOnHold: true, fixes: [], history: [{ check: 1, date: "2026-10-22", what: "content rules, layer 5" }] },
  // A face, house number or name may show (the face check). A safety hold: redone only when a newer
  // face check lands (bump `check` in the build that fixes it), never just because it was held.
  // Check 2: a small house-number box no longer fails the blur (jobs/protect.py blur_radii), which had
  // held every clip of the video; "unprotected" is that failed blur in its own words.
  privacy: {
    check: 2,
    redoOnHold: false,
    fixes: [],
    history: [
      { check: 1, date: "2026-10-22", what: "face and house-number check" },
      { check: 2, date: "2026-10-23", what: "blur accepts small house-number boxes; a failed blur says so" },
    ],
  },
} as const satisfies Record<string, HoldCause>;

export type HoldCauseKey = keyof typeof HOLD_CAUSES;
export const HOLD_CAUSE_KEYS = Object.keys(HOLD_CAUSES) as HoldCauseKey[];

/** Automatic redos per clip per check version of its cause. */
export const MAX_AUTO_REDOS = 2;

// The plain words the engine and the Worker write as a hidden reason, mapped to their cause.
// The critic's words are jobs/critic.py REASON_WORDS; the rules' words are RULES_HIDDEN.
const CRITIC_WORDS: Record<string, HoldCauseKey> = {
  "the words didn't match what's in the video": "text_mismatch",
  "an unfinished shot looked like the finished result": "before_as_finished",
  "background talk showed up in the captions": "noise_captions",
  "a face, house number or name may be showing": "privacy",
  "a house number or face could not be blurred, so it is held for a look": "privacy",
};
export const RULES_WORDS = "the words broke one of this studio's rules";

/** The cause behind a hidden reason, or null when it is not one this studio knows how to redo. Pure. */
export function holdCause(reason: string | null | undefined): HoldCauseKey | null {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r) return null;
  for (const [words, key] of Object.entries(CRITIC_WORDS)) if (r.startsWith(words)) return key;
  if (r.startsWith(RULES_WORDS)) return "rules";
  // "it scored 48, under this studio's bar of 70: …" (Worker) / "scored 48/100, under your bar of 70: …" (engine)
  if (/^(it )?scored \d+(\/100)?, under (this studio's|your) (review )?bar/.test(r)) return "under_bar";
  return null;
}

/** What the sweep needs to know about one held clip. */
export interface HeldClip {
  hidden: number;
  status: string;
  style_of: string | null;
  edited_with: string | null;
  clip_type: string | null;
  hidden_reason: string | null;
  pending_look: string | null;
  rerender_job_id: string | null;
  hold_cause: string | null;
  hold_check: number | null;
  auto_redo_check: number | null;
  auto_redo_count: number;
  /** Any posts row (on the Calendar, in Buffer, posted). */
  in_posts: number;
  /** A video it uses was cleared after 7 days. */
  raw_cleared: number;
  /** A video it uses is held as someone else's (worker/domain/sourceCheck.ts). */
  not_hers: number;
}

export type RedoDecision =
  | { redo: true; cause: HoldCauseKey; check: number; attempt: number; fixes: FixKey[]; fixedSince: boolean }
  | { redo: false; cause: HoldCauseKey | null; why: string; terminal: boolean };

/**
 * Redo this held clip now, or why not (in plain words). Pure; the sweep only loads and acts.
 * Never touches a clip she approved, rejected or put on the Calendar, her own edit or an editor's
 * import, a style, a clip already being remade, or one past the cap.
 */
export function redoDecision(c: HeldClip): RedoDecision {
  const no = (why: string, cause: HoldCauseKey | null = null, terminal = true): RedoDecision => ({ redo: false, cause, why, terminal });
  if (!c.hidden) return no("it is not held");
  if (c.status !== "draft") return no("she already decided on it");
  if (c.in_posts) return no("it is on the Calendar");
  if (c.edited_with || c.clip_type === "imported") return no("it is her own edit or an editor's cut");
  if (c.style_of) return no("it is a style of another clip");
  if (c.pending_look || c.rerender_job_id) return no("a new version is already on its way", null, false);
  const cause = (c.hold_cause && c.hold_cause in HOLD_CAUSES ? (c.hold_cause as HoldCauseKey) : null) ?? holdCause(c.hidden_reason);
  if (!cause) return no("its reason is not one the studio can fix on its own");
  const def: HoldCause = HOLD_CAUSES[cause];
  const heldAt = c.hold_check ?? def.check;
  const fixedSince = heldAt < def.check;
  if (!def.redoOnHold && !fixedSince) return no("it waits for a better check before it is tried again", cause);
  if (c.not_hers) return no("one of its videos looks like someone else's", cause);
  if (c.raw_cleared) return no("its original video was cleared after 7 days", cause);
  const done = c.auto_redo_check === def.check ? c.auto_redo_count : 0;
  if (done >= MAX_AUTO_REDOS) return no(`it was already redone ${done} times on its own`, cause);
  const attempt = done + 1;
  // The second try reaches further: a different opening and a shorter cut on top of the cause's fixes.
  const fixes = [...new Set<FixKey>([...def.fixes, ...(attempt > 1 ? (["different_opening", "shorter"] as FixKey[]) : [])])];
  return { redo: true, cause, check: def.check, attempt, fixes, fixedSince };
}

/** The plain reason for a hidden clip that came with none (Review says "Hidden because …"). */
export function plainHeldReason(score: number | null, bar: number): string {
  return Number.isFinite(score) && score !== null ? `it scored ${Math.round(score)}, under this studio's bar of ${bar}` : "it was not good enough yet";
}

/** Appended once when the studio has used up its redos, so the reason says it was tried. */
export const GAVE_UP_NOTE = "(the studio redid it on its own and it still was not good enough)";
