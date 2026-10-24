-- Clip quality (owner, 23 Oct 2026): the niche research is the default style for every studio and is
-- redone whenever the Brand Profile changes. Each playbook records the locked profile version it was
-- researched for (worker/lib/niche.ts nicheDue); NULL = before this, so the next daily lane refreshes it.
ALTER TABLE niche_playbooks ADD COLUMN profile_version INTEGER;
