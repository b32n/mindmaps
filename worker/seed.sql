-- Dummy data for visualising the board. Rerunnable: wipes and re-inserts.
-- Not a migration — seed data doesn't belong in migration history.
--
--   npm run db:seed          -- register an account first
--
-- A mindmap is a named canvas. A card is title + document; work breakdown
-- lives in the document as checklist blocks, not as sub-cards.
--
-- **Sign up before seeding.** Every board is inserted owned by the earliest
-- account in the database; with no account, the first INSERT aborts with
-- "boards.user_id is required" and nothing is written. Seeding used to leave
-- user_id NULL and let the next registration adopt the rows, which is the
-- ownership grab migration 0014 exists to make impossible. Local-only either
-- way: this file is destructive and has no business near production.

DELETE FROM events;
DELETE FROM sessions;
DELETE FROM edges;
DELETE FROM nodes;
DELETE FROM boards;

-- ------------------------------------------------------------------ mindmaps
-- Owned by the earliest account — the one whose rail you are about to look at.
-- The subquery yields NULL if no account exists, which the 0014 trigger turns
-- into an abort rather than an orphan.

INSERT INTO boards (id,name,status,parent_id,node_id,created_at,updated_at,user_id) VALUES
  ('w-pci','PCI 2026','active',NULL,NULL,1780000000000,1788000000000,
   (SELECT id FROM users ORDER BY created_at LIMIT 1)),
  ('w-auth','Auth consolidation','active',NULL,NULL,1780000000000,1788000000000,
   (SELECT id FROM users ORDER BY created_at LIMIT 1)),
  ('w-dr','Disaster recovery','at-risk',NULL,NULL,1780000000000,1788000000000,
   (SELECT id FROM users ORDER BY created_at LIMIT 1)),
  ('w-dev','Dev productivity','active',NULL,NULL,1780000000000,1788000000000,
   (SELECT id FROM users ORDER BY created_at LIMIT 1));

-- --------------------------------------------------------------------- cards

INSERT INTO nodes (id,board_id,type,title,body,x,y,w,h,data,created_at,updated_at) VALUES
  ('n-scope','w-pci','card','Confirm CDE scope',
   'Which services actually touch cardholder data? The segmentation diagram is two years stale.',
   60,60,260,140,'{}',1780000000000,1788000000000),
  ('n-eviden','w-pci','card','Evidence collection',
   'Quarterly artefacts for the QSA.',380,60,260,140,'{}',1780000000000,1788000000000),
  ('n-token','w-pci','card','Tokenization gaps','',60,320,260,140,'{}',1780000000000,1788000000000),
  ('n-qsa','w-pci','note','QSA walkthrough booked 12 Oct — need scope doc a week before.',
   '',380,320,240,120,'{}',1780000000000,1788000000000),
  ('n-vendor','w-pci','card','Vendor attestations',
   'Chase 3 outstanding AOCs.',700,180,260,140,'{}',1780000000000,1788000000000),

  ('n-trace','w-auth','card','Trace auth flow across services',
   'Four services are involved and nobody has the full path written down.',
   60,60,260,140,'{}',1780000000000,1788000000000),
  ('n-refresh','w-auth','card','Token refresh — two implementations','',
   380,60,260,140,'{}',1780000000000,1788000000000),
  ('n-sso','w-auth','card','SSO migration plan','',60,320,260,140,'{}',1780000000000,1788000000000),
  ('n-anote','w-auth','note','Decision needed before Q3 planning: consolidate or wrap?',
   '',380,320,240,120,'{}',1780000000000,1788000000000),

  ('n-rto','w-dr','card','RTO targets unvalidated','',60,60,260,140,'{}',1780000000000,1788000000000),
  ('n-drill','w-dr','card','Failover drill — never run','',380,60,260,140,'{}',1780000000000,1788000000000),

  ('n-ci','w-dev','card','CI queue times','Builds up 40% since June.',
   60,60,260,140,'{}',1780000000000,1788000000000),
  ('n-onboard','w-dev','note','New joiners take 3 days to first PR','',
   380,60,240,120,'{}',1780000000000,1788000000000);

