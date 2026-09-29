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

import { isArtefact, artefactKey } from "./artefacts";
import { filesOf, isFileKind, type FileEnv } from "./files";
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

  await env.DB.prepare(
    `INSERT OR REPLACE INTO trash (id,kind,user_id,label,node_type,context,summary,deleted_at,payload)
     VALUES (?,'node',?,?,?,?,?,?,?)`,
  )
    .bind(
      nodeId,
      userId,
      (node.title as string) || null,
      String(node.type ?? "node"),
      board?.name ?? null,
      null,
      Date.now(),
      JSON.stringify({ node, edges: edges.results ?? [], files: files.results ?? [] }),
    )
    .run();

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

  await env.DB.prepare(
    `INSERT OR REPLACE INTO trash (id,kind,user_id,label,node_type,context,summary,deleted_at,payload)
     VALUES (?,'board',?,?,NULL,?,?,?,?)`,
  )
    .bind(
      boardId,
      userId,
      (root.name as string) || null,
      boards.length > 1 ? `${boards.length - 1} sub-mindmap${boards.length === 2 ? "" : "s"}` : null,
      describe(rows),
      Date.now(),
      JSON.stringify({ boards, nodes: rows, edges, files }),
    )
    .run();

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
  const row = await env.DB.prepare(`SELECT * FROM trash WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
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

  for (const b of boards) await reinsert(env.DB, "boards", b);
  for (const n of nodes) {
    // Re-embed after restore. The chunk rows and their vectors were removed
    // when the node was, so without this the card comes back visible on the
    // board and invisible to recall.
    await reinsert(env.DB, "nodes", { ...n, index_dirty: Date.now() });
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
export async function restoreFileRows(env: TrashEnv, nodeId: string): Promise<number> {
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
