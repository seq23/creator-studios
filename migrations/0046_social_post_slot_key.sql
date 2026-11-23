-- One post per planned slot, enforced by the database (Boss OS Growth Director "Noelle", 23 Nov 2026,
-- brief A4: "the no-double-post key lives in creator-studios"). The engine's caller names each post's
-- slot (`<platform>:<slot>`, e.g. `instagram:2026-12-04#1`); importEnginePack refuses a slot already
-- taken (409) and this unique index makes that true even when two runs race. Posts made before this
-- (and the studio's own photo planner) carry no key, so nothing existing is touched. Additive only.
ALTER TABLE social_posts ADD COLUMN idem_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_idem_key ON social_posts(idem_key) WHERE idem_key IS NOT NULL;
