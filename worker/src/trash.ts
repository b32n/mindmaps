/**
 * The trash: archive, list, restore, purge.
 *
 * A delete moves rows out of the live tables into `trash` and files the R2
 * objects in `r2_trash`. Nothing is destroyed until the retention window has
 * passed, so "restore" is a real operation rather than a best effort, and the
 * live tables never contain anything a query has to remember to filter out.
 *
 * Two shapes go in here:
 *
 *   node    one node, plus the edges that died with it
 *   board   a whole mindmap subtree — boards, their nodes, their edges — as a
 *           single entry, because deleting a mindmap is one action and undoing
 *           it should be one action too
 */

import { boardRole, canWrite, workspaceRole } from "./access";
import { isArtefact, artefactKey } from "./artefacts";
import { filesOf, isFileKind, type FileEnv } from "./files";
import { reinsertNode, webActor } from "./versions";
import { imageKeyFrom, trashObject, untrashNode, RETENTION_MS, type TrashEnv } from "./r2trash";

export interface TrashRow {
  id: string;
  kind: "node" | "board";
  label: string | null;
  node_type: string | null;
  context: string | null;
  summary: string | null;
  deleted_at: number;
}

type Row = Record<string, unknown>;

/** How many entries one purge tick will clear. */
const PURGE_PER_RUN = 50;

// ---------------------------------------------------------------------------
// Writing rows back
// ---------------------------------------------------------------------------

/**
 * Insert an archived row using whatever columns it actually has.
 *
 * Built from the row's own keys rather than a hardcoded column list, so a
 * migration that adds a column does not quietly start dropping that column on
 * every restore. `OR IGNORE` because a restore can legitimately meet a row that
 * is already back — an edge shared by two separately restored nodes is stored
 * in both payloads.
 */
async function reinsert(db: D1Database, table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  if (!cols.length) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    )
    .bind(...cols.map((c) => row[c] as never))
    .run();
}

/**
 * File a trash entry without ever disturbing someone else's.
 *
 * The id is the node's or mindmap's own, and a node id can be chosen by the
 * caller, so a second user can end up deleting something that carries the id of
 * an entry already sitting in another user's trash. This used to be
 * `INSERT OR REPLACE`, which handed that entry to whoever deleted last: the
 * original owner lost their undo and the new row, with its payload, was the
 * stranger's to restore from.
 *
 * Now an existing entry is only ever refreshed by the user who owns it, or
 * replaced once it is past the retention window (dead, just not swept yet). In
 * every other case the original stays exactly as it was and this archive is not
 * kept, which costs only the one who reused the id an undo.
 */
async function fileEntry(
  env: TrashEnv,
  kind: "node" | "board",
  userId: string,
  e: {
    id: string; label: string | null; nodeType: string | null; context: string | null;
    summary: string | null; payload: string;
  },
): Promise<void> {
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO trash (id,kind,user_id,label,node_type,context,summary,deleted_at,payload)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, user_id = excluded.user_id, label = excluded.label,
       node_type = excluded.node_type, context = excluded.context,
       summary = excluded.summary, deleted_at = excluded.deleted_at,
       payload = excluded.payload
     WHERE trash.user_id = excluded.user_id AND trash.kind = excluded.kind
        OR trash.deleted_at <= ?10`,
  )
    .bind(e.id, kind, userId, e.label, e.nodeType, e.context, e.summary, t, e.payload, t - RETENTION_MS)
    .run();
}

/** A readable count for the listing: "12 cards, 2 sheets". */
function describe(nodes: Row[]): string {
  const tally = new Map<string, number>();
  for (const n of nodes) {
    const t = String(n.type ?? "node");
    tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`);
  return parts.join(", ") || "empty";
}

/**
 * File every R2 object belonging to these nodes.
 *
 * Artefacts and images are the two types with bytes behind them. Anything else
 * lives entirely in its row and needs nothing here.
 */
