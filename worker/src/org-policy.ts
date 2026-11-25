/**
 * The settings of an organisation that rest on its verified domains: who may
 * join by themselves, and who may be invited. And who may change them.
 *
 * Policy belongs to one organisation, never the instance. It applies in org
 * mode (to its one organisation) and multitenant (to each); a personal install
 * refuses all of it with the same 403 `team_spaces_disabled` that creating an
 * organisation gets, because there is nothing for it to be about.
 *
 * Neither switch removes anyone. Auto-join adds a way in, never taking one away.
 * Restricting invites stops *new* invitations to other domains; people already
 * in stay in, and an owner or admin can always open the settings to undo it.
 * Both rest on a verified domain: with none, they are inert (and cannot be
 * switched on).
 */

import { canAdmin, isOwner, workspaceRole, type Role } from "./access";
import { domainsOf, verifiedDomains } from "./domains";
import { currentOrganisation, type Refusal } from "./organisation";
import { readMode, type ModeEnv } from "./mode";
import { assertNotBlocked, blockedFor, domainOfEmail, unscoped } from "./scope";

export interface PolicyEnv extends ModeEnv {
  DB: D1Database;
}

const refuse = (status: Refusal["status"], code: string, error: string): Refusal => ({ ok: false, status, code, error });

export const NOT_FOUND = refuse(404, "not_found", "not found");
const PERSONAL_INSTALL = refuse(
  403,
  "team_spaces_disabled",
  "This install is personal: it has no organisations, so no verified domains, domain policy or SSO. Switch MINDMAPS_MODE to org or multitenant to use them.",
);

export type Guarded = { ok: true; role: Role; workspaceId: string } | Refusal;

/**
 * May this person manage this organisation's domains, policy and SSO?
 *
 *   admin   owner or admin (domains and policy)
 *   owner   the owner only (SSO itself: whoever picks the identity provider can
 *           sign in as anyone on the organisation's domains, and an admin must
 *           not be able to become the owner that way)
 *
 * A stranger and a missing workspace get the same 404. A person locked out by
 * enforce-SSO is refused 403 `sso_required`, except the owner, who keeps the way
 * back in (docs/SSO.md, "Break-glass"): these settings are where enforcement is
 * switched off, and an identity provider that is down must not lock the owner
 * out of them.
 */
export async function guard(env: PolicyEnv, userId: string, workspaceId: string, need: "admin" | "owner"): Promise<Guarded> {
  const mode = readMode(env);
  if (mode === "personal") return PERSONAL_INSTALL;

  const db = unscoped(env.DB);
  const role = await workspaceRole(db, userId, workspaceId);
  if (!role) return NOT_FOUND;
  const ws = await db.prepare(`SELECT personal FROM workspaces WHERE id = ?`).bind(workspaceId).first<{ personal: number }>();
  if (!ws) return NOT_FOUND;
  const notOrg = refuse(404, "not_an_organisation", "This is not an organisation: a personal workspace has no domains, policy or SSO.");
  if (ws.personal) return notOrg;
  if (mode === "org" && (await currentOrganisation(db))?.workspace_id !== workspaceId) return notOrg;

  if (blockedFor(env.DB, userId).has(workspaceId) && !isOwner(role)) assertNotBlocked(env.DB, userId, workspaceId);

  if (!canAdmin(role)) return refuse(403, "forbidden", "Only an owner or admin can change this.");
  if (need === "owner" && !isOwner(role)) return refuse(403, "owner_only", "Only the owner can change single sign-on.");
  return { ok: true, role, workspaceId };
}

// ---------------------------------------------------------------------------
// The policy row
// ---------------------------------------------------------------------------

export interface Policy {
  auto_join: boolean;
  default_role: "viewer" | "editor";
  restrict_invites: boolean;
  enforce_sso: boolean;
}

interface PolicyRow {
  auto_join: number;
  default_role: string;
  restrict_invites: number;
  enforce_sso: number;
}

export async function policyOf(db: D1Database, workspaceId: string): Promise<Policy> {
  const r = await db.prepare(`SELECT auto_join, default_role, restrict_invites, enforce_sso FROM org_policies WHERE workspace_id = ? AND status = 'active'`).bind(workspaceId).first<PolicyRow>();
  return {
    auto_join: !!r?.auto_join,
    default_role: r?.default_role === "editor" ? "editor" : "viewer",
    restrict_invites: !!r?.restrict_invites,
    enforce_sso: !!r?.enforce_sso,
  };
}

const bool = (v: unknown) => typeof v === "boolean";

