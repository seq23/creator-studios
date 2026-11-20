// Shared pieces every format is built from: the brand fonts, a photo that fills or sits as a print,
// headline boxes, the wordmark and the end card. Motion is short and calm (ship-ready D: no bouncy
// or elastic easing); the hook is already readable on frame 0 so the first frame works as a cover.
import React from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { BODY, DISPLAY, DISPLAY_VARIATION, SAFE, type Brand } from "./brand";

export interface Pic {
  /** Path under engine/public (render.mjs copies each source there). */
  src: string;
  w: number;
  h: number;
  /** Where the eye should go, 0..1 from the left / top (the crop keeps it in view). */
  fx?: number;
  fy?: number;
  /** A short label some formats show ("Baby shower"). */
  label?: string;
}

const handle = delayRender("brand fonts");
const faces = [
  new FontFace(DISPLAY, `url(${staticFile("fonts/Fraunces.ttf")})`, { weight: "100 900" }),
  new FontFace(BODY, `url(${staticFile("fonts/Figtree.ttf")})`, { weight: "300 900" }),
];
Promise.all(faces.map((f) => f.load()))
  .then((loaded) => {
    loaded.forEach((f) => document.fonts.add(f));
    continueRender(handle);
  })
  .catch(() => continueRender(handle));

