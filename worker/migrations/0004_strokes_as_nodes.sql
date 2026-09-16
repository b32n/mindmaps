-- 0004_strokes_as_nodes — ink becomes a node like everything else.
--
-- Strokes lived in their own table and rendered into a passive SVG layer, so
-- they couldn't be selected, moved, scaled or deleted. Making each stroke a
-- node means it inherits selection, dragging, NodeResizer, delete and position
-- persistence from the machinery the board already has.
--
-- Geometry: the node's x/y/w/h is the stroke's bounding box. `data` keeps the
-- points in their ORIGINAL absolute coordinates plus the original box size
-- (ow/oh) — the renderer sets an SVG viewBox from those, so scaling is the
-- browser's job and no point math is needed on resize.

INSERT INTO nodes (id, board_id, type, title, body, x, y, w, h, data, created_at, updated_at)
SELECT
  s.id,
  s.board_id,
  'stroke',
  '',
  '',
  bb.min_x,
  bb.min_y,
  MAX(bb.max_x - bb.min_x, 1),
  MAX(bb.max_y - bb.min_y, 1),
  json_object(
    'points', json(s.points),
    'color',  s.color,
    'size',   s.size,
    'ox',     bb.min_x,
    'oy',     bb.min_y,
    'ow',     MAX(bb.max_x - bb.min_x, 1),
    'oh',     MAX(bb.max_y - bb.min_y, 1)
  ),
  s.created_at,
  s.created_at
FROM strokes s
JOIN (
  SELECT
    st.id                                        AS sid,
    MIN(json_extract(pt.value, '$[0]'))          AS min_x,
    MIN(json_extract(pt.value, '$[1]'))          AS min_y,
    MAX(json_extract(pt.value, '$[0]'))          AS max_x,
    MAX(json_extract(pt.value, '$[1]'))          AS max_y
  FROM strokes st, json_each(st.points) pt
  GROUP BY st.id
) bb ON bb.sid = s.id
WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.id);   -- re-runnable

DROP TABLE IF EXISTS strokes;
