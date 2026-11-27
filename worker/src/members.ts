/**
 * Inviting people, and letting them in.
 *
 * An invitation is not access. It is an `invites` row, and it becomes a row in
 * `workspace_members`, `board_shares` or `artefact_grants` only when the person
 * it is addressed to accepts it (`acceptInvite`). Nothing joins anyone on its
 * own: not signing up, not signing in by any route, not being invited.
 *
 * The address someone signs up with is the one invitations are matched to, so
 * on an instance that can send email an invitation is only listed to, and only
 * accepted by, an account whose address is verified (`mayClaimInvites`). Beyond
 * that it takes an explicit act on their side, an account which already exists
 * cannot be added without its owner saying yes, and the invitation can be
 * declined.
 *
 * The one thing that still adds a person directly is sharing a single mindmap or
 * artefact with an existing account: it grants one thing, and not the
 * workspace around it.
 *
 * Invites are matched to an account by email. The match is the way an email
 * provider would make it: lowercased, trimmed, exact. No fuzzy matching, no
 * plus-address normalisation: being clever here is how you hand someone else's
 * invitation to a lookalike address.
 */

import { mayClaimInvites, type EmailAuthEnv } from "./emailauth";
import { INVITE_RESTRICTED_MESSAGE, inviteRefused, workspaceOfTarget } from "./org-policy";
import { assertNotBlocked } from "./scope";
import { MEMBER_ROLE, NOT_CLOSED, canAdmin, canWrite, boardRole, isOwner, nodeRole, workspaceRole, type Role } from "./access";

export interface MemberEnv extends EmailAuthEnv {
  DB: D1Database;
}

export type Target = "workspace" | "board" | "node";

/** The same alphabet as share tokens: no l/o/0/1 to misread aloud. */
export function inviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...bytes].map((b) => alphabet[b & 31]).join("");
}

export const normaliseEmail = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

/** The table a grant on this kind of target lives in. */
const TABLES: Record<Target, { table: string; key: string }> = {
  workspace: { table: "workspace_members", key: "workspace_id" },
  board: { table: "board_shares", key: "board_id" },
  node: { table: "artefact_grants", key: "node_id" },
};

/**
 * May this user hand out access to this thing?
 *
 * Workspaces and mindmaps: owners and admins. Sharing is not something an editor
 * should be able to do on someone else's behalf — an editor who could invite
 * could invite themselves a second account and keep access after removal.
 *
 * Artefacts are the exception: anyone who can edit one can pass it on, because
 * a grant on a single artefact cannot widen into anything else.
 */
export async function canGrant(
  env: MemberEnv,
  userId: string,
  target: Target,
  targetId: string,
): Promise<boolean> {
  if (target === "workspace") return canAdmin(await workspaceRole(env.DB, userId, targetId));
  if (target === "board") return canAdmin(await boardRole(env.DB, userId, targetId));
  return canWrite(await nodeRole(env.DB, userId, targetId));
}

/** A refusal with the status and wording to send back. */
export interface Denied {
  status: 400 | 403 | 404 | 409;
  error: string;
  /** Machine-readable, when there is one worth switching on. */
  code?: string;
}

export interface InviteResult {
  /** Set when the rules for who may change whom say no. */
  denied?: Denied;
  /** Set when the invitee already had an account and is now a member. */
  added?: { userId: string; email: string; role: Role };
  /** Set when they do not, and something has to be sent to them. */
  invited?: { token: string; email: string; role: Role; existing?: true };
}

/**
 * Invite someone, by email.
 *
 * Whether or not the invitee has an account, a workspace invite waits for them
 * to accept it. A mindmap or artefact shared with an existing account is theirs
 * straight away, as before: it is one thing, it can be left, and it does not
 * make them a member of anything.
 */
