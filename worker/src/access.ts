/**
 * Who can see and change what.
 *
 * Every query in this Worker used to ask `b.user_id = ?`, which conflated two
 * questions that are now different: is this yours, and may you read it. This
 * module answers both, so the rules live once instead of in twenty-nine places.
 *
 * Access arrives by four routes, in descending breadth:
 *
 *   workspace membership   everything in a workspace
 *   board share            one mindmap, across a workspace boundary
 *   artefact grant         one artefact, with nothing around it
 *   link share             one artefact, read-only, no account (shares.ts)
 *
 * The ordering of privilege is fixed and total:
 *
 *   owner > editor > viewer > nothing
 *
 * Owner is never a membership row. It lives in `workspaces.owner_id`, so it
 * cannot be revoked by editing a table that grants lesser roles.
 */

export type Role = "owner" | "editor" | "viewer";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function strongest(...roles: Array<Role | null | undefined>): Role | null {
  let best: Role | null = null;
  for (const r of roles) if (r && (!best || RANK[r] > RANK[best])) best = r;
  return best;
}

export const canRead = (r: Role | null): boolean => r !== null;
export const canWrite = (r: Role | null): boolean => r === "editor" || r === "owner";
/** Deleting a mindmap or a workspace, and managing who is in it. Never an editor. */
export const canAdmin = (r: Role | null): boolean => r === "owner";

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/**
 * Boards this user may read, as a correlated subquery.
 *
 * A string rather than a function because it is spliced into queries that
 * already exist. `p` is the positional slot holding the user id, so one bound
 * value serves all three EXISTS clauses.
 *
 * The slot is a parameter rather than hardcoded to ?1 because the host query
 * decides the numbering, and getting it wrong is silent: an UPDATE that put its
 * own value in ?1 compared `owner_id` against a row index, matched nothing, and
 * simply stopped working. Callers pass the slot they actually bound.
 */
export const BOARD_READABLE = (b = "b", p = 1) => `(
  EXISTS (SELECT 1 FROM workspaces w
           WHERE w.id = ${b}.workspace_id AND w.owner_id = ?${p})
  OR EXISTS (SELECT 1 FROM workspace_members wm
              WHERE wm.workspace_id = ${b}.workspace_id AND wm.user_id = ?${p})
  OR EXISTS (SELECT 1 FROM board_shares bs
              WHERE bs.board_id = ${b}.id AND bs.user_id = ?${p})
)`;

/**
 * Nodes this user may read.
 *
 * Wider than its board on purpose: an artefact can be granted on its own, so a
 * node is readable if its board is readable *or* a grant names it directly.
 */
export const NODE_READABLE = (n = "n", b = "b", p = 1) => `(
  ${BOARD_READABLE(b, p)}
  OR EXISTS (SELECT 1 FROM artefact_grants g
              WHERE g.node_id = ${n}.id AND g.user_id = ?${p})
)`;

/**
 * Restrict a readable row to one workspace, matching what recall's vector scope
 * covers.
 *
 * Namespace scoping alone is not enough. Recall is a hybrid — keyword, vectors,
 * graph — and scoping only the vectors would mean the same question returns
 * personal cards through FTS and hides them from the semantic pass. Half-scoped
 * is worse than either: results appear and disappear depending on which arm of
 * the search found them.
 *
 * Mirrors `recallScope` exactly: the workspace itself, plus boards shared to
 * you across a boundary, plus artefacts granted to you directly. A null
 * workspace slot disables the filter, which is the agent case.
 */
export const IN_WORKSPACE = (b = "b", n = "n", pWs = 1, pUser = 2) => `(
  ?${pWs} IS NULL
  OR ${b}.workspace_id = ?${pWs}
  OR EXISTS (SELECT 1 FROM board_shares bs
              WHERE bs.board_id = ${b}.id AND bs.user_id = ?${pUser})
  OR EXISTS (SELECT 1 FROM artefact_grants g
              WHERE g.node_id = ${n}.id AND g.user_id = ?${pUser})
)`;

// ---------------------------------------------------------------------------
// Role lookups
// ---------------------------------------------------------------------------

/** The strongest role this user holds on a workspace, or null. */
export async function workspaceRole(
  db: D1Database,
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  const row = await db
    .prepare(
      `SELECT CASE
                WHEN w.owner_id = ?1 THEN 'owner'
                ELSE (SELECT m.role FROM workspace_members m
                       WHERE m.workspace_id = w.id AND m.user_id = ?1)
              END AS role
         FROM workspaces w WHERE w.id = ?2`,
    )
    .bind(userId, workspaceId)
    .first<{ role: Role | null }>();
  return row?.role ?? null;
}

/**
 * The strongest role on a board: from its workspace, or from a direct share.
 *
 * One query rather than three. A share can only raise the role, never lower it
 * — being handed a mindmap you already own must not demote you on it.
 */
export async function boardRole(
  db: D1Database,
  userId: string,
  boardId: string,
): Promise<Role | null> {
  const row = await db
    .prepare(
      `SELECT CASE
                WHEN w.owner_id = ?1 THEN 'owner'
                ELSE (SELECT m.role FROM workspace_members m
                       WHERE m.workspace_id = w.id AND m.user_id = ?1)
              END AS ws_role,
              (SELECT bs.role FROM board_shares bs
                WHERE bs.board_id = b.id AND bs.user_id = ?1) AS share_role
         FROM boards b LEFT JOIN workspaces w ON w.id = b.workspace_id
        WHERE b.id = ?2`,
    )
    .bind(userId, boardId)
    .first<{ ws_role: Role | null; share_role: Role | null }>();
  if (!row) return null;
  return strongest(row.ws_role, row.share_role);
}

