// How she steers a dump, on the Add screen (worker/domain/steer.ts has the rules):
//   - Surprise me (the default): we pick, varied across the batch, and say what was made
//   - or tap chips: Look, Music, Pace, Clip length, How many, Captions, Platforms, Voice over, Camera sound. An untapped
//     group stays "Surprise me" for that one thing. Every group is always shown (nothing hidden).
// Before she sends: ONE line said back, always ("I'll make about 4 posts: …"), any part of her note
// that could not be used in her own words, any clash between her note and a tap (her note wins),
// and one-tap fixes. Nothing she wrote is dropped in silence (owner, 13 Nov 2026).
import type { NotFollowed, QuickFix, SteerControls, Understood } from "@shared/steer";
import { QUICK_FIXES, QUICK_FIX_LABEL } from "@shared/steer";
import { CAPTION_CHOICES, CAPTION_LABEL, COUNT_CHOICES, LENGTHS, PACES, VOICE_CHOICES, VOICE_LABEL, type VoiceChoice } from "@shared/steer";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import { CAMERA_HINT, CAMERA_LABEL, CAMERA_SOUNDS, type CameraSound } from "@shared/sound";
import "../styles/steer.css";

export interface SteerLook {
  id: string;
  name: string;
  cells: unknown[] | null;
}
export interface SteerTrack {
  id: string;
  file_name: string;
}

const PACE_LABEL = { calm: "Calm", normal: "Normal", fast: "Fast" } as const;

