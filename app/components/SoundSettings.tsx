// Settings → Sound (owner, 22 Oct 2026): what happens to the camera's own sound, and whose voice the
// voice overs use: a free stock voice (listen, then pick) or her own recording. shared/sound.ts has
// the choices. Plain words, big targets; every choice is always shown.
import { Link } from "react-router-dom";
import type { SettingsShape } from "@shared/types";
import { CAMERA_HINT, CAMERA_LABEL, CAMERA_SOUNDS, STOCK_VOICES, voiceInUse, voiceInUseLine, type SoundSettings } from "@shared/sound";
import { Card } from "./ui";
import "../styles/steer.css";

export function SoundCard({ sound, owner, onSave, hasSample = false }: { sound: SoundSettings; owner: boolean; onSave: (partial: Partial<SettingsShape>) => void; hasSample?: boolean }) {
  // Which voice speaks right now, and why, in one plain sentence (Follow-on V).
  const inUse = voiceInUse(sound, hasSample);
  const set = (patch: Partial<SoundSettings>) => owner && onSave({ sound: { ...sound, ...patch } });
  return (
    <section className="section" id="sound">
      <h2>Sound</h2>
      <Card>
        <div className="set-label">Camera sound</div>
        <div className="hint">What happens to the sound your phone recorded. You can change it for one dump on the Dump screen.</div>
        <div className="steer-chips" role="radiogroup" aria-label="Camera sound">
          {CAMERA_SOUNDS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={sound.camera === m} className={`steer-chip${sound.camera === m ? " on" : ""}`} disabled={!owner} onClick={() => set({ camera: m })}>
              {CAMERA_LABEL[m]}
            </button>
          ))}
        </div>
        <p className="hint" data-camera-setting>
          {CAMERA_HINT[sound.camera]}
        </p>
      </Card>
      <Card>
        <div className="set-label">Voice for voice overs</div>
        <div className="hint">Clips with no talking can get a short voice over. Every voice over is labelled “Made with AI” when it posts.</div>
        <p className="voice-in-use" data-voice-in-use={inUse.why}>
          <strong>Voice in use now:</strong> {voiceInUseLine(inUse)}
        </p>
        <div className="steer-chips" role="radiogroup" aria-label="Voice for voice overs">
          <button type="button" role="radio" aria-checked={sound.voice_source === "stock"} className={`steer-chip${sound.voice_source === "stock" ? " on" : ""}`} disabled={!owner} onClick={() => set({ voice_source: "stock" })}>
            A studio voice
          </button>
          <button type="button" role="radio" aria-checked={sound.voice_source === "mine"} className={`steer-chip${sound.voice_source === "mine" ? " on" : ""}`} disabled={!owner} onClick={() => set({ voice_source: "mine" })}>
            My recorded voice
          </button>
        </div>
        {sound.voice_source === "stock" ? (
          <div className="list" data-stock-voices>
            {STOCK_VOICES.map((v) => (
              <div key={v.id} className="list-row">
                <div className="grow">
                  <div className="title">
                    {v.label}
                    {sound.stock_voice === v.id ? <span className="pill ok"> In use</span> : null}
                  </div>
                  <audio controls preload="none" src={v.preview} aria-label={`Listen to ${v.label}`} />
                </div>
                {sound.stock_voice !== v.id ? (
                  <button type="button" className="btn quiet" disabled={!owner} onClick={() => set({ stock_voice: v.id, voice_source: "stock" })}>
                    Use this voice
                  </button>
                ) : null}
              </div>
            ))}
            <p className="hint">Free voices that come with your studio (open licence, no one’s real voice is copied).</p>
          </div>
        ) : (
          <p className="hint">
            Your own voice, from the recording on <Link to="/voice#voice-steps">Voice overs</Link>. Until it is saved, the studio voice speaks instead, so voice overs never wait.
          </p>
        )}
      </Card>
    </section>
  );
}