export async function invite(
  env: MemberEnv,
  inviterId: string,
  target: Target,
  targetId: string,
  rawEmail: string,
  role: "viewer" | "editor",
): Promise<InviteResult | null> {
  const email = normaliseEmail(rawEmail);
  if (!email.includes("@")) return null;

  // An organisation that restricts invitations to its verified domains refuses
  // the rest, whoever asks (org-policy.ts). Not applied to a role change for someone
  // already in the workspace: that is not an invitation, and it must never be
  // the thing that locks a member out.
  const restricted = async (): Promise<InviteResult | null> =>
    (await inviteRefused(env.DB, await workspaceOfTarget(env.DB, target, targetId), email))
      ? { denied: { status: 403, error: INVITE_RESTRICTED_MESSAGE, code: "invite_domain_restricted" } }
      : null;

  const existing = await env.DB.prepare(`SELECT id, email FROM users WHERE lower(email) = ? AND status = 'active'`)
    .bind(email)
    .first<{ id: string; email: string }>();

  if (existing) {
    // Inviting yourself is a no-op rather than an error: it is a harmless
    // mistake, and refusing it tells the inviter nothing useful.
    if (existing.id === inviterId) return { added: { userId: existing.id, email, role } };
    if (target === "workspace") {
      // Someone who is already in the workspace is not "invited": inviting them
      // again is a role change, and goes through exactly the rules a role
      // change does. Otherwise the invite form would be a way round them (an
      // admin demoting an admin, or writing a membership row for the owner).
      const owner = await env.DB.prepare(`SELECT owner_id FROM workspaces WHERE id = ?`)
        .bind(targetId)
        .first<{ owner_id: string }>();
      const already = await env.DB.prepare(
        `SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      )
        .bind(targetId, existing.id)
        .first();
      if (owner?.owner_id === existing.id || already) {
        const res = await changeMemberRole(env, inviterId, targetId, existing.id, role);
        if (!res.ok) return { denied: { status: res.status, error: res.error } };
        return { added: { userId: existing.id, email: existing.email, role } };
      }
      const no = await restricted();
      if (no) return no;
      const token = await createInvite(env, inviterId, target, targetId, email, role);
      return { invited: { token, email, role, existing: true } };
    }
    const no = await restricted();
    if (no) return no;
    // An account whose address was never proven may belong to someone who only
    // typed it in. Adding it would hand them access meant for the real owner,
    // so the share waits as an invitation, as it would for an address with no
    // account, and can be accepted once the address is verified (mayClaimInvites).
    if (await mayClaimInvites(env, existing.id)) {
      await addMember(env, target, targetId, existing.id, role, inviterId);
      return { added: { userId: existing.id, email: existing.email, role } };
    }
  }

  const no = await restricted();
  if (no) return no;
  const token = await createInvite(env, inviterId, target, targetId, email, role);
  return { invited: { token, email, role } };
}

/**
 * Leave one invitation waiting for this address and target.
 *
 * Inviting again replaces what was pending rather than stacking beside it: two
 * live invitations for one person and one workspace, possibly with different
 * roles, would leave "which did they accept?" with no good answer. The earlier
 * one is revoked, with its status, not deleted.
 */
async function createInvite(
  env: MemberEnv,
  inviterId: string,
  target: Target,
  targetId: string,
  email: string,
  role: "viewer" | "editor",
): Promise<string> {
  const token = inviteToken();
  const at = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE invites SET status = 'revoked', revoked = 1, updated_at = ?4
        WHERE email = ?1 AND target_type = ?2 AND target_id = ?3 AND status = 'pending'`,
    ).bind(email, target, targetId, at),
    env.DB.prepare(
      `INSERT INTO invites (token,target_type,target_id,email,role,invited_by,created_at,status,updated_at)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
    ).bind(token, target, targetId, email, role, inviterId, at, at),
  ]);
  return token;
}

export async function addMember(
  env: MemberEnv,
  target: Target,
  targetId: string,
  userId: string,
  role: "viewer" | "editor",
  invitedBy: string | null,
): Promise<void> {
  const { table, key } = TABLES[target];
  await env.DB.prepare(
    `INSERT OR REPLACE INTO ${table} (${key}, user_id, role, invited_by, created_at)
     VALUES (?,?,?,?,?)`,
  )
    .bind(targetId, userId, role, invitedBy, Date.now())
    .run();
}

export async function removeMember(
  env: MemberEnv,
  target: Target,
  targetId: string,
  userId: string,
): Promise<boolean> {
  const { table, key } = TABLES[target];
  const res = await env.DB.prepare(`DELETE FROM ${table} WHERE ${key} = ? AND user_id = ?`)
    .bind(targetId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: number;
}

export interface OwnerRow {
  user_id: string;
  email: string;
  name: string | null;
}

/** Everyone with access, the owner first, then pending invites separately. */
export async function membersOf(
  env: MemberEnv,
  target: Target,
  targetId: string,
): Promise<{
  members: MemberRow[];
  pending: Array<{ token: string; email: string; role: Role; has_account: number }>;
  /** Workspaces only: who owns it, since no membership row says. */
  owner?: OwnerRow;
}> {
  const { table, key } = TABLES[target];
  const roleSql = target === "workspace" ? MEMBER_ROLE("m") : "m.role";

  const members = await env.DB.prepare(
    `SELECT m.user_id, u.email, u.name, ${roleSql} AS role, m.created_at
       FROM ${table} m JOIN users u ON u.id = m.user_id
      WHERE m.${key} = ?
      ORDER BY m.created_at`,
  )
    .bind(targetId)
    .all<MemberRow>();

  // `has_account` is what the people list says the invite is waiting on: for
  // them to accept, or for them to sign up first.
  const pending = await env.DB.prepare(
    `SELECT i.token, i.email, i.role,
            EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = i.email AND u.status = 'active') AS has_account
       FROM invites i
      WHERE i.target_type = ? AND i.target_id = ? AND i.status = 'pending'
      ORDER BY i.created_at`,
  )
    .bind(target, targetId)
    .all<{ token: string; email: string; role: Role; has_account: number }>();

  const owner =
    target === "workspace"
      ? ((await env.DB.prepare(
          `SELECT u.id AS user_id, u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?`,
        )
          .bind(targetId)
          .first<OwnerRow>()) ?? undefined)
      : undefined;

  return { members: members.results ?? [], pending: pending.results ?? [], ...(owner ? { owner } : {}) };
}

export interface PendingForMe {
  token: string;
  target_type: Target;
  target_id: string;
  target_name: string;
  role: "viewer" | "editor";
  invited_by: { email: string; name: string | null };
  created_at: number;
}

/**
 * What is waiting for this person to answer.
 *
 * Read on demand, by address, so it is the same whichever way they signed in
 * and nothing has to remember to run at the right moment. Invitations to
 * something that has since been deleted or closed, or from someone whose
 * account has been deleted, are left out: there is nothing to accept.
 */
export async function pendingFor(env: MemberEnv, rawEmail: string): Promise<PendingForMe[]> {
  const email = normaliseEmail(rawEmail);
  if (!email) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT i.token, i.target_type, i.target_id, i.role, i.created_at,
              u.email AS inviter_email, u.name AS inviter_name,
              CASE i.target_type
                WHEN 'workspace' THEN (SELECT w.name FROM workspaces w WHERE w.id = i.target_id AND w.status = 'active')
                WHEN 'board' THEN (SELECT b.name FROM boards b WHERE b.id = i.target_id AND ${NOT_CLOSED("b")})
                ELSE (SELECT COALESCE(NULLIF(n.title, ''), 'Untitled') FROM nodes n JOIN boards b ON b.id = n.board_id
                       WHERE n.id = i.target_id AND ${NOT_CLOSED("b")})
              END AS target_name
         FROM invites i JOIN users u ON u.id = i.invited_by
        WHERE i.email = ?1 AND i.status = 'pending' AND u.status = 'active'
          AND (i.expires_at IS NULL OR i.expires_at > ?2)
     ) WHERE target_name IS NOT NULL
     ORDER BY created_at DESC`,
  )
    .bind(email, Date.now())
    .all<any>();
  return (results ?? []).map((r) => ({
    token: r.token,
    target_type: r.target_type,
    target_id: r.target_id,
    target_name: r.target_name,
    role: r.role,
    invited_by: { email: r.inviter_email, name: r.inviter_name ?? null },
    created_at: r.created_at,
  }));
}

export type Answer = { ok: true; target_type: Target; target_id: string; role: Role } | ({ ok: false } & Denied);

interface InviteRow {
  token: string;
  target_type: Target;
  target_id: string;
  email: string;
  role: "viewer" | "editor";
  invited_by: string;
  status: string;
  expires_at: number | null;
}

/**
 * The invitation this person may answer, or why not.
 *
 * The same not-found for "no such token", "not addressed to you" and "taken
 * back" so a token in someone else's hands tells them nothing; the inviter
 * revoking is the one thing that looks, to the invitee, like it never was. An
 * invitation already accepted or declined is a conflict.
 */
async function mine(env: MemberEnv, rawEmail: string, token: string): Promise<{ row: InviteRow } | { fail: Answer & { ok: false } }> {
  const row = await env.DB.prepare(
    `SELECT token, target_type, target_id, email, role, invited_by, status, expires_at FROM invites WHERE token = ?`,
  )
    .bind(token)
    .first<InviteRow>();
  const gone = { fail: { ok: false, status: 404, error: "not found" } as Answer & { ok: false } };
  if (!row || row.email !== normaliseEmail(rawEmail)) return gone;
  if (row.status === "revoked") return gone;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return gone;
  if (row.status !== "pending")
    return { fail: { ok: false, status: 409, error: `That invitation was already ${row.status}.` } };
  return { row };
}

/** Is whatever this invitation is to hidden because its workspace is closed, or gone? */
async function unavailable(db: D1Database, row: InviteRow): Promise<boolean> {
  if (row.target_type === "workspace") {
    const w = await db.prepare(`SELECT status FROM workspaces WHERE id = ?`).bind(row.target_id).first<{ status: string }>();
    return !w || w.status !== "active";
  }
  const sql =
    row.target_type === "board"
      ? `SELECT 1 AS x FROM boards b WHERE b.id = ?1 AND ${NOT_CLOSED("b")}`
      : `SELECT 1 AS x FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?1 AND ${NOT_CLOSED("b")}`;
  return !(await db.prepare(sql).bind(row.target_id).first());
}

/**
 * Accept: the person becomes a member, with the role they were invited with.
 *
 * Checked again now, not trusted from when it was sent. The inviter must still
 * be able to hand this out: an admin who was demoted, or removed, after
 * inviting someone must not be able to leave a standing offer behind them. If
 * they cannot, the invitation is ended as revoked and the person is told it is
 * no longer valid. Someone who already holds a membership keeps it: an
 * invitation never lowers or replaces what is already in place.
 */
export async function acceptInvite(
  env: MemberEnv,
  userId: string,
  rawEmail: string,
  token: string,
): Promise<Answer> {
  const found = await mine(env, rawEmail, token);
  if ("fail" in found) return found.fail;
  const { row } = found;

  // Invitations are addressed to an email, so they are only handed to an account
  // that has proven it owns the address (when the instance can send mail).
  if (!(await mayClaimInvites(env, userId)))
    return { ok: false, status: 403, error: "Confirm your email address first.", code: "email_unverified" };

  if (await unavailable(env.DB, row)) return { ok: false, status: 404, error: "not found" };

  // An organisation that requires SSO of this person is joined through its SSO.
  assertNotBlocked(env.DB, userId, await workspaceOfTarget(env.DB, row.target_type, row.target_id));

  const inviter = await env.DB.prepare(`SELECT status FROM users WHERE id = ?`).bind(row.invited_by).first<{ status: string }>();
  if (inviter?.status !== "active" || !(await canGrant(env, row.invited_by, row.target_type, row.target_id))) {
    await endInvite(env, row.token, "revoked");
    return { ok: false, status: 409, error: "That invitation is no longer valid." };
  }

  const held =
    row.target_type === "workspace" &&
    (await env.DB.prepare(
      `SELECT 1 AS x FROM workspaces w
        WHERE w.id = ?1
          AND (w.owner_id = ?2
               OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?2))`,
    )
      .bind(row.target_id, userId)
      .first());

  // An invitation sent before the organisation restricted invitations does not
  // outlive the restriction: the standing offer is withdrawn rather than honoured.
  if (!held && (await inviteRefused(env.DB, await workspaceOfTarget(env.DB, row.target_type, row.target_id), row.email))) {
    await endInvite(env, row.token, "revoked");
    return { ok: false, status: 409, error: INVITE_RESTRICTED_MESSAGE, code: "invite_domain_restricted" };
  }

  const at = Date.now();
  const { table, key } = TABLES[row.target_type];
  await env.DB.batch([
    // Only while still pending, in the same transaction as the status change,
    // so two answers racing cannot both win.
    ...(held
      ? []
      : [
          env.DB.prepare(
            `INSERT OR REPLACE INTO ${table} (${key}, user_id, role, invited_by, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM invites WHERE token = ?6 AND status = 'pending')`,
          ).bind(row.target_id, userId, row.role, row.invited_by, at, row.token),
        ]),
    env.DB.prepare(
      `UPDATE invites SET status = 'accepted', accepted_at = ?2, accepted_by = ?3, updated_at = ?2
        WHERE token = ?1 AND status = 'pending'`,
    ).bind(row.token, at, userId),
  ]);
  return { ok: true, target_type: row.target_type, target_id: row.target_id, role: row.role };
}

/** Decline: the invitation ends, and nothing else changes. */
export async function declineInvite(env: MemberEnv, rawEmail: string, token: string): Promise<Answer> {
  const found = await mine(env, rawEmail, token);
  if ("fail" in found) return found.fail;
  await endInvite(env, found.row.token, "declined");
  return { ok: true, target_type: found.row.target_type, target_id: found.row.target_id, role: found.row.role };
}

/**
 * End a pending invitation with a status.
 *
 * `revoked` is set alongside for declined as well as revoked ones, because it
 * is the column the Worker before 0030 reads: to it, a finished invitation is
 * one that is accepted or revoked, and it must not offer a declined one again.
 */
async function endInvite(env: MemberEnv, token: string, status: "declined" | "revoked"): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE invites SET status = ?2, revoked = 1, updated_at = ?3 WHERE token = ?1 AND status = 'pending'`,
  )
    .bind(token, status, Date.now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** The inviter takes an invitation back. Anyone else gets not-found. */
export async function revokeInvite(
  env: MemberEnv,
  inviterId: string,
  token: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE invites SET status = 'revoked', revoked = 1, updated_at = ?3
      WHERE token = ?1 AND invited_by = ?2 AND status = 'pending'`,
  )
    .bind(token, inviterId, Date.now())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Who may change whom, in a workspace
