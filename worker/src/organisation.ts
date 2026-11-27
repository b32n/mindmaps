/**
 * The organisation: what "create an organisation" means in each mode, who may,
 * and what a person sees of it. See docs/MODES.md.
 *
 *   personal      there is no such thing. Every route here refuses.
 *   org           exactly one per instance, made once by the instance's first
 *                 account. Everyone else is in it by accepted invitation.
 *   multitenant   anyone makes as many as they like (a shared workspace, the same
 *                 thing POST /api/workspaces has always made).
 *
 * An organisation is an ordinary shared workspace. In org mode one of them is
 * marked as the organisation in `instance_organisation` (migration 0031); that
 * single row, and the partial unique index on it, are what make "exactly one"
 * true when two requests race. Nothing is ever deleted or moved here.
 */

import { workspaceRole, type Role } from "./access";
import { cleanName, NAME_MAX } from "./lifecycle";
import { readMode, type Mode, type ModeEnv } from "./mode";

export interface OrganisationEnv extends ModeEnv {
  DB: D1Database;
}

export interface Refusal {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  /** Machine-readable, stable. The app and scripts switch on this, not on the sentence. */
  code: string;
}

const refuse = (status: Refusal["status"], code: string, error: string): Refusal => ({ ok: false, status, code, error });

const NOT_ALLOWED_IN_PERSONAL = refuse(
  403,
  "team_spaces_disabled",
  "This install is personal: it has no organisations or team spaces. Switch MINDMAPS_MODE to org or multitenant to use them.",
);
const EXISTS = refuse(409, "organisation_exists", "This instance already has its organisation. There is only one; ask an admin to invite you to it.");
const SETUP_FIRST = refuse(
  409,
  "organisation_setup_required",
  "This instance is in organisation mode and its organisation has not been set up yet. Its first account does that.",
);
const NOT_OWNER = refuse(403, "not_instance_owner", "Only the first account on this instance can set up its organisation.");
const BAD_NAME = refuse(400, "invalid_name", `An organisation needs a name: 1 to ${NAME_MAX} characters on one line.`);

// ---------------------------------------------------------------------------
// Reading the organisation
// ---------------------------------------------------------------------------

export interface Organisation {
  id: string;
  workspace_id: string;
  name: string;
  created_at: number;
}

/**
 * The instance's organisation, or null if it has none.
 *
 * A row whose workspace no longer exists (its owner deleted their account, which
 * removes it) is retired here, so the slot is free and the instance can be set up
 * again. The row stays as history.
 */
export async function currentOrganisation(db: D1Database): Promise<Organisation | null> {
  const row = await db
    .prepare(
      `SELECT o.id, o.workspace_id, o.created_at, w.name AS name
         FROM instance_organisation o LEFT JOIN workspaces w ON w.id = o.workspace_id
        WHERE o.status = 'active'`,
    )
    .first<{ id: string; workspace_id: string; created_at: number; name: string | null }>();
  if (!row) return null;
  if (row.name === null) {
    await db
      .prepare(`UPDATE instance_organisation SET status = 'retired', updated_at = ?2 WHERE id = ?1 AND status = 'active'`)
      .bind(row.id, Date.now())
      .run();
    return null;
  }
  return { id: row.id, workspace_id: row.workspace_id, name: row.name, created_at: row.created_at };
}

/**
 * The account that may set the organisation up: the earliest one still active.
 *
 * "Earliest" is the order the rows were inserted (SQLite's rowid), not a
 * timestamp, so two sign-ups in the same millisecond still have a first and a
 * second. D1 serialises writes, which is what makes that order real.
 */
