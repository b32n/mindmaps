-- 0019_board_metadata — say what a mindmap is for, tag it, and pin it.
--
-- `description` is the one that earns its place immediately. `list_mindmaps`
-- returns a name and two counts, which is almost nothing to choose between when
-- an agent is deciding where a new card belongs. 0018 and the INSTRUCTIONS tell
-- it to put things somewhere sensible; this is what lets it actually tell. A
-- board called "Auth" and a board called "Platform" are indistinguishable until
-- one of them says it holds session and token work and the other says it holds
-- deploys.
--
-- `labels` is JSON rather than a join table. A label here is a word someone
-- typed, not an entity: nothing else references it, it has no properties, and
-- renaming one is a find-and-replace rather than a migration. A second table
-- would buy referential integrity over a value that has no referents.
--
-- `pinned` is a separate tier above `position`, not a replacement for it.
-- Dragging already orders the rail; pinning is the different statement that a
-- few boards belong at the top regardless of how the rest are arranged. Both
-- tiers keep their own manual order.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`. Wrangler tracks
-- applied migrations, so this runs once — same as 0002, 0009, 0010, 0013, 0015
-- and 0018.

ALTER TABLE boards ADD COLUMN description TEXT;

-- JSON array of strings. NULL and '[]' both mean "no labels"; readers treat
-- them the same so neither a migration default nor a backfill is needed.
ALTER TABLE boards ADD COLUMN labels TEXT;

ALTER TABLE boards ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- The rail reads pinned-first within a user, which is exactly this index.
CREATE INDEX IF NOT EXISTS idx_boards_pinned ON boards(user_id, pinned, position);
