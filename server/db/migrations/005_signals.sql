-- VYBZ migration 005: curated anonymous signal templates
-- Only server-approved templates (or moderated custom text) can be sent,
-- which keeps anonymous contact safe and reportable.

CREATE TABLE IF NOT EXISTS signal_templates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL DEFAULT 'compliment', -- compliment | interest
  body              TEXT    NOT NULL,
  moderation_status TEXT    NOT NULL DEFAULT 'approved',
  enabled           INTEGER NOT NULL DEFAULT 1,
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_templates_kind ON signal_templates(kind, enabled);
