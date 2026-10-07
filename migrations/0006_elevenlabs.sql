-- ElevenLabs premium voice (Phase 11 addition, 25 Sep 2026). Additive.
--
-- voice.elevenlabs_voice_id: the Instant Voice Clone made in her ElevenLabs account from the
-- consented sample. NULL when ElevenLabs is not connected, her plan has no cloning, or the voice
-- was deleted. "Delete my voice" and Disconnect also delete it from ElevenLabs.
ALTER TABLE voice ADD COLUMN elevenlabs_voice_id TEXT;

-- narrations.engine: which voice made it. 'built-in' = the free Chatterbox job on the GitHub
-- runner; 'elevenlabs' = the premium voice, made by the Worker. Every row carries one
-- (validator voice-engines). duration_s: seconds, read from the file; NULL when it cannot be
-- read (never estimated).
ALTER TABLE narrations ADD COLUMN engine TEXT NOT NULL DEFAULT 'built-in' CHECK (engine IN ('built-in', 'elevenlabs'));
ALTER TABLE narrations ADD COLUMN duration_s REAL;

-- Which voice to use: premium when ElevenLabs is connected and ready, or always the built-in one.
INSERT OR IGNORE INTO settings (key, value) VALUES ('voice_engine_preference', '"premium_when_available"');

-- connections.service gains 'elevenlabs'. SQLite cannot alter a CHECK, so the table is rebuilt
-- with every row kept (nothing references connections).
CREATE TABLE connections_new (
  service TEXT PRIMARY KEY CHECK (service IN ('buffer', 'openrouter', 'firecrawl', 'resend', 'hunter', 'meta', 'google', 'tiktok', 'github', 'elevenlabs')),
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
