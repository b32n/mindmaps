/**
 * SSO for an organisation: its configuration, and the two halves of a sign-in.
 *
 * The configuration is one OIDC provider per organisation (issuer, client id,
 * client secret). It moves through four states and each needs the one before:
 *
 *   draft    saved
 *   tested   a sign-in through it worked (the Test step, as the owner)
 *   enabled  people can use it; needs a verified domain
 *   (enforce is a policy switch that needs it enabled: see scope.ts)
 *
 * While it is enabled it cannot be edited: switch it off first. That, and
 * asking for the secret again whenever the issuer or client changes, is what
 * stops a stored secret being redirected to a provider someone else controls.
 *
 * A sign-in starts from an address (`startLogin`): the domain is found among the
 * verified ones, which names the organisation, which names the provider. It ends
 * at the callback (`completeSso`), which returns the provider's verified claims;
 * what to do with the person (find, link or create the account, start the
 * session) is in index.ts beside the Google sign-in it mirrors.
 */

import { verifiedDomains, holderOf } from "./domains";
import { currentOrganisation } from "./organisation";
import { readMode, type ModeEnv } from "./mode";
import {
  authorizeUrl, cleanIssuer, discover, exchangeCode, fetchJwks, OidcError, pkceChallenge, randomToken, verifyIdToken,
  type IdClaims,
} from "./oidc";
import { decryptSecret, encryptSecret, ssoKeyMaterial, type SecretsEnv } from "./secrets";
import { domainOfEmail } from "./scope";
import type { Refusal } from "./organisation";

export interface SsoEnv extends ModeEnv, SecretsEnv {}

const STATE_TTL_MS = 10 * 60_000;
const refuse = (status: Refusal["status"] | 502, code: string, error: string) => ({ ok: false as const, status, code, error });
export type Failure = ReturnType<typeof refuse>;

interface ConfigRow {
  workspace_id: string;
  status: "draft" | "tested" | "enabled" | "removed";
  issuer: string | null;
  client_id: string | null;
  client_secret_enc: string | null;
  tested_at: number | null;
}

const configOf = (db: D1Database, ws: string) =>
  db.prepare(`SELECT workspace_id, status, issuer, client_id, client_secret_enc, tested_at FROM org_sso_configs WHERE workspace_id = ?`).bind(ws).first<ConfigRow>();

// --- configuring -------------------------------------------------------------

export async function saveConfig(env: SsoEnv, ws: string, actorId: string, body: Record<string, unknown>): Promise<{ ok: true } | Failure> {
  const bad = (m: string) => refuse(400, "invalid_sso_config", m);
  const issuer = cleanIssuer(body.issuer);
  if (!issuer) return bad("The issuer is the https address of your identity provider, with no query.");
  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
  if (!clientId || clientId.length > 255) return bad("Enter the client ID your identity provider gave you.");
  const secretGiven = "client_secret" in body && body.client_secret !== undefined && body.client_secret !== null;
  if (secretGiven && (typeof body.client_secret !== "string" || body.client_secret.length > 4096)) return bad("The client secret is a string.");

  const existing = await configOf(env.DB, ws);
  const live = existing && existing.status !== "removed" ? existing : null;
  if (live?.status === "enabled") return refuse(409, "sso_enabled", "Switch SSO off before changing it.");

  const unchanged = !!live && live.issuer === issuer && live.client_id === clientId && !!live.client_secret_enc;
  const secret = secretGiven ? String(body.client_secret) : "";
  if (!secret && !unchanged)
    return refuse(400, "client_secret_required", "Enter the client secret. It is asked for again whenever the issuer or client ID changes.");

  const at = Date.now();
  const enc = secret ? await encryptSecret(await ssoKeyMaterial(env), ws, secret) : live!.client_secret_enc!;
  const keepStatus = unchanged && !secret ? live!.status : "draft";
  await env.DB
    .prepare(
      `INSERT INTO org_sso_configs (workspace_id, status, issuer, client_id, client_secret_enc, tested_at, updated_by, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
       ON CONFLICT(workspace_id) DO UPDATE SET status = ?2, issuer = ?3, client_id = ?4, client_secret_enc = ?5, tested_at = ?6, enabled_at = NULL, updated_by = ?7, updated_at = ?8`,
    )
    .bind(ws, keepStatus, issuer, clientId, enc, keepStatus === "draft" ? null : live!.tested_at, actorId, at)
    .run();
  return { ok: true };
}

