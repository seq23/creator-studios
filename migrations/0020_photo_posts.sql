-- Photo posts (shared/photoPosts.ts): a photo pack (one to ten photos she uploads), what the photo
-- maker makes from it (a slow-zoom reel, a before/after, a carousel), its three captions, and the
-- posts that go out on their own to Facebook, Instagram, TikTok and Pinterest, each with a
-- heads-up and a Skip. Additive: no existing row changes (the two rebuilt tables keep every row).

CREATE TABLE photo_packs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'making', 'ready', 'failed')),
  note TEXT NOT NULL DEFAULT '',
  -- unchecked: the photo maker has not looked yet · clean: nothing to hide · fixed: faces or house
  -- numbers were blurred · blocked: could not be made safe (never posts).
  privacy TEXT NOT NULL DEFAULT 'unchecked' CHECK (privacy IN ('unchecked', 'clean', 'fixed', 'blocked')),
  privacy_detail TEXT,                  -- JSON counts only: {"faces": n, "numbers": n}
  captions TEXT NOT NULL DEFAULT '[]',  -- JSON array of 3 short captions
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ready_at TEXT
);
CREATE INDEX photo_packs_created ON photo_packs (created_at);

CREATE TABLE pack_photos (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES photo_packs (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main', 'before', 'after')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  upload_status TEXT NOT NULL DEFAULT 'uploading' CHECK (upload_status IN ('uploading', 'uploaded', 'failed', 'aborted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pack_photos_pack ON pack_photos (pack_id);

CREATE TABLE pack_items (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES photo_packs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reel', 'before_after', 'carousel')),
  r2_key TEXT,                          -- the video (reel, before_after); NULL until made
  cover_r2_key TEXT,
  images TEXT NOT NULL DEFAULT '[]',    -- JSON array of R2 keys (carousel: the checked photos)
  media_token TEXT,                     -- long random path the platforms fetch (/media/p/<token>)
  ai_made INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pack_items_pack ON pack_items (pack_id);
CREATE UNIQUE INDEX pack_items_token ON pack_items (media_token);

CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES photo_packs (id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('reel', 'before_after', 'carousel')),
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'tiktok', 'pinterest')),
  caption TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  -- scheduled: goes out on its own at scheduled_at · waiting: its platform is not connected (it is
  -- planned again once it is) · held: a rule stopped it (error says which) · skipped: she tapped
  -- Skip, it never goes out · sending / posted / failed.
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'waiting', 'sending', 'posted', 'skipped', 'failed', 'held')),
  heads_up_at TEXT,
  skipped_at TEXT,
  external_id TEXT,
  url TEXT,
  error TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX social_posts_due ON social_posts (status, scheduled_at);
CREATE INDEX social_posts_pack ON social_posts (pack_id);

-- The one-time "What's new" note: a row once she taps Got it (per user, per note id).
CREATE TABLE whats_new_seen (
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, note_id)
);

-- A new job type, 'photopack' (jobs/photopack.py). SQLite cannot change a CHECK in place: the jobs
-- table is rebuilt with the same columns and rows (nothing references it), exactly as 0017 did.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo', 'ytupload', 'photopack')),
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

-- connections.service gains 'facebook' (the Page token) and 'pinterest' (the access token), pasted
-- on Setup. Rebuilt with every row kept, as 0019 did (nothing references it).
CREATE TABLE connections_new (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github', 'elevenlabs', 'opusclip', 'vizard', 'klap', 'submagic', 'descript', 'youtube', 'youtube_api', 'google_app', 'meta_app', 'facebook', 'pinterest')),
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

-- emails_sent.kind gains 'heads_up' (the day-before note listing photo posts, each with a Skip).
-- Rebuilt with every row kept, as 0005 did (nothing references emails_sent).
CREATE TABLE emails_sent_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time_to_dump', 'clips_ready', 'posting_problem', 'connection_needs_you', 'weekly_recap', 'login_code', 'brief_ready', 'heads_up')),
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
