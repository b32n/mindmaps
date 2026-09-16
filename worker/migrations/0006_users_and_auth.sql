-- 0006_users_and_auth — accounts, sessions, and board ownership.
--
-- Idempotent throughout (IF NOT EXISTS), so re-applying is safe.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,   -- always stored lowercased
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  -- password auth: NULL for accounts created purely through Google
  password_hash TEXT,
  password_salt TEXT,
  -- google auth: the `sub` claim, stable per Google account
  google_sub    TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);

-- Server-side sessions. We store a SHA-256 of the cookie value, never the
-- value itself, so a database leak doesn't hand over live sessions.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp ON auth_sessions(expires_at);

-- Short-lived OAuth state, to defend the Google callback against CSRF.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  redirect_to TEXT NOT NULL DEFAULT '/app',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Boards belong to a user. Existing boards predate accounts, so they stay
-- NULL until claimed; the Worker treats NULL as "unclaimed" and assigns them
-- to the first user who signs in (see claimOrphanBoards).
--
-- SUPERSEDED by 0014_boards_require_owner: the claim was a one-time bridge
-- across this migration, but the code ran on every signup. Unowned is no
-- longer a legal state and claimOrphanBoards is gone.
ALTER TABLE boards ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);
