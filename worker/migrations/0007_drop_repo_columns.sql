-- 0007_drop_repo_columns — remove vestiges of the Managed Agents design.
--
-- `repos` existed to mount git repositories into agent sandboxes we no longer
-- run (see DESIGN.md §4, superseded by MCP.md). `linear_ids` was never wired to
-- anything. A board is now a mindmap: a named canvas of connected thoughts.
--
-- SQLite has no `DROP COLUMN IF EXISTS`, so like 0002 and 0003 this is not
-- re-runnable by hand; wrangler's migration tracking runs it once.

ALTER TABLE boards DROP COLUMN repos;
ALTER TABLE boards DROP COLUMN linear_ids;
