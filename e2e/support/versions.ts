// Reads the version history out of the local D1 file, because no API exposes it
// yet (the read routes come in a later change). Read-only and out of band: the
// Worker has no test-only path, and nothing here writes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";

const root = new URL("../..", import.meta.url).pathname;

export interface VersionRow {
  id: string;
  node_id: string;
  board_id: string | null;
  workspace_id: string;
  seq: number;
  node_type: string;
  op: string;
  title: string | null;
  body: string | null;
  doc: string | null;
  data_json: string | null;
  payload_key: string | null;
  payload_bytes: number | null;
  content_hash: string | null;
  actor_user_id: string | null;
  actor_client_id: string | null;
  actor_client_name: string | null;
  actor_via: string;
  status: string;
  created_at: number;
  sealed_at: number | null;
  status_changed_at: number;
}

export interface HeadRow {
  node_id: string;
  head_seq: number;
  head_version_id: string;
  updated_by_user: string | null;
  updated_by_client: string | null;
  updated_at: number;
}

/** The sqlite file behind `DB` in a state dir (the main Worker's unless told otherwise). */
function dbFile(stateDir: string): string {
  const dir = `${root}${stateDir}/v3/d1/miniflare-D1DatabaseObject`;
  const f = readdirSync(dir).find((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite");
  if (!f) throw new Error(`no D1 file in ${dir}`);
  return `${dir}/${f}`;
}

export const MAIN_STATE = process.env.E2E_STATE_DIR ?? ".e2e-state";

/** Run a read-only query. Retries while the Worker holds the write lock. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = [],
  stateDir = MAIN_STATE,
): Promise<T[]> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbFile(stateDir), { readOnly: true });
      return db.prepare(sql).all(...params) as T[];
    } catch (err) {
      last = err;
      if (!/locked|busy/i.test(String((err as Error)?.message))) throw err;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      db?.close();
    }
  }
  throw last;
}

export const versionsOf = (nodeId: string, stateDir = MAIN_STATE) =>
  query<VersionRow>(`SELECT * FROM versions WHERE node_id = ? ORDER BY seq`, [nodeId], stateDir);

export const headOf = async (nodeId: string, stateDir = MAIN_STATE) =>
  (await query<HeadRow>(`SELECT * FROM version_heads WHERE node_id = ?`, [nodeId], stateDir))[0] ?? null;

/** Wait until a node has `n` versions, then return them (the write is awaited by the caller, so this is a read, not a wait on time). */
export async function expectVersions(nodeId: string, n: number, stateDir = MAIN_STATE): Promise<VersionRow[]> {
  const rows = await versionsOf(nodeId, stateDir);
  expect(rows.map((r) => `v${r.seq} ${r.op} ${r.status}`), `versions of ${nodeId}`).toHaveLength(n);
  return rows;
}

/** Every `.ts` file under worker/src, as `[name, source]`. */
export function workerSources(): Array<[string, string]> {
  const dir = `${root}worker/src`;
  return readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(`${dir}/${n}`, "utf8")] as [string, string]);
}

export const migrationFiles = (): string[] =>
  existsSync(`${root}worker/migrations`) ? readdirSync(`${root}worker/migrations`).sort() : [];

export const migrationSql = (name: string) => readFileSync(`${root}worker/migrations/${name}`, "utf8");
