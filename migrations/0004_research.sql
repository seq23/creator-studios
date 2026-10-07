-- Phase 2/3/8 (Client Brain, Research, Learning loop). Additive only.
--
-- platform_videos: her videos as each platform reports them, from the stats connections
-- (Instagram via Meta Graph, YouTube via the YouTube APIs) and from the TikTok Studio export
-- she uploads on Stats. Separate from `metrics` because `metrics.post_id` must point at a
-- dashboard post, while most of her history (and every TikTok export row) was posted before
-- the dashboard existed. When a row matches a dashboard post by its link, post_id is set.
CREATE TABLE platform_videos (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok', 'instagram', 'youtube')),
  external_id TEXT NOT NULL,            -- the platform's video id, or the normalized link
  url TEXT,
  title TEXT,
  posted_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  avg_watch_s REAL,
  source TEXT NOT NULL CHECK (source IN ('api', 'import')),
  post_id TEXT REFERENCES posts (id) ON DELETE SET NULL,
  captured_at TEXT NOT NULL
);
CREATE UNIQUE INDEX platform_videos_ext ON platform_videos (platform, external_id);
CREATE INDEX platform_videos_posted ON platform_videos (platform, posted_at);
