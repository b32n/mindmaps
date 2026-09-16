-- Manual ordering for the mindmap rail.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`, so re-running this
-- against a database that already has the column errors. Wrangler tracks
-- applied migrations in d1_migrations, so it runs once — same situation as
-- 0002_edge_handles.sql. Documented rather than worked around, because the
-- alternatives (a temp table, or catching the error) are worse.

ALTER TABLE boards ADD COLUMN position INTEGER;

-- Backfill from the ordering the rail used until now (most recently updated
-- first), so nobody's list visibly reshuffles the moment this ships. The
-- correlated count is a portable row_number(): how many of this user's boards
-- sort ahead of this one. The id tiebreak keeps it deterministic when two
-- boards share an updated_at.
UPDATE boards
   SET position = (
     SELECT COUNT(*)
       FROM boards b2
      WHERE b2.parent_id IS NULL
        AND (b2.user_id IS boards.user_id)
        AND (b2.updated_at > boards.updated_at
             OR (b2.updated_at = boards.updated_at AND b2.id < boards.id))
   )
 WHERE parent_id IS NULL AND position IS NULL;

-- Sub-boards (a card's own board) never appear in the rail, so they keep NULL.
CREATE INDEX IF NOT EXISTS idx_boards_position ON boards(user_id, position);
