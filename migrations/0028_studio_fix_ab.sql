-- Studio fix A+B combined (23 Oct 2026). Additive only: no table is rebuilt, no row is dropped.
--
-- 1. The clip engine scores 0..100 (an integer with plain reasons); the Worker used to store 0..1.
--    Every stored score moves to the same 0..100 scale once, here, so Review, the Calendar's
--    "best first", the media kit and the version history all read one scale. Rows already on the
--    new scale (a value above 1) are left alone, so applying this to a copy that has new rows is safe.
UPDATE clips SET score = CAST(ROUND(score * 100) AS INTEGER) WHERE score <= 1;
UPDATE clip_versions SET score = CAST(ROUND(score * 100) AS INTEGER) WHERE score <= 1;

-- 2. The engine's voice-over script for the clip (cleaned of reasoning, never the caption read back);
--    the automatic voice over speaks it before drafting one of its own.
ALTER TABLE clips ADD COLUMN voice_script TEXT;

-- 3. The words pass (worker/lib/wordsPass.ts): a clip that came back with no words of its own
--    (words_pending) gets them on a later run; how many runs have tried, and when the last one did.
ALTER TABLE clips ADD COLUMN words_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN words_tried_at TEXT;
CREATE INDEX clips_words_pending ON clips (words_pending, words_tried_at);
