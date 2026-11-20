-- File retention (owner, 20 Nov 2026): her originals are cleared RAW_RETENTION_DAYS after their clips
-- are ready, with an email 14 and 3 days before (Download all / Keep them) and a note when done
-- (worker/lib/retention.ts). Additive only.
--   dumps.originals_kept   1 = she tapped Keep them: this dump's originals are never cleared.
--   file_notices           one row per dump per notice, so each email goes once and nothing is
--                          cleared before its 3-day warning has stood for 3 days. batch_id = the
--                          email it went in (its Download all link opens that batch).
ALTER TABLE dumps ADD COLUMN originals_kept INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS file_notices (
  dump_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('14', '3', 'done')),
  batch_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (dump_id, stage)
);
CREATE INDEX IF NOT EXISTS file_notices_batch ON file_notices (batch_id);
