-- 0001_init — core board / node / edge / ink / session tables
--
-- Every statement is idempotent (IF NOT EXISTS), so this migration is safe to
-- re-apply against a database that already has it. Wrangler also tracks applied
-- migrations in d1_migrations, so normally it runs once; the guards are belt and
-- braces for a re-pointed or hand-restored database.

CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  parent_id   TEXT REFERENCES boards(id) ON DELETE CASCADE,
  -- a card's board: the node this board drills into
  node_id     TEXT,
  linear_ids  TEXT NOT NULL DEFAULT '[]',   -- json: linear project ids
  repos       TEXT NOT NULL DEFAULT '[]',   -- json: [{url, mount_path, branch}]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- type: note | card | image | shape | ticket | pr | session
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  w           REAL NOT NULL DEFAULT 260,
  h           REAL NOT NULL DEFAULT 140,
  data        TEXT NOT NULL DEFAULT '{}',   -- json: type-specific fields
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_board ON nodes(board_id);

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_board ON edges(board_id);

-- freehand ink: one row per stroke, in board coordinates
CREATE TABLE IF NOT EXISTS strokes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  points     TEXT NOT NULL,                 -- json: [[x,y,pressure], ...]
  color      TEXT NOT NULL DEFAULT '#1a1a1a',
  size       REAL NOT NULL DEFAULT 4,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strokes_board ON strokes(board_id);

-- one research thread per card, resumed forever
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  node_id              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  anthropic_session_id TEXT UNIQUE,
  status               TEXT NOT NULL DEFAULT 'pending',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id);

-- webhook + polled events; anthropic_event_id UNIQUE gives us dedupe for free
CREATE TABLE IF NOT EXISTS events (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  anthropic_event_id TEXT UNIQUE,
  type               TEXT NOT NULL,
  payload            TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