/** Enable or disable. Enabling needs a passed test and a verified domain. Disabling also ends enforcement (the caller does, in the same breath). */
export async function setEnabled(env: SsoEnv, ws: string, actorId: string, on: boolean): Promise<{ ok: true } | Failure> {
  const c = await configOf(env.DB, ws);
  if (!c || c.status === "removed") return refuse(409, "sso_not_configured", "Set up SSO first.");
  const at = Date.now();
  if (on) {
    if (c.status !== "tested" && c.status !== "enabled") return refuse(409, "sso_not_tested", "Run the test sign-in first and make sure it works.");
    if (!(await verifiedDomains(env.DB, ws)).length) return refuse(409, "no_verified_domain", "Verify a domain first: SSO is how the people on your verified domains sign in.");
    await env.DB.prepare(`UPDATE org_sso_configs SET status = 'enabled', enabled_at = COALESCE(enabled_at, ?2), updated_by = ?3, updated_at = ?2 WHERE workspace_id = ?1`).bind(ws, at, actorId).run();
  } else {
    await env.DB.batch([
      env.DB.prepare(`UPDATE org_sso_configs SET status = CASE WHEN status = 'enabled' THEN 'tested' ELSE status END, enabled_at = NULL, updated_by = ?3, updated_at = ?2 WHERE workspace_id = ?1`).bind(ws, at, actorId),
      env.DB.prepare(`UPDATE org_policies SET enforce_sso = 0, updated_by = ?3, updated_at = ?2 WHERE workspace_id = ?1`).bind(ws, at, actorId),
    ]);
  }
  return { ok: true };
}

export async function isEnabled(db: D1Database, ws: string): Promise<boolean> {
  return (await configOf(db, ws))?.status === "enabled";
}

/** Forget the configuration: the secret is cleared, the row kept with its status. Enforcement ends with it. */
export async function removeConfig(env: SsoEnv, ws: string, actorId: string): Promise<void> {
  const at = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE org_sso_configs SET status = 'removed', issuer = NULL, client_id = NULL, client_secret_enc = NULL, tested_at = NULL, enabled_at = NULL, updated_by = ?3, updated_at = ?2 WHERE workspace_id = ?1`).bind(ws, at, actorId),
    env.DB.prepare(`UPDATE org_policies SET enforce_sso = 0, updated_by = ?3, updated_at = ?2 WHERE workspace_id = ?1`).bind(ws, at, actorId),
  ]);
}

// --- starting a sign-in ------------------------------------------------------

export const callbackUrl = (origin: string) => `${origin}/api/auth/sso/callback`;

async function begin(
  env: SsoEnv,
  c: ConfigRow,
  purpose: "login" | "test",
  origin: string,
  opts: { userId?: string; hint?: string; redirectTo: string; fetcher?: typeof fetch },
): Promise<{ ok: true; url: string } | Failure> {
  let disc;
  try {
    disc = await discover(c.issuer!, opts.fetcher);
  } catch (err) {
    console.error("sso discovery failed", c.workspace_id, (err as Error).message);
    return refuse(502, "sso_discovery_failed", `Could not reach the identity provider: ${(err as Error).message}`);
  }
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(32);
  const at = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO sso_login_states (state, workspace_id, purpose, user_id, nonce, code_verifier, issuer, redirect_to, status, expires_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9,?10,?10)`,
    )
    .bind(state, c.workspace_id, purpose, opts.userId ?? null, nonce, verifier, c.issuer!, opts.redirectTo, at + STATE_TTL_MS, at)
    .run();
  return {
    ok: true,
    url: authorizeUrl(disc, { clientId: c.client_id!, redirectUri: callbackUrl(origin), state, nonce, challenge: await pkceChallenge(verifier), loginHint: opts.hint }),
  };
}

