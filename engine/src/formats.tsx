// The formats, drawn. Each is timed in beats of its music track (cuts land on the beat) and ends on
// the brand's end card. library.ts holds each format's recipe; this file only draws it.
import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { BRANDS, BODY, DISPLAY, DISPLAY_VARIATION, FPS, type Brand, type SizeId } from "./brand";
import type { FormatId } from "./library";
import { Badge, EndCard, Headline, Line, Mark, Photo, Wordmark, useIn, useSafe, type Pic } from "./parts";

export interface Spot {
  fx: number;
  fy: number;
  label: string;
}

export interface PieceProps {
  [key: string]: unknown;
  brand: string;
  format: FormatId;
  size: SizeId;
  bpm: number;
  /** Path under engine/public, or null for silence (never posted silent: plan.ts requires music on reels). */
  music: string | null;
  pics: Pic[];
  hook: string;
  lines: string[];
  count?: number;
  spots?: Spot[];
  endLine?: string;
  /** Carousel only: which slide this still is. */
  slide?: number;
}

const beat = (bpm: number) => Math.round((FPS * 60) / bpm);
const END = 4; // end card, in beats

/** Each format's body length in beats (before the end card). */
function bodyBeats(p: PieceProps): number {
  switch (p.format) {
    case "wait-for-it":
      return 12;
    case "pov":
      return p.pics.length > 1 ? 12 : 9;
    case "which-one":
      return 16;
    case "rate-it":
      return 3 + 4 * p.pics.length;
    case "three-ideas":
      return 3 + 4 * 3;
    case "quick-tip":
      return 3 + 3 * p.lines.length + 2;
    case "how-it-works":
      return 3 + 4 * 3;
    case "checklist":
      return 4 + 2 * p.lines.length + 2;
    case "countdown":
      return 4 + 7;
    case "real-montage":
      return 3 + 2 * (p.pics.length - 1) + 1;
    case "detail-zoom":
      return 3 + 4 * (p.spots?.length ?? 3) + 3;
    case "this-or-that":
      return 4 * (p.pics.length / 2) + 4;
    case "do-dont":
      return 2 + 5 + 5;
    case "office-party":
      return 3 + 4 * 3;
    case "carousel":
      return 1;
  }
}

export const durationFrames = (p: PieceProps): number => (p.format === "carousel" ? 1 : (bodyBeats(p) + END) * beat(p.bpm));
/** Carousel slides: a cover, one per picture, and the closing slide. */
export const carouselSlides = (p: PieceProps): number => p.pics.length + 2;

