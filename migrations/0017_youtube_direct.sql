-- Full videos straight to her own YouTube channel (owner decision, 26 Sep 2026). She taps
-- "Connect YouTube" once (connections.service = 'youtube', the token AES-GCM encrypted like every
-- other connection); each approved full video on the Calendar is uploaded by a GitHub Actions job
-- ('ytupload', jobs/ytupload.py) and read back. worker/domain/youtubeDirect.ts has the rules.
--
-- youtube_uploads: one row per full video (never a second upload of the same clip).
--   status     queued (waiting for its 7-day window, the 3-a-day cap or tomorrow's allowance),
--              uploading (the job is running), scheduled (on YouTube, private, public at publish_at),
--              live (on YouTube the way she chose), removed (taken off the Calendar before it went
--              public: private and kept, never deleted), mismatch (the read-back differs from what
--              was asked: a red light with a named fix), failed (the hand-off: Upload it yourself)
--   privacy / publish_at            what YouTube was last told
--   actual_privacy / actual_publish_at  what videos.list read back
--   thumbnail  set | needs_verify (her channel isn't verified for custom thumbnails) | failed
--   reason     a short enum (quota, cap, revoked, publish_at, kept_private, …); note: her plain sentence
CREATE TABLE youtube_uploads (
  clip_id TEXT PRIMARY KEY REFERENCES clips (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'uploading', 'scheduled', 'live', 'removed', 'mismatch', 'failed')),
  job_id TEXT,
  video_id TEXT,
  privacy TEXT CHECK (privacy IN ('public', 'unlisted', 'private')),
  publish_at TEXT,
  actual_privacy TEXT,
  actual_publish_at TEXT,
  thumbnail TEXT CHECK (thumbnail IN ('set', 'needs_verify', 'failed')),
  reason TEXT,
  note TEXT,
  not_before TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX youtube_uploads_status ON youtube_uploads (status, not_before);
CREATE INDEX youtube_uploads_started ON youtube_uploads (started_at);

-- A new job type, 'ytupload'. SQLite cannot change a CHECK in place: the jobs table is rebuilt with
-- the same columns and rows (nothing references it), exactly as 0015 did.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo', 'ytupload')),
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

-- connections.service gains 'youtube' (Connect YouTube, full videos; the optional Stats sign-in stays
-- 'google'). Rebuilt with every row kept, as 0008 did (nothing references connections).
CREATE TABLE connections_new (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github', 'elevenlabs', 'opusclip', 'vizard', 'klap', 'submagic', 'descript', 'youtube')),
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
