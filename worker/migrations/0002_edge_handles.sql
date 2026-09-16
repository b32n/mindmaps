-- 0002_edge_handles — remember WHICH side of a card an edge attaches to.
--
-- Cards expose handles on all four sides, so an edge needs to record the
-- handle at each end or every link snaps back to left/right on reload.
--
-- NOTE ON IDEMPOTENCY: SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS`, so unlike 0001 these statements are not self-guarding. Wrangler
-- tracks applied migrations in d1_migrations and will not re-run this one.
-- Re-applying it by hand against a database that already has the columns
-- fails with "duplicate column name" — which is safe (no data is touched),
-- but it is the reason this file is not re-runnable the way 0001 is.

ALTER TABLE edges ADD COLUMN source_handle TEXT;
ALTER TABLE edges ADD COLUMN target_handle TEXT;
