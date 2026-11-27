/**
 * The life of a shared workspace: renaming it, closing it, reopening it, and
 * moving a mindmap into or out of it.
 *
 * Personal homes are not organisations. They are never renamed, closed or left,
 * so every function here that takes a workspace checks `personal` before
 * anything else, and answers 400 to the owner and 404 to anyone else (who
 * should not learn that a stranger's home exists).
 *
 * Closing is a soft delete. The row stays, `status` becomes 'closed', and
 * `access.ts` stops every route to it, so closed means unreachable for the
 * owner as much as for the members. Only the owner can reopen it, and only
 * inside `CLOSE_RETENTION_MS`. Nothing here deletes anything, and there is no
 * purge: a closed workspace past its window simply stays closed.
 */

import { CLOSE_RETENTION_MS, boardRole, canAdmin, canWrite, isOwner, workspaceRole } from "./access";
import type { Denied } from "./members";
import { unpackVector, type SemanticEnv } from "./semantic";

export interface LifecycleEnv {
  DB: D1Database;
}

type Fail = { ok: false } & Denied | { ok: false; status: 410; error: string };
export type Outcome<T> = ({ ok: true } & T) | Fail;

const NOT_FOUND: Fail = { ok: false, status: 404, error: "not found" };

/** What the lifecycle rules need to know about a workspace, closed or not. */
async function facts(db: D1Database, id: string) {
  return db
    .prepare(`SELECT owner_id, personal, status, closed_at FROM workspaces WHERE id = ?`)
    .bind(id)
    .first<{ owner_id: string; personal: number; status: string; closed_at: number | null }>();
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export const NAME_MAX = 80;

/** A name is a label for people: one line of printable text, trimmed. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** Owner and admins rename a shared workspace. Names are labels, not keys: two may be alike. */
export async function renameWorkspace(
  env: LifecycleEnv,
  actorId: string,
  workspaceId: string,
  rawName: unknown,
): Promise<Outcome<{ id: string; name: string; updated_at: number }>> {
  const role = await workspaceRole(env.DB, actorId, workspaceId);
  if (!role) return NOT_FOUND;
  if (!canAdmin(role)) return { ok: false, status: 403, error: "Only an owner or admin can rename a workspace." };

  const ws = await facts(env.DB, workspaceId);
  if (!ws) return NOT_FOUND;
  if (ws.personal) return { ok: false, status: 400, error: "A personal workspace cannot be renamed." };

  const name = cleanName(rawName);
  if (!name) return { ok: false, status: 400, error: `A name is 1 to ${NAME_MAX} characters on one line.` };

  const at = Date.now();
  await env.DB.prepare(`UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'active'`)
    .bind(workspaceId, name, at)
    .run();
  return { ok: true, id: workspaceId, name, updated_at: at };
}

// ---------------------------------------------------------------------------
// Close and reopen
// ---------------------------------------------------------------------------

/** The owner closes a shared workspace. Soft: see the note at the top of this file. */
export async function closeWorkspace(
  env: LifecycleEnv,
  actorId: string,
  workspaceId: string,
): Promise<Outcome<{ closed_at: number; reopen_until: number }>> {
  const ws = await facts(env.DB, workspaceId);
  if (!ws) return NOT_FOUND;
  if (ws.personal) return ws.owner_id === actorId ? { ok: false, status: 400, error: "A personal workspace cannot be closed." } : NOT_FOUND;
  // Closed, it is invisible to everyone but its owner, who is told why.
  if (ws.status !== "active")
    return ws.owner_id === actorId ? { ok: false, status: 409, error: "This workspace is already closed." } : NOT_FOUND;

  const role = await workspaceRole(env.DB, actorId, workspaceId);
  if (!role) return NOT_FOUND;
  if (!isOwner(role)) return { ok: false, status: 403, error: "Only the owner can close a workspace." };

  const at = Date.now();
  const res = await env.DB.prepare(
    `UPDATE workspaces SET status = 'closed', closed_at = ?2, closed_by = ?3, updated_at = ?2
      WHERE id = ?1 AND status = 'active' AND owner_id = ?3 AND personal = 0`,
  )
    .bind(workspaceId, at, actorId)
    .run();
  if ((res.meta?.changes ?? 0) < 1) return { ok: false, status: 409, error: "This workspace changed while you were doing that. Reload and try again." };
  return { ok: true, closed_at: at, reopen_until: at + CLOSE_RETENTION_MS };
}

/**
 * The owner reopens a closed workspace, inside the retention window. Anyone
 * else gets not-found: closed workspaces are not visible to members, so it is
 * not theirs to find out about.
 */
export async function reopenWorkspace(
  env: LifecycleEnv,
  actorId: string,
  workspaceId: string,
): Promise<Outcome<{}>> {
  const ws = await facts(env.DB, workspaceId);
  if (!ws || ws.owner_id !== actorId) return NOT_FOUND;
  if (ws.personal) return { ok: false, status: 400, error: "A personal workspace cannot be closed or reopened." };
  if (ws.status === "active") return { ok: false, status: 409, error: "This workspace is not closed." };

  const cutoff = Date.now() - CLOSE_RETENTION_MS;
  if (ws.closed_at === null || ws.closed_at < cutoff)
    return { ok: false, status: 410, error: "This workspace was closed more than 30 days ago and can no longer be reopened." };

  const res = await env.DB.prepare(
    `UPDATE workspaces SET status = 'active', closed_at = NULL, closed_by = NULL, updated_at = ?2
      WHERE id = ?1 AND status = 'closed' AND owner_id = ?3 AND closed_at >= ?4`,
  )
    .bind(workspaceId, Date.now(), actorId, cutoff)
    .run();
  if ((res.meta?.changes ?? 0) < 1) return { ok: false, status: 409, error: "This workspace changed while you were doing that. Reload and try again." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Move a mindmap
// ---------------------------------------------------------------------------

/** A board and every sub-mindmap beneath it, as a CTE named `tree`. */
const TREE = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM boards WHERE id = ?1
  UNION ALL
  SELECT b.id FROM boards b JOIN tree t ON b.parent_id = t.id
)`;

/**
 * Move a top-level mindmap, with its sub-mindmaps, to another workspace.
 *
 * Who: someone who can write to the mindmap *through its workspace* and to the
 * target. A direct share does not count, however strong: a mindmap handed to
 * you lives in someone else's workspace, and moving it into yours would take it
 * from its owner. A viewer cannot move, in or out.
 *
 * What moves is the ownership of the board, nothing else, so everything that
 * points at the board's id stays true: cards, edges, artefacts and their R2
 * objects, files (keyed by node), direct shares and grants, public links, and
 * trash. The two places that copy the workspace id are updated in the same
 * batch: `boards.workspace_id` and `versions.workspace_id` (history is filed by
 * workspace, and account export and deletion find it that way). Vectors are
 * namespaced by workspace and are moved after the response, see
 * `moveBoardVectors`.
 *
 * The answers for "that workspace is not yours" and "no such workspace" are the
 * same, so ids cannot be enumerated.
 */
export async function moveBoard(
  env: LifecycleEnv,
  actorId: string,
  boardId: string,
  targetId: unknown,
): Promise<Outcome<{ id: string; workspace_id: string }>> {
  if (typeof targetId !== "string" || !targetId.trim())
    return { ok: false, status: 400, error: "Say which workspace to move it to." };
  const target = targetId.trim();

  if (!(await boardRole(env.DB, actorId, boardId))) return NOT_FOUND;
  const board = await env.DB.prepare(`SELECT workspace_id, parent_id FROM boards WHERE id = ?`)
    .bind(boardId)
    .first<{ workspace_id: string | null; parent_id: string | null }>();
  if (!board?.workspace_id) return NOT_FOUND;

  if (!canWrite(await workspaceRole(env.DB, actorId, board.workspace_id)))
    return { ok: false, status: 403, error: "You cannot move this mindmap out of its workspace." };
  if (board.parent_id) return { ok: false, status: 400, error: "Move the top-level mindmap; its sub-mindmaps move with it." };
  if (target === board.workspace_id) return { ok: false, status: 400, error: "It is already in that workspace." };

  const there = await workspaceRole(env.DB, actorId, target);
  if (!there) return NOT_FOUND;
  if (!canWrite(there)) return { ok: false, status: 403, error: "You cannot add mindmaps to that workspace." };

  const at = Date.now();
  await env.DB.batch([
    env.DB.prepare(`${TREE} UPDATE boards SET workspace_id = ?2, updated_at = ?3 WHERE id IN (SELECT id FROM tree)`).bind(boardId, target, at),
    env.DB.prepare(`${TREE} UPDATE versions SET workspace_id = ?2 WHERE board_id IN (SELECT id FROM tree)`).bind(boardId, target),
  ]);
  return { ok: true, id: boardId, workspace_id: target };
}

/**
 * Re-file a moved mindmap's vectors under its new workspace.
 *
 * Vectorize namespaces are workspaces, so after a move recall in the old
 * workspace would keep returning the cards and recall in the new one would
 * miss them. Chunk ids are `<node>#<ord>` and unique across the index, so
 * upserting the same id with the new namespace replaces the old vector in
 * place; there is nothing to delete. The embeddings are read back from
 * `node_chunks`, which keeps the originals for exactly this (see 0017), so no
 * inference runs.
 *
 * Best effort and run after the response: the move itself is already true in D1
 * and the keyword and exact-cosine arms of recall read D1, so they follow
 * immediately. If this fails, the semantic arm is stale for these cards until
 * they are next edited (which re-indexes them under the board's namespace) or
 * `reindex` is run.
 */
export async function moveBoardVectors(env: LifecycleEnv & SemanticEnv, boardId: string, namespace: string): Promise<void> {
  if (!env.VECTORS) return;
  try {
    let after = "";
    for (;;) {
      const { results } = await env.DB.prepare(
        `${TREE}
         SELECT c.id, c.node_id, c.embedding, n.board_id
           FROM node_chunks c JOIN nodes n ON n.id = c.node_id
          WHERE n.board_id IN (SELECT id FROM tree) AND c.embedding IS NOT NULL AND c.id > ?2
          ORDER BY c.id LIMIT 200`,
      )
        .bind(boardId, after)
        .all<{ id: string; node_id: string; embedding: unknown; board_id: string }>();
      const rows = results ?? [];
      if (!rows.length) return;
      const vectors = rows.flatMap((r) => {
        const values = unpackVector(r.embedding);
        return values
          ? [{ id: r.id, values: Array.from(values), namespace, metadata: { workspace: namespace, board: r.board_id, card: r.node_id } }]
          : [];
      });
      if (vectors.length) await env.VECTORS.upsert(vectors);
      after = rows[rows.length - 1]!.id;
    }
  } catch (err) {
    console.error("vector move failed", boardId, err);
  }
}
