-- Housekeeping for the two technical tables from 0030 (docs/SIGNUP.md).
--
-- ADDITIVE ON PURPOSE
--
-- Two nullable columns and two indexes. Nothing is renamed, dropped or
-- rewritten, so the Worker before this one keeps running on a migrated database:
-- its rate-limit upsert never names the new columns, and a row it writes simply
-- has no window length (the sweep then assumes the longest, one hour).
--
-- rate_limits.window_ms   how long this counter's window is, written on every hit
--                         from now on; NULL on older rows
-- rate_limits.expired_at  when the scheduled sweep marked the row 'expired'
--                         (status 'active' -> 'expired'); NULL while active. A hit
--                         on an expired row revives it: status 'active', NULL again
--
-- The sweep (worker/src/housekeeping.ts) marks rows rather than deleting them,
-- and only removes rate_limits rows that have been expired for seven days. Those
-- carry a hashed counter and no account data. email_tokens rows are marked
-- 'expired' once past expires_at and are never removed: they name an address.
CREATE INDEX IF NOT EXISTS idx_rate_limits_sweep ON rate_limits (status, window_start);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expiry ON email_tokens (status, expires_at);

ALTER TABLE rate_limits ADD COLUMN window_ms INTEGER;
ALTER TABLE rate_limits ADD COLUMN expired_at INTEGER;
