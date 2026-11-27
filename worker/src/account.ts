/**
 * Taking your data out, and taking yourself out.
 *
 * ## Export
 *
 * One zip of JSON plus the original bytes. "Yours" means what lives in a
 * workspace you own: its mindmaps, cards, links, artefacts with their payloads,
 * uploaded files, images, and the metadata of every version recorded for them.
 * Things other people have handed you appear only as a reference (what kind,
 * which id, what role) and carry none of what they hold, and things you have
 * handed to others are counted, never named: another person's email is their
 * data, not yours. Link-share tokens are left out for the same reason a password
 * would be, they are the access.
 *
 * Streamed. The JSON is assembled in memory (rows only, a few KB per card) but
 * every file, image and payload is piped from R2 into the response, so the size
 * of someone's uploads does not decide whether their export fits in the Worker.
 *
 * ## Deletion
 *
 * Two halves, in this order, so that stopping between them never leaves anything
 * reachable:
 *
 *   1. `closeAccount`, one atomic batch: the user row is marked `deleted` and
 *      scrubbed (email replaced by an address that cannot receive mail, so the
 *      real one can sign up again), every session and OAuth token is revoked,
 *      every grant, share and invite that gives anyone access to what they own
 *      is cut, and their memberships elsewhere go. After this nobody can sign in
 *      as them or reach their content, whatever happens next.
 *   2. `purgeOwnedContent`, idempotent: the content itself is deleted, the R2
 *      objects behind it are filed in `r2_trash` as already due (the cron reaps
 *      them on its next tick; there is no undo to wait out), version history is
 *      redacted, the vectors are removed. If it is interrupted, the cron runs it
 *      again (`finishDeletions`).
 *
 * The `users` row itself stays, marked. Other people's rows refer to it (a card
 * it wrote in someone else's workspace, a membership it invited), and those are
 * theirs to keep.
 *
 * A workspace with other people in it blocks deletion: the owner has to remove
 * them first. There is no transfer feature, so "transfer" in the message is the
 * rule for when there is one, and removing members is what can be done today.
 */

import { MEMBER_ROLE } from "./access";
import { verifyPassword } from "./auth";
import { artefactKey, isArtefact } from "./artefacts";
import { filesOf, type FileEnv } from "./files";
import { RETENTION_MS, imageKeyFrom, trashObject, type TrashEnv } from "./r2trash";
import { removeCards, type SemanticEnv } from "./semantic";
import { trashObjectsFor } from "./trash";
import { redactVersions } from "./versions";
import { ZipWriter } from "./zip";

export interface AccountEnv extends TrashEnv, SemanticEnv, FileEnv {}

interface Who {
  id: string;
  email: string;
  name: string;
}

const now = () => Date.now();

/** The address a deleted account is left with. Reserved TLD: it can never receive mail or collide. */
export const scrubbedEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Workspaces this user owns, as a subquery over `?1`. */
const OWNED_WS = `(SELECT id FROM workspaces WHERE owner_id = ?1)`;
/** Boards in them. */
const OWNED_BOARDS = `(SELECT id FROM boards WHERE workspace_id IN ${OWNED_WS})`;
/** Nodes on those boards. */
const OWNED_NODES = `(SELECT id FROM nodes WHERE board_id IN ${OWNED_BOARDS})`;

export const exportFilename = (at = new Date()) =>
  `mindmaps-export-${at.toISOString().slice(0, 10)}.zip`;

/**
 * A file name that is safe as one path segment of the archive: no separators,
 * no control characters, no traversal, bounded. The original name is kept in
 * the metadata; this only decides where the bytes sit.
 */
