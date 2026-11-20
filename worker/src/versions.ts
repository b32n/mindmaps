/**
 * Version history: the one place a node's content is written.
 *
 * Every write to a card, a note, an artefact or a file/folder node goes through
 * this module, so no path can forget to record what it did. The routes and MCP
 * tools say *what* to write and *who* is writing; the SQL for it lives here, and
 * `e2e/tests/history/write-sites.spec.ts` fails if it appears anywhere else.
 *
 * What gets recorded (design: the audit's section 3.2):
 *
 *   - One `versions` row per recorded state, with the writer's user, client and
 *     door (web, mcp, system). `version_heads` points at the newest.
 *   - An *open* version is updated in place while the same person keeps saving
 *     from the app inside OPEN_WINDOW_MS, so debounced autosave is a handful of
 *     versions an hour rather than hundreds.
 *   - A different writer, a write from an agent, or a lapsed window *seals* the
 *     head first. An agent's write is always its own sealed version: it is never
 *     folded into a person's, and a person's is never folded into it.
 *   - A write that changes nothing (same content hash) records nothing.
 *   - A node that has no versions yet, or whose row was changed by something
 *     that did not record, is imported on first touch: its current state becomes
 *     a sealed version *before* the write that would replace it.
 *   - An artefact's open version needs no R2 write: the head object is the
 *     state. Sealing copies it to `versions/<nodeId>/<hash>` before it is
 *     replaced.
 *
 * Not here, on purpose: reading, restoring, conflict checks, retention.
 *
 * Rows are not deleted, with one exception in kind: `redactVersions` empties the
 * content of every version in a workspace whose owner deleted their account.
 */
import {
  artefactKey, describeArtefact, isArtefact, putArtefact, type ArtefactKind, type StoredArtefact,
} from "./artefacts";
import type { TokenGrant } from "./oauth";

export interface HistoryEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
}

/** How long one person's autosaves may keep updating the same open version. */
export const OPEN_WINDOW_MS = 10 * 60 * 1000;

export type Via = "web" | "mcp" | "system";

export interface Actor {
  userId: string | null;
  via: Via;
  clientId?: string | null;
  clientName?: string | null;
}

/** Work done by the Worker itself: imports, and the starter mindmap. */
export const SYSTEM: Actor = { userId: null, via: "system" };

/** Someone using the app, or its API with their session. */
export const webActor = (userId: string): Actor => ({ userId, via: "web" });

/** An agent connected over MCP, named by the client it registered as. */
export async function mcpActor(env: HistoryEnv, grant: Pick<TokenGrant, "userId" | "clientId">): Promise<Actor> {
  const client = await env.DB.prepare(`SELECT client_name FROM oauth_clients WHERE client_id = ?`)
    .bind(grant.clientId)
    .first<{ client_name: string }>();
  return { userId: grant.userId, via: "mcp", clientId: grant.clientId, clientName: client?.client_name || null };
}

/**
 * The node types whose content is history-worthy. Images and ink are placed and
 * moved, not edited, and a version for every stroke would be noise.
 */
export const isVersioned = (type: string): boolean =>
  type === "card" || type === "note" || type === "file" || type === "folder" || isArtefact(type);

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * `data` without the keys that say where a card sits or when it was made, which
 * are not content: dragging a card must not look like an edit.
 */
function stableData(data: string | null | undefined): string {
  try {
    const parsed = JSON.parse(data || "{}");
    if (parsed && typeof parsed === "object") {
      delete parsed.placed;
      delete parsed.at;
    }
    return JSON.stringify(parsed);
  } catch {
    return data ?? "";
  }
}

/** What a version is: a node's content, and for an artefact its payload. */
interface State {
  type: string;
  title: string;
  body: string;
  doc: string | null;
  data: string;
  boardId: string;
  /** An artefact's payload text, or null for everything else. */
  payload: string | null;
}

