-- 0016_recall_log — what the brain was asked, and whether it had an answer.
--
-- Retrieval quality is currently unfalsifiable: there is no way to tell whether
-- a change to ranking helped, because there is no record of what anyone asked.
-- An eval set fixes that, but it needs realistic queries, and invented ones are
-- the weakest material — they unconsciously match how the author already knows
-- the cards are worded.
--
-- Real queries are better and free, but only collectable going forward. Hence
-- this table now, ahead of the eval work it is for: what was asked cannot be
-- recovered later.
--
-- It earns its keep before any eval exists, too. `hits = 0` is a list of things
-- the brain should know and does not, which is the one retrieval failure that
-- never gets reported — nobody files a bug against a search that silently
-- returned the wrong thing.
--
-- Only the question is stored, never the results: the answer is reconstructible
-- from the cards, and a log that duplicates card prose is a second copy to keep
-- in step (MCP.md §5). Rows are per-user and cascade with the account.

CREATE TABLE IF NOT EXISTS recall_queries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query      TEXT NOT NULL,
  -- the mindmap the caller scoped to, when they scoped at all
  mindmap_id TEXT,
  -- candidates found before truncation, and how many were actually returned.
  -- Both, because "found 40, showed 8" and "found 8, showed 8" are different
  -- failures when the right card is not among them.
  found      INTEGER NOT NULL,
  shown      INTEGER NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recall_queries_user ON recall_queries(user_id, at);

-- The interesting rows are the empty-handed ones, and they are a small minority
-- of a table that will otherwise grow with every call.
CREATE INDEX IF NOT EXISTS idx_recall_queries_empty ON recall_queries(at) WHERE found = 0;
