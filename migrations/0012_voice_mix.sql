-- A voice over attached to a clip is mixed into it (the voice job's "mix" mode: her voice on top,
-- the clip's own sound turned down) and the clip's media link serves the mixed file, so Review
-- plays it and Buffer posts it. Detach or delete puts the original back. Additive.
ALTER TABLE narrations ADD COLUMN mixed_r2_key TEXT;
ALTER TABLE narrations ADD COLUMN mix_status TEXT CHECK (mix_status IN ('mixing', 'ready', 'failed'));
CREATE INDEX narrations_clip ON narrations (clip_id, mix_status);