async function contentHash(s: State): Promise<string> {
  return sha256(
    JSON.stringify([
      s.type, s.title, s.body, s.doc ?? null, stableData(s.data),
      s.payload === null ? null : await sha256(s.payload),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Reading what is there
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  board_id: string;
  type: string;
  title: string | null;
  body: string | null;
  doc: string | null;
  data: string | null;
  updated_at: number;
}

interface Head {
  version_id: string;
  seq: number;
  status: string;
  created_at: number;
  actor_user_id: string | null;
  actor_client_id: string | null;
  actor_via: string;
  payload_key: string | null;
  content_hash: string | null;
  node_updated_at: number | null;
}

const headOf = (env: HistoryEnv, nodeId: string) =>
  env.DB.prepare(
    `SELECT h.head_version_id AS version_id, h.head_seq AS seq, h.node_updated_at,
            v.status, v.created_at, v.actor_user_id, v.actor_client_id, v.actor_via,
            v.payload_key, v.content_hash
       FROM version_heads h JOIN versions v ON v.id = h.head_version_id
      WHERE h.node_id = ?`,
  )
    .bind(nodeId)
    .first<Head>();

const rowOf = (env: HistoryEnv, nodeId: string) =>
  env.DB.prepare(`SELECT id, board_id, type, title, body, doc, data, updated_at FROM nodes WHERE id = ?`)
    .bind(nodeId)
    .first<NodeRow>();

/** An artefact's stored payload as text, which is what is hashed and copied. */
async function payloadText(env: HistoryEnv, nodeId: string): Promise<string | null> {
  const obj = await env.ARTEFACTS.get(artefactKey(nodeId));
  return obj ? await obj.text() : null;
}

const stateOf = async (env: HistoryEnv, row: NodeRow, payload?: string | null): Promise<State> => ({
  type: row.type,
  title: row.title ?? "",
  body: row.body ?? "",
  doc: row.doc,
  data: row.data ?? "{}",
  boardId: row.board_id,
  payload: isArtefact(row.type) ? (payload !== undefined ? payload : await payloadText(env, row.id)) : null,
});

const versionKey = (nodeId: string, hash: string) => `versions/${nodeId}/${hash}`;

const sameActor = (head: Head, a: Actor) =>
  head.actor_via === a.via && head.actor_user_id === a.userId && head.actor_client_id === (a.clientId ?? null);

// ---------------------------------------------------------------------------
// Planning a version
// ---------------------------------------------------------------------------

type Op = "create" | "edit" | "import" | "undelete";

/**
 * Work out what recording `state` as the node's next version takes, and do the
 * parts that must happen *before* the node is written: sealing the previous
 * head (copying an artefact's bytes out from under the write that replaces
 * them) and storing a sealed version's payload.
 *
 * Returns the statements that go into the same batch as the node's own write.
 * Empty means nothing is to be recorded (the content did not change).
 */
async function plan(
  env: HistoryEnv,
  actor: Actor,
  nodeId: string,
  state: State,
  op: Op,
  nodeUpdatedAt: number,
  /** The head's bytes were overwritten by something that did not record: there is nothing of its own to copy. */
  headGone = false,
): Promise<D1PreparedStatement[]> {
  if (!isVersioned(state.type)) return [];
  const hash = await contentHash(state);
  const head = await headOf(env, nodeId);
  const t = now();

  if (head && head.content_hash === hash) {
    // Nothing changed. Only note the row's new updated_at, so a later write does
    // not mistake a move or a no-op save for a write nobody recorded.
    return [env.DB.prepare(`UPDATE version_heads SET node_updated_at = ? WHERE node_id = ?`).bind(nodeUpdatedAt, nodeId)];
  }

  const fold =
    !!head && head.status === "open" && actor.via === "web" && op === "edit" && sameActor(head, actor) &&
    t - head.created_at < OPEN_WINDOW_MS;

  if (head && head.status === "open" && !fold) {
    // About to be superseded by someone else's write (or a later window): seal
    // it, and for an artefact keep its bytes, which are the live object until
    // the write that follows replaces them.
    let key = head.payload_key;
    let bytes: number | null = null;
    if (isArtefact(state.type) && !key && head.content_hash && !headGone) {
      const live = await payloadText(env, nodeId);
      if (live !== null) {
        key = versionKey(nodeId, head.content_hash);
        bytes = byteLength(live);
        await env.ARTEFACTS.put(key, live, { httpMetadata: { contentType: "application/json" } });
      }
    }
    await env.DB.prepare(
      `UPDATE versions SET status = 'sealed', sealed_at = ?, status_changed_at = ?,
              payload_key = COALESCE(payload_key, ?), payload_bytes = COALESCE(payload_bytes, ?)
        WHERE id = ? AND status = 'open'`,
    )
      .bind(t, t, key, bytes, head.version_id)
      .run();
  }

  if (fold) {
    return [
      env.DB.prepare(
        `UPDATE versions SET title = ?, body = ?, doc = ?, data_json = ?, node_type = ?, content_hash = ?,
                payload_bytes = ?, status_changed_at = ?
          WHERE id = ? AND status = 'open'`,
      ).bind(
        state.title, state.body, state.doc, state.data, state.type, hash,
        state.payload === null ? null : byteLength(state.payload), t, head!.version_id,
      ),
      touchHead(env, head!.version_id, actor, t, nodeUpdatedAt),
    ];
  }

  // A new version. A person's is open (their next saves update it); anything
  // else is final the moment it is written.
  const open = actor.via === "web" && op !== "import";
  let key: string | null = null;
  if (!open && state.payload !== null) {
    key = versionKey(nodeId, hash);
    await env.ARTEFACTS.put(key, state.payload, { httpMetadata: { contentType: "application/json" } });
  }
  const id = crypto.randomUUID();
  const realOp: Op = op === "create" && head ? "undelete" : op;
  return [
    env.DB.prepare(
      `INSERT INTO versions
         (id,node_id,board_id,workspace_id,seq,node_type,op,title,body,doc,data_json,payload_key,payload_bytes,
          content_hash,actor_user_id,actor_client_id,actor_client_name,actor_via,status,created_at,sealed_at,status_changed_at)
       SELECT ?,?,b.id,b.workspace_id,(SELECT COALESCE(MAX(seq),0)+1 FROM versions WHERE node_id = ?),
              ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         FROM boards b WHERE b.id = ?`,
    ).bind(
      id, nodeId, nodeId,
      state.type, realOp, state.title, state.body, state.doc, state.data, key,
      state.payload === null ? null : byteLength(state.payload),
      hash, actor.userId, actor.clientId ?? null, actor.clientName ?? null, actor.via,
      open ? "open" : "sealed", t, open ? null : t, t,
      state.boardId,
    ),
    touchHead(env, id, actor, t, nodeUpdatedAt),
  ];
}

/** Point the head at a version (new, or updated in place). */
const touchHead = (env: HistoryEnv, versionId: string, actor: Actor, t: number, nodeUpdatedAt: number) =>
  env.DB.prepare(
    `INSERT INTO version_heads (node_id,head_seq,head_version_id,updated_by_user,updated_by_client,updated_at,node_updated_at)
     SELECT v.node_id, v.seq, v.id, ?, ?, ?, ? FROM versions v WHERE v.id = ?
     ON CONFLICT(node_id) DO UPDATE SET
       head_seq = excluded.head_seq, head_version_id = excluded.head_version_id,
       updated_by_user = excluded.updated_by_user, updated_by_client = excluded.updated_by_client,
       updated_at = excluded.updated_at, node_updated_at = excluded.node_updated_at`,
  ).bind(actor.userId, actor.clientId ?? null, t, nodeUpdatedAt, versionId);

/**
 * Record what a node already holds, if history does not have it.
 *
 * Called before the first write to a node that was made before history existed,
 * or that something wrote without recording (an older Worker on a migrated
 * database). The current state becomes a sealed `import` version, so the write
 * that follows replaces something that can be found again.
 */
async function importCurrent(env: HistoryEnv, row: NodeRow): Promise<void> {
  if (!isVersioned(row.type)) return;
  const head = await headOf(env, row.id);
  if (head && head.node_updated_at === row.updated_at) return;
  const stmts = await plan(env, SYSTEM, row.id, await stateOf(env, row), "import", row.updated_at, !!head);
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------------
// Writing cards (and every node's row)
// ---------------------------------------------------------------------------

export interface NodeInsert {
  id: string;
  board_id: string;
  type: string;
  title: string;
  body: string;
  doc: string | null;
  x: number;
  y: number;
  w?: number;
  h?: number;
  data: string;
  idem_key?: string | null;
  index_dirty?: number | null;
}

/**
 * Statements that create a node and record its first version, to go in the
 * caller's batch. For nodes without an R2 payload; see `writeArtefact` for those.
 * `record: false` is for a node that is made empty and filled in a moment later
 * (a file); the fill is then its first version (`CardEdit.first`).
 */
export async function cardInsertStmts(
  env: HistoryEnv,
  actor: Actor,
  row: NodeInsert,
  opts: { op?: Op; record?: boolean } = {},
): Promise<D1PreparedStatement[]> {
  const t = now();
  const insert = env.DB.prepare(
    `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,idem_key,index_dirty)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    row.id, row.board_id, row.type, row.title, row.body, row.doc, row.x, row.y, row.w ?? 260, row.h ?? 150,
    row.data, t, t, row.idem_key ?? null, row.index_dirty ?? null,
  );
  if (!isVersioned(row.type) || opts.record === false) return [insert];
  const state: State = { type: row.type, title: row.title, body: row.body, doc: row.doc, data: row.data, boardId: row.board_id, payload: null };
  return [insert, ...(await plan(env, actor, row.id, state, opts.op ?? "create", t))];
}

export interface CardEdit {
  nodeId: string;
  set: {
    title?: string;
    body?: string;
    doc?: string | null;
    data?: string;
    type?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  /** The write is a person placing the node by hand: pins it, which is not content. */
  placed?: boolean;
  /** Mark the node for re-embedding, with this `index_dirty` value. */
  reindex?: number;
  /**
   * This write is the node's first (a file node made empty, then filled): record
   * it as `create` and do not import the placeholder.
   */
  first?: boolean;
}

/**
 * Statements that change a node's row and record the version that results, to
 * go in the caller's batch. Reads first and may seal or import, so it is async.
 */
export async function cardEditStmts(env: HistoryEnv, actor: Actor, edit: CardEdit): Promise<D1PreparedStatement[]> {
  const row = await rowOf(env, edit.nodeId);
  if (!row) return [];
  const contentChange = ["title", "body", "doc", "data", "type"].some((k) => (edit.set as any)[k] !== undefined);
  const versioned = isVersioned(row.type) || (edit.set.type !== undefined && isVersioned(edit.set.type));
  const record = versioned && contentChange;
  if (record && !edit.first) await importCurrent(env, row);

  const t = now();
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["title", "body", "doc", "type", "x", "y", "w", "h"] as const) {
    if (edit.set[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(edit.set[k]);
  }
  if (edit.set.data !== undefined) {
    sets.push(edit.placed ? "data = json_set(?, '$.placed', 'hand')" : "data = ?");
    vals.push(edit.set.data);
  } else if (edit.placed) {
    // `json_valid` rather than COALESCE: `json_set` raises on malformed input,
    // and a card whose `data` somehow went bad must still be draggable.
    sets.push("data = json_set(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.placed', 'hand')");
  }
  sets.push("updated_at = ?");
  vals.push(t);
  if (edit.reindex !== undefined) {
    sets.push("index_dirty = ?");
    vals.push(edit.reindex);
  }
  const update = env.DB.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, row.id);
  if (!record) return [update];

  const type = edit.set.type ?? row.type;
  const state: State = {
    type,
    title: edit.set.title ?? row.title ?? "",
    body: edit.set.body ?? row.body ?? "",
    doc: edit.set.doc !== undefined ? edit.set.doc : row.doc,
    data: edit.set.data ?? row.data ?? "{}",
    boardId: row.board_id,
    payload: isArtefact(type) ? await payloadText(env, row.id) : null,
  };
  return [update, ...(await plan(env, actor, row.id, state, edit.first ? "create" : "edit", t))];
}

/** Change a node's row and record the version, now. `extra` rides in the same batch. */
export async function writeCard(
  env: HistoryEnv,
  actor: Actor,
  edit: CardEdit,
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  const stmts = [...(await cardEditStmts(env, actor, edit)), ...extra];
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * Create one node on its own, for a route that decides about collisions itself.
 *
 * The row goes in first, so a create under an id that is taken fails (unique
 * violation, thrown as-is) before anything else is touched. An artefact's bytes
 * follow, and if they cannot be written the row goes again rather than point at
 * nothing. The version is recorded last, once the node exists in full.
 * `payload: "existing"` is a node coming back (undo) whose bytes never left.
 */
export async function insertNode(
  env: HistoryEnv,
  actor: Actor,
  row: NodeInsert,
  opts: { payload?: { key: string; json: string } | "existing" } = {},
): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,index_dirty)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(row.id, row.board_id, row.type, row.title, row.body, row.doc, row.x, row.y, row.w ?? 260, row.h ?? 140, row.data, t, t, row.index_dirty ?? null)
    .run();

  if (opts.payload && opts.payload !== "existing") {
    try {
      await env.ARTEFACTS.put(opts.payload.key, opts.payload.json, { httpMetadata: { contentType: "application/json" } });
    } catch (err) {
      await env.DB.prepare(`DELETE FROM nodes WHERE id = ?`).bind(row.id).run();
      throw err;
    }
  }
  await recordNode(env, actor, row.id, "create");
}

/** Record a node's current state as its next version (it was written some other way, e.g. a trash restore). */
export async function recordNode(env: HistoryEnv, actor: Actor, nodeId: string, op: Op): Promise<void> {
  const row = await rowOf(env, nodeId);
  if (!row || !isVersioned(row.type)) return;
  const stmts = await plan(env, actor, nodeId, await stateOf(env, row), op, row.updated_at);
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * Put an archived node row back (the trash), using whatever columns it has, and
 * record it. `OR IGNORE`: a restore can legitimately meet a row already back.
 */
export async function reinsertNode(env: HistoryEnv, actor: Actor, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  if (!cols.length) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO nodes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c] as never))
    .run();
  await recordNode(env, actor, String(row.id), "create");
}

// ---------------------------------------------------------------------------
// Writing artefacts
// ---------------------------------------------------------------------------

export interface ArtefactWrite {
  nodeId: string;
  kind: ArtefactKind;
  payload: unknown;
  /** The node's title after the write; omitted, it is left as it is. */
  title?: string;
  /** Present when the node does not exist yet. */
  create?: { boardId: string; x: number; y: number; idemKey?: string | null };
  /** Statements that belong with the write, in the same batch (touching the mindmap). */
  extra?: D1PreparedStatement[];
}

/**
 * Write an artefact: its payload to R2, its summary and snapshot to the row, and
 * the version that results.
 *
 * Ordering matters here. The previous head is sealed (its bytes copied) before
 * the new payload lands on `artefacts/<id>`, and the payload lands before the
 * row changes, so a failure leaves an orphan object or a sealed version, never a
 * row that points at nothing. Throws `ArtefactTooLarge` before anything is
 * touched.
 */
export async function writeArtefact(env: HistoryEnv, actor: Actor, w: ArtefactWrite): Promise<StoredArtefact> {
  const { json, stored } = describeArtefact(w.nodeId, w.kind, w.payload);
  const data = JSON.stringify(stored.data);
  const t = now();

  if (w.create) {
    const title = w.title ?? "";
    const state: State = { type: w.kind, title, body: stored.body, doc: null, data, boardId: w.create.boardId, payload: json };
    const versionStmts = await plan(env, actor, w.nodeId, state, "create", t);
    await putArtefact(env, w.nodeId, w.kind, w.payload);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO nodes (id,board_id,type,title,body,doc,x,y,w,h,data,created_at,updated_at,idem_key)
         VALUES (?,?,?,?,?,NULL,?,?,260,150,?,?,?,?)`,
      ).bind(w.nodeId, w.create.boardId, w.kind, title, stored.body, w.create.x, w.create.y, data, t, t, w.create.idemKey ?? null),
      ...versionStmts,
      ...(w.extra ?? []),
    ]);
    return stored;
  }

  const row = await rowOf(env, w.nodeId);
  if (!row) throw new Error(`no node ${w.nodeId}`);
  await importCurrent(env, row);
  const title = w.title ?? row.title ?? "";
  const state: State = { type: w.kind, title, body: stored.body, doc: null, data, boardId: row.board_id, payload: json };
  const versionStmts = await plan(env, actor, w.nodeId, state, "edit", t);
  await putArtefact(env, w.nodeId, w.kind, w.payload);
  await env.DB.batch([
    env.DB.prepare(`UPDATE nodes SET title = ?, body = ?, data = ?, index_dirty = ?, updated_at = ? WHERE id = ?`)
      .bind(title, stored.body, data, t, t, w.nodeId),
    ...versionStmts,
    ...(w.extra ?? []),
  ]);
  return stored;
}

// ---------------------------------------------------------------------------
// What a reader is told
// ---------------------------------------------------------------------------

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/**
 * Clear the content out of every version recorded in these workspaces, keeping
 * the rows. For an account deletion: a version is a copy of what someone wrote,
 * and the one place history may not outlive its owner.
 *
 * The row stays, as everywhere in this table, with its timeline, its sequence
 * and who wrote it (an id that no longer names anyone once the user is scrubbed);
 * `status` becomes `redacted` and the content columns go empty. Returns the R2
 * keys of the sealed artefact payloads, which the caller files for deletion:
 * the bytes are not in the row, so clearing the pointer alone would strand them.
 *
 * Idempotent: a row already redacted has nothing left to clear and no key to
 * return, so a deletion that was interrupted can simply run this again.
 */
export async function redactVersions(
  env: HistoryEnv,
  workspaceIds: string[],
): Promise<Array<{ nodeId: string; key: string }>> {
  const keys: Array<{ nodeId: string; key: string }> = [];
  for (const ws of workspaceIds) {
    const sealed = await env.DB.prepare(
      `SELECT node_id, payload_key FROM versions WHERE workspace_id = ? AND payload_key IS NOT NULL`,
    )
      .bind(ws)
      .all<{ node_id: string; payload_key: string }>();
    for (const r of sealed.results ?? []) keys.push({ nodeId: r.node_id, key: r.payload_key });

    await env.DB.prepare(
      `UPDATE versions
          SET status = 'redacted', title = NULL, body = NULL, doc = NULL, data_json = NULL,
              payload_key = NULL, content_hash = NULL, actor_note = NULL, label = NULL,
              status_changed_at = ?
        WHERE workspace_id = ? AND status <> 'redacted'`,
    )
      .bind(now(), ws)
      .run();
  }
  return keys;
}

/**
 * "v3 by agent-two (MCP), 4 min ago": which version a node is at and who wrote
 * it. Null for a node nobody has written since history began.
 */
export async function versionLine(env: HistoryEnv, nodeId: string): Promise<string | null> {
  const v = await env.DB.prepare(
    `SELECT v.seq, v.actor_via, v.actor_client_name, v.op, COALESCE(NULLIF(u.name, ''), u.email) AS who, v.status_changed_at
       FROM version_heads h
       JOIN versions v ON v.id = h.head_version_id
       LEFT JOIN users u ON u.id = v.actor_user_id
      WHERE h.node_id = ?`,
  )
    .bind(nodeId)
    .first<{ seq: number; actor_via: string; actor_client_name: string | null; op: string; who: string | null; status_changed_at: number }>();
  if (!v) return null;
  const by =
    v.actor_via === "mcp"
      ? `${v.actor_client_name || "an MCP client"} (MCP)`
      : v.actor_via === "web"
        ? `${v.who || "someone"} (web)`
        : v.op === "import"
          ? "system (existing content, recorded when first changed)"
          : "system";
  return `v${v.seq} by ${by}, ${ago(v.status_changed_at)}`;
}