async function trashObjectsFor(env: TrashEnv, nodes: Row[]): Promise<void> {
  for (const n of nodes) {
    const id = String(n.id);
    const type = String(n.type ?? "");
    if (isArtefact(type)) {
      await trashObject(env, "ARTEFACTS", artefactKey(id), id);
      continue;
    }
    if (isFileKind(type)) {
      // A file node's bytes are one object per row, not one per node, so the
      // keys come from the table rather than from a key function. Read here
      // while the rows still exist: they cascade the moment the node goes.
      for (const f of await filesOf(env as unknown as FileEnv, id)) {
        await trashObject(env, "ARTEFACTS", f.r2_key, id);
      }
      continue;
    }
    if (type === "image") {
      let url: unknown;
      try {
        url = JSON.parse(String(n.data || "{}"))?.url;
      } catch {
        url = null;
      }
      const key = imageKeyFrom(url);
      if (key) await trashObject(env, "IMAGES", key, id);
    }
  }
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/**
 * Archive one node and the edges attached to it.
 *
 * Edges are captured because the foreign keys cascade: the moment the node row
 * goes, every link touching it goes with it, including links reaching onto
 * another mindmap. Restoring a node without them would bring back something
 * disconnected from everything it was connected to.
 *
 * Returns false when the node does not exist, so the caller can 404.
 */
export async function archiveNode(
  env: TrashEnv,
  userId: string,
  nodeId: string,
): Promise<boolean> {
  const node = await env.DB.prepare(`SELECT * FROM nodes WHERE id = ?`).bind(nodeId).first<Row>();
  if (!node) return false;

  const edges = await env.DB.prepare(`SELECT * FROM edges WHERE source_id = ? OR target_id = ?`)
    .bind(nodeId, nodeId)
    .all<Row>();

  /*
   * A file node's rows go the same way its edges do — `files.node_id` cascades
   * — so they are captured for the same reason. Without this the bytes survive
   * in `r2_trash` and the restore brings back an empty folder pointing at
   * nothing, which is the shape of the undo bug that 0020 was written to fix.
   */
  const files = await env.DB.prepare(`SELECT * FROM files WHERE node_id = ?`)
    .bind(nodeId)
    .all<Row>();

  const board = await env.DB.prepare(`SELECT name FROM boards WHERE id = ?`)
    .bind(node.board_id as string)
    .first<{ name: string }>();

  await fileEntry(env, "node", userId, {
    id: nodeId,
    label: (node.title as string) || null,
    nodeType: String(node.type ?? "node"),
    context: board?.name ?? null,
    summary: null,
    payload: JSON.stringify({ node, edges: edges.results ?? [], files: files.results ?? [] }),
  });

  await trashObjectsFor(env, [node]);
  return true;
}

/**
 * Archive a mindmap and everything under it.
 *
 * `boards.parent_id` makes mindmaps a tree and the foreign key cascades, so
 * deleting one takes its descendants with it. The whole subtree goes into a
 * single trash entry: the user performed one delete and expects one thing to
 * put back, not a list of thirty orphaned cards.
 */
export async function archiveBoard(
  env: TrashEnv,
  userId: string,
  boardId: string,
): Promise<boolean> {
  const root = await env.DB.prepare(`SELECT * FROM boards WHERE id = ?`).bind(boardId).first<Row>();
  if (!root) return false;

  // Walk down rather than recurse in SQL: the depth here is small, and this
  // keeps the query plan obvious.
  const boards: Row[] = [root];
  let frontier = [boardId];
  for (let depth = 0; depth < 20 && frontier.length; depth++) {
    const marks = frontier.map(() => "?").join(",");
    const kids = await env.DB.prepare(`SELECT * FROM boards WHERE parent_id IN (${marks})`)
      .bind(...frontier)
      .all<Row>();
    const rows = kids.results ?? [];
    boards.push(...rows);
    frontier = rows.map((r) => String(r.id));
  }

  const ids = boards.map((b) => String(b.id));
  const marks = ids.map(() => "?").join(",");
  const nodes = await env.DB.prepare(`SELECT * FROM nodes WHERE board_id IN (${marks})`)
    .bind(...ids)
    .all<Row>();
  const rows = nodes.results ?? [];

  // Edges reaching *out* of this subtree matter as much as internal ones: a
  // card here linked to a card on a mindmap you are keeping loses that link
  // when this cascade runs, and the restore should bring it back.
  const nodeIds = rows.map((n) => String(n.id));
  let edges: Row[] = [];
  if (nodeIds.length) {
    const nm = nodeIds.map(() => "?").join(",");
    const found = await env.DB.prepare(
      `SELECT * FROM edges WHERE source_id IN (${nm}) OR target_id IN (${nm})`,
    )
      .bind(...nodeIds, ...nodeIds)
      .all<Row>();
    edges = found.results ?? [];
  }

  // Same reason as `archiveNode`: these cascade with their node, and a mindmap
  // delete is the one that used to take every artefact on it with no way back.
  let files: Row[] = [];
  if (nodeIds.length) {
    const nm = nodeIds.map(() => "?").join(",");
    const found = await env.DB.prepare(`SELECT * FROM files WHERE node_id IN (${nm})`)
      .bind(...nodeIds)
      .all<Row>();
    files = found.results ?? [];
  }

  await fileEntry(env, "board", userId, {
    id: boardId,
    label: (root.name as string) || null,
    nodeType: null,
    context: boards.length > 1 ? `${boards.length - 1} sub-mindmap${boards.length === 2 ? "" : "s"}` : null,
    summary: describe(rows),
    payload: JSON.stringify({ boards, nodes: rows, edges, files }),
  });

  await trashObjectsFor(env, rows);
  return true;
}

// ---------------------------------------------------------------------------
// Listing and restoring
// ---------------------------------------------------------------------------

export async function listTrash(env: TrashEnv, userId: string): Promise<TrashRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, label, node_type, context, summary, deleted_at
       FROM trash
      WHERE user_id = ? AND deleted_at > ?
      ORDER BY deleted_at DESC`,
  )
    .bind(userId, Date.now() - RETENTION_MS)
    .all<TrashRow>();
  return rows.results ?? [];
}

/**
 * May this user put a deleted node back by id?
 *
 * Yes only when a live (unexpired) node entry exists and the caller either
 * deleted it, or can write to the mindmap it was deleted from, which keeps a
 * collaborator's undo working on a shared map. Everything else, including "no
 * such entry", answers false, so a caller cannot tell a stranger's trash from an
 * id that was never used. Reads nothing from R2.
 */
export async function mayRestoreNode(
  env: TrashEnv,
  userId: string,
  nodeId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT user_id, json_extract(payload, '$.node.board_id') AS board_id
       FROM trash WHERE id = ? AND kind = 'node' AND deleted_at > ?`,
  )
    .bind(nodeId, now - RETENTION_MS)
    .first<{ user_id: string; board_id: string | null }>();
  if (!row) return false;
  if (row.user_id === userId) return true;
  if (!row.board_id) return false;
  return canWrite(await boardRole(env.DB, userId, row.board_id));
}