export async function startTest(env: SsoEnv, ws: string, actor: { id: string; email: string }, origin: string) {
  const c = await configOf(env.DB, ws);
  if (!c || c.status === "removed") return refuse(409, "sso_not_configured", "Set up SSO first.");
  return begin(env, c, "test", origin, { userId: actor.id, hint: actor.email, redirectTo: "/app" });
}

const NOT_AVAILABLE = refuse(404, "sso_not_available", "Single sign-on is not set up for that address.");

/**
 * "Sign in with SSO": from an address to the provider's door. The same answer
 * whether the domain is unknown, held by an organisation without SSO, or SSO is
 * off, so this cannot be used to list which companies use it.
 */
export async function startLogin(env: SsoEnv, rawEmail: unknown, next: unknown, origin: string, fetcher?: typeof fetch) {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return refuse(400, "invalid_email", "Enter your work email address.");
  const domain = domainOfEmail(email)!;
  const ws = await holderOf(env.DB, domain);
  if (!ws) return NOT_AVAILABLE;
  const open = await env.DB.prepare(`SELECT 1 AS x FROM workspaces WHERE id = ? AND status = 'active' AND personal = 0`).bind(ws).first();
  if (!open) return NOT_AVAILABLE;
  if (readMode(env) === "org" && (await currentOrganisation(env.DB))?.workspace_id !== ws) return NOT_AVAILABLE;
  const c = await configOf(env.DB, ws);
  if (!c || c.status !== "enabled") return NOT_AVAILABLE;
  return begin(env, c, "login", origin, { hint: email, redirectTo: typeof next === "string" && next ? next.slice(0, 2000) : "/app", fetcher });
}

// --- finishing one -----------------------------------------------------------

/** What the login page says. Short, and never the provider's own words. */
const WHY: Record<string, string> = {
  malformed: "the identity provider's response could not be read",
  alg: "the identity provider's response could not be verified",
  key: "the identity provider's response could not be verified",
  signature: "the identity provider's response could not be verified",
  iss: "the response was not meant for this organisation",
  aud: "the response was not meant for this organisation",
  exp: "the response had expired",
  nbf: "the response is not valid yet",
  nonce: "the response did not match this sign-in",
  sub: "the identity provider did not say who you are",
  email: "the identity provider did not share your email address",
  email_verified: "your email address is not verified at your identity provider",
  discovery: "the identity provider could not be reached",
  jwks: "the identity provider's keys could not be fetched",
  token: "the identity provider did not accept the sign-in",
};

export type Completed =
  | { ok: false; purpose: "login" | "test" | null; error: string }
  | { ok: true; purpose: "login" | "test"; workspaceId: string; issuer: string; redirectTo: string; userId: string | null; claims: IdClaims };

