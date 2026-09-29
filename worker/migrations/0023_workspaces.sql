-- Workspaces, and the three ways access is granted.
--
-- Until now "yours" and "readable" were one question, asked as `b.user_id = ?`
-- in twenty-nine places. This separates them, and puts the common case — a team
-- working together — inside a single boundary rather than a web of per-object
-- grants.
--
-- Why a workspace at all, when board sharing has to exist regardless: vectors
-- are partitioned by namespace in Vectorize, and a namespace is a hard wall. If
-- every collaboration were a person-to-person board share, a member's recall
-- would need one vector query per collaborator — linear in headcount. Inside a
-- workspace it is one query, whatever the size of the team. Board shares then
-- survive for what they are actually good at: handing one mindmap to someone
-- outside.
--
-- The personal workspace deliberately reuses the user's id. Existing vectors
-- are already namespaced by user id, so this migration leaves every one of them
-- valid and needs no re-index. It is the difference between a schema change and
-- a data migration over the whole corpus.

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 1 for the workspace created with the account. Personal workspaces cannot be
  -- left or deleted, which is what stops someone removing their own last home.
  personal   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces (owner_id);

-- Membership: the team case, and the reason recall stays one query.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The owner is not stored here. Ownership lives in workspaces.owner_id and is
  -- strictly greater than any role this table can express, so it cannot be
  -- revoked by editing a membership row.
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- The hot path: "which workspaces can this user see". user_id first, because
-- that is the bound column on every request.
CREATE INDEX IF NOT EXISTS idx_wsmembers_user ON workspace_members (user_id, workspace_id);

-- One mindmap, handed to someone outside its workspace.
CREATE TABLE IF NOT EXISTS board_shares (
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_boardshares_user ON board_shares (user_id, board_id);

-- One artefact, handed over without the mindmap around it.
--
-- Recallable by the grantee, which sounds expensive and is not: a grant names
-- specific nodes, and node_chunks holds their embeddings in D1, so those few
-- chunks are scored by exact cosine rather than by searching someone else's
-- Vectorize namespace.
CREATE TABLE IF NOT EXISTS artefact_grants (
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_user ON artefact_grants (user_id, node_id);

-- Invitations to people who have no account yet.
--
-- Separate from the three tables above because an invitation is not access: it
-- becomes a row in one of them when someone signs in and claims it. Keeping
-- them apart means no read path has to remember to exclude the unaccepted.
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('workspace', 'board', 'node')),
  target_id   TEXT NOT NULL,
  -- Lowercased on write, matched against the address someone signs in with.
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (email, accepted_at);
CREATE INDEX IF NOT EXISTS idx_invites_target ON invites (target_type, target_id);

-- Every board belongs to exactly one workspace.
--
-- Added nullable and backfilled rather than declared NOT NULL: boards carries
-- cascading foreign keys from nodes, edges and sub-boards, so the table rebuild
-- that a NOT NULL column forces would cascade-delete live content. Migration
-- 0014 hit the same wall and solved it the same way — a trigger, not a column
-- constraint.
ALTER TABLE boards ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

-- One personal workspace per user, sharing the user's id so existing vector
-- namespaces remain correct.
INSERT OR IGNORE INTO workspaces (id, name, owner_id, personal, created_at)
SELECT id, 'Personal', id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;

UPDATE boards SET workspace_id = user_id WHERE workspace_id IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards (workspace_id);

CREATE TRIGGER IF NOT EXISTS boards_require_workspace_insert
BEFORE INSERT ON boards
FOR EACH ROW WHEN NEW.workspace_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'boards.workspace_id is required');
END;

CREATE TRIGGER IF NOT EXISTS boards_require_workspace_update
BEFORE UPDATE OF workspace_id ON boards
FOR EACH ROW WHEN NEW.workspace_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'boards.workspace_id is required');
END;
