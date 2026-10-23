-- Studio intelligence, layers 2, 4 and 7 (owner's plan, 22 Oct 2026). Additive.
--
-- assets.shot_sheet: what the free vision model (or the local backup) saw in this video, as JSON
-- (jobs/see.py ShotSheet). Saved so "Change" re-plans without looking again (no new model calls).
-- dumps.looks_like: the dump's plain line as JSON {service, shape, camera, sure} (shared/looksLike.ts).
-- dumps.plan_override: what she picked on "Change" ({service, shape}); the next cut follows it.
-- clips.shape / clips.service: the story shape and the service this clip shows (null: not sure).
-- clips.on_screen: what the shot sheet says is on screen in it; a voice over may describe only that.
-- clips.part_assets: JSON list, the video each part comes from when a clip joins several (before -> after).
-- clips.hidden_reason: why the studio hid it, in plain words (layer 6, the critic).
ALTER TABLE assets ADD COLUMN shot_sheet TEXT;
ALTER TABLE dumps ADD COLUMN looks_like TEXT;
ALTER TABLE dumps ADD COLUMN plan_override TEXT;
ALTER TABLE clips ADD COLUMN shape TEXT;
ALTER TABLE clips ADD COLUMN service TEXT;
ALTER TABLE clips ADD COLUMN on_screen TEXT;
ALTER TABLE clips ADD COLUMN part_assets TEXT;
ALTER TABLE clips ADD COLUMN hidden_reason TEXT;
