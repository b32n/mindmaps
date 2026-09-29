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

import { canAdmin, canWrite, boardRole, nodeRole, workspaceRole, type Role } from "./access";

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
 * Workspaces and mindmaps: owners only. Sharing is not something an editor
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

export interface InviteResult {
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

/** Everyone with access, the owner first, then pending invites separately. */
export async function membersOf(
  env: MemberEnv,
  target: Target,
  targetId: string,
): Promise<{ members: MemberRow[]; pending: Array<{ token: string; email: string; role: Role }> }> {
  const { table, key } = TABLES[target];

  const members = await env.DB.prepare(
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at
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

  return { members: members.results ?? [], pending: pending.results ?? [] };
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
      await addMember(env, row.target_type, row.target_id, userId, row.role, null);
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
