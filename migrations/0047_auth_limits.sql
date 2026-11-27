-- Per-connection limits on the login routes (27 Nov 2026, security audit C: the 6-digit code could
-- be guessed by many /verify calls at once). One row per (route, hashed client IP) and fixed
-- window; the count goes up in ONE statement (upsert ... RETURNING), so parallel calls cannot all
-- read "under the limit". The IP is kept only as a SHA-256, never in the clear. Additive only.
CREATE TABLE IF NOT EXISTS auth_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
