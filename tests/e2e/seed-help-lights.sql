-- The help screenshots' connections and health board (tests/e2e/demo.ts applies it after the
-- real Connect routes have connected Buffer, OpenRouter and ElevenLabs, and again after a guide
-- that changed a connection). Idempotent: it clears before it writes. Everything before the
-- first INSERT is the clean-up block.
DELETE FROM connections WHERE service IN ('hunter', 'firecrawl', 'opusclip', 'vizard', 'klap', 'submagic', 'descript', 'meta', 'google', 'tiktok');
DELETE FROM health WHERE name IN ('hunter', 'firecrawl', 'opusclip', 'vizard', 'klap', 'submagic', 'descript', 'meta', 'google', 'tiktok', 'Brand finder', 'Daily brand refresh');
DELETE FROM health WHERE name IN ('Buffer', 'TikTok (via Buffer)', 'Instagram (via Buffer)', 'YouTube (via Buffer)', 'Clip cutting', 'Email (Resend)', 'Job runner (GitHub)', 'Storage', 'Runway', 'TikTok stats', 'YouTube stats', 'Instagram stats', 'Brand finder', 'Daily brand refresh', 'Voice');

-- Her saved voice (consent given): a guide that deletes it to picture the set-up steps gets it back here.
UPDATE voice SET sample_r2_key = 'voice/demo/sample.webm', consent_at = '2026-09-23T14:00:00.000Z', consent_text = 'This is my own voice and I consent to it being cloned for my narration', model_r2_key = 'voice/demo/model.pt', enabled = 1, updated_at = '2026-09-23T14:05:00.000Z' WHERE id = 1;

-- The health board: mostly green, one red (Instagram disconnected inside Buffer, which is why
-- the demo Instagram post failed) and one yellow (storage filling up).
INSERT OR REPLACE INTO health (name, light, note, fix_guide, checked_at) VALUES
  ('Buffer', 'green', 'Connected: 3 channels', NULL, '2026-09-26T04:00:00.000Z'),
  ('TikTok (via Buffer)', 'green', 'Posting OK', NULL, '2026-09-26T04:00:00.000Z'),
  ('Instagram (via Buffer)', 'red', 'Instagram is disconnected inside Buffer, so its posts wait', 'reconnect-an-account', '2026-09-26T04:00:00.000Z'),
  ('YouTube (via Buffer)', 'green', 'Posting OK', NULL, '2026-09-26T04:00:00.000Z'),
  ('Clip cutting', 'green', 'Last dump cut in 12 minutes', NULL, '2026-09-26T04:00:00.000Z'),
  ('Email (Resend)', 'green', 'Ready to send', NULL, '2026-09-26T04:00:00.000Z'),
  ('Job runner (GitHub)', 'green', 'Ready', NULL, '2026-09-26T04:00:00.000Z'),
  ('Storage', 'yellow', '8.1 GB of 10 GB used. Cut footage clears itself after 7 days', 'storage-almost-full', '2026-09-26T04:00:00.000Z'),
  ('TikTok stats', 'green', '5 videos from your TikTok export', NULL, '2026-09-24T12:00:00.000Z'),
  ('YouTube stats', 'green', 'Public numbers, no sign-in', NULL, '2026-09-26T04:00:00.000Z'),
  ('Instagram stats', 'green', 'Your typed numbers from Sep 24', NULL, '2026-09-24T12:00:00.000Z'),
  ('Brand finder', 'green', '12 brands checked, 3 new', NULL, '2026-09-26T04:00:00.000Z'),
  ('Voice', 'green', 'Your built-in voice is ready', NULL, '2026-09-23T14:10:00.000Z');