/** Write only what was sent. `enforce_sso` is not settable here: it has its own route and its own preconditions. */
export async function setPolicy(
  db: D1Database,
  workspaceId: string,
  actorId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; policy: Policy } | Refusal> {
  const keys = ["auto_join", "default_role", "restrict_invites"].filter((k) => k in body);
  if (!keys.length || "enforce_sso" in body)
    return refuse(400, "invalid_policy", "Send auto_join, default_role or restrict_invites.");
  if ("default_role" in body && body.default_role !== "viewer" && body.default_role !== "editor")
    return refuse(400, "invalid_role", "The default role is viewer or editor.");
  for (const k of ["auto_join", "restrict_invites"])
    if (k in body && !bool(body[k])) return refuse(400, "invalid_policy", `${k} is true or false.`);

  if ((body.auto_join === true || body.restrict_invites === true) && !(await verifiedDomains(db, workspaceId)).length)
    return refuse(409, "no_verified_domain", "Verify a domain first: this setting applies to the people on your verified domains.");

  const at = Date.now();
  await db
    .prepare(`INSERT OR IGNORE INTO org_policies (workspace_id, status, created_at, updated_at) VALUES (?1,'active',?2,?2)`)
    .bind(workspaceId, at)
    .run();
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  if ("auto_join" in body) (sets.push("auto_join = ?"), vals.push(body.auto_join ? 1 : 0));
  if ("default_role" in body) (sets.push("default_role = ?"), vals.push(String(body.default_role)));
  if ("restrict_invites" in body) (sets.push("restrict_invites = ?"), vals.push(body.restrict_invites ? 1 : 0));
  await db
    .prepare(`UPDATE org_policies SET ${sets.join(", ")}, updated_by = ?, updated_at = ? WHERE workspace_id = ?`)
    .bind(...vals, actorId, at, workspaceId)
    .run();
  return { ok: true, policy: await policyOf(db, workspaceId) };
}

/** Enforcement has its own switch; it needs SSO enabled (checked by the caller). */
export async function setEnforce(db: D1Database, workspaceId: string, actorId: string, on: boolean): Promise<void> {
  const at = Date.now();
  await db
    .prepare(`INSERT OR IGNORE INTO org_policies (workspace_id, status, created_at, updated_at) VALUES (?1,'active',?2,?2)`)
    .bind(workspaceId, at)
    .run();
  await db
    .prepare(`UPDATE org_policies SET enforce_sso = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ?`)
    .bind(on ? 1 : 0, actorId, at, workspaceId)
    .run();
}

// ---------------------------------------------------------------------------
// Restricting invitations
// ---------------------------------------------------------------------------

/** The workspace an invitation target lives in. */
export async function workspaceOfTarget(db: D1Database, target: "workspace" | "board" | "node", id: string): Promise<string | null> {
  if (target === "workspace") return id;
  const sql =
    target === "board"
      ? `SELECT workspace_id AS ws FROM boards WHERE id = ?`
      : `SELECT b.workspace_id AS ws FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?`;
  return (await db.prepare(sql).bind(id).first<{ ws: string | null }>())?.ws ?? null;
}

/**
 * Is an invitation to `email`, to something in this workspace, refused by its
 * policy? Only when invites are restricted *and* there is at least one verified
 * domain to restrict them to, and only for a real organisation.
 */
export async function inviteRefused(db: D1Database, workspaceId: string | null, email: string): Promise<boolean> {
  if (!workspaceId) return false;
  const p = await db
    .prepare(
      `SELECT 1 AS x FROM org_policies p JOIN workspaces w ON w.id = p.workspace_id AND w.personal = 0 AND w.status = 'active'
        WHERE p.workspace_id = ? AND p.restrict_invites = 1`,
    )
    .bind(workspaceId)
    .first();
  if (!p) return false;
  const domains = await verifiedDomains(db, workspaceId);
  if (!domains.length) return false;
  const d = domainOfEmail(email);
  return !d || !domains.includes(d);
}

export const INVITE_RESTRICTED_MESSAGE =
  "This organisation only invites people on its verified domains. Ask an owner or admin to add the address's domain, or to turn that restriction off.";

// ---------------------------------------------------------------------------
// Auto-join
// ---------------------------------------------------------------------------

export interface Joiner {
  id: string;
  email: string;
  proven_via?: string | null;
}

export interface Offer {
  workspace_id: string;
  name: string;
  role: "viewer" | "editor";
}

/** Organisations whose auto-join covers this person's address, that they are not already in. */
async function candidates(env: PolicyEnv, user: Joiner, workspaceId?: string): Promise<Array<Offer & { personal?: never }>> {
  const domain = domainOfEmail(user.email);
  if (!domain) return [];
  const db = unscoped(env.DB);
  const rows = await db
    .prepare(
      `SELECT p.workspace_id, w.name, p.default_role AS role
         FROM org_domains d
         JOIN org_policies p ON p.workspace_id = d.workspace_id AND p.auto_join = 1
         JOIN workspaces w ON w.id = d.workspace_id AND w.status = 'active' AND w.personal = 0
        WHERE d.domain = ?1 AND d.status = 'verified' AND (?2 IS NULL OR d.workspace_id = ?2)`,
    )
    .bind(domain, workspaceId ?? null)
    .all<{ workspace_id: string; name: string; role: string }>();
  let list = rows.results ?? [];
  if (readMode(env) === "org") {
    const org = await currentOrganisation(db);
    list = list.filter((r) => r.workspace_id === org?.workspace_id);
  }
  return list.map((r) => ({ workspace_id: r.workspace_id, name: r.name, role: r.role === "editor" ? "editor" : "viewer" }));
}

