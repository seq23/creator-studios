// Steering a dump (owner, 26 Sep 2026: "some degree of on-demand control is good and maybe a
// surprise-me aspect can be good too if they don't care much"). One shape for the Dump screen's
// chips, the parsed notes and the cut job: every control is optional, and an unset control means
// "surprise me" for that one thing. worker/domain/steer.ts holds the rules; this is the data.
import type { Platform } from "./constants";

export const PACES = ["calm", "normal", "fast"] as const;
export type Pace = (typeof PACES)[number];

/** Clip length choices, in seconds; each fits inside the cutter's recipe bounds. */
export const LENGTHS = {
  short: { label: "Short (under 20 s)", minS: 8, maxS: 20 },
  medium: { label: "Medium (20–45 s)", minS: 20, maxS: 45 },
  long: { label: "Long (45–90 s)", minS: 45, maxS: 90 },
} as const;
export type Length = keyof typeof LENGTHS;

export const CAPTION_CHOICES = ["clean", "karaoke", "boxed", "none"] as const;
export type CaptionChoice = (typeof CAPTION_CHOICES)[number];
export const CAPTION_LABEL: Record<CaptionChoice, string> = { clean: "Simple", karaoke: "Word by word", boxed: "On a box", none: "No captions" };

export const COUNT_CHOICES = [5, 10, 20, 30] as const;
export const MAX_COUNT = 30;

/**
 * Voice over for this dump (owner, 26 Sep 2026: "is it either all or none?"): on the clips with no
 * talking (the default when Automatic voice overs is on and her voice is saved), none for this
 * dump, or none now and she adds them one by one in Review. worker/domain/autoVoice.ts voiceFor.
 */
export const VOICE_CHOICES = ["quiet", "none", "pick"] as const;
export type VoiceChoice = (typeof VOICE_CHOICES)[number];
export const VOICE_LABEL: Record<VoiceChoice, string> = { quiet: "On quiet clips", none: "None for this dump", pick: "Let me pick in Review" };

/** Music: "none", "any" (her songs, one per clip in turn) or one song ("track:<id>"). */
export type MusicChoice = "none" | "any" | `track:${string}`;

export interface SteerControls {
  looks?: string[];
  music?: MusicChoice;
  pace?: Pace;
  length?: Length;
  count?: number;
  captions?: CaptionChoice;
  platforms?: Platform[];
  voice?: VoiceChoice;
  /** Moments that must be in: words she said, a person, a product. */
  include?: string[];
  /** Moments to leave out. */
  avoid?: string[];
}

/** Something she asked for that cannot be done as asked: still made, and said so on the dump. */
export interface NotFollowed {
  what: string;
  why: string;
}

/** What a note was read as: the controls, one plain sentence per control, and what cannot be followed. */
export interface Understood {
  controls: SteerControls;
  said: string[];
  not_followed: NotFollowed[];
  /** "rules" (always) or "rules+ai" when the free AI model also read it. */
  by: "rules" | "rules+ai";
}

export const STEER_KEYS = ["looks", "music", "pace", "length", "count", "captions", "platforms", "voice", "include", "avoid"] as const;
export type SteerKey = (typeof STEER_KEYS)[number];
