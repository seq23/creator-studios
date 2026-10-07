-- Setup (studio brief §3): connections.service gains the services a studio pastes on Setup that
-- were Worker secrets before: 'youtube_api' (YouTube numbers key), 'google_app' (the Google sign-in
-- client id + secret), 'meta_app' (the Instagram sign-in app id + secret). 'resend' and 'github'
-- were already allowed. Rebuilt with every row kept, as 0008 and 0017 did (nothing references it).
CREATE TABLE connections_new (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github', 'elevenlabs', 'opusclip', 'vizard', 'klap', 'submagic', 'descript', 'youtube', 'youtube_api', 'google_app', 'meta_app')),
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'ok', 'error', 'disconnected')),
  secret_enc TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  last_ok_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO connections_new (service, status, secret_enc, meta, last_ok_at, last_error, updated_at)
  SELECT service, status, secret_enc, meta, last_ok_at, last_error, updated_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
