// Settings > Editing: which Looks each dump rotates through (all on by default), word captions,
// the end card, the music bed, and My music (her own songs, the only music ever used). Everything
// is visible and on by default except music, which needs a song first. The Worker's rules are in
// worker/routes/editing.ts; this card only shows them.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, patch, post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { Card, Switch, useLoad, useToast } from "./ui";
import type { LookView } from "./LookPicker";
import "../styles/looks.css";

interface Editing {
  looks: string[];
  captions: boolean;
  end_card: boolean;
  music: boolean;
}
interface MusicTrack {
  id: string;
  file_name: string;
  size_bytes: number;
}
interface EditorRow {
  capability: string;
  name: string;
  what: string;
  choice: string;
  effective: string;
  options: { id: string; name: string; connected: boolean }[];
}
interface EditingView {
  editing: Editing;
  looks: LookView[];
  music: MusicTrack[];
  editors: EditorRow[];
  templates: { name: string; what: string };
}

export function EditingCard({ owner }: { owner: boolean }) {
  const toast = useToast();
  const data = useLoad(() => get<EditingView>("/api/editing"));
  const [uploading, setUploading] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const v = data.data;

  async function saveEditor(capability: string, id: string) {
    try {
      data.setData(await patch<EditingView>("/api/editing", { editors: { [capability]: id } }));
      toast.ok(id === "built-in" ? "Saved. The built-in editor does it." : "Saved. New clips use it.");
    } catch (e) {
      toast.bad(e);
    }
  }

  async function save(partial: Partial<Editing>) {
    try {
      data.setData(await patch<EditingView>("/api/editing", partial));
      toast.ok("Saved. New clips use it.");
    } catch (e) {
      toast.bad(e);
    }
  }

  async function addSong(f: File) {
    setUploading(0);
    try {
      const up = await uploadFile(f, "music", null, (x) => setUploading(x));
      const r = await post<EditingView & { note: string }>("/api/editing/music", { id: up.id, key: up.key, fileName: f.name, mimeType: f.type });
      data.setData(r);
      toast.ok(r.note);
    } catch (e) {
      toast.bad(e);
    } finally {
      setUploading(null);
      if (file.current) file.current.value = "";
    }
  }

  async function removeSong(id: string) {
    try {
      data.setData(await del<EditingView>(`/api/editing/music/${id}`));
      toast.ok("Song removed.");
    } catch (e) {
      toast.bad(e);
    }
  }

  if (!v) return null;
  const on = new Set(v.editing.looks);
  return (
    <section className="section" aria-label="Editing">
      <h2>Editing</h2>
      <Card>
        <div className="set-text">
          <div className="set-label">Looks in the mix</div>
          <div className="hint">Each dump’s clips take turns through the looks switched on, so they never all look the same. Change any clip’s look in Review.</div>
        </div>
        <ul className="editing-looks">
          {v.looks.map((l) => (
            <li key={l.id}>
              <label className="editing-look" data-editing-look={l.id}>
                <input
                  type="checkbox"
                  checked={on.has(l.id)}
                  disabled={!owner || (on.has(l.id) && on.size === 1)}
                  onChange={(e) => save({ looks: e.target.checked ? [...on, l.id] : [...on].filter((x) => x !== l.id) })}
                  aria-label={`Use the ${l.name} look`}
                />
                <img src={l.thumb} alt="" width={111} height={64} loading="lazy" />
                <span className="look-text">
                  <span className="look-name">{l.name}</span>
                  <span className="hint">{l.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="hint">
          <Link to="/help/looks-and-styles">What each look does</Link>
        </div>
      </Card>
      <Card>
        <Switch label="Captions" hint="Off = no words on screen (the hook still shows). On = the words you say, in each look’s style." checked={v.editing.captions} onChange={(x) => owner && save({ captions: x })} />
        <Switch label="End card" hint="Off = clips end on your footage. On = your logo and handle for the last 1.5 seconds." checked={v.editing.end_card} onChange={(x) => owner && save({ end_card: x })} />
        <Switch
          label="Music bed"
          hint={v.music.length ? "Off = only your voice. On = one of your own songs, quietly under your voice." : "Off until you add a song under My music. Only songs you upload are ever used."}
          checked={v.editing.music}
          onChange={(x) => owner && save({ music: x })}
        />
      </Card>
      <Card>
        <div className="set-text">
          <div className="set-label">Who edits</div>
          <div className="hint">The built-in editor is free and always works. Pick a connected editor for a job and it does it instead, using your credits there; if it fails, the built-in editor takes over.</div>
        </div>
        {v.editors.map((row) => {
          const picked = row.options.find((o) => o.id === row.choice);
          return (
            <div key={row.capability} className="editor-row" data-editor-row={row.capability}>
              <div className="set-text">
                <label className="set-label" htmlFor={`editor-${row.capability}`}>
                  {row.name}
                </label>
                <div className="hint">{row.what}</div>
                {row.choice !== row.effective && picked ? <div className="hint">{picked.name} isn’t connected, so the built-in editor does this.</div> : null}
              </div>
              <select id={`editor-${row.capability}`} className="select" value={row.choice} disabled={!owner} onChange={(e) => saveEditor(row.capability, e.target.value)}>
                {row.options.map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.connected}>
                    {o.connected ? o.name : `${o.name} (connect it first)`}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        <div className="editor-row" data-editor-row="templates">
          <div className="set-text">
            <div className="set-label">{v.templates.name}</div>
            <div className="hint">{v.templates.what}</div>
          </div>
          <span className="pill">Built-in (free)</span>
        </div>
        <div className="hint">
          <Link to="/settings/connections">Connect an editor</Link> · <Link to="/help/edit-in-capcut">Use CapCut instead</Link>
        </div>
      </Card>
      <Card>
        <div className="set-text">
          <div className="set-label">My music</div>
          <div className="hint">Only songs you own or have the rights to. We never add music you didn’t upload: a song you don’t hold the rights to can get a post muted or taken down.</div>
        </div>
        {v.music.length ? (
          <ul className="music-list">
            {v.music.map((t) => (
              <li key={t.id} className="music-row" data-music-track>
                <span className="grow">{t.file_name}</span>
                {owner ? (
                  <button className="btn quiet small" onClick={() => removeSong(t.id)}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No songs yet.</p>
        )}
        {owner ? (
          <div>
            <input ref={file} id="music-file" className="sr-only" type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && addSong(e.target.files[0])} />
            <label htmlFor="music-file" className="btn quiet small" aria-disabled={uploading !== null}>
              {uploading !== null ? `Uploading… ${Math.round(uploading * 100)}%` : "Add a song"}
            </label>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
