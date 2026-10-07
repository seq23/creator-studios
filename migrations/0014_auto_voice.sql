-- Automatic voice overs (owner, 26 Sep 2026). Additive.
--
-- clips.speech: how much of the clip has her talking (0..1), measured by the cut job from the
-- transcript (or the speech runs when there are no words). NULL = not measured (older clips):
-- never voiced over automatically, like a clip with talking.
ALTER TABLE clips ADD COLUMN speech REAL;
-- narrations.auto: 1 = made automatically for a clip with no talking (Automatic voice overs on).
-- narrations.ai_generated: every voice over is her cloned voice, i.e. AI-generated audio; a post
-- carrying one is disclosed (Buffer's isAiGenerated on TikTok, Instagram and YouTube).
-- narrations.batch: the voice job run that makes it (one run voices all silent clips of a dump).
ALTER TABLE narrations ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE narrations ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 1;
ALTER TABLE narrations ADD COLUMN batch TEXT;
CREATE INDEX narrations_batch ON narrations (batch);
