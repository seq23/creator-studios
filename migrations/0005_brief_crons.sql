-- Section 6 brief crons (monthly refresh, weekly adjustment). Additive.
--
-- research_briefs.adjusted_at: when the weekly adjustment last rewrote the live brief's
-- her-data claims. It never changes status or approved_at.
ALTER TABLE research_briefs ADD COLUMN adjusted_at TEXT;

-- emails_sent.kind gains 'brief_ready' ("New brief draft ready"). SQLite cannot alter a CHECK,
-- so the table is rebuilt with every row kept (nothing references emails_sent).
CREATE TABLE emails_sent_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time_to_dump', 'clips_ready', 'posting_problem', 'connection_needs_you', 'weekly_recap', 'login_code', 'brief_ready')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  ref_id TEXT,
  provider_id TEXT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO emails_sent_new (id, kind, to_email, subject, ref_id, provider_id, sent_at)
  SELECT id, kind, to_email, subject, ref_id, provider_id, sent_at FROM emails_sent;
DROP TABLE emails_sent;
ALTER TABLE emails_sent_new RENAME TO emails_sent;
CREATE INDEX emails_kind ON emails_sent (kind, sent_at);