// ---------------------------------------------------------------------------
//
// Four roles, one owner. The rules, all enforced here and nowhere else:
//
//   owner    exactly one. Never a membership row. Cannot be removed, demoted or
//            leave: the only way it moves is `transferOwnership`, which makes
//            the old owner an admin. "The last owner" and "the owner" are the
//            same person, so one rule covers both.
//   admin    manages editors and viewers: invite, change role, remove, and
//            rename or delete mindmaps. Cannot touch the owner, another admin,
//            or the admin role itself.
//   editor / viewer  as before.
//
// Why admins cannot appoint or remove admins: an admin who could would be able
// to mint peers the owner never chose, or evict the owner's other deputies, and
// the owner could not undo it without being online. Appointing and demoting
// admins, like transferring ownership, stays with the owner. Admins can still
// leave. The cost is that an admin cannot manage another admin; the owner can.
//
// Personal homes are not organisations: no admin role and no transfer there.

export type RoleChange = { ok: true; role: "admin" | "editor" | "viewer" } | ({ ok: false } & Denied);

const ASSIGNABLE = new Set(["admin", "editor", "viewer"]);

/** The workspace row the rules need, or null. */
async function workspaceFacts(db: D1Database, workspaceId: string) {
  return db
    .prepare(`SELECT owner_id, personal FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ owner_id: string; personal: number }>();
}

/** The target's current workspace role, if they are an active member. */
async function activeMemberRole(db: D1Database, workspaceId: string, userId: string): Promise<Role | null> {
  const row = await db
    .prepare(
      `SELECT ${MEMBER_ROLE("m")} AS role
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.user_id = ? AND u.status = 'active'`,
    )
    .bind(workspaceId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

/** Change an existing member's role. */
export async function changeMemberRole(
  env: MemberEnv,
  actorId: string,
  workspaceId: string,
  targetId: string,
  role: unknown,
): Promise<RoleChange> {
  const actor = await workspaceRole(env.DB, actorId, workspaceId);
  if (!actor) return { ok: false, status: 404, error: "not found" };
  if (!canAdmin(actor)) return { ok: false, status: 403, error: "You cannot change who has access." };

  const ws = await workspaceFacts(env.DB, workspaceId);
  if (!ws) return { ok: false, status: 404, error: "not found" };

  if (targetId === ws.owner_id) {
    return isOwner(actor)
      ? { ok: false, status: 409, error: "The owner's role cannot be changed. Transfer ownership to someone else first." }
      : { ok: false, status: 403, error: "Only the owner can change the owner." };
  }

  if (typeof role !== "string" || !ASSIGNABLE.has(role))
    return { ok: false, status: 400, error: "Role must be admin, editor or viewer." };
  if (role === "admin" && ws.personal)
    return { ok: false, status: 400, error: "A personal workspace has no admins." };

  const current = await activeMemberRole(env.DB, workspaceId, targetId);
  if (!current) return { ok: false, status: 404, error: "not found" };

  if (!isOwner(actor) && (role === "admin" || current === "admin"))
    return { ok: false, status: 403, error: "Only the owner can appoint or change admins." };

  await env.DB.prepare(
    `UPDATE workspace_members SET role = ?3, admin = ?4 WHERE workspace_id = ?1 AND user_id = ?2`,
  )
    .bind(workspaceId, targetId, role === "viewer" ? "viewer" : "editor", role === "admin" ? 1 : 0)
    .run();
  return { ok: true, role: role as "admin" | "editor" | "viewer" };
}

export type Removal = { ok: true } | ({ ok: false } & Denied);

/**
 * Remove a member of a workspace, or let them leave.
 *
 * Leaving is always allowed except for the owner. Removing someone else needs
 * admin, and removing an admin needs the owner.
 */
export async function removeWorkspaceMember(
  env: MemberEnv,
  actorId: string,
  workspaceId: string,
  targetId: string,
): Promise<Removal> {
  const actor = await workspaceRole(env.DB, actorId, workspaceId);
  if (targetId !== actorId && !canAdmin(actor))
    return { ok: false, status: 403, error: "You cannot change who has access." };

  const ws = await workspaceFacts(env.DB, workspaceId);
  if (ws && targetId === ws.owner_id) {
    return targetId === actorId
      ? { ok: false, status: 409, error: "The owner cannot leave. Transfer ownership to someone else first." }
      : { ok: false, status: 403, error: "The owner cannot be removed." };
  }

  const current = await activeMemberRole(env.DB, workspaceId, targetId);
  if (current === "admin" && targetId !== actorId && !isOwner(actor))
    return { ok: false, status: 403, error: "Only the owner can remove an admin." };

  // The record and the removal are one batch, and the record is written from
  // the row about to go, so it holds the role they really had and exists only
  // if they really were a member. Leaving and being removed look the same to
  // the access tables and differ here: who did it.
  const [, gone] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_member_events (id, workspace_id, user_id, status, role, actor_user_id, created_at, updated_at)
       SELECT ?1, m.workspace_id, m.user_id, ?2, ${MEMBER_ROLE("m")}, ?3, ?4, ?4
         FROM workspace_members m WHERE m.workspace_id = ?5 AND m.user_id = ?6`,
    ).bind(crypto.randomUUID(), targetId === actorId ? "left" : "removed", actorId, Date.now(), workspaceId, targetId),
    env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).bind(workspaceId, targetId),
  ]);
  return (gone?.meta?.changes ?? 0) > 0 ? { ok: true } : { ok: false, status: 404, error: "not found" };
}

