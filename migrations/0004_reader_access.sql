-- Weekly Brief — reader access gate + activity tracking.
--
-- The WhatsApp-distributed link is shared by many readers on personal
-- devices. Instead of a per-person username/password (which older
-- readers won't tolerate re-entering), readers unlock the app once per
-- device with their NAME plus a single shared access code. That gives
-- named accountability (who opened it) without repeat-login friction.
-- Sessions are long-lived (default 60 days) and can be revoked or all
-- force-expired at once by rotating the code (app_settings.reader_code).

CREATE TABLE IF NOT EXISTS reader_sessions (
  id TEXT PRIMARY KEY,             -- random session id, stored in cookie
  name TEXT NOT NULL,              -- reader-entered name (accountability, not auth)
  code_version INTEGER NOT NULL DEFAULT 1,  -- ties session to a code generation; rotating the code bumps this and invalidates old sessions
  user_agent TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  visit_count INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reader_sessions_name ON reader_sessions(name);
CREATE INDEX IF NOT EXISTS idx_reader_sessions_last_seen ON reader_sessions(last_seen);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,        -- reader_sessions.id
  name TEXT NOT NULL DEFAULT '',   -- denormalised for fast admin queries
  edition TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,            -- 'view_tab' | 'view_sector' | 'export' | 'read_aloud' | 'ask'
  detail TEXT NOT NULL DEFAULT '', -- e.g. tab name, sector title, export format
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts);
CREATE INDEX IF NOT EXISTS idx_activity_edition ON activity_log(edition);

-- app_settings already exists (migration 0003) as a generic key/value
-- store. Seed the reader access code and its version counter into it.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('reader_code', '6170');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('reader_code_version', '1');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('reader_session_days', '60');

-- Admin dashboard password (separate from Microsoft SSO, which is not
-- yet configured). Default seeded below — CHANGE THIS from the
-- dashboard's "Change password" action after first login.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_password', 'AlBukhary2026!');
