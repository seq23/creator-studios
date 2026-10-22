-- photo_packs.ai_edited: the owner ticked "Some of these photos were edited with AI" (owner's word
-- 22 Oct 2026: AI-enhanced photos carry the "Made with AI" label like any AI asset). Every piece
-- made from such a set is labelled, the photo set included.
ALTER TABLE photo_packs ADD COLUMN ai_edited INTEGER NOT NULL DEFAULT 0;
