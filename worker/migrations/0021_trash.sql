-- The trash: deleted things, kept for a week, restorable.
--
-- An archive table rather than a `deleted_at` column on `nodes`. Forty-one
-- queries read `nodes` — board loads, FTS, graph walks, recall, counts — and
-- soft-deleting in place would mean every one of them growing a filter that is
-- invisible when forgotten. The failure mode is a deleted card surfacing in
-- `recall`, which is the one thing this product cannot do. Moving the row out
-- means `nodes` holds only live rows and no existing query changes at all.
--
-- The cost is that a restore has to put the row back rather than flip a flag.
-- That is a cost worth paying: it is one code path, tested once, instead of a
-- rule every future query has to remember.
CREATE TABLE IF NOT EXISTS trash (
  -- The node id, or the mindmap id. Not a fresh id: the thing keeps its
  -- identity while it sits here, so an edge pointing at it restores intact.
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('node', 'board')),
  -- Denormalised rather than joined. The board a node came from may itself be
  -- deleted by the time anyone opens the trash, so the listing cannot depend on
  -- any live row still existing.
  user_id    TEXT NOT NULL,
  label      TEXT,
  node_type  TEXT,
  context    TEXT,
  -- A short human count for the list: "12 cards, 2 sheets".
  summary    TEXT,
  deleted_at INTEGER NOT NULL,
  -- Everything needed to put it back. For a node: the row and the edges that
  -- died with it. For a mindmap: the whole subtree — boards, nodes, edges — in
  -- one row, so the list shows one entry and restore is one operation.
  payload    TEXT NOT NULL
);

-- The only read that matters: this user's trash, newest first.
CREATE INDEX IF NOT EXISTS idx_trash_user ON trash (user_id, deleted_at DESC);

-- The reaper's read.
CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash (deleted_at);
