-- Learn from my past videos (owner's plan, 23 Oct 2026). Her old FINISHED videos, uploaded on Client
-- Brain → My past videos, stored apart from footage (R2 pastvideos/<id>, never raw/), so they are
-- never cut into clips. The pastvideos job only watches them and writes the Brand Profile section
-- "How my videos feel" (video_feel) into a new unlocked draft version. Additive only.
CREATE TABLE past_videos (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  upload_status TEXT NOT NULL DEFAULT 'uploading' CHECK (upload_status IN ('uploading', 'uploaded', 'aborted')),
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A new job type, 'pastvideos' (jobs/pastvideos.py). The jobs table is rebuilt with the same columns
-- and rows (nothing references it), exactly as 0027 did.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo', 'ytupload', 'photopack', 'niche', 'pastvideos')),
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
