-- Steering a dump (owner, 26 Sep 2026: on-demand control, and a "surprise me" for when she
-- doesn't care). Additive. worker/domain/steer.ts holds the rules; shared/steer.ts the shapes.
--
-- dumps.steer: the chips she tapped on Dump (JSON SteerControls); NULL or {} = Surprise me.
-- dumps.steer_notes: what her dump note was read as (JSON Understood), as she saw it before Dump.
-- dumps.not_followed: every request that could not be done as asked, after the cut (JSON list of
-- {what, why}): never silently dropped. dumps.tried: "What we tried: …" (one line).
ALTER TABLE dumps ADD COLUMN steer TEXT;
ALTER TABLE dumps ADD COLUMN steer_notes TEXT;
ALTER TABLE dumps ADD COLUMN not_followed TEXT;
ALTER TABLE dumps ADD COLUMN tried TEXT;
-- assets.steer_notes: what a video's own note was read as (it steers that video's clips).
ALTER TABLE assets ADD COLUMN steer_notes TEXT;
-- clips.music: the song under the clip (R2 key of her upload), NULL = no music.
-- clips.pending_music: Change music in Review: 'none' or a song id, while it re-renders.
ALTER TABLE clips ADD COLUMN music TEXT;
ALTER TABLE clips ADD COLUMN pending_music TEXT;