/** The strongest role on a node: inherited from its board, or granted directly. */
export async function nodeRole(
  db: D1Database,
  userId: string,
  nodeId: string,
): Promise<Role | null> {
  const row = await db
    .prepare(
      `SELECT CASE
                WHEN w.owner_id = ?1 THEN 'owner'
                ELSE (SELECT m.role FROM workspace_members m
                       WHERE m.workspace_id = w.id AND m.user_id = ?1)
              END AS ws_role,
              (SELECT bs.role FROM board_shares bs
                WHERE bs.board_id = b.id AND bs.user_id = ?1) AS share_role,
              (SELECT g.role FROM artefact_grants g
                WHERE g.node_id = n.id AND g.user_id = ?1) AS grant_role
         FROM nodes n
         JOIN boards b ON b.id = n.board_id
         LEFT JOIN workspaces w ON w.id = b.workspace_id
        WHERE n.id = ?2`,
    )
    .bind(userId, nodeId)
    .first<{ ws_role: Role | null; share_role: Role | null; grant_role: Role | null }>();
  if (!row) return null;
  return strongest(row.ws_role, row.share_role, row.grant_role);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  name: string;
  owner_id: string;
  personal: number;
  role: Role;
}

/** Every workspace this user can open, personal first. */
export async function workspacesFor(db: D1Database, userId: string): Promise<WorkspaceRow[]> {
  const rows = await db
    .prepare(
      `SELECT w.id, w.name, w.owner_id, w.personal,
              CASE WHEN w.owner_id = ?1 THEN 'owner'
                   ELSE (SELECT m.role FROM workspace_members m
                          WHERE m.workspace_id = w.id AND m.user_id = ?1)
              END AS role
         FROM workspaces w
        WHERE w.owner_id = ?1
           OR EXISTS (SELECT 1 FROM workspace_members m
                       WHERE m.workspace_id = w.id AND m.user_id = ?1)
        ORDER BY w.personal DESC, w.created_at`,
    )
    .bind(userId)
    .all<WorkspaceRow>();
  return rows.results ?? [];
}

/**
 * The personal workspace, created with the account.
 *
 * Its id is the user's id, deliberately: vectors were namespaced by user id
 * before workspaces existed, so this keeps every one of them valid and means
 * introducing workspaces needed no re-index.
 */
export async function ensurePersonalWorkspace(db: D1Database, userId: string): Promise<string> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, owner_id, personal, created_at)
       VALUES (?1, 'Personal', ?1, 1, ?2)`,
    )
    .bind(userId, Date.now())
    .run();
  return userId;
}

// ---------------------------------------------------------------------------
// Retrieval scope
// ---------------------------------------------------------------------------

export interface RecallScope {
  /** Vectorize namespaces to query, concurrently. The current workspace first. */
  namespaces: string[];
  /**
   * Nodes reachable only by a direct artefact grant.
   *
   * Scored by exact cosine over `node_chunks.embedding` in D1 rather than by
   * searching the owner's namespace: a grant names specific nodes, so there is
   * nothing to search for. Cheaper than a vector query and exact rather than
   * approximate.
   */
  grantedNodeIds: string[];
}

/**
 * What recall may look at, from inside one workspace.
 *
 * Scoped to the workspace you are in rather than everything you can see, so a
 * search never mixes work and personal context — and so the usual case is
 * exactly one vector query however large the team.
 *
 * The extra namespaces are for boards shared across a workspace boundary, which
 * live in their owner's namespace and cannot be reached any other way. That is
 * the only case that costs more than one query, and it is the rare one.
 */
export async function recallScope(
  db: D1Database,
  userId: string,
  /**
   * Null means "wherever I can reach" rather than "nowhere".
   *
   * The app always knows which workspace the question came from. An agent does
   * not — it has no notion of being anywhere — so a missing workspace widens to
   * every workspace the user belongs to. That is a fan-out bounded by
   * memberships, which is a small number, rather than by collaborators.
   */
  workspaceId: string | null,
): Promise<RecallScope> {
  if (!workspaceId) {
    const [all, granted] = await Promise.all([
      db
        .prepare(
          `SELECT w.id AS ns FROM workspaces w WHERE w.owner_id = ?1
            UNION
           SELECT m.workspace_id AS ns FROM workspace_members m WHERE m.user_id = ?1
            UNION
           SELECT b.workspace_id AS ns FROM board_shares bs
             JOIN boards b ON b.id = bs.board_id WHERE bs.user_id = ?1`,
        )
        .bind(userId)
        .all<{ ns: string }>(),
      db
        .prepare(`SELECT node_id FROM artefact_grants WHERE user_id = ?1`)
        .bind(userId)
        .all<{ node_id: string }>(),
    ]);
    const namespaces = (all.results ?? []).map((r) => r.ns).filter(Boolean);
    return {
      namespaces: namespaces.length ? namespaces : [userId],
      grantedNodeIds: (granted.results ?? []).map((r) => r.node_id),
    };
  }

  const [shared, granted] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT b.workspace_id AS ns
           FROM board_shares bs
           JOIN boards b ON b.id = bs.board_id
          WHERE bs.user_id = ?1 AND b.workspace_id <> ?2`,
      )
      .bind(userId, workspaceId)
      .all<{ ns: string }>(),
    db
      .prepare(
        `SELECT g.node_id
           FROM artefact_grants g
           JOIN nodes n ON n.id = g.node_id
           JOIN boards b ON b.id = n.board_id
          WHERE g.user_id = ?1 AND b.workspace_id <> ?2`,
      )
      .bind(userId, workspaceId)
      .all<{ node_id: string }>(),
  ]);

  return {
    namespaces: [workspaceId, ...(shared.results ?? []).map((r) => r.ns).filter(Boolean)],
    grantedNodeIds: (granted.results ?? []).map((r) => r.node_id),
  };
}
