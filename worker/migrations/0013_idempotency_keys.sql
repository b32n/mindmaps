-- Stable keys, so an agent can be pointed at the same board twice.
--
-- The failure this fixes is the one that makes a brain rot with use: run
-- "summarise this session" a second time and you got a second overlapping
-- mindmap, then a third. Every re-run made the memory worse. MCP.md §7 flagged
-- this as "cheap now, painful to retrofit" — this is the cheap moment.
--
-- A key is the *agent's* name for something, not ours. It carries meaning only
-- to whoever chose it, which is why it is scoped rather than global:
--
--   boards.idem_key   unique per user   — "my running notes on PCI"
--   nodes.idem_key    unique per board  — "the QSA evidence card on that map"
--
-- Scoping node keys to a board matters more than it looks. Agents already pass
-- throwaway keys like "a"/"b"/"n0" to wire up edges within one call; making
-- those persist globally would turn every second call into a collision. Per
-- board, "a" on one mindmap is simply a different thing from "a" on another.
--
-- SQLite treats NULLs as distinct in a UNIQUE index, so any number of rows may
-- go unkeyed. That is what keeps every existing call — and every caller that
-- never passes a key — behaving exactly as it did.
--
-- NOT IDEMPOTENT: ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite.
-- Wrangler tracks applied migrations, so it runs once.

ALTER TABLE boards ADD COLUMN idem_key TEXT;
ALTER TABLE nodes  ADD COLUMN idem_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_idem ON boards(user_id, idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_idem  ON nodes(board_id, idem_key);
