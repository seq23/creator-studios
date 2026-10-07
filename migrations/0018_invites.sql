-- First-login invites (studio brief §4): a sample studio has no owner email until its first-login
-- link is used. `npm run studio:invite <slug>` (scripts/studio.mjs) stores only the SHA-256 of the
-- link's token here; POST /api/auth/invite trades the token for the owner email once, then sends a
-- login code. The claimed address lives in settings.owner_email.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
