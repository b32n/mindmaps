-- The workspace an MCP connection was set up for.
--
-- Chosen on the consent page, kept on the authorization code until it is
-- exchanged, then on the token and on every token a refresh issues. It becomes
-- the default for the tools that create a mindmap or look across mindmaps.
--
-- Additive and nullable on purpose. A NULL means "no workspace was chosen",
-- which is every token issued before this column existed, and those keep doing
-- exactly what they did: create in the personal workspace, read everywhere the
-- person can. Nothing is renamed or dropped, so the previous Worker version
-- still runs against a database that has this applied (it never selects the
-- column).
--
-- No foreign key: a workspace can go away while a token lives on, and the token
-- must then say so to its holder rather than be deleted with it.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`. Wrangler tracks
-- applied migrations, so this runs once — same as 0002, 0009 and 0010.

ALTER TABLE oauth_codes  ADD COLUMN workspace_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN workspace_id TEXT;
