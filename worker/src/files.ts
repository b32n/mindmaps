/**
 * Files: the fifth and sixth artefact kinds.
 *
 * A sheet, a document, a deck and a page are all *authored* here — an agent
 * writes a payload in a format this Worker understands, and an editor renders
 * it. A file is the opposite: opaque bytes we did not write and cannot read,
 * kept because someone needs them again later.
 *
 * That is worth having for a reason that has nothing to do with storage.
 * Memory already survives a session ending, because it lives in D1 and
 * Vectorize. Files do not — they live on whichever machine an agent happened to
 * run on, and the next agent, on a different machine, cannot see them. A file
 * with a URL, a permission model and a text snapshot crosses that gap.
 *
 * Two node types, one table:
 *
 *   `file`    one row  — a thing you dropped on the board
 *   `folder`  many     — a set of things that belong together
 *
 * Neither goes through `putArtefact`. That path JSON-parses the payload and
 * caps it at 4 MB, which is right for a workbook and wrong for a 30 MB video:
 * bytes stream from the request into R2 and are never held whole in the
 * isolate. Keeping that true is what makes the size cap a constant rather than
 * an architecture — see MAX_FILE_BYTES.
 */

import { trashObject, type TrashEnv } from "./r2trash";

export interface FileEnv {
  DB: D1Database;
  ARTEFACTS: R2Bucket;
}

/** The node types backed by this table. */
export type FileKind = "file" | "folder";

export const FILE_TYPES: readonly string[] = ["file", "folder"];

export const isFileKind = (type: string): type is FileKind => FILE_TYPES.includes(type);

/**
 * The most bytes one upload may carry.
 *
 * 50 MB is a starting point, not a boundary: raising it is editing this
 * constant, because nothing downstream buffers. The real ceiling is the
 * Workers request-body limit — past that the bytes cannot traverse the Worker
 * at all, and uploads need either R2 multipart or a presigned PUT straight to
 * the bucket. That is a change of transport and touches nothing here: the row,
 * the snapshot and the permissions are all the same either way.
 */
export const MAX_FILE_BYTES = 50_000_000;

/**
 * The most we will read into memory to extract a snippet.
 *
 * Above this a text file is stored like any other blob and leans on its
 * description. The number is about the isolate's 128 MB, not about R2.
 */
const TEXT_SNAPSHOT_MAX = 256_000;

/** How much of a file's text reaches the snapshot. */
const SNIPPET_CHARS = 2_000;

/**
 * Per file, inside a folder's rolled-up snapshot.
 *
 * Tighter than SNIPPET_CHARS because a folder's body is the sum of its
 * members: forty files at two thousand characters would be a body no chunker
 * can do anything useful with.
 */
const FOLDER_SNIPPET_CHARS = 300;

/**
 * Where a folder's snapshot stops.
 *
 * `MAX_CHUNKS` is 64 (semantic.ts), so a body past roughly that many passages
 * is indexed only as far as the ceiling and the rest is silently invisible.
 * Truncating deliberately, and saying so in the text, is better than a folder
 * that is half-searchable for reasons nobody can see. A folder this large
 * wants to be several folders.
 */
const FOLDER_SNAPSHOT_FILES = 60;

export const fileKey = (nodeId: string, fileId: string) => `files/${nodeId}/${fileId}`;

// ---------------------------------------------------------------------------
// What we can read
// ---------------------------------------------------------------------------

/**
 * Content types we will decode as text.
 *
 * `text/*` plus the application types that are text wearing a different label.
 * Deliberately a list rather than a sniff: guessing wrong means storing the
 * first two kilobytes of a binary as a card's searchable body.
 */
const TEXT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/x-sh",
]);

