-- Sam Creator Dashboard — full data model (BUILD_PLAN.md section 14) plus login tables.
-- One migration for the base so every phase builds on the same shape. Later phases add
-- 0002_*.sql and up; never edit this file after it has run in production.

-- ---------- login (email one-time code, no passwords) ----------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'helper')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX login_codes_email ON login_codes (email, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------- client brain ----------
CREATE TABLE brand_docs (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  extract_status TEXT NOT NULL DEFAULT 'pending' CHECK (extract_status IN ('pending', 'extracting', 'done', 'failed', 'unreadable')),
  extract_error TEXT,
  char_count INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE brand_profile (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  sections TEXT NOT NULL,               -- JSON, fixed section keys (see shared/types.ts BrandProfileSections)
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  source TEXT NOT NULL DEFAULT 'draft' CHECK (source IN ('draft', 'edited', 'rollback')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------- research ----------
CREATE TABLE research_briefs (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,                   -- JSON: sections with cited claims
  sources TEXT NOT NULL DEFAULT '[]',   -- JSON array of {id, url, title, kind: 'her_data'|'web'|'upload'}
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE research_uploads (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------- dumps and footage ----------
CREATE TABLE dumps (
  id TEXT PRIMARY KEY,
  door TEXT NOT NULL CHECK (door IN ('new', 'recycle')),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'queued', 'cutting', 'ready', 'reviewed', 'failed')),
  error_summary TEXT,
  clips_made INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dumped_at TEXT,
  ready_at TEXT
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  dump_id TEXT NOT NULL REFERENCES dumps (id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  upload_id TEXT,                       -- R2 multipart id while uploading
  upload_status TEXT NOT NULL DEFAULT 'uploading' CHECK (upload_status IN ('uploading', 'uploaded', 'failed', 'aborted')),
  duration_s REAL,
  file_note TEXT,
  content_hash TEXT,                    -- for "never re-upload the identical file"
  original_platform TEXT,               -- recycle only
  original_posted_at TEXT,              -- recycle only
  original_views INTEGER,               -- recycle only
  raw_deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX assets_dump ON assets (dump_id);
CREATE INDEX assets_hash ON assets (content_hash);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  dump_id TEXT NOT NULL REFERENCES dumps (id) ON DELETE CASCADE,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  recipe TEXT NOT NULL CHECK (recipe IN ('talking_head', 'hook_first', 'story', 'montage', 'recycle')),
  hook_text TEXT NOT NULL DEFAULT '',
  hook_alt TEXT,
  caption TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL DEFAULT '["tiktok","instagram","youtube"]',  -- JSON array
  score REAL NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  cover_r2_key TEXT,
  media_token TEXT,                     -- long random path Buffer fetches; cleared after posting + 30 days
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'deleted')),
  reject_reason TEXT,
  paid_partnership INTEGER NOT NULL DEFAULT 0,
  deal_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,    -- under the quality bar
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX clips_status ON clips (status, score);
CREATE INDEX clips_dump ON clips (dump_id);
CREATE UNIQUE INDEX clips_media_token ON clips (media_token);

-- ---------- scheduling and results ----------
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  scheduled_at TEXT NOT NULL,
  buffer_post_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_buffer', 'posted', 'failed', 'unscheduled')),
  url TEXT,
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX posts_sched ON posts (scheduled_at, platform, status);
CREATE INDEX posts_clip ON posts (clip_id);

CREATE TABLE metrics (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  avg_watch_s REAL
);
CREATE INDEX metrics_post ON metrics (post_id, captured_at);

-- Platform-level account stats (for the media kit and research), one row per sync.
CREATE TABLE account_stats (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  captured_at TEXT NOT NULL,
  followers INTEGER NOT NULL DEFAULT 0,
  avg_views INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'import', 'manual'))
);

-- ---------- voice (off until switched on) ----------
CREATE TABLE voice (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sample_r2_key TEXT,
  consent_at TEXT,
  consent_text TEXT,
  model_r2_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO voice (id, enabled) VALUES (1, 0);

CREATE TABLE narrations (
  id TEXT PRIMARY KEY,
  script TEXT NOT NULL,
  r2_key TEXT,
  clip_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'ready', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------- settings, jobs, connections ----------
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                  -- JSON
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Launch defaults (BUILD_PLAN.md section 10b). Settings page edits these.
INSERT INTO settings (key, value) VALUES
  ('weekly_caps', '{"tiktok":10,"instagram":7,"youtube":5}'),
  ('hard_cap_per_channel', '10'),
  ('runway_threshold_weeks', '2'),
  ('notify_emails', '[]'),
  ('posting_slots_source', '"research"'),
  ('features', '{"voice":false,"deeper_research":false,"weekly_recap":true,"help_ask":false}'),
  ('recycle_cooldown_days', '90'),
  ('helper_email', 'null');

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dispatched', 'running', 'done', 'failed')),
  ref_id TEXT,                          -- dump id, doc id, brief version …
  run_id TEXT,                          -- GitHub Actions run id when known
  nonce TEXT NOT NULL,
  safe_error TEXT,                      -- never contains her content
  progress TEXT,                        -- JSON {step, done, total}
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_type_status ON jobs (type, status, created_at);

CREATE TABLE connections (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github')),
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'ok', 'error', 'disconnected')),
  secret_enc TEXT,                      -- AES-GCM encrypted key/token, base64
  meta TEXT NOT NULL DEFAULT '{}',      -- JSON: channels found, credits left, account name …
  last_ok_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Health lights and events (Home + Settings). One row per check name, overwritten each run.
CREATE TABLE health (
  name TEXT PRIMARY KEY,
  light TEXT NOT NULL CHECK (light IN ('green', 'yellow', 'red', 'grey')),
  note TEXT NOT NULL DEFAULT '',
  fix_guide TEXT,                       -- help guide slug
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE emails_sent (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time_to_dump', 'clips_ready', 'posting_problem', 'connection_needs_you', 'weekly_recap', 'login_code')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  ref_id TEXT,
  provider_id TEXT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX emails_kind ON emails_sent (kind, sent_at);

-- ---------- brand deals ----------
CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  program_url TEXT,
  socials TEXT NOT NULL DEFAULT '{}',   -- JSON
  fit_score REAL NOT NULL DEFAULT 0,
  fit_reasons TEXT NOT NULL DEFAULT '[]',
  why_now TEXT,
  source_links TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'finder' CHECK (origin IN ('her_list', 'finder', 'program_search')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'saved', 'hidden')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE brand_contacts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('form', 'role_email', 'agency')),
  value TEXT NOT NULL,
  found_on_url TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX brand_contacts_brand ON brand_contacts (brand_id);

CREATE TABLE pitches (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES brand_contacts (id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  dm_text TEXT NOT NULL DEFAULT '',
  followup_1 TEXT NOT NULL DEFAULT '',
  followup_2 TEXT NOT NULL DEFAULT '',
  clip_links TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'sent', 'replied', 'closed')),
  sent_at TEXT,
  next_followup_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'found' CHECK (stage IN ('found', 'drafted', 'sent', 'replied', 'negotiating', 'won', 'passed')),
  terms_note TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '[]',   -- JSON [{clip_id, due_at, platform, done}]
  paid_partnership INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE media_kit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bio TEXT NOT NULL DEFAULT '',
  photo_r2_key TEXT,
  featured_clip_ids TEXT NOT NULL DEFAULT '[]',
  past_partners TEXT NOT NULL DEFAULT '[]',
  rates TEXT,                           -- JSON or null; shown only if she enters them
  public_slug TEXT NOT NULL DEFAULT 'studio',
  contact_email TEXT,
  updated_at TEXT
);
INSERT INTO media_kit (id) VALUES (1);

-- ---------- help ----------
CREATE TABLE help_feedback (
  id TEXT PRIMARY KEY,
  guide_slug TEXT NOT NULL,
  worked INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Decision log (approve/reject/lock events) so the learning loop and the audit trail read one table.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX events_kind ON events (kind, created_at);
