-- Email verification, password reset and sign-in rate limits.
--
-- ADDITIVE ON PURPOSE
--
-- Two nullable columns on `users`, two new tables, nothing renamed, dropped or
-- rewritten except the one backfill below. The Worker before this one never
-- reads any of it, and its INSERTs name their columns, so it keeps running on a
-- migrated database: accounts it creates simply have no verification mark.
--
-- `email_verified_at` NULL means the address has not been proven. Who proved it
-- is in `email_verified_via`: 'email' (followed the link), 'google' (Google said
-- the address is verified), 'reset' (completed a password reset, which is the
-- same proof), or 'grandfathered'.
--
-- GRANDFATHERING. Every account that exists when this runs is marked verified
-- ('grandfathered', at its creation time). Those people signed in and were
-- claiming invites long before there was any way to verify, and un-verifying them
-- would lock people out of workspaces they already belong to. The cost is that
-- an address squatted before this release stays trusted; an owner who is worried
-- about that can ask the person to reset their password.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN email_verified_via TEXT;

UPDATE users
   SET email_verified_at = created_at, email_verified_via = 'grandfathered'
 WHERE email_verified_at IS NULL;

-- One row per emailed link. Only the SHA-256 of the token is stored, so a
-- database leak yields no usable links. Rows are never deleted: status moves
-- 'active' -> 'used' | 'superseded' | 'revoked', which is also the audit trail.
CREATE TABLE IF NOT EXISTS email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- 'verify' | 'reset'
  email       TEXT NOT NULL,                 -- the address it was sent to
  token_hash  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active',
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind, status);

-- Fixed-window counters for sign-up, sign-in, reset and resend. One row per key
-- and reused in place (the window restarts on the same row), so the table is
-- not appended to on every request and nothing is deleted. Keys are hashed.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
