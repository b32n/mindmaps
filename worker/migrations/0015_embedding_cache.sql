-- 0015_embedding_cache — close the window where a card is written but not yet
-- findable by meaning.
--
-- Vectorize writes are asynchronous by design: an upsert goes through a
-- write-ahead log and becomes queryable later. Cloudflare improved this on
-- 2026-07-01 (median 2min -> under 30s, p99 5min -> under 2min), but there is
-- no synchronous mode and there is not going to be one. MCP.md §8b recorded the
-- symptom as "findable by wording immediately, by meaning about a minute
-- later", and accepted it.
--
-- It is worth not accepting, because of *when* it bites. The agent workflow
-- this brain exists for is: write down what you just learned, then keep
-- working, then ask what you know. Those happen minutes apart, inside one
-- session — precisely the window where Vectorize has the old answer or no
-- answer. The lag is least visible in benchmarks and most visible in the one
-- workflow the product is for.
--
-- The fix is not to wait for Vectorize but to stop depending on it for the
-- recent tail. The embedding is already computed on every save; this keeps a
-- copy next to the card. Cards embedded inside the lag window are then scored
-- by exact cosine in the Worker and merged with whatever Vectorize returns, so
-- a card is findable by meaning the moment its write commits.
--
-- 768 float32 = 3,072 bytes per card. Two secondary benefits worth the column:
--
--   1. Rebuilding the Vectorize index no longer means re-running inference over
--      every card — the vectors are already here.
--   2. Deletion needs no new bookkeeping: the embedding lives in the row, so
--      `ON DELETE CASCADE` takes it with the card.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`. Wrangler tracks
-- applied migrations, so it runs once — same as 0002, 0009, 0010 and 0013.

ALTER TABLE nodes ADD COLUMN embedding BLOB;
ALTER TABLE nodes ADD COLUMN embedded_at INTEGER;

-- The hot query is "cards embedded in the last few minutes", newest first.
-- Partial, because the overwhelming majority of rows are never in that window
-- and a NULL embedded_at has nothing to say about freshness.
CREATE INDEX IF NOT EXISTS idx_nodes_embedded_at
  ON nodes(embedded_at)
  WHERE embedded_at IS NOT NULL;
