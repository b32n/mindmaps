/**
 * Deferred deletion for R2 objects.
 *
 * R2 has no foreign keys and nothing cascades into it, so every node delete has
 * to say explicitly what happens to the bytes behind it. Doing that eagerly is
 * what broke undo: deleting a sheet destroyed the payload, and the restore that
 * followed found an empty pointer and wrote a blank workbook over it. The node
 * came back looking fine and the spreadsheet was gone.
 *
 * So a delete files the object here and leaves it alone. Undo un-files it and
 * the bytes were never touched. The cron sweep reaps anything past the window
 * that no live node still references.
 *
 * This also closes the opposite leak on the image path, which never deleted
 * anything: image objects now go through the same door and are reaped on the
 * same schedule.
 */

export interface TrashEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
  IMAGES: R2Bucket;
}

/** Binding name, not bucket name — the reaper needs to know what to call. */
export type TrashBucket = "ARTEFACTS" | "IMAGES";

/**
 * How long a deleted object survives.
 *
 * Long enough that undo works tomorrow, not just this session: a board is a
 * thing people come back to, and "I deleted that yesterday" is the case that
 * actually matters. Short enough that a deleted spreadsheet is not billed
 * indefinitely.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How many objects one cron tick will reap. Bounded so a large backlog costs
 *  many cheap minutes rather than one run that exceeds its time budget. */
const REAP_PER_RUN = 100;

/**
 * File an object for deletion.
 *
 * `INSERT OR REPLACE` so re-deleting a restored node refreshes the clock rather
 * than failing on the primary key or keeping the older, nearly-expired row.
 */
export async function trashObject(
  env: TrashEnv,
  bucket: TrashBucket,
  key: string,
  nodeId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO r2_trash (bucket, key, node_id, deleted_at) VALUES (?,?,?,?)`,
  )
    .bind(bucket, key, nodeId, Date.now())
    .run();
}

/**
 * Take a node's objects back out of the trash.
 *
 * Called when a node is created under an id that was deleted — which is exactly
 * what undo does. Cheap enough to run on every create: one indexed delete
 * against a table that is empty most of the time.
 */
export async function untrashNode(env: TrashEnv, nodeId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM r2_trash WHERE node_id = ?`).bind(nodeId).run();
}

/** Is this object currently filed for deletion? */
export async function isTrashed(env: TrashEnv, bucket: TrashBucket, key: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS hit FROM r2_trash WHERE bucket = ? AND key = ?`)
    .bind(bucket, key)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * The R2 key behind an image node.
 *
 * Image nodes store a full URL rather than a key, because that is what goes in
 * an `<img src>`. The key is the last segment. Returns null for anything that
 * is not one of ours — a node pointing at an external image must not cause a
 * delete attempt against our bucket.
 */
export function imageKeyFrom(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const marker = "/api/images/";
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const key = url.slice(at + marker.length).split(/[?#]/)[0];
  return key || null;
}

/**
 * Delete expired objects whose node is really gone.
 *
 * The `NOT EXISTS` is the safety catch rather than a formality. A row is filed
 * on delete and removed on restore, but a restore that half-failed — row
 * written, un-trash lost to a dropped connection — would otherwise leave a live
 * node scheduled to have its payload deleted a week later. Checking the node at
 * reap time means the trash can only ever destroy something nothing points at.
 *
 * Returns the number of objects actually removed.
 */
export async function reapTrash(env: TrashEnv, now = Date.now()): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT t.bucket, t.key
       FROM r2_trash t
      WHERE t.deleted_at < ?
        AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = t.node_id)
      ORDER BY t.deleted_at
      LIMIT ?`,
  )
    .bind(now - RETENTION_MS, REAP_PER_RUN)
    .all<{ bucket: TrashBucket; key: string }>();

  // A row whose node is alive again is stale by definition: trash is filed only
  // after the row is deleted, and a create under the same id un-files it. The
  // only way to have both is an un-trash that was lost, so clear it here rather
  // than leave a live node shadowed by a delete order forever.
  await env.DB.prepare(
    `DELETE FROM r2_trash
      WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = r2_trash.node_id)`,
  ).run();

  const rows = due.results ?? [];
  let gone = 0;

  for (const row of rows) {
    const bucket = row.bucket === "IMAGES" ? env.IMAGES : env.ARTEFACTS;
    try {
      await bucket.delete(row.key);
    } catch (err) {
      // Leave the row so the next tick tries again. Dropping it here would turn
      // a transient R2 error into a permanent leak, which is the failure this
      // whole table exists to avoid.
      console.error("reap failed", row.bucket, row.key, err);
      continue;
    }
    await env.DB.prepare(`DELETE FROM r2_trash WHERE bucket = ? AND key = ?`)
      .bind(row.bucket, row.key)
      .run();
    gone++;
  }

  return gone;
}
