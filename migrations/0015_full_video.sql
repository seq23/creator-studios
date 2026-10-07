-- The full-video door (owner, 26 Sep 2026): "A full video for YouTube". One video, uploaded whole:
-- no cutting, no 9:16 reframing. A title, description with chapters, tags and three thumbnail
-- choices are drafted from its transcript; she approves it in Review; it goes on the Calendar
-- within her YouTube cap and posts through Buffer (worker/domain/fullVideo.ts has the rules).
--
-- dumps.kind: 'clips' (the cutter, both older doors) or 'full_video' (this door; door stays 'new').
ALTER TABLE dumps ADD COLUMN kind TEXT NOT NULL DEFAULT 'clips';

-- clips.full_video: 1 = the whole video (a clips row so Review, the Calendar and Buffer treat it
-- like any post; platforms is always ["youtube"]). clips.youtube: its YouTube details as JSON
-- {title, description, chapters:[{t,title}], tags:[], thumbnails:[{key,t}], thumb_pick, privacy,
--  width, height, size_bytes, studio_done_at, handoff}. file_deleted_at: the video file was removed
-- by the storage rule (7 days after it posted, or 14 days unapproved); the thumbnails, words and
-- numbers stay.
ALTER TABLE clips ADD COLUMN full_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN youtube TEXT;
ALTER TABLE clips ADD COLUMN file_deleted_at TEXT;

-- A new job type, 'fullvideo' (jobs/fullvideo.py): probe, faststart copy (no re-encode),
-- transcript, three thumbnail frames. SQLite cannot change a CHECK in place, so the jobs table is
-- rebuilt with the same columns and rows (nothing references it).
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo')),
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
