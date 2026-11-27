-- Verified domains, domain policy and SSO, per organisation (a shared workspace).
--
-- ADDITIVE ON PURPOSE
--
-- Five new tables and four nullable columns. Nothing existing is renamed,
-- dropped or rewritten, and every new column is nullable, so the Worker before
-- this one keeps running against a migrated database: its INSERTs name their
-- columns and leave these empty, and it never reads the new tables. What it does
-- not do is honour a policy: an older Worker would ignore "enforce SSO". Apply
-- this migration and deploy the new Worker together (`npm run deploy` does, in
-- that order).
--
-- Nothing here is ever deleted. Rows carry a `status` and `created_at` /
-- `updated_at`; ending something sets a status. There are deliberately no
-- foreign keys: these are records, and must never be what makes deleting a
-- workspace or an account fail.

-- A domain an organisation claims. 'pending' until its TXT record is found,
-- 'verified' after, 'removed' when let go. `token` is the random value the TXT
-- record `_mindmaps-verify.<domain>` must carry (as `mindmaps-verify=<token>`).
-- Many organisations may hold a pending claim on one domain; only one may hold
-- it verified, and the partial unique index below is what makes that true when
-- two verify at the same instant.
CREATE TABLE IF NOT EXISTS org_domains (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain       TEXT NOT NULL,
  token        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_by   TEXT,
  verified_at  INTEGER,
  removed_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_domains_verified ON org_domains (domain) WHERE status = 'verified';
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_domains_live ON org_domains (workspace_id, domain) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_org_domains_ws ON org_domains (workspace_id, status);

-- The policy of one organisation. No row means every switch is off.
CREATE TABLE IF NOT EXISTS org_policies (
  workspace_id     TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'active',
  auto_join        INTEGER NOT NULL DEFAULT 0,
  default_role     TEXT NOT NULL DEFAULT 'viewer',
  restrict_invites INTEGER NOT NULL DEFAULT 0,
  enforce_sso      INTEGER NOT NULL DEFAULT 0,
  updated_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_policies_enforce ON org_policies (enforce_sso) WHERE enforce_sso = 1;

-- One OIDC provider per organisation. `status` is 'draft' (saved), 'tested'
-- (a sign-in through it worked), 'enabled' (people can use it) or 'removed'.
-- `client_secret_enc` is the client secret encrypted with AES-GCM (see
-- worker/src/secrets.ts); it is never returned by any route and is cleared when
-- the configuration is removed.
CREATE TABLE IF NOT EXISTS org_sso_configs (
  workspace_id      TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'draft',
  issuer            TEXT,
  client_id         TEXT,
  client_secret_enc TEXT,
  tested_at         INTEGER,
  enabled_at        INTEGER,
  updated_by        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Which account a provider's subject is. Tied to the issuer too, so changing
-- provider does not let a new provider's subject collide with an old one's.
CREATE TABLE IF NOT EXISTS sso_identities (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_identities_subject ON sso_identities (workspace_id, issuer, subject) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities (user_id);

-- One sign-in in flight: single use ('pending' -> 'used'), short-lived. Holds
-- what the callback must check the provider's answer against.
CREATE TABLE IF NOT EXISTS sso_login_states (
  state         TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  purpose       TEXT NOT NULL,          -- 'login' or 'test'
  user_id       TEXT,                   -- 'test': who asked
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  redirect_to   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- What a session (and the OAuth grant made from it) has proved.
--   proven_via        'google' or 'sso': the address was proven by that sign-in
--   sso_workspace_id  the organisation whose SSO this session came through
ALTER TABLE auth_sessions ADD COLUMN proven_via TEXT;
ALTER TABLE auth_sessions ADD COLUMN sso_workspace_id TEXT;
ALTER TABLE oauth_codes ADD COLUMN sso_workspace_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN sso_workspace_id TEXT;
