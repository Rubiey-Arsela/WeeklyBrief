-- Weekly Brief — highlights, users, and app settings.
-- highlights: text-range highlighter on report items (colour, edit, delete).
-- users: Microsoft-signed-in users, logged for visibility (no roles yet).
-- app_settings: singleton-style key/value store for feature flags the
-- director can flip without a redeploy (e.g. require_login, allowed_domain).

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  edition TEXT NOT NULL,
  item_key TEXT NOT NULL,        -- stable slug: sec:<section-slug>::item:<item-slug>
  start_offset INTEGER NOT NULL, -- flattened-text offset within the item body
  end_offset INTEGER NOT NULL,
  colour TEXT NOT NULL DEFAULT 'yellow',
  text_snippet TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'Anonymous',
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_highlights_edition ON highlights(edition);
CREATE INDEX IF NOT EXISTS idx_highlights_item ON highlights(edition, item_key);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- Microsoft object id (oid claim)
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  first_login TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT NOT NULL DEFAULT (datetime('now')),
  login_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