function Chip({ on, children, onClick, label }: { on: boolean; children: React.ReactNode; onClick: () => void; label?: string }) {
  return (
    <button type="button" className={`steer-chip${on ? " on" : ""}`} aria-pressed={on} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

function Group({ name, children, surprise, onSurprise }: { name: string; children: React.ReactNode; surprise: boolean; onSurprise: () => void }) {
  return (
    <div className="steer-group" role="group" aria-label={name}>
      <div className="steer-name">{name}</div>
      <div className="steer-chips">
        <Chip on={surprise} onClick={onSurprise} label={`${name}: surprise me`}>
          Surprise me
        </Chip>
        {children}
      </div>
    </div>
  );
}

/**
 * What happens about voice overs when she taps nothing: the Settings switch "Automatic voice overs"
 * (on → "quiet", off → "none"), and whether her voice is saved (GET /api/voice `auto`).
 */
export interface VoiceDefault {
  choice: VoiceChoice;
  hasVoice: boolean;
}

export function SteerPanel({ steer, onChange, looks, tracks, disabled, voice, camera }: { steer: SteerControls; onChange: (s: SteerControls) => void; looks: SteerLook[]; tracks: SteerTrack[]; disabled?: boolean; voice: VoiceDefault; camera: CameraSound }) {
  const set = (patch: Partial<SteerControls>) => {
    const next = { ...steer, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as SteerControls);
  };
  const surpriseAll = Object.keys(steer).filter((k) => k !== "include" && k !== "avoid").length === 0;
  const toggleLook = (id: string) => {
    const cur = steer.looks ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set({ looks: next.length ? next : undefined });
  };
  const togglePlatform = (p: Platform) => {
    // From "Surprise me", a tap means "just this one"; after that, taps add and remove.
    if (!steer.platforms) return set({ platforms: [p] });
    const cur = steer.platforms;
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || cur.includes(x));
    set({ platforms: next.length === PLATFORMS.length || !next.length ? undefined : next });
  };
  return (
    <fieldset className="steer" disabled={disabled}>
      <legend className="label">How should we cut this?</legend>
      <div className="steer-modes" role="group" aria-label="Surprise me or steer">
        <Chip on={surpriseAll} onClick={() => onChange(steer.include || steer.avoid ? { include: steer.include, avoid: steer.avoid } : {})}>
          Surprise me
        </Chip>
        <span className="hint">{surpriseAll ? "We pick a mix of looks, music and lengths and tell you what we tried. Or tap below to steer." : "Your picks are used; anything left on Surprise me is ours to pick."}</span>
      </div>
      <Group name="Look" surprise={!steer.looks} onSurprise={() => set({ looks: undefined })}>
        {looks.map((l) => (
          <Chip key={l.id} on={!!steer.looks?.includes(l.id)} onClick={() => toggleLook(l.id)}>
            {l.name}
          </Chip>
        ))}
      </Group>
      <Group name="Music" surprise={!steer.music} onSurprise={() => set({ music: undefined })}>
        <Chip on={steer.music === "none"} onClick={() => set({ music: "none" })}>
          No music
        </Chip>
        <Chip on={steer.music === "any"} onClick={() => set({ music: "any" })}>
          {tracks.length ? "My songs" : "Studio music"}
        </Chip>
        {tracks.map((t) => (
          <Chip key={t.id} on={steer.music === `track:${t.id}`} onClick={() => set({ music: `track:${t.id}` })}>
            {t.file_name.replace(/\.[a-z0-9]+$/i, "")}
          </Chip>
        ))}
        {!tracks.length ? <span className="hint">Studio music = free songs that come with your studio. Add your own under Settings → Editing → My music.</span> : null}
      </Group>
      <Group name="Pace" surprise={!steer.pace} onSurprise={() => set({ pace: undefined })}>
        {PACES.map((p) => (
          <Chip key={p} on={steer.pace === p} onClick={() => set({ pace: p })}>
            {PACE_LABEL[p]}
          </Chip>
        ))}
      </Group>
      <Group name="Clip length" surprise={!steer.length} onSurprise={() => set({ length: undefined })}>
        {(Object.keys(LENGTHS) as (keyof typeof LENGTHS)[]).map((k) => (
          <Chip key={k} on={steer.length === k} onClick={() => set({ length: k })}>
            {LENGTHS[k].label}
          </Chip>
        ))}
      </Group>
      <Group name="How many" surprise={!steer.count} onSurprise={() => set({ count: undefined })}>
        {COUNT_CHOICES.map((n) => (
          <Chip key={n} on={steer.count === n} onClick={() => set({ count: n })} label={`${n} clips`}>
            {n}
          </Chip>
        ))}
      </Group>
      <Group name="Captions" surprise={!steer.captions} onSurprise={() => set({ captions: undefined })}>
        {CAPTION_CHOICES.map((c) => (
          <Chip key={c} on={steer.captions === c} onClick={() => set({ captions: c })}>
            {CAPTION_LABEL[c]}
          </Chip>
        ))}
      </Group>
      <Group name="Platforms" surprise={!steer.platforms} onSurprise={() => set({ platforms: undefined })}>
        {PLATFORMS.map((p) => (
          <Chip key={p} on={!!steer.platforms?.includes(p)} onClick={() => togglePlatform(p)}>
            {PLATFORM_LABEL[p]}
          </Chip>
        ))}
      </Group>
      {/* Voice over: no "Surprise me" here; untapped, her Settings switch decides, and the chip it picks is marked. */}
      <div className="steer-group" role="group" aria-label="Voice over">
        <div className="steer-name">Voice over</div>
        <div className="steer-chips">
          {VOICE_CHOICES.map((v) => {
            const isDefault = !steer.voice && voice.choice === v;
            return (
              <Chip key={v} on={steer.voice === v || isDefault} onClick={() => set({ voice: steer.voice === v ? undefined : v })}>
                {VOICE_LABEL[v]}
                {isDefault ? " (your setting)" : ""}
              </Chip>
            );
          })}
        </div>
        <span className="hint" data-voice-hint>
          {(steer.voice ?? voice.choice) === "quiet"
            ? voice.hasVoice
              ? "Clips with no talking get a voice over in the voice you picked (Settings → Sound); clips where you talk never do. You can remove any of them in New posts to look at."
              : "Pick a voice first (Settings → Sound) or record your own (Voice overs); until then no voice overs are made."
            : (steer.voice ?? voice.choice) === "pick"
              ? "No voice overs now; tap Add voice over on any clip in New posts to look at."
              : "No voice overs on this batch. You can still add one to any clip in New posts to look at."}
        </span>
      </div>
      {/* Camera sound: no "Surprise me"; untapped, Settings → Sound decides, and the chip it picks is marked. */}
      <div className="steer-group" role="group" aria-label="Camera sound">
        <div className="steer-name">Camera sound</div>
        <div className="steer-chips">
          {CAMERA_SOUNDS.map((m) => {
            const isDefault = !steer.camera && camera === m;
            return (
              <Chip key={m} on={steer.camera === m || isDefault} onClick={() => set({ camera: steer.camera === m ? undefined : m })}>
                {CAMERA_LABEL[m]}
                {isDefault ? " (your setting)" : ""}
              </Chip>
            );
          })}
        </div>
        <span className="hint" data-camera-hint>
          {CAMERA_HINT[steer.camera ?? camera]}
        </span>
      </div>
    </fieldset>
  );
}

/** Which one-tap fixes are in force now (Fewer and More are steps, never "on"). */
function fixOn(fix: QuickFix, fixed: SteerControls | undefined): boolean {
  if (fix === "one") return fixed?.count === 1;
  if (fix === "no_words") return fixed?.captions === "none";
  if (fix === "instagram_only") return fixed?.platforms?.length === 1 && fixed.platforms[0] === "instagram";
  return false;
}

/**
 * What the studio says back before anything is made. The upload's own (not `compact`): always one
 * line, then what it couldn't use, then the one-tap fixes. Under one video's note (`compact`): what
 * that note was read as, and what it couldn't use.
 */
export function UnderstoodNote({ understood, compact, onFix, fixed }: { understood: Understood | null; compact?: boolean; onFix?: (fix: QuickFix) => void; fixed?: SteerControls }) {
  if (!understood) return null;
  const leftover = understood.leftover ?? [];
  const clashes = understood.clashes ?? [];
  if (compact && !understood.said.length && !understood.not_followed.length && !leftover.length) return null;
  return (
    <div className={`understood${compact ? " compact" : ""}`} data-understood>
      {!compact && understood.plan ? (
        <p className="understood-plan" data-plan>
          {understood.plan}
        </p>
      ) : null}
      {compact && understood.said.length ? (
        <ul>
          {understood.said.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      {leftover.map((l) => (
        <p key={l} className="understood-left" data-leftover>
          I couldn’t use this part: “{l}”
        </p>
      ))}
      {clashes.map((c) => (
        <p key={c} className="understood-left" data-clash>
          {c}
        </p>
      ))}
      <NotFollowedList items={understood.not_followed} before />
      {!compact && onFix ? (
        <>
          <div className="steer-chips understood-fixes" role="group" aria-label="Quick changes">
            {QUICK_FIXES.map((f) => (
              <Chip key={f} on={fixOn(f, fixed)} onClick={() => onFix(f)}>
                {QUICK_FIX_LABEL[f]}
              </Chip>
            ))}
          </div>
          <div className="hint">Not right? Tap one of these, or change your note. What you write wins over a choice you tapped.</div>
        </>
      ) : null}
    </div>
  );
}

export function NotFollowedList({ items, before }: { items: NotFollowed[]; before?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="not-followed" data-not-followed>
      <div className="label">{before ? "I can’t do this as asked" : "What I couldn’t do"}</div>
      <ul>
        {items.map((x) => (
          <li key={x.what}>
            <strong>{x.what}</strong>, because {x.why}.
          </li>
        ))}
      </ul>
    </div>
  );
}