const Music: React.FC<{ src: string | null; total: number }> = ({ src, total }) => {
  if (!src) return null;
  return <Audio src={staticFile(src)} volume={(f) => interpolate(f, [0, 6, total - 18, total], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />;
};

/** A soft dark wash at the top so cotton text boxes read over bright photos. */
const TopWash: React.FC = () => <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(20,12,18,.38) 0%, rgba(20,12,18,0) 34%)" }} />;

// ------------------------------------------------------------------ the formats

const WaitForIt: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const f = useCurrentFrame();
  const s = useSafe();
  const on = 4 * B;
  const dim = interpolate(f, [on - 2, on + 10], [0.62, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = interpolate(f, [on, on + 6, on + 24], [0, 0.22, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const total = 12 * B;
  return (
    <AbsoluteFill>
      <Photo pic={p.pics[0]} dur={total} dim={dim} zoomFrom={1.02} zoomTo={1.1} />
      <AbsoluteFill style={{ backgroundColor: `rgba(255,214,140,${glow})` }} />
      <TopWash />
      <Sequence durationInFrames={on + 6}>
        <Headline brand={b} text={p.hook} hookFrame0 size={88} />
      </Sequence>
      <Sequence from={on + 4}>
        <Line brand={b} text={p.lines[0]} y={s.bottom - 170} size={54} tone="plum" />
      </Sequence>
    </AbsoluteFill>
  );
};

const Pov: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const total = bodyBeats(p) * B;
  const half = p.pics.length > 1 ? 6 * B : total;
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={half + 8}>
        <Photo pic={p.pics[0]} dur={half + 8} />
      </Sequence>
      {p.pics[1] ? (
        <Sequence from={half}>
          <Fade len={8}>
            <Photo pic={p.pics[1]} dur={total - half} zoomFrom={1.1} zoomTo={1.03} />
          </Fade>
        </Sequence>
      ) : null}
      <TopWash />
      <Headline brand={b} text={p.hook} hookFrame0 size={80} />
      <Sequence from={3 * B}>
        <Line brand={b} text={p.lines[0]} y={s.bottom - 170} size={52} tone="plum" />
      </Sequence>
    </AbsoluteFill>
  );
};

const Fade: React.FC<{ len: number; children: React.ReactNode }> = ({ len, children }) => {
  const o = useIn(0, len);
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** Two pictures stacked, each in its own half. */
const Split: React.FC<{ a: Pic; c: Pic; dur: number; la?: string; lc?: string; b: Brand; badges?: boolean }> = ({ a, c, dur, la, lc, b, badges }) => {
  const { width, height } = useVideoConfig();
  const s = useSafe();
  const half = height / 2;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, top: 0, width, height: half - 4, overflow: "hidden" }}>
        <AbsoluteFill style={{ width, height: half }}>
          <Photo pic={a} dur={dur} print={false} />
        </AbsoluteFill>
      </div>
      <div style={{ position: "absolute", left: 0, top: half + 4, width, height: half - 4, overflow: "hidden" }}>
        <AbsoluteFill style={{ width, height: half }}>
          <Photo pic={c} dur={dur} print={false} zoomFrom={1.1} zoomTo={1.03} />
        </AbsoluteFill>
      </div>
      <div style={{ position: "absolute", left: 0, top: half - 4, width, height: 8, backgroundColor: b.colors.ground }} />
      {badges ? (
        <>
          <Badge brand={b} n="1" x={s.right - 130} y={half - 170} />
          <Badge brand={b} n="2" x={s.right - 130} y={half + 50} at={3} />
        </>
      ) : null}
      {la ? <Line brand={b} text={la} y={half - 150} size={50} /> : null}
      {lc ? <Line brand={b} text={lc} y={half + 60} size={50} at={3} /> : null}
    </AbsoluteFill>
  );
};

const WhichOne: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const [a, c] = p.pics;
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={4 * B}>
        <Split a={a} c={c} dur={4 * B} b={b} badges />
      </Sequence>
      <Sequence from={4 * B} durationInFrames={4 * B}>
        <Photo pic={a} dur={4 * B} />
        <Badge brand={b} n="1" x={s.left} y={s.bottom - 160} />
      </Sequence>
      <Sequence from={8 * B} durationInFrames={4 * B}>
        <Photo pic={c} dur={4 * B} />
        <Badge brand={b} n="2" x={s.left} y={s.bottom - 160} />
      </Sequence>
      <Sequence from={12 * B} durationInFrames={4 * B}>
        <Split a={a} c={c} dur={4 * B} b={b} badges />
        <Line brand={b} text={p.lines[0]} y={s.bottom - 130} size={56} tone="plum" />
      </Sequence>
      <Sequence durationInFrames={4 * B + 4}>
        <Headline brand={b} text={p.hook} hookFrame0 size={74} y={s.top} />
      </Sequence>
    </AbsoluteFill>
  );
};

const RateIt: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const total = bodyBeats(p) * B;
  const each = 4 * B;
  return (
    <AbsoluteFill>
      {p.pics.map((pic, i) => (
        <Sequence key={i} from={i === 0 ? 0 : 3 * B + i * each} durationInFrames={i === 0 ? 3 * B + each + 8 : each + 8}>
          <Fade len={i === 0 ? 1 : 8}>
            <Photo pic={pic} dur={each + 3 * B} />
          </Fade>
        </Sequence>
      ))}
      <TopWash />
      <Headline brand={b} text={p.hook} hookFrame0 size={80} />
      <Sequence from={total - 4 * B}>
        <Line brand={b} text={p.lines[0]} y={s.bottom - 150} size={54} tone="plum" />
      </Sequence>
    </AbsoluteFill>
  );
};

