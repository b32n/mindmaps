-- A mindmap's declared "home view": the pan, zoom and open card it should start
-- in on a device that has never seen it.
--
-- Deliberately server-side, unlike the per-device last-position state which
-- lives in the browser. The distinction is the whole point of having both:
--
--   home_view      an intentional statement about how this board should open.
--                  Rare to change, worth syncing everywhere.
--   local state    where you happened to be last time on this machine.
--                  Tied to a screen size and a session; syncing it would mean a
--                  viewport saved on a 27" monitor deciding what a laptop sees.
--
-- NOT IDEMPOTENT: SQLite has no `ADD COLUMN IF NOT EXISTS`. Wrangler tracks
-- applied migrations, so this runs once — same as 0002 and 0009.

ALTER TABLE boards ADD COLUMN home_view TEXT;
