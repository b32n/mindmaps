-- Full-text search over cards.
--
-- `search` ranked by `updated_at` and matched with `LIKE '%q%'`, which meant a
-- card mentioning the query once outranked one that was about it, and a search
-- for "rotating" could not find "rotation". MCP.md §7 parked this as "start
-- with LIKE; move when it hurts". It hurts: relevance is the whole job of the
-- read side of a brain.
--
-- An external-content FTS5 table indexes `nodes` in place rather than copying
-- it. `content=nodes` means the index stores only the terms; the columns are
-- read back from `nodes` on demand, so there is one copy of the prose and no
-- way for the two to disagree about what a card says.
--
-- `body` is the markdown projection maintained on every write (MCP.md §5),
-- which is exactly why that projection exists.
--
-- NOT IDEMPOTENT: creates tables and triggers. Wrangler runs it once.

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title,
  body,
  content='nodes',
  content_rowid='rowid',
  -- porter stemming so "rotating" finds "rotation"; unicode61 folds accents and
  -- case. Both matter more here than exact-match purity.
  tokenize='porter unicode61'
);

-- External-content tables are not maintained automatically: the triggers are
-- the contract. `delete` rows must be written before the change, with the OLD
-- values, or FTS5 leaves the stale terms behind and the index rots quietly.
CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body)
    VALUES('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body)
    VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO nodes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Backfill everything written before the index existed.
INSERT INTO nodes_fts(rowid, title, body) SELECT rowid, title, body FROM nodes;
