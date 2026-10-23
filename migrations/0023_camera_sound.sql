-- Camera sound, built-in music, Try another version with notes (owner, 22 Oct 2026). Additive.
--
-- clips.muted: 1 = cut with the camera sound off (none of the video's own sound is in it; music
-- plays instead and it counts as having no talking, so automatic voice over applies). A new look
-- keeps it muted (jobs/cut.py rerender_clip).
-- clips.again_notes: what she asked to change on "Try another version" (it steers the new cut of this
-- clip's video, worker/jobs/cut.ts buildAgainSpec); kept for the next try.
-- clips.music now also holds a built-in track, "library/<id>" (jobs/music/library.json, CC0).
ALTER TABLE clips ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN again_notes TEXT;
