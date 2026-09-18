-- Weekly Brief — initial schema
-- Mirrors the original Flask/JSON-file storage shape as closely as possible:
-- corpus-level data (entities/indicators/trends/section order) rarely
-- changes and is stored as JSON blobs in a singleton row; each edition
-- keeps its flat item list (also JSON) exactly as it was authored, and
-- view_model() (ported to TypeScript) derives sections/pulse/trends/delta
-- from it at read time, same as app.py did.

CREATE TABLE IF NOT EXISTS corpus (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_note TEXT NOT NULL DEFAULT '',
  entities TEXT NOT NULL DEFAULT '[]',   -- JSON array
  indicators TEXT NOT NULL DEFAULT '[]', -- JSON array
  trends TEXT NOT NULL DEFAULT '[]',     -- JSON array
  sections TEXT NOT NULL DEFAULT '[]'    -- JSON array of published section names (order)
);

CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,           -- e.g. 'W36'
  label TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,            -- ISO date, used for sort order
  status TEXT NOT NULL DEFAULT 'draft',
  exec_summary TEXT NOT NULL DEFAULT '',
  speed_read TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  structural TEXT NOT NULL DEFAULT '',
  pulse TEXT NOT NULL DEFAULT '[]',       -- JSON array (published Pulse rows)
  items TEXT NOT NULL DEFAULT '[]',       -- JSON array (flat news items)
  watchlist TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  beyond TEXT NOT NULL DEFAULT '',
  pdf TEXT,                               -- JSON object {name,url,size,r2_key} or NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_editions_date ON editions(date);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  edition TEXT NOT NULL,
  anchor TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.5,
  text TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'Anonymous',
  colour TEXT NOT NULL DEFAULT 'yellow',
  resolved INTEGER NOT NULL DEFAULT 0,
  replies TEXT NOT NULL DEFAULT '[]',    -- JSON array of {author,text,ts}
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_edition ON notes(edition);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  edition TEXT,
  item TEXT,
  type TEXT NOT NULL DEFAULT 'comment',
  section TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  text TEXT NOT NULL DEFAULT ''
);
