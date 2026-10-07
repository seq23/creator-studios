-- Media kit + brand deals overhaul (25 Sep 2026, docs/reviews/2026-09-25-mediakit-deals.md,
-- docs/reviews/agency-pov.md). Additive, except the deals table, which is rebuilt because its
-- stage CHECK changes (SQLite cannot alter a CHECK); every row is kept and mapped.

-- ---------- media kit: draft, published versions, old links, views ----------
-- media_kit.draft: the whole editable kit (KitContent in worker/domain/kit.ts) as JSON. Saving
-- (autosave) writes only the draft; Publish copies it into media_kit_versions. The public link
-- always serves the newest published version; a draft is never public.
ALTER TABLE media_kit ADD COLUMN draft TEXT;
ALTER TABLE media_kit ADD COLUMN draft_saved_at TEXT;

CREATE TABLE media_kit_versions (
  version INTEGER PRIMARY KEY,
  content TEXT NOT NULL,          -- KitContent JSON at publish time (private rate fields included; the public view strips them)
  slug TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every link name the kit has ever had: an old link keeps working (it forwards to the current one).
CREATE TABLE kit_slugs (
  slug TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO kit_slugs (slug) SELECT public_slug FROM media_kit WHERE id = 1;

-- One row per public view of the kit (no IP, no user agent stored).
CREATE TABLE kit_views (
  id TEXT PRIMARY KEY,
  version INTEGER,
  viewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX kit_views_at ON kit_views (viewed_at);

-- A kit that was already live (bio or clips saved before this change) becomes version 1 so the
-- public link does not go dark on deploy. The route fills the rest of the content from it.
INSERT INTO media_kit_versions (version, content, slug, published_at)
  SELECT 1, json_object('legacy', 1, 'bio', bio, 'featured_clip_ids', json(featured_clip_ids), 'past_partners', json(past_partners), 'rates', json(COALESCE(rates, 'null')), 'contact_email', contact_email), public_slug, COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM media_kit WHERE id = 1 AND (bio != '' OR featured_clip_ids != '[]' OR past_partners != '[]');

-- ---------- brands: what kind of buyer, the money signal, the sourced "why" ----------
ALTER TABLE brands ADD COLUMN kind TEXT NOT NULL DEFAULT 'brand' CHECK (kind IN ('brand', 'agency', 'local'));
-- JSON {level: "paying" | "likely" | "unproven", evidence: [{text, url}]}: why we think they pay creators.
ALTER TABLE brands ADD COLUMN budget_signal TEXT NOT NULL DEFAULT '{"level":"unproven","evidence":[]}';
-- JSON [{text, url}]: "why this brand" lines, each with the page it came from.
ALTER TABLE brands ADD COLUMN why_sourced TEXT NOT NULL DEFAULT '[]';
ALTER TABLE brands ADD COLUMN last_seen_at TEXT;

-- ---------- pitches: the third, closing follow-up (stop after 3) ----------
ALTER TABLE pitches ADD COLUMN followup_3 TEXT NOT NULL DEFAULT '';

-- ---------- deals: the pipeline a talent manager runs ----------
-- Stages (shared/constants.ts DEAL_STAGES): find_contact → pitch → follow_up → negotiating →
-- agreed → delivering → invoiced → paid → done, plus declined (she said no) and lost (they
-- said no or went quiet), each with a reason.
CREATE TABLE deals_new (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'pitch' CHECK (stage IN ('find_contact', 'pitch', 'follow_up', 'negotiating', 'agreed', 'delivering', 'invoiced', 'paid', 'done', 'declined', 'lost')),
  terms_note TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '[]',   -- JSON [{id, clip_id, platform, due_at, note, done}]
  paid_partnership INTEGER NOT NULL DEFAULT 1,
  -- terms: JSON DealTerms (worker/domain/memo.ts): fee, package, usage, exclusivity, payment terms, upfront, kill fee, dates
  terms TEXT NOT NULL DEFAULT '{}',
  -- delivery: JSON checklist state (worker/domain/delivery.ts)
  delivery TEXT NOT NULL DEFAULT '{}',
  outcome_reason TEXT,
  invoice_number TEXT,
  pitched_at TEXT,
  replied_at TEXT,
  agreed_at TEXT,
  delivered_at TEXT,
  invoiced_at TEXT,
  invoice_due_at TEXT,
  paid_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO deals_new (id, brand_id, stage, terms_note, deliverables, paid_partnership, outcome_reason, pitched_at, replied_at, agreed_at, closed_at, updated_at, created_at)
  SELECT d.id, d.brand_id,
    CASE d.stage
      WHEN 'found' THEN CASE WHEN EXISTS (SELECT 1 FROM brand_contacts c WHERE c.brand_id = d.brand_id) THEN 'pitch' ELSE 'find_contact' END
      WHEN 'drafted' THEN CASE WHEN EXISTS (SELECT 1 FROM brand_contacts c WHERE c.brand_id = d.brand_id) THEN 'pitch' ELSE 'find_contact' END
      WHEN 'sent' THEN 'follow_up'
      WHEN 'replied' THEN 'negotiating'
      WHEN 'negotiating' THEN 'negotiating'
      WHEN 'won' THEN CASE WHEN d.deliverables != '[]' THEN 'delivering' ELSE 'agreed' END
      WHEN 'passed' THEN 'declined'
    END,
    d.terms_note, d.deliverables, d.paid_partnership,
    CASE d.stage WHEN 'passed' THEN 'Passed before the deals overhaul' ELSE NULL END,
    (SELECT MIN(p.sent_at) FROM pitches p WHERE p.brand_id = d.brand_id AND p.sent_at IS NOT NULL),
    CASE WHEN d.stage IN ('replied', 'negotiating', 'won') THEN d.updated_at ELSE NULL END,
    CASE d.stage WHEN 'won' THEN d.updated_at ELSE NULL END,
    CASE d.stage WHEN 'passed' THEN d.updated_at ELSE NULL END,
    d.updated_at, d.created_at
  FROM deals d;
DROP TABLE deals;
ALTER TABLE deals_new RENAME TO deals;
CREATE INDEX deals_brand ON deals (brand_id);
CREATE INDEX deals_stage ON deals (stage);

-- Every email drafted for a deal, kept on its timeline (a redraft is a new row, nothing is overwritten).
CREATE TABLE deal_emails (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  scenario TEXT NOT NULL,           -- a key of SCENARIOS in worker/domain/emails.ts
  subject TEXT NOT NULL,
  subject_options TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'warm' CHECK (tone IN ('warm', 'straight', 'short')),
  length TEXT NOT NULL DEFAULT 'standard' CHECK (length IN ('brief', 'standard', 'detailed')),
  source TEXT NOT NULL DEFAULT 'starter' CHECK (source IN ('ai', 'starter')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX deal_emails_deal ON deal_emails (deal_id, created_at);

-- What a brand sent her, pasted in: the terms read from it (each labelled "from their email"),
-- the red flags, and the qualifier's verdict.
CREATE TABLE deal_offers (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  pasted TEXT NOT NULL,
  terms TEXT NOT NULL DEFAULT '{}',
  flags TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'rules' CHECK (source IN ('ai', 'rules')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX deal_offers_deal ON deal_offers (deal_id, created_at);

-- The creator marketplaces she has joined (keys of MARKETPLACES in worker/domain/marketplaces.ts).
INSERT OR IGNORE INTO settings (key, value) VALUES ('marketplaces_joined', '[]');