-- --------------------------------------------------------------------- edges

INSERT INTO edges (id,board_id,source_id,target_id,label,created_at,source_handle,target_handle) VALUES
  ('e1','w-pci','n-scope','n-eviden','blocks',1780000000000,'right','left'),
  ('e2','w-pci','n-scope','n-token','',1780000000000,'bottom','top'),
  ('e3','w-auth','n-trace','n-refresh','',1780000000000,'right','left'),
  ('e4','w-auth','n-refresh','n-sso','blocks',1780000000000,'bottom','right');

-- ------------------------------------------------------------------- threads
-- anthropic_session_id is NULL so nothing tries to poll a session that does
-- not exist; `status` is what the card chip reads.

INSERT INTO sessions (id,node_id,anthropic_session_id,status,created_at,updated_at) VALUES
  ('s-trace','n-trace',NULL,'idle',1780000000000,1788000000000),
  ('s-scope','n-scope',NULL,'running',1780000000000,1788000000000),
  ('s-ci','n-ci',NULL,'idle',1780000000000,1788000000000);

-- ----------------------------------------------------------------------- ink
-- Strokes are nodes: x/y/w/h is the bounding box, and `data` keeps the points
-- in original coordinates plus that box (ox/oy/ow/oh) for the SVG viewBox.

INSERT INTO nodes (id,board_id,type,title,body,x,y,w,h,data,created_at,updated_at) VALUES
  ('k1','w-pci','stroke','','',340,140,46,22,
   '{"points":[[340,150,0.5],[356,162,0.6],[372,156,0.6],[386,140,0.5]],"color":"#b4741c","size":5,"ox":340,"oy":140,"ow":46,"oh":22}',
   1780000000000,1788000000000),
  ('k2','w-auth','stroke','','',336,130,28,10,
   '{"points":[[336,130,0.5],[350,140,0.6],[364,132,0.6]],"color":"#2f6f4f","size":5,"ox":336,"oy":130,"ow":28,"oh":10}',
   1780000000000,1788000000000);

-- ----------------------------------------------------------------- documents
-- The done/total chip on a card is derived from these checklist blocks.

UPDATE nodes SET doc = '[
 {"type":"paragraph","content":[{"type":"text","text":"Which services actually touch cardholder data? The segmentation diagram is two years stale.","styles":{}}]},
 {"type":"heading","props":{"level":3},"content":[{"type":"text","text":"To confirm","styles":{}}]},
 {"type":"checkListItem","props":{"checked":true},"content":[{"type":"text","text":"Which service owns session state","styles":{}}]},
 {"type":"checkListItem","props":{"checked":false},"content":[{"type":"text","text":"Card data in logs - audit","styles":{}}]},
 {"type":"checkListItem","props":{"checked":false},"content":[{"type":"text","text":"Redraw the segmentation diagram","styles":{}}]},
 {"type":"paragraph","content":[{"type":"text","text":"QSA walkthrough is 12 Oct, so this needs to land a week before.","styles":{}}]}
]' WHERE id = 'n-scope';

UPDATE nodes SET doc = '[
 {"type":"paragraph","content":[{"type":"text","text":"Four services are involved and nobody has the full path written down.","styles":{}}]},
 {"type":"checkListItem","props":{"checked":true},"content":[{"type":"text","text":"bank-platform issues the session","styles":{}}]},
 {"type":"checkListItem","props":{"checked":true},"content":[{"type":"text","text":"access validates, but caches for 15m","styles":{}}]},
 {"type":"checkListItem","props":{"checked":false},"content":[{"type":"text","text":"Refresh races the cache under load","styles":{}}]},
 {"type":"paragraph","content":[{"type":"text","text":"This is almost certainly the August incident.","styles":{}}]}
]' WHERE id = 'n-trace';

-- Ownership is set on the INSERTs above, not swept up at the end: a board that
-- is briefly unowned is a board that could be claimed by the wrong account.
