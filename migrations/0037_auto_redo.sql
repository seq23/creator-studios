-- The studio redoes held clips on its own (owner's standing rule, 23 Oct 2026; worker/lib/autoRedo.ts,
-- shared/holdCauses.ts). hold_cause: why it is held (a HOLD_CAUSES key); hold_check: that cause's
-- check version when it was held (a newer build that fixes the check redoes it). auto_redo_count
-- redos so far under check version auto_redo_check (cap MAX_AUTO_REDOS per version: no loops);
-- auto_redo_job_id: the automatic redo in flight.
ALTER TABLE clips ADD COLUMN hold_cause TEXT;
ALTER TABLE clips ADD COLUMN hold_check INTEGER;
ALTER TABLE clips ADD COLUMN auto_redo_check INTEGER;
ALTER TABLE clips ADD COLUMN auto_redo_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN auto_redo_job_id TEXT;
-- A hidden clip that came with no reason gets one in plain words from the hourly sweep (it knows the bar).
