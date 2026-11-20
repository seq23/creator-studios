-- The content engine (spry + porch-and-party brains, CONTENT ENGINE, 19 Nov 2026): finished reels and
-- photo sets made on the host's Mac (engine/), reviewed on their real frames, then queued as photo
-- packs through the signed ops door (worker/routes/ops.ts engine-pack). A pack records who made it
-- (the studio's photo maker, or the engine), which format it is (for the weekly learning by format)
-- and the review verdict it passed (an engine pack without a PASS never posts). Additive only.
ALTER TABLE photo_packs ADD COLUMN made_by TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE photo_packs ADD COLUMN format TEXT;
ALTER TABLE photo_packs ADD COLUMN review TEXT;
