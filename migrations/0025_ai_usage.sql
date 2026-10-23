-- Cloudflare Workers AI as a second $0 source for the studio-intelligence jobs (owner, 23 Oct 2026:
-- "use the cloudflare free allowance too"). The account's free allowance is 10,000 neurons a day for
-- every Worker together; past it the account is billed. Each studio spends at most its own share
-- (registry aiBudget → var STUDIO_AI_BUDGET; the shares sum to 8,500, validator cloudflare-ai-budget)
-- and counts every call here, per UTC day (Cloudflare's own reset).
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  neurons REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0
);