export function safeSegment(name: string, fallback = "file"): string {
  const cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const IMAGE_IN_TEXT = /\/api\/images\/([A-Za-z0-9._-]+)/g;

/**
 * The export, as a stream. `done` settles when the archive is complete (or has
 * failed); hand it to `ctx.waitUntil` so the Worker keeps going while the
 * response is being read.
 */
export function exportAccount(env: AccountEnv, who: Who): { body: ReadableStream<Uint8Array>; done: Promise<void> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const done = build(env, who, new ZipWriter(writer)).catch(async (err) => {
    console.error("account export failed", err);
    // Error the stream, so the browser sees a failed download, not a short zip
    // that looks complete.
    await writer.abort(err).catch(() => {});
  });
  return { body: readable, done };
}

async function build(env: AccountEnv, who: Who, zip: ZipWriter): Promise<void> {
  const db = env.DB;
  const me = who.id;
  const all = async (sql: string): Promise<Row[]> => ((await db.prepare(sql).bind(me).all<Row>()).results ?? []);

  const workspaces = await all(
    `SELECT w.id, w.name, w.personal, w.created_at,
            (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members
       FROM workspaces w WHERE w.owner_id = ?1 ORDER BY w.personal DESC, w.created_at`,
  );

  const boards = (
    await all(
      `SELECT id, name, status, parent_id, node_id, workspace_id, description, labels, pinned, position,
              home_view, created_at, updated_at
         FROM boards WHERE workspace_id IN ${OWNED_WS} ORDER BY created_at`,
    )
  ).map((b) => ({ ...b, labels: parseJson(b.labels) ?? [], pinned: !!b.pinned }));

  const nodes = await all(
    `SELECT n.id, n.board_id, n.type, n.title, n.body, n.doc, n.x, n.y, n.w, n.h, n.data, n.created_at, n.updated_at
       FROM nodes n WHERE n.board_id IN ${OWNED_BOARDS} ORDER BY n.created_at`,
  );
  const cards = nodes.map((n) => ({ ...n, doc: parseJson(n.doc), data: parseJson(n.data) ?? {} }));

  // A link belongs to no board, so it is yours when both ends are. A link from
  // your card to someone else's is half theirs and is left out.
  const links = await all(
    `SELECT e.id, e.source_id, e.target_id, e.label, e.source_handle, e.target_handle, e.created_at
       FROM edges e
      WHERE e.source_id IN ${OWNED_NODES} AND e.target_id IN ${OWNED_NODES}
      ORDER BY e.created_at`,
  );

  const fileRows = await all(
    `SELECT f.id, f.node_id, f.name, f.size, f.content_type, f.description, f.uploaded_at, f.uploaded_by, f.r2_key
       FROM files f WHERE f.node_id IN ${OWNED_NODES} ORDER BY f.node_id, f.position, f.uploaded_at`,
  );

  const versions = (
    await all(
      `SELECT id, node_id, board_id, workspace_id, seq, node_type, op, title, payload_key IS NOT NULL AS has_payload,
              payload_bytes, content_hash, restored_from, pinned, label, actor_user_id, actor_client_name,
              actor_via, status, created_at, sealed_at, status_changed_at
         FROM versions WHERE workspace_id IN ${OWNED_WS} ORDER BY node_id, seq`,
    )
  ).map(({ actor_user_id, has_payload, pinned, ...v }) => ({
    ...v,
    has_payload: !!has_payload,
    pinned: !!pinned,
    // Who, without naming anyone else: you, someone else, or the system.
    actor: actor_user_id === me ? "you" : actor_user_id ? "other" : "system",
  }));

  // --- by reference only: what other people handed to this user -------------

  const ref = (kind: string) => (r: Row) => ({ kind, id: r.id, role: r.role });
  const sharedWithMe = [
    ...(await all(`SELECT workspace_id AS id, ${MEMBER_ROLE("workspace_members")} AS role FROM workspace_members WHERE user_id = ?1`)).map(ref("workspace")),
    ...(await all(`SELECT board_id AS id, role FROM board_shares WHERE user_id = ?1`)).map(ref("mindmap")),
    ...(await all(`SELECT node_id AS id, role FROM artefact_grants WHERE user_id = ?1`)).map(ref("artefact")),
  ];

  // --- what this user handed out: counted, nobody named ----------------------

  const sharing = [
    ...(
      await all(
        `SELECT board_id AS id, role, COUNT(*) AS people FROM board_shares
          WHERE board_id IN ${OWNED_BOARDS} GROUP BY board_id, role`,
      )
    ).map((r) => ({ kind: "mindmap", ...r })),
    ...(
      await all(
        `SELECT node_id AS id, role, COUNT(*) AS people FROM artefact_grants
          WHERE node_id IN ${OWNED_NODES} GROUP BY node_id, role`,
      )
    ).map((r) => ({ kind: "artefact", ...r })),
    ...(
      await all(
        `SELECT target_id AS id, COUNT(*) AS links FROM shares
          WHERE grant_type = 'link' AND target_type = 'node' AND revoked = 0
            AND target_id IN ${OWNED_NODES} GROUP BY target_id`,
      )
    ).map((r) => ({ kind: "artefact", ...r })),
  ];

  // --- the bytes ---------------------------------------------------------------

  const missing: string[] = [];

  const artefacts: Array<Record<string, unknown>> = [];
  for (const n of nodes) {
    if (!isArtefact(String(n.type))) continue;
    const id = String(n.id);
    const obj = await env.ARTEFACTS.get(artefactKey(id));
    const path = obj ? `artefacts/${safeSegment(id)}.json` : null;
    artefacts.push({ node_id: id, board_id: n.board_id, type: n.type, title: n.title, path });
    if (obj) await zip.add(path!, obj.body);
    else missing.push(`artefacts/${id}`);
  }

  const files = [];
  for (const f of fileRows) {
    const path = `files/${safeSegment(String(f.node_id))}/${safeSegment(String(f.id))}-${safeSegment(String(f.name))}`;
    const obj = await env.ARTEFACTS.get(String(f.r2_key));
    files.push({
      id: f.id, node_id: f.node_id, name: f.name, size: f.size, content_type: f.content_type,
      description: f.description, uploaded_at: f.uploaded_at,
      uploaded_by: f.uploaded_by === me ? "you" : f.uploaded_by ? "other" : null,
      path: obj ? path : null,
    });
    if (obj) await zip.add(path, obj.body);
    else missing.push(`files/${f.id}`);
  }

  // Images: the ones that are nodes on your mindmaps, and the ones embedded in
  // your cards' documents. Either way an image is a key in IMAGES.
  const imageKeys = new Set<string>();
  for (const n of nodes) {
    if (n.type === "image") {
      const key = imageKeyFrom((parseJson(n.data) as { url?: unknown } | null)?.url);
      if (key) imageKeys.add(key);
    }
    for (const text of [n.doc, n.body]) {
      if (typeof text !== "string") continue;
      for (const m of text.matchAll(IMAGE_IN_TEXT)) imageKeys.add(m[1]!);
    }
  }
  const images: Array<{ key: string; path: string | null }> = [];
  for (const key of imageKeys) {
    const obj = await env.IMAGES.get(key);
    const path = obj ? `images/${safeSegment(key)}` : null;
    images.push({ key, path });
    if (obj) await zip.add(path!, obj.body);
    else missing.push(`images/${key}`);
  }

  // --- the JSON, last, because the manifest reports what was and wasn't found ---

  const json = (name: string, value: unknown) => zip.addText(name, JSON.stringify(value, null, 2));
  await json("workspaces.json", workspaces.map((w) => ({ ...w, personal: w.personal ? 1 : 0 })));
  await json("mindmaps.json", boards);
  await json("cards.json", cards);
  await json("links.json", links);
  await json("artefacts.json", artefacts);
  await json("files.json", files);
  await json("images.json", images);
  await json("versions.json", versions);
  await json("shared-with-me.json", sharedWithMe);
  await json("sharing.json", sharing);
  await json("manifest.json", {
    format: "mindmaps-export",
    version: 1,
    exported_at: new Date().toISOString(),
    account: { id: me, email: who.email, name: who.name },
    counts: {
      workspaces: workspaces.length, mindmaps: boards.length, cards: cards.length, links: links.length,
      artefacts: artefacts.length, files: files.length, images: images.length, versions: versions.length,
    },
    missing,
    notes: [
      "Only what you own is here: the mindmaps in workspaces you own, and everything on them.",
      "shared-with-me.json lists what other people gave you by id and role only; none of their content is included.",
      "sharing.json counts the people and links you have shared with; it does not name them.",
      "versions.json is the history's metadata (who, when, how), not the content of each version.",
    ],
  });
  await zip.finish();
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Workspaces this account owns that other active people are still in. Deleting
 * the account would delete them, content and all, so it is refused until each
 * is transferred to another member, emptied, or closed. A closed workspace is
 * not in the way: its people have already lost access, and the owner chose that
 * knowing deleting the account deletes it for good (the 30 days to reopen it
 * end with the account).
 *
 * Nothing here relies on `workspaces.owner_id ... ON DELETE CASCADE`: the
 * `users` row is never deleted (only marked), and the workspace rows go by name
 * in `purgeOwnedContent`, after this check has passed.
 */
export async function deletionBlockers(db: D1Database, userId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .prepare(
      `SELECT w.id, w.name FROM workspaces w
        WHERE w.owner_id = ?1 AND w.status = 'active'
          AND EXISTS (SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
                       WHERE m.workspace_id = w.id AND m.user_id <> ?1 AND u.status = 'active')
        ORDER BY w.created_at`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();
  return rows.results ?? [];
}

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string; workspaces?: Array<{ id: string; name: string }> };

/**
 * Check the confirmation, refuse if the user still owns a workspace with other
 * people in it, then close the account and delete what it owned.
 *
 * The confirmation is the account's own email typed out, or its password. The
 * session cookie proves who is asking; this proves they meant it.
 */
export async function deleteAccount(
  env: AccountEnv,
  userId: string,
  input: { email?: unknown; password?: unknown },
): Promise<DeleteOutcome> {
  const row = await env.DB.prepare(
    `SELECT id, email, password_hash, password_salt FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first<{ id: string; email: string; password_hash: string | null; password_salt: string | null }>();
  if (!row) return { ok: false, status: 404, error: "not found" };

  const typed = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const emailOk = typed !== "" && typed === row.email.toLowerCase();
  const passwordOk =
    !emailOk &&
    typeof input.password === "string" &&
    input.password !== "" &&
    !!row.password_hash &&
    !!row.password_salt &&
    (await verifyPassword(input.password, row.password_hash, row.password_salt));
  if (!emailOk && !passwordOk)
    return { ok: false, status: 400, error: "That does not match. Confirm by typing your account's email address." };

  const workspaces = await deletionBlockers(env.DB, userId);
  if (workspaces.length) {
    const names = workspaces.map((w) => `“${w.name}”`).join(", ");
    const many = workspaces.length > 1;
    return {
      ok: false,
      status: 409,
      error:
        `You own ${names}, and other people are in ${many ? "them" : "it"}. ` +
        `Transfer ownership of ${many ? "them" : "it"} to another member (the workspace's People dialog), ` +
        `or remove ${many ? "their" : "its"} members, then delete your account.`,
      workspaces,
    };
  }

  await closeAccount(env.DB, userId);
  await purgeOwnedContent(env, userId);
  return { ok: true };
}

/**
 * Half one: make the account, and everything it owned, unreachable. One batch,
 * so it happens entirely or not at all.
 */
export async function closeAccount(db: D1Database, userId: string): Promise<void> {
  // The same refusal as `deleteAccount`, repeated where the destruction is, so
  // no caller can reach it without passing the guard.
  if ((await deletionBlockers(db, userId)).length) throw new Error("account still owns a shared workspace");
  const at = now();
  const one = (sql: string, ...args: Array<string | number>) => db.prepare(sql).bind(...args);
  await db.batch([
    one(
      `UPDATE users
          SET status = 'deleted', deleted_at = ?1, email = ?2, name = '', avatar_url = NULL,
              password_hash = NULL, password_salt = NULL, google_sub = NULL, updated_at = ?1
        WHERE id = ?3 AND status = 'active'`,
      at, scrubbedEmail(userId), userId,
    ),
    one(`DELETE FROM auth_sessions WHERE user_id = ?`, userId),
    // Revoked rather than deleted, like every revoke here: the row says the
    // token existed and was ended. Codes were never usable twice and are not
    // worth keeping.
    one(`UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ?`, userId),
    one(`DELETE FROM oauth_codes WHERE user_id = ?`, userId),
    // Every way in that a link or a grant gives: links on their artefacts and
    // mindmaps, grants of either to anyone, and whatever was shared *to* them.
    one(
      `UPDATE shares SET revoked = 1
        WHERE owner_id = ?1 OR grantee_id = ?1
           OR (target_type = 'node'  AND target_id IN ${OWNED_NODES})
           OR (target_type = 'board' AND target_id IN ${OWNED_BOARDS})`,
      userId,
    ),
    one(`DELETE FROM board_shares WHERE user_id = ?1 OR board_id IN ${OWNED_BOARDS}`, userId),
    one(`DELETE FROM artefact_grants WHERE user_id = ?1 OR node_id IN ${OWNED_NODES}`, userId),
    one(`DELETE FROM workspace_members WHERE user_id = ?1 OR workspace_id IN ${OWNED_WS}`, userId),
    // Offers they made that nobody took up. Accepted ones are the other
    // person's access now, and were handled above if it was to their content.
    one(`UPDATE invites SET revoked = 1 WHERE invited_by = ?1 AND accepted_at IS NULL AND revoked = 0`, userId),
    one(`DELETE FROM recall_queries WHERE user_id = ?`, userId),
  ]);
}

/**
 * Half two: delete what the account owned. Safe to run again.
 *
 * Each owned workspace goes in turn: its objects are filed for the reaper,
 * its history is redacted, its vectors removed, and then its mindmaps (which
 * cascade to their cards, links and file rows) and the workspace row itself.
 */
export async function purgeOwnedContent(env: AccountEnv, userId: string): Promise<void> {
  const due = now() - RETENTION_MS - 1;
  const owned = await env.DB.prepare(`SELECT id FROM workspaces WHERE owner_id = ?`)
    .bind(userId)
    .all<{ id: string }>();

  // The trash first: what they deleted from their own workspaces is theirs to
  // erase too, and nothing can restore it once the workspace is gone. Entries
  // from other people's workspaces are not theirs and stay.
  const inOwned = (t: string) => `(
      (${t}.kind = 'board' AND json_extract(${t}.payload, '$.boards[0].workspace_id') IN ${OWNED_WS})
   OR (${t}.kind = 'node'  AND json_extract(${t}.payload, '$.node.board_id') IN ${OWNED_BOARDS}))`;
  await env.DB.batch([
    // Their objects are already filed, with the retention clock running. Start
    // it past the end, as for everything else here.
    env.DB.prepare(
      `UPDATE r2_trash SET deleted_at = ?2
        WHERE node_id IN (
          SELECT t.id FROM trash t WHERE t.user_id = ?1 AND ${inOwned("t")} AND t.kind = 'node'
          UNION
          SELECT json_extract(j.value, '$.id') FROM trash t, json_each(t.payload, '$.nodes') j
           WHERE t.user_id = ?1 AND ${inOwned("t")} AND t.kind = 'board'
        )`,
    ).bind(userId, due),
    env.DB.prepare(`DELETE FROM trash WHERE user_id = ?1 AND ${inOwned("trash")}`).bind(userId),
  ]);

  for (const { id: ws } of owned.results ?? []) {
    const nodes = (
      await env.DB.prepare(
        `SELECT n.id, n.type, n.data, n.doc, n.body FROM nodes n
          WHERE n.board_id IN (SELECT id FROM boards WHERE workspace_id = ?)`,
      )
        .bind(ws)
        .all<Row>()
    ).results ?? [];

    // Read while the rows exist: the file rows go with their node.
    await trashObjectsFor(env, nodes, due);
    for (const n of nodes) {
      if (n.type === "image") continue;
      // images embedded in a card's document are R2 objects with no node of their own
      for (const text of [n.doc, n.body]) {
        if (typeof text !== "string") continue;
        for (const m of text.matchAll(IMAGE_IN_TEXT)) await trashObject(env, "IMAGES", m[1]!, String(n.id), due);
      }
    }
    for (const v of await redactVersions(env, [ws])) await trashObject(env, "ARTEFACTS", v.key, v.nodeId, due);

    const ids = nodes.map((n) => String(n.id));
    for (let i = 0; i < ids.length; i += 10) await removeCards(env, ids.slice(i, i + 10));

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM boards WHERE workspace_id = ?`).bind(ws),
      env.DB.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(ws),
    ]);
  }
}

/**
 * Cron: finish any deletion that was interrupted between the halves. Bounded
 * per tick, and a no-op (one indexed read) when there is nothing to do.
 */
export async function finishDeletions(env: AccountEnv, limit = 5): Promise<number> {
  const stuck = await env.DB.prepare(
    `SELECT u.id FROM users u
      WHERE u.status <> 'active'
        AND EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
      ORDER BY u.deleted_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const { id } of stuck.results ?? []) await purgeOwnedContent(env, id);
  return (stuck.results ?? []).length;
}
