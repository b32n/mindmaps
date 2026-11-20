/**
 * Inviting people, and letting them in.
 *
 * Two cases, and they are genuinely different:
 *
 *   the invitee has an account   they become a member immediately
 *   they do not                  an invite row waits for them to sign up
 *
 * The second is why `invites` exists at all. Access cannot be a row in
 * `workspace_members` before there is a user to point at, and inventing a
 * placeholder user would put a half-real account in the table every read path
 * trusts.
 *
 * Invites are claimed by email on sign-in. That means the address someone signs
 * up with is what grants them access, so it must be compared the way an email
 * provider would: lowercased, trimmed, exact. No fuzzy matching, no plus-address
 * normalisation — being clever here is how you hand someone else's workspace to
 * a lookalike address.
 */

import { MEMBER_ROLE, canAdmin, canWrite, boardRole, isOwner, nodeRole, workspaceRole, type Role } from "./access";

export interface MemberEnv {
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
}

export interface InviteResult {
  /** Set when the rules for who may change whom say no. */
  denied?: Denied;
  /** Set when the invitee already had an account and is now a member. */
  added?: { userId: string; email: string; role: Role };
  /** Set when they do not, and something has to be sent to them. */
  invited?: { token: string; email: string; role: Role };
}

/**
 * Invite someone, by email.
 *
 * An existing account is added straight away rather than sent a link to click.
 * That matches what people expect of a workspace — you are added and you see it
 * appear — and avoids an invite that sits unclaimed because it went to a spam
 * folder. Someone who does not want to be there can leave.
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

  const existing = await env.DB.prepare(`SELECT id, email FROM users WHERE lower(email) = ?`)
    .bind(email)
    .first<{ id: string; email: string }>();

  if (existing) {
    // Inviting yourself is a no-op rather than an error: it is a harmless
    // mistake, and refusing it tells the inviter nothing useful.
    if (existing.id === inviterId) return { added: { userId: existing.id, email, role } };
    if (target === "workspace") {
      // Someone who is already in the workspace is not "added": inviting them
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
    }
    await addMember(env, target, targetId, existing.id, role, inviterId);
    return { added: { userId: existing.id, email: existing.email, role } };
  }

  const token = inviteToken();
  await env.DB.prepare(
    `INSERT INTO invites (token,target_type,target_id,email,role,invited_by,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(token, target, targetId, email, role, inviterId, Date.now())
    .run();
  return { invited: { token, email, role } };
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
  pending: Array<{ token: string; email: string; role: Role }>;
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

  const pending = await env.DB.prepare(
    `SELECT token, email, role FROM invites
      WHERE target_type = ? AND target_id = ? AND accepted_at IS NULL AND revoked = 0
      ORDER BY created_at`,
  )
    .bind(target, targetId)
    .all<{ token: string; email: string; role: Role }>();

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

/**
 * Turn every invite addressed to this email into real access.
 *
 * Called on sign-in and on sign-up, not just sign-up: someone may be invited
 * after they already have an account but before they next log in, and an invite
 * that only ever fires at registration would strand them.
 *
 * Expired and revoked invites are skipped but left in place, so the inviter can
 * still see that they were sent.
 */
export async function claimInvites(
  env: MemberEnv,
  userId: string,
  rawEmail: string,
): Promise<number> {
  const email = normaliseEmail(rawEmail);
  if (!email) return 0;

  const { results } = await env.DB.prepare(
    `SELECT token, target_type, target_id, role FROM invites
      WHERE email = ? AND accepted_at IS NULL AND revoked = 0
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(email, Date.now())
    .all<{ token: string; target_type: Target; target_id: string; role: "viewer" | "editor" }>();

  const rows = results ?? [];
  for (const row of rows) {
    // Each invite is claimed on its own. One pointing at something since
    // deleted must not stop the rest — the foreign key will refuse it and the
    // others still land.
    try {
      // An invite must never overwrite something stronger already in place: the
      // address may belong to the workspace's owner, or to someone since made
      // an admin, and REPLACE would quietly demote them.
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
      if (!held) await addMember(env, row.target_type, row.target_id, userId, row.role, null);
      await env.DB.prepare(
        `UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE token = ?`,
      )
        .bind(Date.now(), userId, row.token)
        .run();
    } catch (err) {
      console.error("invite claim failed", row.token, err);
    }
  }
  return rows.length;
}

export async function revokeInvite(
  env: MemberEnv,
  inviterId: string,
  token: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE invites SET revoked = 1 WHERE token = ? AND invited_by = ? AND accepted_at IS NULL`,
  )
    .bind(token, inviterId)
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

  return (await removeMember(env, "workspace", workspaceId, targetId))
    ? { ok: true }
    : { ok: false, status: 404, error: "not found" };
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