const Numbered: React.FC<{ p: PieceProps; b: Brand; B: number; steps: string[]; badges: boolean }> = ({ p, b, B, steps, badges }) => {
  const s = useSafe();
  const each = 4 * B;
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={3 * B + 6}>
        <Photo pic={p.pics[0]} dur={3 * B} dim={0.35} />
        <AbsoluteFill style={{ justifyContent: "center" }}>
          <Headline brand={b} text={p.hook} hookFrame0 size={92} y={s.top + 160} />
        </AbsoluteFill>
      </Sequence>
      {p.pics.slice(0, 3).map((pic, i) => (
        <Sequence key={i} from={3 * B + i * each} durationInFrames={each + (i === 2 ? 0 : 6)}>
          <Fade len={6}>
            <Photo pic={pic} dur={each} zoomFrom={i % 2 ? 1.12 : 1.03} zoomTo={i % 2 ? 1.04 : 1.11} />
            <TopWash />
            {badges ? <Badge brand={b} n={String(i + 1)} x={s.left} y={s.top} /> : null}
            <Line brand={b} text={steps[i] ?? ""} y={badges ? s.top + 150 : s.bottom - 220} size={56} at={3} />
          </Fade>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const QuickTip: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const total = bodyBeats(p) * B;
  const half = Math.round(total / 2);
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={p.pics[1] ? half + 8 : total}>
        <Photo pic={p.pics[0]} dur={total} />
      </Sequence>
      {p.pics[1] ? (
        <Sequence from={half}>
          <Fade len={8}>
            <Photo pic={p.pics[1]} dur={total - half} zoomFrom={1.1} zoomTo={1.03} />
          </Fade>
        </Sequence>
      ) : null}
      <TopWash />
      <Headline brand={b} text={p.hook} hookFrame0 size={82} />
      {p.lines.map((l, i) => (
        // one thought on screen at a time: each line replaces the one before
        <Sequence key={i} from={3 * B + i * 3 * B} durationInFrames={i < p.lines.length - 1 ? 3 * B : undefined}>
          <Line brand={b} text={l} y={s.bottom - 190} size={52} tone="plum" />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const Checklist: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const total = bodyBeats(p) * B;
  const { width } = useVideoConfig();
  const scale = width / 1080;
  const panelIn = useIn(3 * B, 9);
  return (
    <AbsoluteFill>
      <Photo pic={p.pics[0]} dur={total} dim={0.18} printY={0.77} printMax={0.3} />
      <TopWash />
      <Headline brand={b} text={p.hook} hookFrame0 size={78} />
      <div style={{ position: "absolute", left: s.left, top: s.top + 360 * scale, width: s.inner + 60 * scale, backgroundColor: b.colors.ground, borderRadius: 26 * scale, padding: `${34 * scale}px ${36 * scale}px`, boxShadow: "0 20px 50px rgba(0,0,0,.28)", opacity: panelIn, transform: `translateY(${(1 - panelIn) * 24}px)`, display: "flex", flexDirection: "column", gap: 26 * scale }}>
        {p.lines.map((l, i) => (
          <ChecklistRow key={i} b={b} text={l} at={4 * B + i * 2 * B} scale={scale} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

const ChecklistRow: React.FC<{ b: Brand; text: string; at: number; scale: number }> = ({ b, text, at, scale }) => {
  const p = useIn(at, 7);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 * scale, opacity: 0.35 + 0.65 * p }}>
      <div style={{ width: 66 * scale, height: 66 * scale, borderRadius: 12 * scale, border: `4px solid ${b.colors.ink}`, backgroundColor: b.colors.tag, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <Mark kind="check" size={50 * scale} color={b.colors.ink} at={at} />
      </div>
      <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 46 * scale, color: b.colors.ink, lineHeight: 1.15 }}>{text}</div>
    </div>
  );
};

const Countdown: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const f = useCurrentFrame();
  const s = useSafe();
  const { width } = useVideoConfig();
  const n = p.count ?? 7;
  // The true number from frame 0 (it is the cover); it lands with a short settle, never counts from a wrong one.
  const settle = interpolate(f, [0, 10], [1.06, 1], { extrapolateRight: "clamp" });
  const total = bodyBeats(p) * B;
  const scale = width / 1080;
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={4 * B + 8}>
        <AbsoluteFill style={{ backgroundColor: b.colors.ink, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10 * scale }}>
          <div style={{ fontFamily: DISPLAY, fontVariationSettings: DISPLAY_VARIATION, fontWeight: 800, fontSize: 470 * scale, lineHeight: 0.9, color: b.colors.ground, transform: `scale(${settle})` }}>{n}</div>
          <div style={{ fontFamily: BODY, fontWeight: 800, fontSize: 64 * scale, color: b.colors.tag, letterSpacing: ".02em", textAlign: "center", maxWidth: width * 0.8, whiteSpace: "pre-line" }}>{p.hook}</div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={4 * B}>
        <Fade len={8}>
          <Photo pic={p.pics[0]} dur={total - 4 * B} />
          <TopWash />
          <Line brand={b} text={p.lines[0]} y={s.top} size={58} at={4} />
        </Fade>
      </Sequence>
    </AbsoluteFill>
  );
};

const RealMontage: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const first = 3 * B;
  const each = 2 * B;
  return (
    <AbsoluteFill>
      {p.pics.map((pic, i) => {
        const from = i === 0 ? 0 : first + (i - 1) * each;
        const len = i === 0 ? first : i === p.pics.length - 1 ? each + B : each;
        return (
          <Sequence key={i} from={from} durationInFrames={len}>
            <Photo pic={pic} dur={len} zoomFrom={i % 2 ? 1.1 : 1.02} zoomTo={i % 2 ? 1.03 : 1.09} />
            {i > 0 && pic.label ? <Line brand={b} text={pic.label} y={s.bottom - 140} size={46} tone="haint" at={2} /> : null}
          </Sequence>
        );
      })}
      <Sequence durationInFrames={first}>
        <TopWash />
        <Headline brand={b} text={p.hook} hookFrame0 size={84} />
      </Sequence>
    </AbsoluteFill>
  );
};

const DetailZoom: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const f = useCurrentFrame();
  const s = useSafe();
  const spots = p.spots ?? [];
  const pic = p.pics[0];
  const each = 4 * B;
  const keys: number[] = [0, 3 * B];
  spots.forEach((_, i) => keys.push(3 * B + i * each + 8, 3 * B + (i + 1) * each));
  const back = 3 * B + spots.length * each;
  // Camera: whole → each spot (scale 2.1) → whole.
  const at = (i: number) => (i < 0 ? { x: 0.5, y: 0.5, z: 1 } : { x: spots[i].fx, y: spots[i].fy, z: 2.1 });
  let cur = at(-1);
  for (let i = 0; i < spots.length; i++) {
    const start = 3 * B + i * each;
    const prev = at(i - 1 >= 0 ? i - 1 : -1);
    const t = interpolate(f, [start, start + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    if (f >= start) cur = { x: prev.x + (spots[i].fx - prev.x) * t, y: prev.y + (spots[i].fy - prev.y) * t, z: (i === 0 ? 1 : 2.1) + (2.1 - (i === 0 ? 1 : 2.1)) * t };
  }
  if (f >= back) {
    const t = interpolate(f, [back, back + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const last = at(spots.length - 1);
    cur = { x: last.x + (0.5 - last.x) * t, y: last.y + (0.5 - last.y) * t, z: 2.1 + (1 - 2.1) * t };
  }
  const label = spots.findIndex((_, i) => f >= 3 * B + i * each + 10 && f < 3 * B + (i + 1) * each);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${cur.z})`, transformOrigin: `${cur.x * 100}% ${cur.y * 100}%` }}>
        <Photo pic={pic} dur={1} zoomFrom={1} zoomTo={1} print={false} />
      </AbsoluteFill>
      {f < 3 * B + 4 ? (
        <>
          <TopWash />
          <Headline brand={b} text={p.hook} hookFrame0 size={84} />
        </>
      ) : null}
      {label >= 0 ? (
        <Sequence from={3 * B + label * each + 10} durationInFrames={each - 10}>
          <Line brand={b} text={spots[label].label} y={s.bottom - 150} size={52} tone="haint" />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

const ThisOrThat: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const rounds = p.pics.length / 2;
  const each = 4 * B;
  return (
    <AbsoluteFill>
      {Array.from({ length: rounds }, (_, r) => (
        <Sequence key={r} from={r * each} durationInFrames={r === rounds - 1 ? each + 4 * B : each}>
          <Split a={p.pics[2 * r]} c={p.pics[2 * r + 1]} dur={each} la={p.pics[2 * r].label} lc={p.pics[2 * r + 1].label} b={b} />
        </Sequence>
      ))}
      <Sequence durationInFrames={each}>
        <Headline brand={b} text={p.hook} hookFrame0 size={76} align="center" />
      </Sequence>
      <Sequence from={rounds * each}>
        <Headline brand={b} text={p.lines[0]} size={72} tone="plum" align="center" />
      </Sequence>
    </AbsoluteFill>
  );
};

const DoDont: React.FC<{ p: PieceProps; b: Brand; B: number }> = ({ p, b, B }) => {
  const s = useSafe();
  const { width } = useVideoConfig();
  const scale = width / 1080;
  const row = (kind: "check" | "cross", text: string) => (
    <div style={{ position: "absolute", left: s.left, top: s.bottom - 230 * scale, width: s.inner + 60 * scale, display: "flex", alignItems: "center", gap: 20 * scale, backgroundColor: b.colors.ground, borderRadius: 22 * scale, padding: `${22 * scale}px ${28 * scale}px`, boxShadow: "0 12px 30px rgba(0,0,0,.25)" }}>
      <Mark kind={kind} size={74 * scale} color={kind === "cross" ? "#B3261E" : b.colors.ink} at={4} />
      <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 48 * scale, color: b.colors.ink, lineHeight: 1.15 }}>{text}</div>
    </div>
  );
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={7 * B + 6}>
        <Photo pic={p.pics[0]} dur={7 * B} dim={0.08} />
        <TopWash />
        <Sequence from={2 * B}>{row("cross", p.lines[0])}</Sequence>
      </Sequence>
      <Sequence from={7 * B}>
        <Fade len={6}>
          <Photo pic={p.pics[1]} dur={5 * B} />
          <TopWash />
          {row("check", p.lines[1])}
        </Fade>
      </Sequence>
      <Sequence durationInFrames={7 * B}>
        <Headline brand={b} text={p.hook} hookFrame0 size={80} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ carousel stills

export const CarouselSlide: React.FC<PieceProps> = (p) => {
  const b = BRANDS[p.brand];
  const { width } = useVideoConfig();
  const scale = width / 1080;
  const i = p.slide ?? 0;
  const last = carouselSlides(p) - 1;
  if (i === last) {
    return (
      <AbsoluteFill style={{ backgroundColor: b.colors.ground, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 44 * scale }}>
        <Wordmark brand={b} size={84 * scale} />
        <div style={{ fontFamily: BODY, fontWeight: 600, fontSize: 44 * scale, color: b.colors.inkSoft, textAlign: "center", maxWidth: width * 0.8, lineHeight: 1.3 }}>{p.endLine ?? b.line}</div>
        <div style={{ backgroundColor: b.colors.accent, color: b.colors.ink, fontFamily: BODY, fontWeight: 800, fontSize: 48 * scale, padding: `${22 * scale}px ${44 * scale}px`, borderRadius: 16 * scale, border: `${3 * scale}px solid ${b.colors.ink}`, boxShadow: `0 ${5 * scale}px 0 ${b.colors.ink}` }}>{b.cta}</div>
        <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 38 * scale, color: b.colors.ink }}>{b.ctaUrl}</div>
      </AbsoluteFill>
    );
  }
  if (i === 0) {
    // The cover: the headline large on plum, the set's pictures fanned below as prints.
    const height = width * 1.25;
    const fan = p.pics.slice(0, 3);
    const pw = width * 0.42;
    return (
      <AbsoluteFill style={{ backgroundColor: b.colors.ink }}>
        <div style={{ position: "absolute", left: 70 * scale, right: 70 * scale, top: 90 * scale, fontFamily: DISPLAY, fontVariationSettings: DISPLAY_VARIATION, fontWeight: 800, fontSize: 92 * scale, lineHeight: 1.02, letterSpacing: "-0.01em", color: b.colors.ground, whiteSpace: "pre-line", textWrap: "balance" }}>{p.hook}</div>
        {fan.map((pic, k) => {
          const ph = Math.min(pw * (pic.h / pic.w), pw * 1.3);
          const cx = width / 2 + (k - (fan.length - 1) / 2) * width * 0.25;
          return (
            <div key={k} style={{ position: "absolute", left: cx - pw / 2, top: height * 0.68 - ph / 2 + (k === 1 ? -20 : 10) * scale, width: pw, height: ph, padding: 10 * scale, backgroundColor: b.colors.ground, borderRadius: 8, boxShadow: "0 24px 50px rgba(0,0,0,.5)", transform: `rotate(${(k - (fan.length - 1) / 2) * 5}deg)`, zIndex: k === 1 ? 2 : 1 }}>
              <Img src={staticFile(pic.src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `${(pic.fx ?? 0.5) * 100}% ${(pic.fy ?? 0.5) * 100}%`, borderRadius: 3 }} />
            </div>
          );
        })}
        <div style={{ position: "absolute", right: 56 * scale, bottom: 52 * scale, fontFamily: BODY, fontWeight: 800, fontSize: 34 * scale, color: b.colors.ink, backgroundColor: b.colors.tag, borderRadius: 999, padding: `${12 * scale}px ${26 * scale}px`, border: `3px solid ${b.colors.ink}` }}>Swipe ›</div>
        <div style={{ position: "absolute", left: 70 * scale, bottom: 58 * scale }}>
          <Wordmark brand={b} size={40 * scale} color={b.colors.ground} />
        </div>
      </AbsoluteFill>
    );
  }
  const pic = p.pics[i - 1];
  return (
    <AbsoluteFill>
      <Photo pic={pic} dur={1} zoomFrom={1} zoomTo={1} printY={0.47} />
      {pic.label ? (
        <div style={{ position: "absolute", left: 56 * scale, bottom: 60 * scale, fontFamily: BODY, fontWeight: 700, fontSize: 44 * scale, color: b.colors.ink, backgroundColor: b.colors.ground, borderRadius: 14 * scale, padding: `${14 * scale}px ${26 * scale}px`, boxShadow: "0 8px 24px rgba(0,0,0,.2)" }}>{pic.label}</div>
      ) : null}
      <div style={{ position: "absolute", right: 44 * scale, top: 40 * scale, fontFamily: BODY, fontWeight: 700, fontSize: 28 * scale, color: "#fff", textShadow: "0 1px 6px rgba(0,0,0,.6)" }}>{`${i + 1}/${last + 1}`}</div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ the piece

export const Piece: React.FC<PieceProps> = (p) => {
  const b = BRANDS[p.brand];
  const B = beat(p.bpm);
  const body = bodyBeats(p) * B;
  const total = durationFrames(p);
  let main: React.ReactNode;
  switch (p.format) {
    case "wait-for-it":
      main = <WaitForIt p={p} b={b} B={B} />;
      break;
    case "pov":
      main = <Pov p={p} b={b} B={B} />;
      break;
    case "which-one":
      main = <WhichOne p={p} b={b} B={B} />;
      break;
    case "rate-it":
      main = <RateIt p={p} b={b} B={B} />;
      break;
    case "three-ideas":
      main = <Numbered p={p} b={b} B={B} steps={p.pics.map((x) => x.label ?? "")} badges />;
      break;
    case "how-it-works":
      main = <Numbered p={p} b={b} B={B} steps={p.lines} badges />;
      break;
    case "office-party":
      main = <Numbered p={p} b={b} B={B} steps={p.lines} badges={false} />;
      break;
    case "quick-tip":
      main = <QuickTip p={p} b={b} B={B} />;
      break;
    case "checklist":
      main = <Checklist p={p} b={b} B={B} />;
      break;
    case "countdown":
      main = <Countdown p={p} b={b} B={B} />;
      break;
    case "real-montage":
      main = <RealMontage p={p} b={b} B={B} />;
      break;
    case "detail-zoom":
      main = <DetailZoom p={p} b={b} B={B} />;
      break;
    case "this-or-that":
      main = <ThisOrThat p={p} b={b} B={B} />;
      break;
    case "do-dont":
      main = <DoDont p={p} b={b} B={B} />;
      break;
    case "carousel":
      return <CarouselSlide {...p} />;
  }
  return (
    <AbsoluteFill style={{ backgroundColor: b.colors.ink }}>
      <Sequence durationInFrames={body}>{main}</Sequence>
      <Sequence from={body}>
        <EndCard brand={b} line={p.endLine} />
      </Sequence>
      <Music src={p.music} total={total} />
    </AbsoluteFill>
  );
};
