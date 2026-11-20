-- Version history, the core: one append-only row per recorded state of a node.
--
-- A card, a note, an artefact (sheet, doc, deck, page) or a file/folder node
-- gets a row here every time its content changes, with who changed it and
-- through which door. Nothing reads this yet; reading, restoring, conflict
-- checks, retention and the UI each come later. This is only what has to exist
-- first, because history cannot be recovered after the fact.
--
-- WHY SNAPSHOTS
--
-- A row is the whole state, not a diff. Sheets, decks and documents are nested
-- JSON, a chain of diffs needs patch code per kind, and one bad link would
-- break every later restore. A snapshot restores in one read. What bounds the
-- cost is *when* a row is written (see versions.ts: an open window, a seal on a
-- change of writer, a content hash that drops no-op saves), not diffing.
--
-- WHY NO FOREIGN KEY
--
-- `node_id` is deliberately not a reference to `nodes`. A node can be deleted
-- and purged from the trash, and its history must outlive it: that is the only
-- way a deleted node can be recreated from its last version. `workspace_id` is
-- copied onto each row for the same reason: once the node is gone, the board it
-- sat on may be gone too, and access to a version has to be decidable without
-- either.
--
-- NOTHING IS EVER DELETED
--
-- Rows change `status` and carry timestamps; they are not removed. `open` is the
-- newest version while its writer may still be editing it (autosave updates it
-- in place); `sealed` is final. Later changes will add `pruned` and `redacted`
-- and clear the content columns while keeping the row, so the timeline and the
-- sequence stay truthful.
--
-- ARTEFACT PAYLOADS
--
-- An artefact's bytes are in R2, not here. While a version is open its payload
-- is whatever `artefacts/<nodeId>` holds, so editing costs no extra R2
-- operations and `payload_key` is NULL. Sealing copies those bytes to
-- `versions/<nodeId>/<contentHash>` *before* the write that would replace them,
-- and records that key. Cards and files keep their content in the row.
--
-- ADDITIVE ON PURPOSE
--
-- Two new tables, new indexes, nothing altered, renamed or dropped. The Worker
-- version before this one never reads or writes them, so it keeps running on a
-- migrated database; its writes simply are not recorded, and the first write by
-- a newer Worker notices (the node's updated_at no longer matches the head's
-- `node_updated_at`) and records what it finds before recording its own.
--
-- Idempotent: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS versions (
  id                TEXT PRIMARY KEY,
  node_id           TEXT NOT NULL,
  -- Where the node was when this version was written.
  board_id          TEXT,
  workspace_id      TEXT NOT NULL,
  -- 1, 2, 3... per node.
  seq               INTEGER NOT NULL,
  node_type         TEXT NOT NULL,
  -- create | edit | import | undelete. Later changes add rename, restore, delete.
  -- `import` is a state found rather than a change made: the first version of a
  -- node that pre-dates history, or a write by a Worker that did not record.
  op                TEXT NOT NULL,
  title             TEXT,
  -- The derived text snapshot: the same string search indexes. Never indexed
  -- from here, so an old version cannot surface in recall.
  body              TEXT,
  -- Cards: the block JSON the editor renders.
  doc               TEXT,
  -- `nodes.data` as it was (the summary of an artefact, a file's counts, ...).
  data_json         TEXT,
  -- Artefacts: where the sealed payload lives in R2. NULL while open.
  payload_key       TEXT,
  payload_bytes     INTEGER,
  -- sha-256 of the content (type, title, body, doc, data and the payload), so a
  -- write that changes nothing records nothing.
  content_hash      TEXT,
  restored_from     INTEGER,
  -- Who. The user is the person on whose authority the write was made; for an
  -- agent that is whoever approved the connection. The client is snapshotted by
  -- name because a client can be renamed or removed later. `via` is web | mcp |
  -- system.
  actor_user_id     TEXT,
  actor_client_id   TEXT,
  actor_client_name TEXT,
  actor_via         TEXT NOT NULL,
  actor_note        TEXT,
  label             TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'open',
  created_at        INTEGER NOT NULL,
  sealed_at         INTEGER,
  status_changed_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_node_seq ON versions (node_id, seq);
CREATE INDEX IF NOT EXISTS idx_versions_workspace ON versions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_client ON versions (actor_client_id, created_at DESC);

-- The newest version of each node: one primary-key lookup answers "what is the
-- current version, and who wrote it".
CREATE TABLE IF NOT EXISTS version_heads (
  node_id           TEXT PRIMARY KEY,
  head_seq          INTEGER NOT NULL,
  head_version_id   TEXT NOT NULL,
  updated_by_user   TEXT,
  updated_by_client TEXT,
  updated_at        INTEGER NOT NULL,
  -- The value of nodes.updated_at the row had when the head was written. If the
  -- row has moved on since, something wrote it without recording a version.
  node_updated_at   INTEGER
);
