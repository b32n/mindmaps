-- 0018_index_dirty — cards edited in the browser get re-embedded too.
--
-- Until now `indexCard` was only ever reached from the MCP write path. A card
-- edited in the web app updated its prose and its FTS row, and left its vectors
-- describing the previous version — so it stayed findable by *wording* and
-- answered by *meaning* from text it no longer contained. Silent, and worse
-- after 0017, because a shortened card also kept passages it had lost.
--
-- The obvious fix — reindex inside the PATCH — is wrong here. The editor
-- commits on a 400ms debounce (`useDraftField`), so typing a paragraph is a
-- stream of PATCHes, and embedding each one would mean dozens of inference
-- calls to index a single edit, most of them describing half-finished
-- sentences.
--
-- So a write marks the card and a scheduled sweep does the work. Marking is a
-- column write on a row already being updated; the sweep coalesces a burst of
-- edits into one embedding of the final text. The cost is that a browser edit
-- becomes findable by meaning within a minute rather than instantly — the same
-- order as the Vectorize write lag that is already unavoidable, and the fresh
-- window (0017) covers the card the moment the sweep runs.
--
-- MCP writes keep indexing inline: an agent that records something and recalls
-- it moments later is the workflow this brain exists for, and it does not
-- write a character at a time.
--
-- NULL means clean. A timestamp means "changed at this moment, not yet
-- embedded" — a timestamp rather than a flag so the sweep can take the oldest
-- first and a stuck row is visible rather than merely true.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`. Wrangler runs it
-- once — same as 0002, 0009, 0010, 0013 and 0015.

ALTER TABLE nodes ADD COLUMN index_dirty INTEGER;

-- The sweep asks only for dirty rows, which are a vanishing fraction of the
-- table, so the index is partial for the same reason as 0015 and 0017.
CREATE INDEX IF NOT EXISTS idx_nodes_index_dirty
  ON nodes(index_dirty)
  WHERE index_dirty IS NOT NULL;

-- Everything already in the database was indexed by the reindex endpoint, or
-- never needed indexing. Nothing is marked here: a blanket backfill would
-- queue every card in every account for re-embedding on the next tick, which
-- is a large inference bill for no change in content.
