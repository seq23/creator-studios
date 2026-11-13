-- The Rejected bin (owner's ruling, 13 Nov 2026: "Rejected posts go to a bin first. From the bin she
-- can bring one back or delete it for good"). A photo post she skipped sits in the bin; "Delete for
-- good" stamps deleted_at: the row stays (so the set's posts are never planned a second time) but it
-- can never be brought back, planned or sent, and no screen lists it. Reels need nothing new: a
-- rejected reel is the bin, and clips.status = 'deleted' is already "for good". Additive only.
ALTER TABLE social_posts ADD COLUMN deleted_at TEXT;
