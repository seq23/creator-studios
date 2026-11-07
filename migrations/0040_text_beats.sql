-- On-screen text beats (owner, 7 Nov 2026: Porch & Party clips carry no voice over; the words are on
-- screen). A JSON list of 2 to 4 short lines the words pass writes (worker/lib/wordsPass.ts); a
-- re-render burns them after the hook and before the end card (jobs/looks.py build_ass). NULL = none.
ALTER TABLE clips ADD COLUMN text_beats TEXT;
