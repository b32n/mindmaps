-- 0003_card_doc — a card's description becomes a rich document.
--
-- Sub-cards are gone. A card is now title + document; breaking work down
-- happens with list blocks inside the doc, or with more cards on the board.
-- That removes the recursive card-owns-a-board model entirely.
--
--   doc  — BlockNote block JSON, the editable source of truth
--   body — plain-text projection of doc, kept for the collapsed card preview
--          (cheap to render, and the obvious thing to search on later)
--
-- Same SQLite caveat as 0002: no `ADD COLUMN IF NOT EXISTS`, so this file is
-- not re-runnable by hand. Wrangler's d1_migrations tracking runs it once.

ALTER TABLE nodes ADD COLUMN doc TEXT;

-- Boards that only existed to hold a card's sub-cards have no purpose now.
-- Top-level workstreams (node_id IS NULL) are untouched.
DELETE FROM boards WHERE node_id IS NOT NULL;
