-- Looks and editors (25 Sep 2026). Additive, plus one CHECK widening by table rebuild.
--
-- clips.look: the Look the clip was rendered in (worker/domain/looks.ts, jobs/looks.json). NULL =
-- made before Looks existed, or imported from another editor (edited_with says which).
-- clips.parts: JSON [[start_s, end_s], ...] in play order (a hook-first clip is its best line,
-- then the body), so a re-render keeps the same cut. clips.layout: JSON {cells, voice} for a grid
-- Look (which moment is in each cell, whose sound plays).
ALTER TABLE clips ADD COLUMN look TEXT;
ALTER TABLE clips ADD COLUMN parts TEXT;
ALTER TABLE clips ADD COLUMN layout TEXT;

-- A re-render in progress ("Change look" in Review): the old file stays live until the new one
-- is ready. rerender_error is the plain sentence when the last one failed (the old file is kept).
ALTER TABLE clips ADD COLUMN pending_look TEXT;
ALTER TABLE clips ADD COLUMN pending_layout TEXT;
ALTER TABLE clips ADD COLUMN rerender_job_id TEXT;
ALTER TABLE clips ADD COLUMN rerender_error TEXT;

-- media_version bumps every time the clip's file is swapped (a new Look, her own edit), so the
-- player and the cover never show a cached old version (/media/<token>?v=<n>).
ALTER TABLE clips ADD COLUMN media_version INTEGER NOT NULL DEFAULT 0;

-- edited_with: the editor that made the current file when it is not the built-in one: 'capcut',
-- 'inshot', 'descript' (her own edit, uploaded back from Review) or a connected editor's id.
ALTER TABLE clips ADD COLUMN edited_with TEXT;

-- Her own songs for the music bed (Settings > Editing > My music). Only files she uploads; no
-- bundled music, no libraries (licensing: she must hold the rights to what she posts).
CREATE TABLE music_tracks (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Settings > Editing. looks_off lists the Looks she switched off, so a Look added later is on
-- by default. Music is off until she adds a song. editors: who does each editing job
-- ("built-in" or a connected editor, worker/domain/editors.ts).
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('editing', '{"looks_off":[],"captions":true,"end_card":true,"music":false,"editors":{"cut_from_source":"built-in","caption":"built-in","enhance":"built-in"}}');

-- Work done by another editor. A connected editor (Opus Clip, Vizard, Klap cut a dump; Submagic
-- captions a clip; Descript enhances one) is polled until done; 'handback' is her own edit from an
-- app with no API (CapCut, InShot), uploaded back from Review. Either way the result is imported
-- through the same checks as the built-in cutter (the cut job's import mode). source_token is the
-- long random path a connected editor fetches the video from (/media/source/<token>), valid only
-- while the row is 'submitted'. result: JSON (the editor's output links, or her uploaded file).
CREATE TABLE editor_jobs (
  id TEXT PRIMARY KEY,
  editor TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('cut_from_source', 'caption', 'enhance', 'handback')),
  dump_id TEXT REFERENCES dumps (id) ON DELETE CASCADE,
  clip_id TEXT REFERENCES clips (id) ON DELETE CASCADE,
  asset_id TEXT,
  project_id TEXT,
  source_token TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'importing', 'done', 'failed')),
  error TEXT,
  result TEXT,
  polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX editor_jobs_status ON editor_jobs (status, created_at);
CREATE UNIQUE INDEX editor_jobs_token ON editor_jobs (source_token);

-- connections.service gains the editors with a self-serve API (docs/EDITORS.md). SQLite cannot
-- alter a CHECK, so the table is rebuilt with every row kept (nothing references connections).
CREATE TABLE connections_new (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github', 'elevenlabs', 'opusclip', 'vizard', 'klap', 'submagic', 'descript')),
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'ok', 'error', 'disconnected')),
  secret_enc TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  last_ok_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO connections_new (service, status, secret_enc, meta, last_ok_at, last_error, updated_at)
  SELECT service, status, secret_enc, meta, last_ok_at, last_error, updated_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
