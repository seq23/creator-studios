-- On-screen text beats (owner, 7 Nov 2026: Porch & Party clips carry no voice over; the words are on
-- screen). A JSON list of 2 to 4 short lines the words pass writes (worker/lib/wordsPass.ts); a
-- re-render burns them after the hook and before the end card (jobs/looks.py build_ass). NULL = none.
ALTER TABLE clips ADD COLUMN text_beats TEXT;

-- A final photo (owner, 7 Nov 2026: "it must END on the finished product"): a still she adds in Review
-- (POST /api/clips/:id/final-photo), stored at clips/<dump>/<clip>-final-<n>.<ext>; a re-render holds
-- it last with a gentle push-in, under the end card (jobs/cut.py final_still). NULL = none.
ALTER TABLE clips ADD COLUMN final_photo_key TEXT;
