-- Nothing hidden, nothing switched off (owner, 26 Sep 2026: "nothing should be hidden - she can
-- use it if she chooses, nothing switched off"). Every Settings → Features switch is ON: voice
-- ("Use my voice on clips"), deeper web research, the weekly recap email, help questions. She can
-- turn any of them off herself; none of them hides a screen (validator nothing-hidden).
-- One settings row per database; this sets it once, on both production and staging.
INSERT OR IGNORE INTO settings (key, value) VALUES ('features', '{"voice":true,"deeper_research":true,"weekly_recap":true,"help_ask":true}');
UPDATE settings SET value = '{"voice":true,"deeper_research":true,"weekly_recap":true,"help_ask":true}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'features';
