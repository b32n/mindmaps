-- Account deletion: a user is marked deleted, not removed.
--
-- `users` is referenced by foreign keys across the schema (workspaces, boards,
-- shares, history), and some of those rows belong to other people: a mindmap
-- someone else owns still records who wrote a card in it. So deleting an account
-- keeps its row and takes the person out of it: `status` becomes 'deleted',
-- `deleted_at` says when, and the email, name, avatar, password hash and Google
-- id are scrubbed (the email replaced by an unusable address so the real one can
-- be used to sign up again). Everything the user owned is deleted by the Worker
-- code, which also revokes their sessions and tokens; see worker/src/account.ts.
--
-- ADDITIVE ON PURPOSE
--
-- Two columns, one index, nothing renamed, dropped or rewritten. `status` is
-- defaulted and `deleted_at` is nullable, so the Worker version before this one
-- keeps running on a migrated database: its INSERTs name their columns and leave
-- these to the defaults, and it never reads them. A deleted account looks to it
-- like one with no password and no sessions, which cannot sign in either.
--
-- Not idempotent by itself, like the other ALTERs in this directory: D1's
-- migration table is what makes a migration run once. The index is guarded.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- Only deleted accounts are in it, so it stays tiny: the cron finds a deletion
-- that was interrupted part way through by looking here.
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at) WHERE status <> 'active';
