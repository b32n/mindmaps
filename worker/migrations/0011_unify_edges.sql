-- Edges stop belonging to a board.
--
-- Until now an edge carried `board_id`, which encoded an assumption: both ends
-- live on the same canvas. That made mindmaps islands, and islands cannot be a
-- brain — the connections worth having are the ones between topics you did not
-- realise were related. DESIGN.md §3 assumed a card could span two mindmaps
-- from the start; this is the schema finally allowing it.
--
-- An edge is now simply a relationship between two cards. It renders on any
-- board where either end is present: both ends visible means a normal link,
-- one end visible means a stub pointing off-canvas.
--
-- Ownership is derived, not stored. users -> boards -> nodes -> edges, so a
-- deleted account still takes its edges with it and there is no denormalised
-- user_id to drift.
--
-- SQLite cannot add a foreign key with ALTER TABLE, so this is the standard
-- table rebuild. That is a feature here rather than a chore: `edges` never had
-- foreign keys on source_id/target_id, which is exactly why 0005 existed to
-- sweep up orphans by hand and why the delete path in index.ts has to remove
-- edges explicitly. Declaring them properly retires both.
--
-- NOT IDEMPOTENT: it drops and recreates a table. Wrangler tracks applied
-- migrations, so it runs once — same as 0002, 0009 and 0010.

CREATE TABLE edges_rebuilt (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  -- which side of each card the link attaches to: top|right|bottom|left
  source_handle TEXT,
  target_handle TEXT
);

-- Orphans are filtered rather than allowed to fail the insert: after 0005 there
-- should be none, but a hand-restored database is exactly the case these
-- migrations are written to survive.
INSERT INTO edges_rebuilt (id, source_id, target_id, label, created_at, source_handle, target_handle)
SELECT e.id, e.source_id, e.target_id, e.label, e.created_at, e.source_handle, e.target_handle
  FROM edges e
 WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.source_id)
   AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.target_id);

DROP TABLE edges;
ALTER TABLE edges_rebuilt RENAME TO edges;

-- Both directions are queried: "what leaves this card" and "what arrives at
-- it". Traversal walks these in both directions, so index both.
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
