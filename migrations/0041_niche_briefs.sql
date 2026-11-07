-- The niche brief (owner, 7 Nov 2026: research the niche "once each time a new user to each studio
-- gets ready to dump / upload photos"). One row per research run for this studio's user: who the
-- buyer is, 5-10 named accounts in the niche, their hooks, caption and call-to-action patterns,
-- words to avoid, hashtags and norms per channel (JSON), with its sources and researched-on date.
-- worker/lib/nicheBrief.ts writes it; every writer reads the latest ready one. Additive only.
CREATE TABLE IF NOT EXISTS niche_briefs (
  id TEXT PRIMARY KEY,
  user_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('researching', 'ready', 'failed')),
  brief TEXT,
  sources TEXT,
  researched_on TEXT,
  error TEXT,
  job_id TEXT,
  origin TEXT NOT NULL DEFAULT 'research',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS niche_briefs_status ON niche_briefs (status, created_at);
