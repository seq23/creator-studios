-- Day 358 (docs/reviews/2026-09-26-day-358.md): archive (never delete) for dumps, deals, research
-- briefs and voice overs; Home cards she dismissed; file sizes for the storage meter and budget;
-- the draft-clearing warning and her "Keep".

-- Archive: archived_at set = out of the way (lists hide it unless "Show archived"); archived_by
-- 'her' (a tap) or 'tidy' (the daily tidy rules). Restore clears both.
ALTER TABLE dumps ADD COLUMN archived_at TEXT;
ALTER TABLE dumps ADD COLUMN archived_by TEXT CHECK (archived_by IN ('her', 'tidy'));
ALTER TABLE deals ADD COLUMN archived_at TEXT;
ALTER TABLE deals ADD COLUMN archived_by TEXT CHECK (archived_by IN ('her', 'tidy'));
ALTER TABLE research_briefs ADD COLUMN archived_at TEXT;
ALTER TABLE research_briefs ADD COLUMN archived_by TEXT CHECK (archived_by IN ('her', 'tidy'));
ALTER TABLE narrations ADD COLUMN archived_at TEXT;
ALTER TABLE narrations ADD COLUMN archived_by TEXT CHECK (archived_by IN ('her', 'tidy'));

-- Bytes each row holds in storage (the clip file + its cover; a voice over's audio + its mix).
-- NULL = not measured yet: the daily lane fills it from the storage listing.
ALTER TABLE clips ADD COLUMN file_bytes INTEGER;
ALTER TABLE narrations ADD COLUMN file_bytes INTEGER;

-- Unapproved drafts are cleared 60 days after they were made (worker/domain/tidy.ts). The Home
-- warning is recorded the first time it shows (delete_warned_at); a draft is never cleared unless
-- that was at least 7 days ago. Keep = keep_until (60 more days, warning reset).
ALTER TABLE clips ADD COLUMN delete_warned_at TEXT;
ALTER TABLE clips ADD COLUMN keep_until TEXT;

-- Home cards and notices she dismissed (a key per card; a changed card gets a new key and shows again).
CREATE TABLE dismissals (
  key TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Tidy up automatically: on by default (Settings → Tidy up), like every switch.
INSERT OR IGNORE INTO settings (key, value) VALUES ('tidy', '{"on":true}');

CREATE INDEX IF NOT EXISTS dumps_created ON dumps (archived_at, created_at);
CREATE INDEX IF NOT EXISTS deals_archived ON deals (archived_at, stage);
CREATE INDEX IF NOT EXISTS narrations_created ON narrations (archived_at, created_at);
CREATE INDEX IF NOT EXISTS posts_status ON posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS clips_dump_status ON clips (dump_id, status);
