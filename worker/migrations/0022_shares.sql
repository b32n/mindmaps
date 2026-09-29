-- Share links.
--
-- A row per share rather than a signed URL, because the whole point of a share
-- is that you can take it back. The mindbox's owner-preview URLs are
-- HMAC(nodeId.exp) and cannot be revoked without rotating MINDBOX_SECRET, which
-- would break every link at once — fine for a one-hour preview of your own
-- artefact, useless for something you sent to someone.
--
-- Deliberately wider than what is implemented today:
--
--   target_type  'node' now, 'board' when mindmaps become shareable. Sharing a
--                mindmap needs an answer for edges that cross onto private
--                boards, which is a design question, not a schema one.
--   grant_type   'link' now, 'user' when there is a permissions model. Named
--                sharing turns "owner" into "owner or grantee" across the ~41
--                queries that filter on user_id, so it is a refactor rather
--                than a feature — but it should not need a new table.
--
-- Getting those two columns in now costs nothing and saves a migration that
-- would have to rewrite live share URLs.
CREATE TABLE IF NOT EXISTS shares (
  -- The unguessable part of the URL. Primary key because it is what a request
  -- arrives holding.
  token       TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('node', 'board')),
  target_id   TEXT NOT NULL,
  -- Who shared it. Not a foreign key to nodes: a share outlives its target
  -- going to the trash, and resolving a share checks the target is really there
  -- anyway.
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_type  TEXT NOT NULL CHECK (grant_type IN ('link', 'user')),
  -- Null for link shares. The grantee once named sharing exists.
  grantee_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  -- Null means no expiry. Checked on every resolve, so a lapsed share stops
  -- working whether or not anything has swept it.
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- Cheap answer to "has anyone opened this?", which is the first thing anyone
  -- asks after sending a link.
  last_seen_at INTEGER,
  views       INTEGER NOT NULL DEFAULT 0
);

-- The owner's view: every share on one artefact.
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares (target_type, target_id);

-- The owner's other view: everything they have shared.
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares (owner_id, created_at DESC);
