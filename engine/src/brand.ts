// One brand per studio that uses the engine. Porch & Party's tokens are the approved brand
// (porch-and-party brain, Voice, approved 6 Nov 2026): Cotton ground, Porch-step plum ink, Marigold
// only on the one call to action per screen, Haint blue for the 901 plaque and tags. Fraunces 800
// (SOFT 100, WONK 1) for every heading and the wordmark, Figtree for body text. No script fonts.
export interface Brand {
  id: string;
  name: string;
  plaque: string;
  line: string;
  cta: string;
  ctaUrl: string;
  colors: { ground: string; ink: string; inkSoft: string; accent: string; tag: string };
}

export const BRANDS: Record<string, Brand> = {
  pnp: {
    id: "pnp",
    name: "Porch & Party",
    plaque: "901",
    line: "Memphis porches & parties,\nset up for you.",
    cta: "Check my date ›",
    ctaUrl: "porchandparty901.com/request",
    colors: { ground: "#FBF6EE", ink: "#2A1A28", inkSoft: "#5B4858", accent: "#F2B01E", tag: "#CFE8E6" },
  },
};

export const DISPLAY = "PnPDisplay";
export const BODY = "PnPBody";
/** Fraunces' soft, wonky cut, as the wordmark uses it. */
export const DISPLAY_VARIATION = '"SOFT" 100, "WONK" 1';

export const FPS = 30;

export type SizeId = "reel" | "feed" | "story" | "pin";
export const SIZES: Record<SizeId, { width: number; height: number }> = {
  reel: { width: 1080, height: 1920 },
  story: { width: 1080, height: 1920 },
  feed: { width: 1080, height: 1350 },
  pin: { width: 1000, height: 1500 },
};

/**
 * Where text may sit so the platforms' own buttons and captions never cover it (TikTok and Reels:
 * the top bar, the right-hand buttons and the caption block at the bottom). Fractions of the frame.
 */
export const SAFE = { top: 0.12, bottom: 0.25, left: 0.074, right: 0.15 };