export async function completeSso(env: SsoEnv, params: URLSearchParams, origin: string, fetcher?: typeof fetch): Promise<Completed> {
  const fail = (purpose: "login" | "test" | null, error: string): Completed => ({ ok: false, purpose, error });
  const state = params.get("state");
  const code = params.get("code");
  if (!state) return fail(null, "That sign-in was cancelled or incomplete.");

  // Single use: the state is spent before anything else happens with it.
  const at = Date.now();
  const row = await env.DB
    .prepare(
      `UPDATE sso_login_states SET status = 'used', updated_at = ?2
        WHERE state = ?1 AND status = 'pending' AND expires_at > ?2
        RETURNING workspace_id, purpose, user_id, nonce, code_verifier, issuer, redirect_to`,
    )
    .bind(state, at)
    .first<{ workspace_id: string; purpose: "login" | "test"; user_id: string | null; nonce: string; code_verifier: string; issuer: string; redirect_to: string }>();
  if (!row) return fail(null, "That sign-in link expired or was already used. Try again.");

  const p = row.purpose;
  if (params.get("error")) return fail(p, "Your identity provider refused the sign-in.");
  if (!code) return fail(p, "That sign-in was cancelled or incomplete.");

  const c = await configOf(env.DB, row.workspace_id);
  const usable = c && c.issuer === row.issuer && c.client_secret_enc && (p === "test" ? c.status !== "removed" : c.status === "enabled");
  if (!usable) return fail(p, "Single sign-on is no longer set up for this organisation.");
  const secret = await decryptSecret(await ssoKeyMaterial(env), row.workspace_id, c.client_secret_enc!);
  if (!secret) return fail(p, "Single sign-on needs to be set up again for this organisation.");

  try {
    const disc = await discover(c.issuer!, fetcher);
    const idToken = await exchangeCode(disc, { clientId: c.client_id!, clientSecret: secret, code, redirectUri: callbackUrl(origin), verifier: row.code_verifier }, fetcher);
    const keys = await fetchJwks(disc.jwks_uri, fetcher);
    const claims = await verifyIdToken(idToken, { keys, issuer: disc.issuer, clientId: c.client_id!, nonce: row.nonce });

    const domain = domainOfEmail(claims.email.trim().toLowerCase());
    if (!domain || !(await verifiedDomains(env.DB, row.workspace_id)).includes(domain))
      return fail(p, "That account's email address is not on one of this organisation's verified domains.");

    if (p === "test") {
      await env.DB
        .prepare(`UPDATE org_sso_configs SET status = CASE WHEN status = 'enabled' THEN 'enabled' ELSE 'tested' END, tested_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
        .bind(row.workspace_id, Date.now())
        .run();
    }
    return { ok: true, purpose: p, workspaceId: row.workspace_id, issuer: row.issuer, redirectTo: row.redirect_to, userId: row.user_id, claims };
  } catch (err) {
    if (err instanceof OidcError) {
      console.error("sso sign-in refused", row.workspace_id, err.code, err.message);
      return fail(p, `Single sign-on failed: ${WHY[err.code] ?? "the sign-in could not be completed"}.`);
    }
    throw err;
  }
}

// --- who the provider says it is ---------------------------------------------

export type Resolved = { kind: "user"; userId: string } | { kind: "new" } | { kind: "conflict" };

/**
 * The account a verified identity belongs to: the one already linked to this
 * subject, else the active account with this address (which is then linked),
 * else none (the caller may make one, if the instance lets it).
 */
export async function resolveIdentity(db: D1Database, ws: string, issuer: string, claims: IdClaims): Promise<Resolved> {
  const email = claims.email.trim().toLowerCase();
  const linked = await db
    .prepare(
      `SELECT i.user_id FROM sso_identities i JOIN users u ON u.id = i.user_id AND u.status = 'active'
        WHERE i.workspace_id = ? AND i.issuer = ? AND i.subject = ? AND i.status = 'active'`,
    )
    .bind(ws, issuer, claims.sub)
    .first<{ user_id: string }>();
  if (linked) return { kind: "user", userId: linked.user_id };

  const user = await db.prepare(`SELECT id FROM users WHERE email = ? AND status = 'active'`).bind(email).first<{ id: string }>();
  if (!user) return { kind: "new" };
  // An account already tied to a different subject here is not handed to a new one.
  const other = await db
    .prepare(`SELECT 1 AS x FROM sso_identities WHERE workspace_id = ? AND issuer = ? AND user_id = ? AND status = 'active'`)
    .bind(ws, issuer, user.id)
    .first();
  return other ? { kind: "conflict" } : { kind: "user", userId: user.id };
}

export async function linkIdentity(db: D1Database, ws: string, issuer: string, claims: IdClaims, userId: string): Promise<void> {
  const at = Date.now();
  await db
    .prepare(
      `INSERT INTO sso_identities (id, workspace_id, issuer, subject, user_id, email, status, last_login_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'active',?7,?7,?7)
       ON CONFLICT (workspace_id, issuer, subject) WHERE status = 'active' DO UPDATE SET last_login_at = ?7, updated_at = ?7`,
    )
    .bind(crypto.randomUUID(), ws, issuer, claims.sub, userId, claims.email.trim().toLowerCase(), at)
    .run();
}
