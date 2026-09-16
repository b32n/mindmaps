-- 0005_orphan_edges — remove edges whose endpoints no longer exist.
--
-- `edges` only ever had a foreign key on board_id, never on source_id or
-- target_id, so deleting a node left its links behind pointing at nothing.
-- The Worker now deletes incident edges explicitly on node delete; this clears
-- the ones that already leaked. Re-runnable.

DELETE FROM edges
WHERE source_id NOT IN (SELECT id FROM nodes)
   OR target_id NOT IN (SELECT id FROM nodes);