const memberOf = async (db: D1Database, userId: string, ws: string) =>
  !!(await db
    .prepare(`SELECT 1 AS x FROM workspaces w WHERE w.id = ?1 AND (w.owner_id = ?2 OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?2))`)
    .bind(ws, userId)
    .first());

/**
 * What this session may be offered. An address that has not been proven by this
 * sign-in (Google, or the organisation's SSO) is not shown the organisation at
 * all, only told that proving it would unlock something: anyone can type an
 * address into a password form.
 */
export async function joinOffers(env: PolicyEnv, user: Joiner): Promise<{ offers: Offer[]; unproven: boolean } | Refusal> {
  if (readMode(env) === "personal") return PERSONAL_INSTALL;
  const db = unscoped(env.DB);
  const open: Offer[] = [];
  for (const c of await candidates(env, user)) if (!(await memberOf(db, user.id, c.workspace_id))) open.push(c);
  if (!open.length) return { offers: [], unproven: false };
  const locked = blockedFor(env.DB, user.id);
  const usable = open.filter((o) => !locked.has(o.workspace_id));
  if (!user.proven_via || usable.length < open.length) return { offers: [], unproven: true };
  return { offers: usable, unproven: false };
}

export async function joinOrganisation(
  env: PolicyEnv,
  user: Joiner,
  workspaceId: string,
): Promise<{ ok: true; workspace_id: string; role: "viewer" | "editor" } | Refusal> {
  if (readMode(env) === "personal") return PERSONAL_INSTALL;
  const db = unscoped(env.DB);
  const cand = (await candidates(env, user, workspaceId))[0];
  // One answer for "no such organisation", "not your domain" and "no auto-join":
  // a person must not be able to probe which organisations hold which domains.
  if (!cand) return refuse(404, "join_not_available", "There is nothing to join here.");
  if (await memberOf(db, user.id, workspaceId)) return refuse(409, "already_member", "You are already in this organisation.");
  assertNotBlocked(env.DB, user.id, workspaceId);
  if (!user.proven_via)
    return refuse(
      403,
      "email_unproven",
      "Joining by your address needs that address proven first. Confirm it by email, or sign in with Google or your organisation's SSO, then join.",
    );

  const at = Date.now();
  const batch = await db.batch([
    // Re-checks, in the statement that writes, that the policy still offers it.
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, admin, invited_by, created_at)
         SELECT ?1, ?2, ?3, 0, NULL, ?4
          WHERE EXISTS (SELECT 1 FROM org_policies WHERE workspace_id = ?1 AND auto_join = 1)
            AND EXISTS (SELECT 1 FROM org_domains WHERE workspace_id = ?1 AND domain = ?5 AND status = 'verified')`,
      )
      .bind(workspaceId, user.id, cand.role, at, domainOfEmail(user.email)),
  ]);
  if ((batch[0]?.meta?.changes ?? 0) < 1) return refuse(404, "join_not_available", "There is nothing to join here.");
  await db
    .prepare(
      `INSERT INTO workspace_member_events (id, workspace_id, user_id, status, role, actor_user_id, created_at, updated_at)
       VALUES (?1,?2,?3,'joined',?4,?3,?5,?5)`,
    )
    .bind(crypto.randomUUID(), workspaceId, user.id, cand.role, at)
    .run();
  return { ok: true, workspace_id: workspaceId, role: cand.role };
}

// ---------------------------------------------------------------------------
// Everything the settings page shows
// ---------------------------------------------------------------------------

export interface SsoSummary {
  status: "none" | "draft" | "tested" | "enabled";
  issuer: string | null;
  client_id: string | null;
  /** That a secret is stored: never what it is. */
  has_secret: boolean;
  tested_at: number | null;
  /** The address to register with the identity provider as the redirect (callback) URL. */
  redirect_uri: string;
}

export async function ssoSummary(db: D1Database, workspaceId: string, redirectUri: string): Promise<SsoSummary> {
  const c = await db
    .prepare(`SELECT status, issuer, client_id, client_secret_enc, tested_at FROM org_sso_configs WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<{ status: string; issuer: string | null; client_id: string | null; client_secret_enc: string | null; tested_at: number | null }>();
  if (!c || c.status === "removed") return { status: "none", issuer: null, client_id: null, has_secret: false, tested_at: null, redirect_uri: redirectUri };
  return {
    status: c.status as SsoSummary["status"],
    issuer: c.issuer,
    client_id: c.client_id,
    has_secret: !!c.client_secret_enc,
    tested_at: c.tested_at,
    redirect_uri: redirectUri,
  };
}

export async function securityOf(db: D1Database, workspaceId: string, redirectUri: string) {
  return {
    workspace_id: workspaceId,
    domains: await domainsOf(db, workspaceId),
    policy: await policyOf(db, workspaceId),
    sso: await ssoSummary(db, workspaceId, redirectUri),
  };
}
