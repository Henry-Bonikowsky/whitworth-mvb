-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS officers (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  name  TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  role  TEXT NOT NULL CHECK (role IN ('admin', 'editor'))
);
CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,            -- yyyy-mm-dd
  time        TEXT,                     -- HH:MM or NULL
  opponent    TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  home_away   TEXT NOT NULL CHECK (home_away IN ('home', 'away', 'neutral')),
  our_score   INTEGER CHECK (our_score >= 0),   -- both NULL = upcoming, both set = result
  their_score INTEGER CHECK (their_score >= 0),
  notes       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS roster (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  number   TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  year     TEXT NOT NULL DEFAULT '',
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announcements (
  id    INTEGER PRIMARY KEY,
  date  TEXT NOT NULL,
  title TEXT NOT NULL,
  body  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS photos (
  id      INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id),
  key     TEXT NOT NULL UNIQUE,         -- R2 object key
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS photos_game ON photos (game_id, sort);

INSERT OR IGNORE INTO officers (email, name, title, role) VALUES ('henrybonikowsky@gmail.com', 'Henry Bonikowsky', '', 'admin');
