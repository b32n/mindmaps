/**
 * Enforce SSO, at the one place every read goes through.
 *
 * An organisation can require its members to use its SSO. A person is subject to
 * that when their address is on one of the organisation's verified domains, and
 * what they have to show is a session that came through that organisation's SSO.
 * Anything else (a password session, a Google one, an OAuth connection made from
 * one) is refused for that organisation's workspace and nothing else.
 *
 * ## How it reaches every query
 *
 * Access is decided in access.ts, but a request's session is known only at the
 * front door. Rather than thread "which organisations is this session locked out
 * of" through every call (and silently fail open wherever one is missed), the
 * front door wraps the request's database handle: `scopeDb(db, user, blocked)`.
 * Everything the request does goes through that handle, so:
 *
 *  - role lookups (`workspaceRole`, `boardRole`, `nodeRole`) see the block for
 *    that user and throw `SsoRequiredError` when they would have granted a role,
 *    which the Worker answers as 403 `sso_required`;
 *  - the SQL fragments that decide what a list may contain carry a marker (a
 *    comment reading "sso:" and a column name; see `notBlocked`), and the
 *    wrapper's `prepare` replaces it with `<column> NOT IN (...) AND`, so a
 *    locked workspace's mindmaps simply are not there. On an unwrapped handle (the cron, a share link) the marker is just a
 *    comment and nothing changes.
 *
 * A request with nothing blocked (nearly all of them) gets the plain handle back.
 */

export class SsoRequiredError extends Error {
  readonly code = "sso_required";
  constructor(readonly workspaceId: string) {
    super("This organisation requires single sign-on. Sign in with SSO to open it.");
    this.name = "SsoRequiredError";
  }
}

interface Scope {
  userId: string;
  blocked: ReadonlySet<string>;
}

const scopes = new WeakMap<object, Scope>();
const targets = new WeakMap<object, D1Database>();
const EMPTY: ReadonlySet<string> = new Set();

/** Ids are UUIDs; refuse to inline anything else rather than escape it. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const MARK = /\/\*sso:([A-Za-z0-9_.]+)\*\//g;

/** The marker a fragment puts where a workspace column must not be a locked one. */
export const notBlocked = (column: string) => `/*sso:${column}*/`;

export function scopeDb(db: D1Database, userId: string, blocked: readonly string[]): D1Database {
  const ids = blocked.filter((b) => SAFE_ID.test(b));
  if (!ids.length) return db;
  const list = ids.map((i) => `'${i}'`).join(",");
  const proxy: D1Database = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => target.prepare(sql.replace(MARK, (_m, col) => `${col} NOT IN (${list}) AND `));
      const v = Reflect.get(target, key) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  scopes.set(proxy, { userId, blocked: new Set(ids) });
  targets.set(proxy, db);
  return proxy;
}

/**
 * The plain handle behind a scoped one. For the few things that must see past
 * the lock to describe it (the organisation's own state, and the owner's way
 * back in to the settings, see docs/SSO.md), never for reading content.
 */
export const unscoped = (db: D1Database): D1Database => targets.get(db) ?? db;

/** The workspaces `userId` is locked out of on this handle (none, for any other user or an unwrapped handle). */
export function blockedFor(db: D1Database, userId: string): ReadonlySet<string> {
  const s = scopes.get(db);
  return s && s.userId === userId ? s.blocked : EMPTY;
}

/** Throws if this handle's user is locked out of `workspaceId`. */
export function assertNotBlocked(db: D1Database, userId: string, workspaceId: string | null | undefined): void {
  if (workspaceId && blockedFor(db, userId).has(workspaceId)) throw new SsoRequiredError(workspaceId);
}

/** The domain part of an address, lowercased, or null. */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).trim().toLowerCase() : null;
}

/**
 * The organisations that require SSO of this address, which this session has not
 * satisfied: enforcement on, SSO enabled, the workspace open, the address's
 * domain verified for it, and the session not one of its SSO's.
 */
export async function blockedWorkspaces(db: D1Database, email: string, ssoWorkspaceId: string | null): Promise<string[]> {
  const domain = domainOfEmail(email);
  if (!domain) return [];
  const rows = await db
    .prepare(
      `SELECT p.workspace_id AS id
         FROM org_domains d
         JOIN org_policies p ON p.workspace_id = d.workspace_id AND p.enforce_sso = 1
         JOIN org_sso_configs c ON c.workspace_id = d.workspace_id AND c.status = 'enabled'
         JOIN workspaces w ON w.id = d.workspace_id AND w.status = 'active'
        WHERE d.domain = ?1 AND d.status = 'verified'`,
    )
    .bind(domain)
    .all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id).filter((id) => id !== ssoWorkspaceId);
}
