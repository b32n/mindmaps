-- Organisation lifecycle: closing a shared workspace, leaving one, and invites
-- that have to be accepted.
--
-- ADDITIVE ON PURPOSE
--
-- Nothing is renamed, dropped or rewritten, and every new column is nullable or
-- defaulted, so the Worker before this one keeps running against a migrated
-- database: its INSERTs name their columns and leave these to the defaults.
-- What it does not do is honour them: an older Worker has never heard of a
-- closed workspace and would keep serving one. So apply this migration and
-- deploy the new Worker together (`npm run deploy` does, in that order); the
-- window between is the only exposure. Invites are different: their old columns
-- are kept in step on purpose, see below.
--
-- Not idempotent by itself, like the other ALTERs in this directory: D1's
-- migration table is what makes a migration run once. The table and indexes are
-- guarded.

-- A workspace is closed, never deleted. `status` is 'active' or 'closed';
-- `closed_at` starts the retention window (30 days, set in worker/src/access.ts)
-- inside which only the owner can reopen it. `closed_by` is who closed it.
-- `updated_at` is when the row last changed (a rename, a close, a reopen).
ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE workspaces ADD COLUMN closed_at INTEGER;
ALTER TABLE workspaces ADD COLUMN closed_by TEXT;
ALTER TABLE workspaces ADD COLUMN updated_at INTEGER;
UPDATE workspaces SET updated_at = created_at WHERE updated_at IS NULL;

-- Only closed workspaces are in it, so it stays tiny: it is how the owner's
-- list of closed workspaces is found.
CREATE INDEX IF NOT EXISTS idx_workspaces_closed ON workspaces (owner_id, closed_at) WHERE status <> 'active';

-- Invites gain a status: 'pending', 'accepted', 'declined' or 'revoked'.
--
-- The columns it replaces in spirit (`accepted_at`, `revoked`) are kept, and
-- the Worker keeps writing them: a decline or a revoke sets `revoked = 1` and an
-- accept sets `accepted_at`, so an older Worker reading only those still treats
-- the invite as finished and never claims it. Backfilled from them here.
ALTER TABLE invites ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE invites ADD COLUMN updated_at INTEGER;
UPDATE invites SET status = 'accepted' WHERE accepted_at IS NOT NULL;
UPDATE invites SET status = 'revoked' WHERE accepted_at IS NULL AND revoked = 1;
UPDATE invites SET updated_at = COALESCE(accepted_at, created_at) WHERE updated_at IS NULL;

-- "What is waiting for this address", asked on every page load of the app.
CREATE INDEX IF NOT EXISTS idx_invites_pending ON invites (email, status, created_at);

-- Why a person is no longer in a workspace: they left, or were removed.
--
-- Leaving deletes the `workspace_members` row, exactly as removal always has,
-- and this records it. The row is not kept with a status on purpose: that table
-- is read by every access check in the Worker, and by the Worker before this
-- one, and a "left" row that an older Worker read as a member would hand access
-- back to someone who had given it up. History goes beside it instead. There
-- are deliberately no foreign keys: this is a record, it has to outlive the
-- workspace and the user it describes, and must never be what makes a delete
-- fail. Never deleted.
CREATE TABLE IF NOT EXISTS workspace_member_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  -- 'left' (their own doing) or 'removed' (someone else's)
  status        TEXT NOT NULL,
  -- what they were: 'admin', 'editor' or 'viewer'
  role          TEXT NOT NULL,
  actor_user_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_events_ws ON workspace_member_events (workspace_id, user_id, created_at);