export async function instanceOwnerId(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT id FROM users WHERE status = 'active' ORDER BY rowid LIMIT 1`).first<{ id: string }>();
  return row?.id ?? null;
}

/** Is this workspace the organisation of an org-mode instance? (Used to refuse closing it.) */
export async function isOrganisationWorkspace(env: OrganisationEnv, workspaceId: string): Promise<boolean> {
  if (readMode(env) !== "org") return false;
  const org = await currentOrganisation(env.DB);
  return org?.workspace_id === workspaceId;
}

export type OrganisationState =
  | "disabled" // personal: there is no organisation
  | "setup" // org, none yet, and you are the one who sets it up
  | "waiting" // org, none yet, and you are not
  | "member" // org, and you are in it
  | "outside" // org, and you are not in it
  | "available"; // multitenant: you can create one

export interface OrganisationInfo {
  mode: Mode;
  state: OrganisationState;
  can_create: boolean;
  organisation: { workspace_id: string; name: string; role: Role } | null;
  /** Outside only: what the organisation is called, so the page can say whom to ask. */
  organisation_name: string | null;
  /** Setup only: shared workspaces this account owns, which could become the organisation. */
  adoptable: { id: string; name: string }[];
  /**
   * Outside only: show nothing but the "ask for an invite" page. True for an
   * account made after the organisation existed. An account that already had
   * its own data is not shut out of it (`false`), only told it is not in the
   * organisation.
   */
  gated: boolean;
}

export async function organisationFor(env: OrganisationEnv, user: { id: string }): Promise<OrganisationInfo> {
  const mode = readMode(env);
  const base = { mode, can_create: false, organisation: null, organisation_name: null, adoptable: [], gated: false };
  if (mode === "personal") return { ...base, state: "disabled" };
  if (mode === "multitenant") return { ...base, state: "available", can_create: true };

  const org = await currentOrganisation(env.DB);
  if (!org) {
    if ((await instanceOwnerId(env.DB)) !== user.id) return { ...base, state: "waiting" };
    const rows = await env.DB
      .prepare(`SELECT id, name FROM workspaces WHERE owner_id = ?1 AND personal = 0 AND status = 'active' ORDER BY created_at, rowid`)
      .bind(user.id)
      .all<{ id: string; name: string }>();
    return { ...base, state: "setup", can_create: true, adoptable: rows.results ?? [] };
  }

  const role = await workspaceRole(env.DB, user.id, org.workspace_id);
  if (role) return { ...base, state: "member", organisation: { workspace_id: org.workspace_id, name: org.name, role } };

  const me = await env.DB.prepare(`SELECT created_at FROM users WHERE id = ?`).bind(user.id).first<{ created_at: number }>();
  return { ...base, state: "outside", gated: (me?.created_at ?? 0) >= org.created_at, organisation_name: org.name };
}

// ---------------------------------------------------------------------------
// Creating one
// ---------------------------------------------------------------------------

/** Why POST /api/workspaces (the older way to make a shared workspace) is not allowed in this mode, if it is not. */
export async function workspaceCreationRefusal(env: OrganisationEnv): Promise<Refusal | null> {
  const mode = readMode(env);
  if (mode === "personal") return NOT_ALLOWED_IN_PERSONAL;
  if (mode === "org") return (await currentOrganisation(env.DB)) ? EXISTS : SETUP_FIRST;
  return null;
}

export type Created = { ok: true; id: string; name: string; adopted: boolean } | Refusal;

const insertWorkspace = (db: D1Database, wsId: string, name: string, userId: string, at: number) =>
  db
    .prepare(`INSERT INTO workspaces (id, name, owner_id, personal, created_at, updated_at) VALUES (?1,?2,?3,0,?4,?4)`)
    .bind(wsId, name, userId, at);

/** Make a shared workspace owned by `userId`. Shared by both ways in. */
export async function createSharedWorkspace(db: D1Database, userId: string, name: string): Promise<string> {
  const wsId = crypto.randomUUID();
  await insertWorkspace(db, wsId, name, userId, Date.now()).run();
  return wsId;
}

/**
 * POST /api/organisation.
 *
 * Org mode: refused if there is one already (409, whoever asks); refused to
 * anyone but the instance's first account (403); otherwise creates it, from
 * `name`, or by choosing a workspace the account already owns (`workspace_id`),
 * which is how an install switched to org mode with data keeps it. The
 * workspace and its marker go in one batch, so there is never a half-made one,
 * and the unique index decides a race: the loser's batch fails whole.
 */
export async function createOrganisation(
  env: OrganisationEnv,
  userId: string,
  body: { name?: unknown; workspace_id?: unknown },
): Promise<Created> {
  const mode = readMode(env);
  if (mode === "personal") return NOT_ALLOWED_IN_PERSONAL;

  if (mode === "multitenant") {
    if (body.workspace_id !== undefined)
      return refuse(400, "adopt_not_available", "Choosing an existing workspace is only for instances in organisation mode.");
    const name = cleanName(body.name);
    if (!name) return BAD_NAME;
    return { ok: true, id: await createSharedWorkspace(env.DB, userId, name), name, adopted: false };
  }

  if (await currentOrganisation(env.DB)) return EXISTS;
  if ((await instanceOwnerId(env.DB)) !== userId) return NOT_OWNER;

  const at = Date.now();
  const orgId = crypto.randomUUID();
  const mark = (wsId: string, adopted: number) =>
    env.DB
      .prepare(
        `INSERT INTO instance_organisation (id, workspace_id, status, created_by, adopted, created_at, updated_at)
         VALUES (?1,?2,'active',?3,?4,?5,?5)`,
      )
      .bind(orgId, wsId, userId, adopted, at);

  try {
    if (body.workspace_id !== undefined) {
      if (typeof body.workspace_id !== "string" || !body.workspace_id) return refuse(404, "workspace_not_found", "No such workspace.");
      const ws = await env.DB
        .prepare(`SELECT id, name, personal FROM workspaces WHERE id = ? AND owner_id = ? AND status = 'active'`)
        .bind(body.workspace_id, userId)
        .first<{ id: string; name: string; personal: number }>();
      if (!ws) return refuse(404, "workspace_not_found", "No such workspace.");
      if (ws.personal) return refuse(400, "workspace_not_adoptable", "A personal workspace cannot be the organisation.");
      await mark(ws.id, 1).run();
      return { ok: true, id: ws.id, name: ws.name, adopted: true };
    }

    const name = cleanName(body.name);
    if (!name) return BAD_NAME;
    const wsId = crypto.randomUUID();
    await env.DB.batch([insertWorkspace(env.DB, wsId, name, userId, at), mark(wsId, 0)]);
    return { ok: true, id: wsId, name, adopted: false };
  } catch (err) {
    // The unique index said no: someone else's request got there first.
    if (await currentOrganisation(env.DB)) return EXISTS;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Where an agent connects
// ---------------------------------------------------------------------------

/**
 * The workspace an agent is connected to unless its user picks another: the
 * organisation, for a member of an org-mode instance; otherwise `null`, and the
 * caller keeps its own default (Personal first).
 */
export async function defaultConnectWorkspace(env: OrganisationEnv, workspaceIds: string[]): Promise<string | null> {
  if (readMode(env) !== "org") return null;
  const org = await currentOrganisation(env.DB);
  return org && workspaceIds.includes(org.workspace_id) ? org.workspace_id : null;
}
