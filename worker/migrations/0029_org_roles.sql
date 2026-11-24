-- Organisation safety: an admin role, and a record of ownership changes.
--
-- ADDITIVE ON PURPOSE
--
-- `workspace_members.role` is CHECKed to ('viewer', 'editor'). Widening a CHECK
-- means rebuilding the table, and an older Worker reading a role it has never
-- heard of would treat it as nothing at all. So admin is a flag beside the role
-- rather than a new value of it: an admin is a row with role = 'editor' and
-- admin = 1. The Worker before this one ignores the column and sees an editor,
-- which is the right degraded behaviour (they can still write, they just cannot
-- administer until the Worker is current). Nothing is renamed, dropped or
-- rewritten, and the DEFAULT means its INSERTs, which name their columns, keep
-- working on a migrated database.
--
-- Owner stays where it was, in workspaces.owner_id. Transferring it is an
-- UPDATE of that column plus the membership rows around it, in one batch (see
-- worker/src/members.ts), so there is no moment with no owner or with two.
-- `workspaces.owner_id ... ON DELETE CASCADE` is left exactly as it is, and
-- nothing relies on it: account deletion removes workspaces by name in
-- worker/src/account.ts, and is refused while the account still owns one that
-- other people are in.
ALTER TABLE workspace_members ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;

-- One row per ownership transfer. Status and timestamps in the style of the
-- rest of this schema, and never deleted. There are deliberately no foreign
-- keys: this is history, and it has to outlive the workspace it describes (a
-- workspace can be deleted later) and must never be what makes a delete fail.
CREATE TABLE IF NOT EXISTS workspace_ownership_transfers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'completed',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_ws
  ON workspace_ownership_transfers (workspace_id, created_at);