export type Transfer = { ok: true; ownerId: string } | ({ ok: false } & Denied);

/**
 * Hand a workspace to an existing, active member. The old owner stays on as an
 * admin; nothing is deleted.
 *
 * One batch, so it happens entirely or not at all and there is never a moment
 * with no owner or two. D1 runs a batch in a single transaction but cannot
 * branch, so the first statement writes the audit row only if every condition
 * holds *now* (still the owner, a shared workspace, the target an active
 * member), and each later statement is conditional on that row. Two racing
 * transfers therefore cannot both win, and a lost race leaves nothing behind.
 */
export async function transferOwnership(
  env: MemberEnv,
  actorId: string,
  workspaceId: string,
  toUserId: unknown,
): Promise<Transfer> {
  const actor = await workspaceRole(env.DB, actorId, workspaceId);
  if (!actor) return { ok: false, status: 404, error: "not found" };
  if (!isOwner(actor)) return { ok: false, status: 403, error: "Only the owner can transfer ownership." };

  const ws = await workspaceFacts(env.DB, workspaceId);
  if (!ws) return { ok: false, status: 404, error: "not found" };
  if (ws.personal) return { ok: false, status: 400, error: "A personal workspace cannot be transferred." };

  if (typeof toUserId !== "string" || !toUserId || toUserId === actorId)
    return { ok: false, status: 400, error: "Choose another member to make the owner." };
  if (!(await activeMemberRole(env.DB, workspaceId, toUserId)))
    return { ok: false, status: 400, error: "Ownership can only be transferred to an existing member." };

  const id = crypto.randomUUID();
  const at = Date.now();
  const done = `EXISTS (SELECT 1 FROM workspace_ownership_transfers WHERE id = ?1)`;
  const [audit] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_ownership_transfers
         (id, workspace_id, from_user_id, to_user_id, status, created_at, updated_at)
       SELECT ?1, w.id, w.owner_id, ?2, 'completed', ?3, ?3
         FROM workspaces w
        WHERE w.id = ?4 AND w.owner_id = ?5 AND w.personal = 0
          AND EXISTS (SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
                       WHERE m.workspace_id = w.id AND m.user_id = ?2 AND u.status = 'active')`,
    ).bind(id, toUserId, at, workspaceId, actorId),
    env.DB.prepare(`UPDATE workspaces SET owner_id = ?2 WHERE id = ?3 AND ${done}`).bind(id, toUserId, workspaceId),
    env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?2 AND user_id = ?3 AND ${done}`).bind(
      id, workspaceId, toUserId,
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, admin, invited_by, created_at)
       SELECT ?2, ?3, 'editor', 1, ?4, ?5 WHERE ${done}`,
    ).bind(id, workspaceId, actorId, toUserId, at),
  ]);
  if ((audit?.meta?.changes ?? 0) < 1)
    return { ok: false, status: 409, error: "Ownership changed while you were doing that. Reload and try again." };
  return { ok: true, ownerId: toUserId };
}
