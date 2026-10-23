-- Studio fix (owner, 23 Oct 2026). Additive only: no existing row changes meaning.
--
-- What she dumped: each file's camera EXIF (a photo with no camera Make/Model is an AI picture),
-- when it was taken, and the stage the clip engine gave it (arrival, prep, team, process, finished,
-- detail, hero).
ALTER TABLE assets ADD COLUMN exif_camera INTEGER;
ALTER TABLE assets ADD COLUMN taken_at TEXT;
ALTER TABLE assets ADD COLUMN role TEXT;

-- Clip numbers: a dump's own sequence, never reused (clip_seq only goes up), and the version
-- letter (1 = "5", 2 = "5b"). The engine's result fields: what kind of clip, the score's reasons,
-- the hero shot it ends on, every file it uses, whether it uses an AI picture, which event it
-- tells, whether its words are still being written, and which clip it is a style of.
ALTER TABLE dumps ADD COLUMN clip_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dumps ADD COLUMN clip_counts TEXT;
ALTER TABLE clips ADD COLUMN number INTEGER;
ALTER TABLE clips ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE clips ADD COLUMN clip_type TEXT;
ALTER TABLE clips ADD COLUMN score_reasons TEXT;
ALTER TABLE clips ADD COLUMN hero_asset_id TEXT;
ALTER TABLE clips ADD COLUMN files_used TEXT;
ALTER TABLE clips ADD COLUMN uses_ai_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN event_group TEXT;
ALTER TABLE clips ADD COLUMN words_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN style_of TEXT;
ALTER TABLE clips ADD COLUMN again_fixes TEXT;
CREATE INDEX clips_number ON clips (dump_id, number);

-- Earlier versions of a clip, kept so she can compare and keep the best (Review > Compare versions).
-- The files stay until the clip is deleted or the version is dropped.
CREATE TABLE clip_versions (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,               -- JSON: the clip's fields as they were
  r2_key TEXT NOT NULL,
  cover_r2_key TEXT,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX clip_versions_clip ON clip_versions (clip_id, version);

-- The link each post went out with (the studio's link with this platform's tracking added).
ALTER TABLE posts ADD COLUMN tracked_link TEXT;

-- What converts in this studio's niche, researched monthly (jobs/niche_research.py).
CREATE TABLE niche_playbooks (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,                   -- JSON {updated_at, formats[], hooks[], caption_tips[]}
  summary TEXT NOT NULL DEFAULT '',     -- the plain lines on the Brand page and in the monthly note
  sources INTEGER NOT NULL DEFAULT 0,
  emailed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A new job type, 'niche' (jobs/niche_research.py). The jobs table is rebuilt with the same columns
-- and rows (nothing references it), exactly as 0020 did.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo', 'ytupload', 'photopack', 'niche')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatched', 'running', 'done', 'failed')),
  ref_id TEXT,
  run_id TEXT,
  nonce TEXT NOT NULL,
  safe_error TEXT,
  progress TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);
INSERT INTO jobs_new (id, type, status, ref_id, run_id, nonce, safe_error, progress, created_at, started_at, finished_at)
  SELECT id, type, status, ref_id, run_id, nonce, safe_error, progress, created_at, started_at, finished_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_type_status ON jobs (type, status, created_at);

-- emails_sent.kind gains 'niche_note' (the short monthly "What's working in your niche" note).
CREATE TABLE emails_sent_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time_to_dump', 'clips_ready', 'posting_problem', 'connection_needs_you', 'weekly_recap', 'login_code', 'brief_ready', 'heads_up', 'niche_note')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  ref_id TEXT,
  provider_id TEXT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO emails_sent_new (id, kind, to_email, subject, ref_id, provider_id, sent_at)
  SELECT id, kind, to_email, subject, ref_id, provider_id, sent_at FROM emails_sent;
DROP TABLE emails_sent;
ALTER TABLE emails_sent_new RENAME TO emails_sent;
CREATE INDEX emails_kind ON emails_sent (kind, sent_at);