/**
 * Extensions that are text whatever the browser claimed.
 *
 * A drag-and-drop of `schema.sql` or `main.rs` arrives as
 * `application/octet-stream` in most browsers, and those are exactly the files
 * whose contents are worth searching.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm",
  "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "proto", "tf",
  "dockerfile", "gitignore", "log", "diff", "patch",
]);

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Can we get searchable text out of this without a parser? */
export function isTextual(name: string, contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  if (TEXT_TYPES.has(type)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

/**
 * Whether this upload must come with a description.
 *
 * The rule that keeps files from being a bucket. Every other artefact kind
 * earns its way into `recall` by deriving text; a zip derives nothing, so the
 * uploader says in one line what it is and that line becomes the snapshot.
 *
 * Required rather than optional on purpose. ARTEFACTS.md §7 names the failure
 * mode — agents make the node and leave it blank — and an optional field in a
 * tool schema is a field agents skip.
 */
export const needsDescription = (name: string, contentType: string, size: number): boolean =>
  !isTextual(name, contentType) || size > TEXT_SNAPSHOT_MAX;

/**
 * Decode a text file's head.
 *
 * `fatal: false` so a file that is mostly text with a stray invalid byte still
 * yields something useful rather than throwing; the replacement characters are
 * noise in a snapshot and nothing more.
 */
function snippetFrom(bytes: ArrayBuffer): string {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  // A file with no whitespace in its first kilobyte is minified or is binary
  // that slipped the type check. Either way its text is not worth indexing.
  const head = text.slice(0, SNIPPET_CHARS);
  return /\s/.test(head.slice(0, 1_000)) ? head.trim() : "";
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface FileRow {
  id: string;
  node_id: string;
  name: string;
  size: number;
  content_type: string;
  description: string;
  snippet: string;
  r2_key: string;
  position: number;
  uploaded_at: number;
  uploaded_by: string | null;
}

/** What a client sees. `snippet` and `r2_key` stay on the server. */
export interface FileMeta {
  id: string;
  name: string;
  size: number;
  contentType: string;
  description: string;
  uploadedAt: number;
  uploadedBy: string | null;
}

export const toMeta = (row: FileRow): FileMeta => ({
  id: row.id,
  name: row.name,
  size: row.size,
  contentType: row.content_type,
  description: row.description,
  uploadedAt: row.uploaded_at,
  uploadedBy: row.uploaded_by,
});

export async function filesOf(env: FileEnv, nodeId: string): Promise<FileRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM files WHERE node_id = ? ORDER BY position, uploaded_at`,
  )
    .bind(nodeId)
    .all<FileRow>();
  return rows.results ?? [];
}

export async function fileById(env: FileEnv, fileId: string): Promise<FileRow | null> {
  return await env.DB.prepare(`SELECT * FROM files WHERE id = ?`).bind(fileId).first<FileRow>();
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const kb = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

/**
 * What the brain reads.
 *
 * A single file gets its description and as much of its text as we kept. A
 * folder gets a line per member, because the question asked of a folder is
 * "which one of these is the thing I want" and the answer is in the names and
 * the descriptions, not in any one file's contents.
 */
export function fileSnapshot(kind: FileKind, title: string, rows: FileRow[]): string {
  const lines: string[] = [title];

  if (kind === "file") {
    const f = rows[0];
    if (!f) return `${title}\n(empty)`;
    lines.push(`${f.name} · ${f.content_type} · ${kb(f.size)}`);
    if (f.description) lines.push(f.description);
    if (f.snippet) lines.push("", f.snippet);
    return lines.join("\n");
  }

  lines.push(`${rows.length} file${rows.length === 1 ? "" : "s"}`);
  for (const f of rows.slice(0, FOLDER_SNAPSHOT_FILES)) {
    const head = [f.name, f.description].filter(Boolean).join(" — ");
    const text = f.snippet ? ` ${f.snippet.slice(0, FOLDER_SNIPPET_CHARS)}` : "";
    lines.push(`${head}${text}`);
  }
  if (rows.length > FOLDER_SNAPSHOT_FILES)
    lines.push(`… and ${rows.length - FOLDER_SNAPSHOT_FILES} more, not indexed.`);

  return lines.join("\n");
}

/** Goes in `nodes.data`: what the board needs to draw the node collapsed. */
export function fileSummary(kind: FileKind, rows: FileRow[]): Record<string, unknown> {
  const bytes = rows.reduce((n, f) => n + f.size, 0);
  if (kind === "file") {
    const f = rows[0];
    return f
      ? { files: 1, bytes, name: f.name, contentType: f.content_type, fileId: f.id }
      : { files: 0, bytes: 0 };
  }
  return { files: rows.length, bytes };
}

/**
 * Rewrite the node's summary and snapshot from its rows.
 *
 * Called after every upload, rename and removal, and it reads only D1 — which
 * is why the snippet is a column rather than something re-read from R2. It
 * also marks the node dirty, so the cron re-embeds it: a file nobody can find
 * by meaning is the failure this whole design is trying to avoid.
 */
export async function refreshFileNode(
  env: FileEnv,
  nodeId: string,
  kind: FileKind,
  title: string,
): Promise<{ data: Record<string, unknown>; body: string }> {
  const rows = await filesOf(env, nodeId);
  const body = fileSnapshot(kind, title, rows);
  const data = { kind, ...fileSummary(kind, rows) };

  await env.DB.prepare(
    `UPDATE nodes SET data = ?, body = ?, index_dirty = 1, updated_at = ? WHERE id = ?`,
  )
    .bind(JSON.stringify(data), body, Date.now(), nodeId)
    .run();

  return { data, body };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface UploadInput {
  nodeId: string;
  kind: FileKind;
  /** The node's title, so the snapshot can be rebuilt in the same call. */
  title: string;
  name: string;
  contentType: string;
  description: string;
  size: number;
  uploadedBy: string | null;
  /**
   * The bytes. A buffer when we mean to read the text out of it, a stream when
   * we do not — the caller decides with `wantsSnippet`, because a stream can
   * only be consumed once and that choice has to happen before it is touched.
   */
  source: ArrayBuffer | ReadableStream;
}

/** Should this upload be buffered so its text can be extracted? */
export const wantsSnippet = (name: string, contentType: string, size: number): boolean =>
  isTextual(name, contentType) && size > 0 && size <= TEXT_SNAPSHOT_MAX;

export class FileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Put one file behind a node.
 *
 * R2 first, D1 second, for the reason `putArtefact` gives: a failed row write
 * leaves an orphan object the reaper will collect, where the reverse leaves a
 * row pointing at bytes that are not there.
 *
 * The key carries an upload id rather than being `files/<nodeId>`, so replacing
 * a file writes a new object instead of overwriting one. Nothing reads the old
 * key today, but the layout is the part that is expensive to change later, and
 * versions are only worth having if the bytes were never overwritten.
 */
export async function storeFile(env: FileEnv, input: UploadInput): Promise<FileRow> {
  if (input.size > MAX_FILE_BYTES)
    throw new FileError(
      `That file is ${kb(input.size)}, over the ${MAX_FILE_BYTES / 1_000_000} MB limit.`,
      413,
    );

  const name = input.name.trim().slice(0, 300) || "untitled";
  const description = input.description.trim().slice(0, 1_000);

  if (needsDescription(name, input.contentType, input.size) && !description)
    throw new FileError(
      "This file needs a one-line description — it is the only thing that will make it findable later.",
      400,
    );

  const fileId = crypto.randomUUID();
  const key = fileKey(input.nodeId, fileId);

  let snippet = "";
  let body: ArrayBuffer | ReadableStream = input.source;
  if (input.source instanceof ArrayBuffer) {
    snippet = snippetFrom(input.source);
    body = input.source;
  }

  await env.ARTEFACTS.put(key, body, {
    httpMetadata: {
      contentType: input.contentType,
      // Stored on the object as well as the row, so the download path can serve
      // a correct filename even if it is ever reached without the row.
      contentDisposition: `attachment; filename="${name.replace(/["\\]/g, "")}"`,
    },
  });

  const row: FileRow = {
    id: fileId,
    node_id: input.nodeId,
    name,
    size: input.size,
    content_type: input.contentType,
    description,
    snippet,
    r2_key: key,
    position: Date.now(),
    uploaded_at: Date.now(),
    uploaded_by: input.uploadedBy,
  };

  await env.DB.prepare(
    `INSERT INTO files
       (id,node_id,name,size,content_type,description,snippet,r2_key,position,uploaded_at,uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      row.id, row.node_id, row.name, row.size, row.content_type, row.description,
      row.snippet, row.r2_key, row.position, row.uploaded_at, row.uploaded_by,
    )
    .run();

  await refreshFileNode(env, input.nodeId, input.kind, input.title);
  return row;
}

/**
 * Remove one file from its node.
 *
 * The object is filed rather than deleted, exactly as a node's payload is: the
 * bytes outlive the row by the retention window, so removing the wrong file
 * from a folder is recoverable for a week instead of immediately final.
 */
export async function removeFile(
  env: FileEnv & TrashEnv,
  row: FileRow,
  kind: FileKind,
  title: string,
): Promise<void> {
  await trashObject(env, "ARTEFACTS", row.r2_key, row.node_id);
  await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(row.id).run();
  await refreshFileNode(env, row.node_id, kind, title);
}

/**
 * File every object behind a node, on the way to deleting it.
 *
 * The rows go by cascade; the bytes do not, because nothing cascades into R2.
 * Called from the node delete path alongside `archiveNode`, and the `r2_trash`
 * rows are keyed by node id, so the undo that restores the node un-files all of
 * them in one delete.
 */
export async function trashFilesOf(env: FileEnv & TrashEnv, nodeId: string): Promise<void> {
  for (const row of await filesOf(env, nodeId)) {
    await trashObject(env, "ARTEFACTS", row.r2_key, nodeId);
  }
}
