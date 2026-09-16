-- 0017_chunks — embed passages, not card prefixes.
--
-- Until now a card was one vector over its first 1,800 characters. Three
-- consequences, all of which get worse as the brain gets more useful:
--
--   1. A long card is invisible below the cut. Whatever it says after 1,800
--      characters cannot be found by meaning at all.
--   2. `recall` excerpts from the top of the card regardless of what matched,
--      so even a correct hit shows the wrong passage.
--   3. Worst for running logs (`open_at: "bottom"`), where the indexed prefix
--      is the *oldest* content — the exact inverse of what those cards are for.
--
-- One vector per passage fixes all three: long cards are covered, the winning
-- chunk is the excerpt to show, and a log card is findable by its latest entry.
--
-- The chunk id doubles as the Vectorize id (`<node_id>#<ord>`), so mapping a
-- vector hit back to its card is a string split and needs no lookup table.
-- Usefully, an id with no `#` still splits to itself, so vectors written by the
-- previous whole-card scheme keep resolving to the right card while a reindex
-- is in flight.
--
-- `nodes.embedding` / `nodes.embedded_at` from 0015 are dropped: chunks carry
-- their own vector and their own freshness, and the exact-cosine pass that
-- closes the Vectorize write lag now runs over this table instead. Keeping
-- both would mean two places to keep in step for no gain — which is the thing
-- 0012 and MCP.md §5 are both careful to avoid.
--
-- NOT IDEMPOTENT: creates a table and drops columns. Wrangler runs it once.

CREATE TABLE IF NOT EXISTS node_chunks (
  -- `<node_id>#<ord>` — also the Vectorize vector id
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  -- the passage as it will be shown; the title is prepended only when
  -- embedding, so a chunk carries its topic into the vector without repeating
  -- the title in every excerpt
  text        TEXT NOT NULL,
  embedding   BLOB,
  embedded_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_chunks_ord ON node_chunks(node_id, ord);

-- Drives the exact-cosine pass over recently written chunks. Partial for the
-- same reason as 0015: most rows are never in the window.
CREATE INDEX IF NOT EXISTS idx_node_chunks_fresh
  ON node_chunks(embedded_at)
  WHERE embedded_at IS NOT NULL;

-- The index from 0015 has to go first: SQLite refuses to drop a column that a
-- surviving index still references, and reports it only when the DROP runs.
DROP INDEX IF EXISTS idx_nodes_embedded_at;

ALTER TABLE nodes DROP COLUMN embedding;
ALTER TABLE nodes DROP COLUMN embedded_at;
