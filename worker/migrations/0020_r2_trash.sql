-- Deferred deletion for R2 objects.
--
-- Nothing cascades into R2. Until now a node delete either destroyed its object
-- immediately (artefacts) or never at all (images), and both are wrong in the
-- same place: undo. Deleting a sheet and pressing undo restored the row, found
-- no payload behind the pointer, and silently wrote a blank workbook over it.
--
-- So a delete now files the object here instead of destroying it. Undo removes
-- the row and the object was never touched. The cron that already runs every
-- minute reaps whatever has been sitting here past the retention window and is
-- still not referenced by a live node.
--
-- Keyed by (bucket, key) rather than node_id: one node has at most one object
-- today, but the pair is what actually identifies an object, and it makes
-- filing the same key twice a no-op rather than a duplicate.
CREATE TABLE IF NOT EXISTS r2_trash (
  -- Binding name, not bucket name. ARTEFACTS and IMAGES currently point at the
  -- same bucket; the reaper needs to know which binding to call, and that stays
  -- true if they are split later.
  bucket     TEXT NOT NULL CHECK (bucket IN ('ARTEFACTS', 'IMAGES')),
  key        TEXT NOT NULL,
  -- The node that referenced it. Undo restores a node under its original id, so
  -- this is what an un-trash looks the row up by.
  node_id    TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

-- The reaper's query: oldest first, past the window.
CREATE INDEX IF NOT EXISTS idx_r2_trash_deleted ON r2_trash (deleted_at);

-- Un-trash on restore looks up by node, not by key, because the client replaying
-- an undo knows the node id and should not have to know R2 layout.
CREATE INDEX IF NOT EXISTS idx_r2_trash_node ON r2_trash (node_id);
