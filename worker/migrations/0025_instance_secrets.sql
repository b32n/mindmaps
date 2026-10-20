-- Secrets this deployment generates for itself, so a fresh install needs no
-- configuration. Currently: the key that signs artefact preview URLs.
CREATE TABLE IF NOT EXISTS instance_secrets (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