/**
 * May this user write where an archive would land?
 *
 * A node goes back onto the mindmap it left, which is still there (the
 * deleted-mindmap case is answered separately, so "not there" passes here). A
 * mindmap goes back under its parent if that is still live, and otherwise into
 * the workspace it was in. A row with no workspace is a legacy personal one,
 * writable by its own creator.
 */
async function mayWriteTarget(
  env: TrashEnv,
  userId: string,
  kind: string,
  boards: Row[],
  nodes: Row[],
): Promise<boolean> {
  if (kind === "node" || !boards.length) {
    const boardId = nodes[0]?.board_id;
    if (!boardId) return true;
    const role = await boardRole(env.DB, userId, String(boardId));
    if (role) return canWrite(role);
    const live = await env.DB.prepare(`SELECT 1 AS hit FROM boards WHERE id = ?`).bind(String(boardId)).first();
    return !live;
  }
  const root = boards[0];
  if (root.parent_id) {
    const role = await boardRole(env.DB, userId, String(root.parent_id));
    if (role) return canWrite(role);
    const live = await env.DB.prepare(`SELECT 1 AS hit FROM boards WHERE id = ?`).bind(String(root.parent_id)).first();
    if (live) return false;
  }
  if (root.workspace_id) return canWrite(await workspaceRole(env.DB, userId, String(root.workspace_id)));
  return root.user_id === userId;
}

export interface RestoreResult {
  ok: boolean;
  /** Where to send the user afterwards. */
  boardId?: string;
  error?: string;
}

/**
 * Put an entry back.
 *
 * Order is forced by the foreign keys: boards, then nodes, then edges. Edges go
 * last and with `OR IGNORE`, because an edge whose other end is still deleted
 * would fail its foreign key — that link is genuinely gone until the other end
 * comes back too, and one dead link must not abort the whole restore.
 */
