-- "Looks like someone else's video" (Phase 0 live test, 25 Sep 2026). Set by the cut job's
-- watermark check (worker/domain/sourceCheck.ts): NULL = nothing seen, 'hers' = her own handle,
-- 'other' = another creator's watermark/handle (clips held off the calendar), 'confirmed' = she
-- tapped "This is my video". source_note is the plain sentence the Dump screen shows.
ALTER TABLE assets ADD COLUMN source_owner TEXT CHECK (source_owner IN ('hers', 'other', 'confirmed'));
ALTER TABLE assets ADD COLUMN source_note TEXT;
