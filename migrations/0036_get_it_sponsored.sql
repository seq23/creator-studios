-- Get it sponsored (owner-approved mock-up, 23 Oct 2026). A page inside Brand deals: she types an
-- experience she wants paid for (a trip, a treatment; for a business studio an event), the $0
-- "sponsor" job (jobs/sponsor.py) finds brands that sponsor it, videos to make and a to-do list,
-- and "Pitch this brand" drops a brand with a drafted first email into Deals. She sends every
-- pitch herself. Additive: two new tables, and the jobs table rebuilt with the same columns and
-- every row (nothing references it), exactly as 0027 and 0031 did, to allow the new job type.

CREATE TABLE sponsor_asks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,                       -- what she typed: "Spring break in Turks & Caicos"
  when_month TEXT NOT NULL DEFAULT '',       -- "2027-03" (the to-do dates work back from it), '' = not sure
  who TEXT NOT NULL DEFAULT '',              -- "Just me", "Family" …
  notes TEXT NOT NULL DEFAULT '',            -- "Anything else?"
  medical INTEGER NOT NULL DEFAULT 0,        -- 1: Botox, a clinic, surgery … the rules box shows first
  status TEXT NOT NULL DEFAULT 'researching' CHECK (status IN ('researching', 'ready', 'failed')),
  result TEXT,                               -- JSON SponsorResult (shared/sponsored.ts)
  ticks TEXT NOT NULL DEFAULT '{}',          -- JSON {todoId: "YYYY-MM-DD ticked"}
  hidden TEXT NOT NULL DEFAULT '[]',         -- JSON brand keys she said "Not for me" to (brought back any time)
  pitched TEXT NOT NULL DEFAULT '{}',        -- JSON {brandKey: dealId}
  job_id TEXT,
  safe_error TEXT,                           -- never her content
  ready_at TEXT,
  archived_at TEXT,                          -- "Archive this experience": nothing is deleted
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sponsor_asks_created ON sponsor_asks (archived_at, created_at);

-- "Add to my Calendar" for a video idea: a day to film it, shown on Calendar under "To film".
-- Not a post (posts need a cut clip); it never posts anything.
CREATE TABLE film_plans (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,                         -- YYYY-MM-DD in her audience time zone
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',             -- hook + shots
  ask_id TEXT,                               -- the sponsor_asks row it came from
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX film_plans_day ON film_plans (day);

-- A new job type, 'sponsor'. Same columns, every row copied back.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('cut', 'extract', 'research', 'brand_finder', 'voice', 'help_screenshots', 'metrics', 'fullvideo', 'ytupload', 'photopack', 'niche', 'pastvideos', 'sponsor')),
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