export async function restoreTrash(
  env: TrashEnv,
  userId: string,
  id: string,
): Promise<RestoreResult> {
  const row = await env.DB.prepare(
    `SELECT * FROM trash WHERE id = ? AND user_id = ? AND deleted_at > ?`,
  )
    .bind(id, userId, Date.now() - RETENTION_MS)
    .first<Row>();
  if (!row) return { ok: false, error: "not found" };

  let payload: { node?: Row; boards?: Row[]; nodes?: Row[]; edges?: Row[]; files?: Row[] };
  try {
    payload = JSON.parse(String(row.payload));
  } catch {
    return { ok: false, error: "This item's record is damaged and cannot be restored." };
  }

  const boards = payload.boards ?? [];
  const nodes = payload.nodes ?? (payload.node ? [payload.node] : []);
  const edges = payload.edges ?? [];
  const files = payload.files ?? [];

  /*
   * Restoring is writing, so it needs write access to where the item goes back
   * *now*. Owning the entry is not enough: it was filed when the user could
   * still write there, and they may since have been removed, demoted to viewer,
   * or had the mindmap unshared. Refused rather than redirected to the user's
   * home — the same choice as the deleted-mindmap case below, because dropping
   * something on a map the user did not pick is worse than telling them why it
   * cannot go back. The entry is left in place, so it can be retried if access
   * returns.
   */
  if (!(await mayWriteTarget(env, userId, row.kind as string, boards, nodes)))
    return {
      ok: false,
      error: "You no longer have edit access to the mindmap this came from, so it cannot be restored there.",
    };

  // A node cannot go back onto a mindmap that is no longer there. This is the
  // one case a restore can legitimately refuse, and saying so beats dropping
  // the card somewhere arbitrary.
  if (!boards.length && nodes.length) {
    const live = await env.DB.prepare(`SELECT 1 AS hit FROM boards WHERE id = ?`)
      .bind(String(nodes[0].board_id))
      .first<{ hit: number }>();
    if (!live)
      return {
        ok: false,
        error: "The mindmap this came from was deleted too. Restore that first.",
      };
  }

  // Someone else may have made a node under this id since (an id is not a
  // credential, but it can be squatted). Replaying the archive onto it would
  // attach the archived file rows and edges to a node the owner never had.
  for (const n of nodes) {
    const taken = await env.DB.prepare(`SELECT 1 AS hit FROM nodes WHERE id = ?`)
      .bind(String(n.id))
      .first<{ hit: number }>();
    if (taken) return { ok: false, error: "A card with this id already exists, so this cannot be restored." };
  }

  for (const b of boards) await reinsert(env.DB, "boards", b);
  for (const n of nodes) {
    // Re-embed after restore. The chunk rows and their vectors were removed
    // when the node was, so without this the card comes back visible on the
    // board and invisible to recall.
    await reinsertNode(env, webActor(userId), { ...n, index_dirty: Date.now() });
    await untrashNode(env, String(n.id));
  }
  for (const e of edges) await reinsert(env.DB, "edges", e);
  // After the nodes, because `files.node_id` references them.
  for (const f of files) await reinsert(env.DB, "files", f);

  await env.DB.prepare(`DELETE FROM trash WHERE id = ?`).bind(id).run();

  return {
    ok: true,
    boardId: boards.length ? String(boards[0].id) : String(nodes[0]?.board_id ?? ""),
  };
}

/**
 * Forget a node's trash entry because the node is live again.
 *
 * Called when a create under a trashed id was allowed to take it back (undo).
 * Left in place, the entry is stale: it still belongs to whoever deleted
 * first, and would collide with the next deletion of the same node by someone
 * else, which `fileEntry` rightly refuses to overwrite.
 */
export async function dropNodeEntry(env: TrashEnv, nodeId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM trash WHERE id = ? AND kind = 'node'`).bind(nodeId).run();
}

/**
 * Put back a node's file rows, for the undo that does not come through here.
 *
 * There are two ways a deleted node comes back. The trash dialog calls
 * `restoreTrash`, which replays the whole archived payload. Client-side undo
 * instead re-POSTs the node it captured, and that path only ever knew about the
 * row itself.
 *
 * For every other artefact that was enough, because the payload lives in R2
 * under the node's own id and is simply re-read. A file node's metadata is in
 * D1 and cascaded away with the node, so undo would restore an empty folder
 * pointing at bytes that are still sitting safely in `r2_trash` — the precise
 * shape of the bug 0020 was written to fix, one table over.
 *
 * Only looks at node entries. A mindmap delete archives its nodes inside the
 * board's entry, and that is undone through the trash dialog rather than by
 * replaying individual nodes.
 */
export async function restoreFileRows(
  env: TrashEnv,
  userId: string,
  nodeId: string,
): Promise<number> {
  if (!(await mayRestoreNode(env, userId, nodeId))) return 0;
  const row = await env.DB.prepare(`SELECT payload FROM trash WHERE id = ? AND kind = 'node'`)
    .bind(nodeId)
    .first<{ payload: string }>();
  if (!row?.payload) return 0;

  let files: Row[] = [];
  try {
    files = (JSON.parse(row.payload) as { files?: Row[] }).files ?? [];
  } catch {
    return 0;
  }

  for (const f of files) await reinsert(env.DB, "files", f);
  return files.length;
}

// ---------------------------------------------------------------------------
// Purging
// ---------------------------------------------------------------------------

/**
 * Destroy an entry now, without waiting for the window.
 *
 * Only the trash row goes here. The R2 objects stay filed and are reaped on
 * their own schedule, which keeps object deletion in exactly one place —
 * `reapTrash`, with its check that no live node still references the key.
 */
export async function purgeTrash(env: TrashEnv, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM trash WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function emptyTrash(env: TrashEnv, userId: string): Promise<number> {
  const res = await env.DB.prepare(`DELETE FROM trash WHERE user_id = ?`).bind(userId).run();
  return res.meta?.changes ?? 0;
}

/** Drop entries past the retention window. Called from the cron. */
export async function sweepTrash(env: TrashEnv, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM trash WHERE id IN (
       SELECT id FROM trash WHERE deleted_at < ? ORDER BY deleted_at LIMIT ?
     )`,
  )
    .bind(now - RETENTION_MS, PURGE_PER_RUN)
    .run();
  return res.meta?.changes ?? 0;
}
