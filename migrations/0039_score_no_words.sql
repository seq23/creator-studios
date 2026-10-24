-- Scores that differ (owner, 24 Oct 2026: most clips scored 90). When an already-cut dump's words are
-- written again (worker/lib/rewriteWords.ts), the clip's score without its words points is kept here,
-- uncapped, so the words pass gives it back plus the new hook's graded points (hookPoints) instead of
-- every clip restarting from the waiting cap of 80. NULL once the words are in, and for every clip
-- the cut scores itself.
ALTER TABLE clips ADD COLUMN score_no_words REAL;
