-- Arbitrary files, singly and in folders.
--
-- The problem this solves is not storage, it is continuity. Memory already
-- crosses sessions and agents because it lives in D1 and Vectorize; files do
-- not, because they live on whichever machine an agent happened to be running
-- on. A file with a URL, a permission model and a text snapshot is an artefact
-- in exactly the sense ARTEFACTS.md means, and it is the last thing an agent
-- has to leave behind when its session ends.
--
-- Two node types, one table. A `file` node has one row here, a `folder` node
-- has many, and every other difference is presentation. Writing it as two
-- tables would mean two upload paths, two download paths and two reapers, all
-- to express a cardinality the route already enforces.
--
-- WHY THE FILES ARE NOT THEMSELVES NODES
--
-- The obvious design is a folder node with file nodes under it, joined by a
-- parent id. It was rejected for the same reason `deleted_at` on `nodes` was
-- rejected in 0021: forty-one queries read that table, and a column that must
-- be filtered out is a column someone will forget to filter. There the failure
-- was a deleted card surfacing in recall; here it would be a folder's contents
-- spilling loose across the canvas. A folder's members living in their own
-- table changes no existing query, and to everything already written a folder
-- is simply a node.
--
-- What that costs, recorded so it is a decision rather than a discovery: a file
-- inside a folder has no node id, so it cannot be an endpoint of an edge, and
-- it cannot be shared or granted on its own. Sharing granularity is the folder.
--
-- WHY MEMBERSHIP IS HERE RATHER THAN IN AN R2 MANIFEST
--
-- A manifest object would have been less schema. But the whole point is several
-- agents working the same mindmap, and a manifest is one object, so two agents
-- uploading to a folder at once is a read-modify-write race that silently drops
-- one of them. An append is one INSERT.
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  -- The `file` or `folder` node this belongs to. CASCADE keeps the rows from
  -- outliving the node, but note that it does NOT reach the bytes: nothing
  -- cascades into R2, so the delete path files these keys in `r2_trash` before
  -- removing the node. See r2trash.ts.
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  -- As the uploader named it. Shown, and searched: half of finding a file again
  -- is remembering roughly what it was called.
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  -- One line saying what this is, and the only thing that makes a zip or a
  -- spreadsheet findable by meaning. Required at upload for anything we cannot
  -- read text out of — see files.ts. Stored NOT NULL with a default so the
  -- column is simple; the route is where the rule lives.
  description TEXT NOT NULL DEFAULT '',
  -- The head of the file's text, for the kinds we can read: markdown, csv,
  -- json, source. Kept here rather than re-read from R2 because the owning
  -- node's snapshot is rebuilt on every upload, and rebuilding a folder of
  -- forty files would otherwise be forty R2 gets to produce one string.
  snippet     TEXT NOT NULL DEFAULT '',
  -- Where the bytes are: `files/<node_id>/<id>`. Stored rather than derived so
  -- that changing the key layout later does not strand every existing row.
  r2_key      TEXT NOT NULL,
  -- Order within a folder. Sparse, so a reorder is one UPDATE.
  position    REAL NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  -- Who put it there. A folder is a shared surface and "who added this" is the
  -- first question asked about a file nobody recognises.
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- The hot path: every read is "the files of this node, in order".
CREATE INDEX IF NOT EXISTS idx_files_node ON files (node_id, position);

-- The reaper resolves a key back to its row to check nothing still references
-- it, and the download route resolves a signed file id to its node for the
-- permission check.
CREATE INDEX IF NOT EXISTS idx_files_key ON files (r2_key);