export const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** 0 → 1 over `len` frames starting at `start`, calm ease. */
export function useIn(start: number, len = 9): number {
  const f = useCurrentFrame();
  return interpolate(f, [start, start + len], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
}

export function useSafe() {
  const { width, height } = useVideoConfig();
  return { width, height, top: height * SAFE.top, bottom: height * (1 - SAFE.bottom), left: width * SAFE.left, right: width * (1 - SAFE.right), inner: width * (1 - SAFE.left - SAFE.right) };
}

/** True when a picture is wider than the frame can fill without cropping most of it away. */
export const isWide = (p: Pic, width: number, height: number) => p.w / p.h > (width / height) * 1.6;

/**
 * A photo filling the frame with a slow push (from `zoomFrom` to `zoomTo` over `dur` frames).
 * A wide photo is shown whole as a print on the brand's plum ground (a faint, blurred wash of the
 * photo behind it) rather than cropped to a sliver or blown up past its resolution.
 */
export const Photo: React.FC<{ pic: Pic; dur: number; zoomFrom?: number; zoomTo?: number; dim?: number; print?: boolean; tilt?: number; ground?: string; printY?: number; printMax?: number }> = ({ pic, dur, zoomFrom = 1.04, zoomTo = 1.12, dim = 0, print, tilt = -1.2, ground = "#2A1A28", printY = 0.56, printMax = 0.42 }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const z = interpolate(f, [0, dur], [zoomFrom, zoomTo], { extrapolateRight: "clamp" });
  const fx = (pic.fx ?? 0.5) * 100;
  const fy = (pic.fy ?? 0.5) * 100;
  const asPrint = print ?? isWide(pic, width, height);
  if (!asPrint) {
    return (
      <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
        <Img src={staticFile(pic.src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `${fx}% ${fy}%`, transform: `scale(${z})`, transformOrigin: `${fx}% ${fy}%`, filter: dim ? `brightness(${1 - dim})` : undefined }} />
      </AbsoluteFill>
    );
  }
  // The print: as wide as the safe frame allows, never taller than printMax (42%) of it, keeping its shape.
  let pw = width * 0.86;
  let ph = pw * (pic.h / pic.w);
  if (ph > height * printMax) {
    ph = height * printMax;
    pw = ph * (pic.w / pic.h);
  }
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: ground }}>
      <Img src={staticFile(pic.src)} style={{ position: "absolute", inset: -60, width: width + 120, height: height + 120, objectFit: "cover", opacity: 0.22, filter: "blur(30px) saturate(1.1)" }} />
      <div
        style={{
          position: "absolute",
          left: (width - pw) / 2,
          top: height * printY - ph / 2,
          width: pw,
          height: ph,
          padding: 14,
          backgroundColor: "#FBF6EE",
          borderRadius: 10,
          boxShadow: "0 30px 70px rgba(0,0,0,.45)",
          transform: `rotate(${tilt}deg) scale(${0.97 + (z - zoomFrom) * 0.5})`,
        }}
      >
        <div style={{ width: "100%", height: "100%", overflow: "hidden", borderRadius: 4 }}>
          <Img src={staticFile(pic.src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `${fx}% ${fy}%`, filter: dim ? `brightness(${1 - dim})` : undefined }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

type Tone = "cotton" | "plum" | "haint";
const toneStyle = (b: Brand, tone: Tone): React.CSSProperties =>
  tone === "plum" ? { backgroundColor: b.colors.ink, color: b.colors.ground } : tone === "haint" ? { backgroundColor: b.colors.tag, color: b.colors.ink } : { backgroundColor: b.colors.ground, color: b.colors.ink };

/** A headline on its own box: Fraunces, plum on cotton (or the reverse). Readable at phone size. */
export const Headline: React.FC<{ brand: Brand; text: string; size?: number; tone?: Tone; at?: number; align?: "left" | "center"; y?: number; hookFrame0?: boolean }> = ({ brand, text, size = 84, tone = "cotton", at = 0, align = "left", y, hookFrame0 }) => {
  const s = useSafe();
  const p = useIn(at, 8);
  // The hook is readable on frame 0 (it is the cover); it only settles in, it never fades up from nothing.
  const o = hookFrame0 ? 1 : p;
  const ty = hookFrame0 ? (1 - p) * 10 : (1 - p) * 26;
  return (
    <div style={{ position: "absolute", left: s.left, width: s.inner, top: y ?? s.top, display: "flex", justifyContent: align === "center" ? "center" : "flex-start", opacity: o, transform: `translateY(${ty}px)` }}>
      <div
        style={{
          ...toneStyle(brand, tone),
          fontFamily: DISPLAY,
          fontVariationSettings: DISPLAY_VARIATION,
          fontWeight: 800,
          fontSize: size,
          lineHeight: 1.04,
          letterSpacing: "-0.01em",
          padding: `${size * 0.26}px ${size * 0.34}px ${size * 0.3}px`,
          borderRadius: size * 0.22,
          boxShadow: "0 10px 30px rgba(0,0,0,.18)",
          textAlign: align,
          maxWidth: "100%",
          whiteSpace: "pre-line",
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** A smaller body line (Figtree) on a box, for second beats and labels. */
export const Line: React.FC<{ brand: Brand; text: string; size?: number; tone?: Tone; at?: number; x?: number; y: number; width?: number }> = ({ brand, text, size = 50, tone = "cotton", at = 0, x, y, width }) => {
  const s = useSafe();
  const p = useIn(at, 8);
  return (
    <div style={{ position: "absolute", left: x ?? s.left, top: y, width: width ?? s.inner, opacity: p, transform: `translateY(${(1 - p) * 20}px)` }}>
      <span
        style={{
          ...toneStyle(brand, tone),
          display: "inline-block",
          fontFamily: BODY,
          fontWeight: 700,
          fontSize: size,
          lineHeight: 1.2,
          padding: `${size * 0.28}px ${size * 0.42}px`,
          borderRadius: size * 0.3,
          boxShadow: "0 8px 24px rgba(0,0,0,.16)",
          whiteSpace: "pre-line",
        }}
      >
        {text}
      </span>
    </div>
  );
};

/** The wordmark: "Porch & Party" in soft Fraunces with 901 on a haint-blue house-number plaque. */
export const Wordmark: React.FC<{ brand: Brand; size?: number; color?: string }> = ({ brand, size = 92, color }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.28, fontFamily: DISPLAY, fontVariationSettings: DISPLAY_VARIATION, fontWeight: 800, fontSize: size, letterSpacing: "-0.01em", color: color ?? brand.colors.ink, whiteSpace: "nowrap" }}>
    <span>{brand.name}</span>
    <span style={{ fontFamily: BODY, fontWeight: 800, fontSize: size * 0.52, letterSpacing: ".04em", backgroundColor: brand.colors.tag, color: brand.colors.ink, border: `${Math.max(2, size * 0.03)}px solid ${brand.colors.ink}`, borderRadius: 999, padding: `${size * 0.14}px ${size * 0.24}px`, boxShadow: `0 ${size * 0.04}px 0 ${brand.colors.ink}` }}>{brand.plaque}</span>
  </div>
);

/** The last beat of every reel: who we are and the one next step (the only marigold thing). */
export const EndCard: React.FC<{ brand: Brand; line?: string }> = ({ brand, line }) => {
  const { width, height } = useVideoConfig();
  const a = useIn(0, 8);
  const b = useIn(6, 9);
  const c = useIn(12, 9);
  const scale = width / 1080;
  return (
    <AbsoluteFill style={{ backgroundColor: brand.colors.ground, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 46 * scale, paddingBottom: height * 0.08 }}>
      <div style={{ opacity: a, transform: `translateY(${(1 - a) * 16}px)` }}>
        <Wordmark brand={brand} size={104 * scale} />
      </div>
      <div style={{ opacity: b, fontFamily: BODY, fontWeight: 600, fontSize: 46 * scale, color: brand.colors.inkSoft, textAlign: "center", maxWidth: width * 0.9, lineHeight: 1.25, textWrap: "balance" }}>{line ?? brand.line}</div>
      <div style={{ opacity: c, transform: `translateY(${(1 - c) * 14}px)`, display: "flex", flexDirection: "column", alignItems: "center", gap: 22 * scale }}>
        <div style={{ backgroundColor: brand.colors.accent, color: brand.colors.ink, fontFamily: BODY, fontWeight: 800, fontSize: 52 * scale, padding: `${24 * scale}px ${48 * scale}px`, borderRadius: 16 * scale, border: `${3 * scale}px solid ${brand.colors.ink}`, boxShadow: `0 ${5 * scale}px 0 ${brand.colors.ink}` }}>{brand.cta}</div>
        <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 40 * scale, color: brand.colors.ink }}>{brand.ctaUrl}</div>
      </div>
    </AbsoluteFill>
  );
};

/** A big numeral badge (1, 2, 3) for lists and "which one". */
export const Badge: React.FC<{ brand: Brand; n: string; x: number; y: number; size?: number; at?: number }> = ({ brand, n, x, y, size = 120, at = 0 }) => {
  const p = useIn(at, 7);
  return (
    <div style={{ position: "absolute", left: x, top: y, width: size, height: size, borderRadius: size, backgroundColor: brand.colors.tag, color: brand.colors.ink, border: `4px solid ${brand.colors.ink}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: DISPLAY, fontVariationSettings: DISPLAY_VARIATION, fontWeight: 800, fontSize: size * 0.56, opacity: p, transform: `scale(${0.85 + 0.15 * p})` }}>
      {n}
    </div>
  );
};

/** A drawn check or cross (no emoji), for checklists and do / don't. */
export const Mark: React.FC<{ kind: "check" | "cross"; size?: number; color: string; at?: number }> = ({ kind, size = 64, color, at = 0 }) => {
  const p = useIn(at, 8);
  const d = kind === "check" ? "M8 34 L26 52 L58 14" : "M14 14 L50 50 M50 14 L14 50";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ flex: "none" }}>
      <path d={d} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={100} strokeDashoffset={100 - 100 * p} />
    </svg>
  );
};
