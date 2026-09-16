/**
 * Walking the graph.
 *
 * Until migration 0011 an edge belonged to a board, so every path was confined
 * to one canvas and traversal told you nothing you could not already see. Now
 * that edges span mindmaps, the paths worth walking are precisely the ones that
 * leave the map you started on — which is what makes this worth having rather
 * than a demo.
 */

export interface Neighbour {
  id: string;
  title: string;
  body: string;
  board_id: string;
  board_name: string;
  updated_at: number;
  /** hops from the starting card */
  depth: number;
  /** how it connects to the card one hop closer in */
  via_label: string;
  via_from: string;
  /** true when this card is the target of a `supersedes` link */
  superseded: number;
}

/**
 * Labels that mean "this replaces that".
 *
 * Matched case- and space-insensitively, and `supercedes` is here because it is
 * the common misspelling — a brain that ignores a supersession because of a
 * typo is worse than one that accepts both.
 *
 * The SQL below needs this as a literal list, so it is generated from the same
 * constant rather than written out again in three places and left to drift.
 */
const SUPERSEDE_LABELS = ["supersedes", "supercedes", "replaces"] as const;

const SUPERSEDE_SQL_LIST = SUPERSEDE_LABELS.map((l) => `'${l}'`).join(",");

export const isSupersedeLabel = (label: string | null | undefined) =>
  (SUPERSEDE_LABELS as readonly string[]).includes(String(label ?? "").trim().toLowerCase());

/** `EXISTS (...)` fragment: has anything superseded the node aliased as `alias`? */
const supersededExpr = (alias: string) =>
  `EXISTS (SELECT 1 FROM edges s
            WHERE s.target_id = ${alias}.id
              AND lower(trim(s.label)) IN (${SUPERSEDE_SQL_LIST}))`;

/**
 * Breadth-first walk outward from a card, following links in both directions.
 *
 * Direction is ignored on purpose. "What blocks this" and "what does this
 * block" are equally relevant when you are trying to remember why something
 * matters, and an agent asking for context wants the neighbourhood, not the
 * out-edges.
 *
 * `UNION` rather than `UNION ALL` does the cycle handling: a card already
 * reached is not re-expanded, so a mutual pair or a loop terminates instead of
 * recursing forever.
 */
export async function neighbourhood(
  db: D1Database,
  userId: string,
  rootId: string,
  depth: number,
  limit: number,
): Promise<Neighbour[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE reach(id, depth, via_label, via_from) AS (
         SELECT ?1, 0, '', ''
         UNION
         SELECT
           CASE WHEN e.source_id = r.id THEN e.target_id ELSE e.source_id END,
           r.depth + 1,
           e.label,
           r.id
         FROM reach r
         JOIN edges e ON e.source_id = r.id OR e.target_id = r.id
         WHERE r.depth < ?2
       )
       SELECT n.id, n.title, n.body, n.board_id, n.updated_at,
              b.name AS board_name,
              r.depth, r.via_label, r.via_from,
              ${supersededExpr("n")} AS superseded
         FROM reach r
         JOIN nodes  n ON n.id = r.id
         JOIN boards b ON b.id = n.board_id
        WHERE b.user_id = ?3
          AND r.id <> ?1
          AND n.type IN ('card','note')
        ORDER BY r.depth, n.updated_at DESC
        LIMIT ?4`,
    )
    .bind(rootId, depth, userId, limit)
    .all<Neighbour>();
  return results ?? [];
}

/**
 * The same walk for many starting cards at once, used by `recall` to expand a
 * set of search hits without one query per hit.
 *
 * Returns a map from root id to its neighbours. Roots are excluded from each
 * other's neighbour lists only when they would be the root itself; a hit that
 * is also a neighbour of another hit is worth knowing about, because that
 * adjacency is a relevance signal.
 */
export async function neighbourhoods(
  db: D1Database,
  userId: string,
  rootIds: string[],
  perRoot: number,
): Promise<Map<string, Neighbour[]>> {
  const out = new Map<string, Neighbour[]>();
  if (!rootIds.length) return out;

  // One hop only, so a single join beats a recursive CTE per root.
  const marks = rootIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT r.root, n.id, n.title, n.body, n.board_id, n.updated_at,
              b.name AS board_name, r.via_label, 1 AS depth, r.root AS via_from,
              ${supersededExpr("n")} AS superseded
         FROM (
           SELECT e.source_id AS root, e.target_id AS other, e.label AS via_label FROM edges e
            WHERE e.source_id IN (${marks})
           UNION ALL
           SELECT e.target_id AS root, e.source_id AS other, e.label AS via_label FROM edges e
            WHERE e.target_id IN (${marks})
         ) r
         JOIN nodes  n ON n.id = r.other
         JOIN boards b ON b.id = n.board_id
        WHERE b.user_id = ? AND n.type IN ('card','note')
        ORDER BY n.updated_at DESC`,
    )
    .bind(...rootIds, ...rootIds, userId)
    .all<Neighbour & { root: string }>();

  for (const row of results ?? []) {
    const list = out.get(row.root) ?? [];
    if (list.length >= perRoot) continue;
    if (list.some((x) => x.id === row.id)) continue;
    list.push(row);
    out.set(row.root, list);
  }
  return out;
}

/** Which of these cards have been superseded by something else. */
export async function supersededSet(
  db: D1Database,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const marks = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT e.target_id AS id
         FROM edges e
        WHERE e.target_id IN (${marks})
          AND lower(trim(e.label)) IN (${SUPERSEDE_SQL_LIST})`,
    )
    .bind(...ids)
    .all<{ id: string }>();
  return new Set((results ?? []).map((r) => r.id));
}
