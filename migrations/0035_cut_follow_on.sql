-- A cut's follow-on work (the "Cutting clips" light, the "Clips ready" email, her connected editors,
-- automatic voice overs) runs AFTER the job callback has answered (worker/jobs/cut.ts cutFollowOn).
-- 1 = built-in cut, 2 = an editor's import: still to do. 0 = done. The hourly lane finishes any
-- left over (finishPendingCuts), so a slow AI call can never fail a cut whose clips were saved.
ALTER TABLE dumps ADD COLUMN follow_on_pending INTEGER NOT NULL DEFAULT 0;
