-- Follow-on V (owner, 23 Oct 2026): the voice-over script follows the clip's shots, and the dump
-- carries optional "notes for the voice" that reach the script writer.
-- clips.shot_list: JSON [{t0, t1, stage, what}] on the clip's own timeline (jobs/cut.py shot_list).
-- dumps.voice_notes: what she typed in "Notes for the voice" on the Dump screen (plain text, <= 400).
ALTER TABLE clips ADD COLUMN shot_list TEXT;
ALTER TABLE dumps ADD COLUMN voice_notes TEXT;
