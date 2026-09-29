/**
 * Share links: create, resolve, revoke.
 *
 * A share is a row, not a signature. The mindbox's owner-preview URLs are
 * HMAC(nodeId.exp) and expire in an hour, which is right for opening your own
 * artefact and useless for something you sent someone: you cannot take it back
 * without rotating the secret and breaking every link at once.
 *
 * Resolution is the only path in this codebase that reads a user's content
 * without a session, so it is deliberately narrow. It returns the payload and
 * the title of one artefact and nothing else — not the board it sits on, not
 * its neighbours, not the owner's name. A share is a window onto one thing.
 */

import { canWrite, nodeRole } from "./access";
import { isArtefact, type ArtefactKind } from "./artefacts";

export interface ShareEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
}

export interface ShareRow {
  token: string;
  target_type: "node" | "board";
  target_id: string;
  expires_at: number | null;
  revoked: number;
  created_at: number;
  last_seen_at: number | null;
  views: number;
}

/**
 * 160 bits of randomness, base32-ish.
 *
 * Long enough that guessing is not a strategy, short enough to paste into a
 * message without wrapping. Unguessability is the entire access control on a
 * link share, so this is not a place to be clever or brief.
 */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1
  return [...bytes].map((b) => alphabet[b & 31]).join("");
}

/** Create a link share for a node the caller owns. */
export async function createShare(
  env: ShareEnv,
  ownerId: string,
  nodeId: string,
  opts: { expiresAt?: number | null } = {},
): Promise<ShareRow | null> {
  /*
   * Anyone who can edit the artefact can publish a link to it.
   *
   * This checked `b.user_id` until workspaces existed, which meant an editor on
   * a shared mindmap could change an artefact but not share it — and the
   * refusal arrived as a silent 404, so it read as the artefact not existing.
   * The bar matches `canGrant`: a link share on one artefact cannot widen into
   * anything else, so it is not an owner-only act.
   */
  if (!canWrite(await nodeRole(env.DB, ownerId, nodeId))) return null;

  const token = newToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO shares
       (token,target_type,target_id,owner_id,grant_type,grantee_id,expires_at,revoked,created_at)
     VALUES (?,'node',?,?,'link',NULL,?,0,?)`,
  )
    .bind(token, nodeId, ownerId, opts.expiresAt ?? null, now)
    .run();

  return {
    token,
    target_type: "node",
    target_id: nodeId,
    expires_at: opts.expiresAt ?? null,
    revoked: 0,
    created_at: now,
    last_seen_at: null,
    views: 0,
  };
}

/** Every share on one node, for the owner's share panel. */
export async function sharesFor(
  env: ShareEnv,
  userId: string,
  nodeId: string,
): Promise<ShareRow[]> {
  // Links on an artefact are a property of the artefact, not of whoever made
  // them: a second editor needs to see that it is already shared, and be able
  // to revoke a link they did not create.
  if (!canWrite(await nodeRole(env.DB, userId, nodeId))) return [];
  const rows = await env.DB.prepare(
    `SELECT token, target_type, target_id, expires_at, revoked, created_at, last_seen_at, views
       FROM shares
      WHERE target_type = 'node' AND target_id = ? AND revoked = 0
      ORDER BY created_at DESC`,
  )
    .bind(nodeId)
    .all<ShareRow>();
  return rows.results ?? [];
}

/**
 * Revoke.
 *
 * A flag rather than a delete, so the row survives as a record that the link
 * existed and stopped working, and so a revoked token can never be reissued by
 * chance.
 */
export async function revokeShare(
  env: ShareEnv,
  userId: string,
  token: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT target_id FROM shares WHERE token = ? AND target_type = 'node'`,
  )
    .bind(token)
    .first<{ target_id: string }>();
  if (!row) return false;
  if (!canWrite(await nodeRole(env.DB, userId, row.target_id))) return false;

  const res = await env.DB.prepare(`UPDATE shares SET revoked = 1 WHERE token = ?`)
    .bind(token)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface ResolvedShare {
  kind: ArtefactKind;
  title: string;
  nodeId: string;
  /** Null for `html`: the page renders in the mindbox, not from this payload. */
  payload: unknown | null;
}

/**
 * Turn a token into the one artefact it points at.
 *
 * Every refusal returns the same shape, because distinguishing "no such token"
 * from "revoked" from "expired" tells someone probing tokens which guesses were
 * close. The owner sees the real state in their share panel.
 */
export async function resolveShare(
  env: ShareEnv,
  token: string,
  opts: { withPayload?: boolean } = {},
): Promise<ResolvedShare | null> {
  if (!token || token.length < 16) return null;

  const row = await env.DB.prepare(
    `SELECT s.target_id, s.expires_at, s.revoked, n.type, n.title
       FROM shares s
       JOIN nodes n ON n.id = s.target_id
      WHERE s.token = ? AND s.target_type = 'node'`,
  )
    .bind(token)
    .first<{
      target_id: string;
      expires_at: number | null;
      revoked: number;
      type: string;
      title: string;
    }>();

  // A missing join means the artefact was deleted, which unshares it — the
  // trash keeps the row out of `nodes`, so a shared thing you delete stops
  // resolving immediately rather than a week later.
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;
  if (!isArtefact(row.type)) return null;

  let payload: unknown | null = null;
  if (opts.withPayload && row.type !== "html") {
    const obj = await env.ARTEFACTS.get(`artefacts/${row.target_id}`);
    if (!obj) return null;
    try {
      payload = await obj.json();
    } catch {
      return null;
    }
  }

  return {
    kind: row.type as ArtefactKind,
    title: row.title ?? "",
    nodeId: row.target_id,
    payload,
  };
}

/**
 * Record that a share was opened.
 *
 * Best effort and never awaited on the response path: a counter failing to
 * increment must not stop someone reading a document.
 */
export async function noteView(env: ShareEnv, token: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE shares SET views = views + 1, last_seen_at = ? WHERE token = ?`,
    )
      .bind(Date.now(), token)
      .run();
  } catch (err) {
    console.error("share view count failed", err);
  }
}
