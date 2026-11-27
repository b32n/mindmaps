-- The organisation of an org-mode instance: which shared workspace it is.
--
-- ADDITIVE ON PURPOSE
--
-- One new table and one index. Nothing existing is altered, so the Worker before
-- this one runs against a migrated database unchanged: it does not know the
-- table exists and never reads it. An install that is not in org mode never
-- writes to it either.
--
-- The organisation is not a new kind of thing. It is an ordinary shared
-- workspace (so roles, invitations, close-protection and moving mindmaps all
-- work on it as they do on any), marked here as "the" organisation. A row
-- points at a workspace; it does not own or duplicate one.
--
-- "Exactly one" is enforced by the database, not by a check in the Worker: the
-- partial unique index below allows one row with status 'active'. Two requests
-- creating it at once cannot both succeed, whichever Worker instance serves
-- them. A row is never deleted. If the workspace behind it is gone (its owner
-- deleted their account), the Worker marks the row 'retired', which frees the
-- slot, and keeps it as history. There is deliberately no foreign key: this is
-- a record, and it must never be what makes deleting a workspace fail.
--
-- `adopted` is 1 when an existing workspace was made the organisation rather
-- than a new one created, which is how an install switched to org mode with
-- data already in it gets one (see docs/MODES.md).
CREATE TABLE IF NOT EXISTS instance_organisation (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_by   TEXT NOT NULL,
  adopted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instance_organisation_active
  ON instance_organisation (status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_instance_organisation_ws ON instance_organisation (workspace_id);
