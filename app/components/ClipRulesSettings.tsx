// Settings → Your clips (studio fix, 23 Oct 2026): what every clip asks people to do and where it
// sends them, when a caption says "Made with AI", how many clips a dump gives, the review bar, the
// town words, prices, and the logo on the end card. shared/studioRules.ts holds the rules; the
// studio's own defaults come with it and "Back to the studio's default" restores one field.
// Calm: one field per row, plain words, one Save per field, big targets, nothing hidden.
import { useEffect, useState } from "react";
import { get, patch } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { Card, Stepper, Switch, useLoad, useToast } from "./ui";
import type { StudioRules } from "@shared/studioRules";
import { RULE_LIMITS } from "@shared/studioRules";
import "../styles/steer.css";

interface RulesView {
  rules: StudioRules;
  defaults: StudioRules;
  logo_url: string | null;
}

export function ClipRulesCard({ owner }: { owner: boolean }) {
  const toast = useToast();
  const view = useLoad(() => get<RulesView>("/api/settings/rules"));
  const [phrases, setPhrases] = useState("");
  const [link, setLink] = useState("");
  const [places, setPlaces] = useState("");
  const [busy, setBusy] = useState(false);
  const r = view.data?.rules;

  useEffect(() => {
    if (!r) return;
    setPhrases(r.cta_phrases.join("\n"));
    setLink(r.cta_link);
    setPlaces(r.place_words.join(", "));
  }, [r]);

  async function save(partial: Partial<StudioRules>, said = "Saved. New clips use it.") {
    setBusy(true);
    try {
      view.setData(await patch<RulesView>("/api/settings/rules", partial));
      toast.ok(said);
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const h = await uploadFile(file, "logo", null, () => undefined);
      view.setData(await patch<RulesView>("/api/settings/rules", { logo_r2_key: h.key }));
      toast.ok("Logo saved. New clips end with it.");
    } catch (e) {
      toast.bad(e);
    } finally {
      setBusy(false);
    }
  }

  if (!r || !view.data) return null;
  const d = view.data.defaults;
  const off = !owner || busy;

  return (
    <section className="section" id="your-clips" data-clip-rules>
      <h2>Your clips</h2>
      <Card>
        <label className="set-label" htmlFor="cta-phrases">
          What each clip asks people to do
        </label>
        <div className="hint">One per line. Clips take turns with these, on the last screen and in the caption.</div>
        <textarea id="cta-phrases" className="textarea" rows={3} value={phrases} disabled={!owner} onChange={(e) => setPhrases(e.target.value)} />
        <div className="btn-row">
          <button type="button" className="btn small" disabled={off || phrases === r.cta_phrases.join("\n")} onClick={() => save({ cta_phrases: phrases.split("\n") })}>
            Save what clips ask
          </button>
        </div>
      </Card>
      <Card>
        <label className="set-label" htmlFor="cta-link">
          Where they go: your link
        </label>
        <div className="hint">The page people land on to book or ask. Each platform gets its own tracking version, so Stats can tell where people came from.</div>
        <input id="cta-link" className="input" inputMode="url" placeholder="https://" value={link} disabled={!owner} onChange={(e) => setLink(e.target.value)} />
        <div className="btn-row">
          <button type="button" className="btn small" disabled={off || link === r.cta_link} onClick={() => save({ cta_link: link.trim() })}>
            Save the link
          </button>
          {d.cta_link && d.cta_link !== r.cta_link ? (
            <button type="button" className="btn quiet small" disabled={off} onClick={() => save({ cta_link: d.cta_link })}>
              Back to the studio’s default
            </button>
          ) : null}
        </div>
        {!r.cta_link ? <p className="hint" data-no-link>No link yet: captions end with “{r.cta_phrases[0]}” and no link until you add one.</p> : null}
      </Card>
      <Card>
        <div className="set-label">When a caption says “Made with AI”</div>
        <div className="hint">It sits on its own line at the very end of the caption, under a short line. Never on the video itself.</div>
        <div className="steer-chips" role="radiogroup" aria-label="When a caption says Made with AI">
          <button type="button" role="radio" aria-checked={r.ai_note === "all"} className={`steer-chip${r.ai_note === "all" ? " on" : ""}`} disabled={off} onClick={() => save({ ai_note: "all" })}>
            Every clip
          </button>
          <button type="button" role="radio" aria-checked={r.ai_note === "ai_images"} className={`steer-chip${r.ai_note === "ai_images" ? " on" : ""}`} disabled={off} onClick={() => save({ ai_note: "ai_images" })}>
            Only clips with an AI picture
          </button>
        </div>
        <p className="hint">An AI picture is a photo with no camera details in it (a reimagined or made-up picture). Clips with an AI voice over always say it.</p>
      </Card>
      <Card>
        <div className="set-label">How many clips from each dump</div>
        <div className="hint">Different clips, never the same clip in another look. Fewer when the footage is thin.</div>
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">At least</div>
          </div>
          <Stepper label="At least this many clips" value={r.clip_target.min} min={RULE_LIMITS.clipsMin} max={r.clip_target.max} onChange={(n) => !off && save({ clip_target: { min: n, max: r.clip_target.max } })} />
        </div>
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">At most</div>
          </div>
          <Stepper label="At most this many clips" value={r.clip_target.max} min={r.clip_target.min} max={RULE_LIMITS.clipsMax} onChange={(n) => !off && save({ clip_target: { min: r.clip_target.min, max: n } })} />
        </div>
      </Card>
      <Card>
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">Review bar: {r.bar} out of 100</div>
            <div className="hint">A clip under it is made again once. If it is still under, it is tucked under “Show hidden” with the reason.</div>
          </div>
          <Stepper label="Review bar" value={r.bar} min={0} max={100} onChange={(n) => !off && save({ bar: n })} />
        </div>
      </Card>
      <Card>
        <label className="set-label" htmlFor="place-words">
          Your towns and local words
        </label>
        <div className="hint">Put in captions, on screen and in voice overs, so local people find you. Separate them with commas.</div>
        <input id="place-words" className="input" value={places} disabled={!owner} onChange={(e) => setPlaces(e.target.value)} />
        <div className="btn-row">
          <button type="button" className="btn small" disabled={off || places === r.place_words.join(", ")} onClick={() => save({ place_words: places.split(",") })}>
            Save the towns
          </button>
        </div>
      </Card>
      <Card>
        <Switch checked={r.prices} onChange={(v) => !off && save({ prices: v })} label="Clips may say a price" hint={r.prices ? "Only prices from your price list, never anything else." : "No prices in any clip, caption or voice over."} />
      </Card>
      <Card>
        <div className="set-label">Logo on the last screen</div>
        <div className="hint">A PNG with a clear background works best.</div>
        {view.data.logo_url ? <img className="rules-logo" src={`${view.data.logo_url}?v=${encodeURIComponent(r.logo_r2_key ?? "")}`} alt="Your logo" /> : <p className="hint">No logo yet: the last screen shows your name.</p>}
        <div className="btn-row">
          <label className={`btn small${off ? " disabled" : ""}`}>
            {view.data.logo_url ? "Choose a different logo" : "Choose your logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={off} onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {view.data.logo_url ? (
            <button type="button" className="btn quiet small" disabled={off} onClick={() => save({ logo_r2_key: null }, "Logo removed.")}>
              Remove the logo
            </button>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
