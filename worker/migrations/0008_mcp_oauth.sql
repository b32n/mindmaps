-- OAuth 2.1 authorization server, for the MCP endpoint.
--
-- We are both the authorization server and the resource server: the MCP
-- endpoint is the protected resource, and the same Worker issues the tokens.
-- That's the simple case the MCP spec explicitly allows, and it means we
-- authenticate the user to *our* board and nothing else — no model credentials
-- are involved anywhere in this flow.
--
-- Idempotent: every statement is IF NOT EXISTS, so re-applying is safe.

-- Clients register themselves (RFC 7591 dynamic client registration). Harnesses
-- like Claude Code are *public* clients — they can't hold a secret — so PKCE is
-- the only thing binding an authorization code to the client that requested it.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL DEFAULT '',
  -- JSON array. An authorization request's redirect_uri must appear here
  -- exactly; that exact-match rule is what stops an open redirect.
  redirect_uris  TEXT NOT NULL,
  -- NULL for public clients. Confidential clients store a hash, never the
  -- secret itself.
  secret_hash    TEXT,
  created_at     INTEGER NOT NULL
);

-- Authorization codes. Single-use and short-lived; `used` is set rather than
-- the row deleted so a replayed code is detectably a replay rather than just
-- an unknown code.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  -- PKCE. We require S256; `plain` is not accepted.
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  -- RFC 8707 resource indicator. Carried through to the token so the resource
  -- server can check it was the intended audience.
  resource       TEXT,
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- Access and refresh tokens. Only hashes are stored, exactly as with the
-- browser session cookie: a database leak yields no usable credential.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     TEXT PRIMARY KEY,
  refresh_hash   TEXT,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  -- the audience this token was issued for; validated on every MCP request
  resource       TEXT,
  expires_at     INTEGER NOT NULL,
  -- refresh tokens outlive the access token they came with
  refresh_expires_at INTEGER,
  revoked        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user    ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires  ON oauth_codes(expires_at);

-- The existing Google-login table carries a `redirect_to`; the MCP authorize
-- flow reuses the same table for its own round trip through sign-in, so no new
-- table is needed there.
