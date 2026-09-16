-- 0014_boards_require_owner — a board with no owner is no longer a valid row.
--
-- 0006 made `boards.user_id` nullable on purpose: boards existed before
-- accounts did, so they stayed NULL until the first registration adopted them
-- (`claimOrphanBoards`). That bridge has been crossed — it was a one-time
-- event against a pre-auth database — but the function it left behind ran on
-- *every* signup, not just the first:
--
--     UPDATE boards SET user_id = ? WHERE user_id IS NULL
--
-- So any row that ended up unowned by some unrelated route — a hand-written
-- INSERT, a reseed against production, a future code path that forgets the
-- column — was handed to whoever happened to register next. A cross-tenant
-- leak whose trigger is a mistake somewhere else entirely. `claimOrphanBoards`
-- is deleted; this closes the hole underneath it so nothing can recreate the
-- state it used to mop up.
--
-- Enforced with triggers rather than `NOT NULL`, which in SQLite would mean
-- rebuilding the table. `boards` is the parent of two cascading foreign keys
-- (nodes.board_id, and boards.parent_id to itself), so a drop-and-recreate
-- risks cascading away every node on the way through — a much worse failure
-- than the one being fixed. Triggers give the same guarantee at write time
-- with none of that exposure.
--
-- Existing orphans, if any, are left alone rather than deleted or reassigned:
-- with nothing left to claim them they are inert, and guessing an owner is the
-- behaviour this migration exists to remove. To see them:
--
--     wrangler d1 execute mindmaps --local \
--       --command "SELECT id, name FROM boards WHERE user_id IS NULL"

CREATE TRIGGER IF NOT EXISTS boards_owner_required_insert
BEFORE INSERT ON boards
WHEN NEW.user_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'boards.user_id is required: a board must have an owner');
END;

CREATE TRIGGER IF NOT EXISTS boards_owner_required_update
BEFORE UPDATE OF user_id ON boards
WHEN NEW.user_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'boards.user_id is required: a board must have an owner');
END;
