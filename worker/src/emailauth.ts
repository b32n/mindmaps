/**
 * Email verification, password reset and the rate limits on sign-up and
 * sign-in. The HTTP routes are in index.ts (`authRoute`); the rules live here.
 * docs/EMAIL.md is the operator-facing account of all of it.
 *
 * Tokens: 256 random bits, emailed once, stored only as a SHA-256. Each is
 * single-use (an atomic UPDATE ... WHERE status = 'active' decides who got
 * there first), expires, and is never deleted: `email_tokens.status` records
 * what became of it.
 */

import { hashPassword, passwordProblems, randomHex, sha256 } from "./auth";
import { mailConfigured, resetEmail, sendMail, verificationEmail, type MailEnv } from "./mail";

export interface EmailAuthEnv extends MailEnv {
  DB: D1Database;
}

const now = () => Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

export const VERIFY_TTL_MS = 24 * HOUR;
export const RESET_TTL_MS = HOUR;

export const INVALID_LINK = "That link is invalid or has expired.";
export const UNCONFIGURED =
  "This mindmaps can't send email yet, so this isn't available. Ask whoever runs it to set up email (docs/EMAIL.md).";
export const RATE_LIMITED = "Too many attempts. Wait a while and try again.";

// --- rate limits ------------------------------------------------------------

/** [attempts, window]. Per address and per client address, the second only when the client address is known. */
export const LIMITS = {
  register_ip: [10, HOUR],
  login_email: [10, 15 * MIN],
  login_ip: [30, 15 * MIN],
  resend_user: [3, HOUR],
  resend_ip: [20, HOUR],
  forgot_email: [3, HOUR],
  forgot_ip: [20, HOUR],
  reset_ip: [20, HOUR],
  verify_ip: [30, HOUR],
} as const;
export type Limit = keyof typeof LIMITS;

/**
 * The client's address, from `CLIENT_IP_HEADER` (default `cf-connecting-ip`,
 * which Cloudflare always sets and a client cannot forge). Null when the header
 * is absent: the per-client limits are then skipped rather than pooled into one
 * shared bucket, and the per-address limits still apply. The test configs name a
 * header nothing sends by default, so one machine running the whole suite is not
 * one client; specs that exercise the limit send it.
 */
export const clientIp = (req: Request, env: object) =>
  req.headers.get((env as { CLIENT_IP_HEADER?: string }).CLIENT_IP_HEADER || "cf-connecting-ip")?.trim() || null;

const keyOf = (limit: Limit, subject: string) => sha256(`${limit}:${subject.toLowerCase()}`);

/** Count one attempt. True when it is within the limit. */
export async function rateHit(db: D1Database, limit: Limit, subject: string | null): Promise<boolean> {
  if (!subject) return true;
  const [max, window] = LIMITS[limit];
  const t = now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key,count,window_start,created_at,updated_at) VALUES (?1,1,?2,?2,?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END,
         updated_at = ?2
       RETURNING count`,
    )
    .bind(await keyOf(limit, subject), t, t - window)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= max;
}

/** Whether the limit is already used up, without counting (for limits that count failures only). */
export async function rateBlocked(db: D1Database, limit: Limit, subject: string | null): Promise<boolean> {
  if (!subject) return false;
  const [max, window] = LIMITS[limit];
  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE key = ? AND window_start > ?`)
    .bind(await keyOf(limit, subject), now() - window)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= max;
}

// --- verification state -----------------------------------------------------

/**
 * Whether this user may claim invites addressed to their email.
 *
 * True when the address is verified. Also true when the instance cannot send
 * email at all: nobody could ever verify, so enforcing it would only stop
 * invited people joining. That is how every instance behaved before this, and
 * it is documented as the reason to set email up.
 */
export async function mayClaimInvites(env: EmailAuthEnv, userId: string): Promise<boolean> {
  if (!mailConfigured(env)) return true;
  return isVerified(env.DB, userId);
}

export async function isVerified(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT email_verified_at AS v FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ v: number | null }>();
  return !!row?.v;
}

export async function markVerified(db: D1Database, userId: string, via: "email" | "google" | "reset") {
  const t = now();
  await db
    .prepare(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?1),
                        email_verified_via = COALESCE(email_verified_via, ?2), updated_at = ?1
        WHERE id = ?3`,
    )
    .bind(t, via, userId)
    .run();
}

/** Every way back in for a user: browser sessions, MCP tokens and pending authorisation codes. */
export async function revokeAccess(db: D1Database, userId: string) {
  await db.batch([
    db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).bind(userId),
    db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM oauth_codes WHERE user_id = ?`).bind(userId),
  ]);
}

// --- tokens -----------------------------------------------------------------

type Kind = "verify" | "reset";

/** A fresh token for the user. Any earlier live one of the same kind is superseded. */
export async function issueToken(
  db: D1Database,
  userId: string,
  kind: Kind,
  email: string,
): Promise<string> {
  const token = randomHex(32);
  const t = now();
  await db.batch([
    db
      .prepare(
        `UPDATE email_tokens SET status = 'superseded', updated_at = ?
          WHERE user_id = ? AND kind = ? AND status = 'active'`,
      )
      .bind(t, userId, kind),
    db
      .prepare(
        `INSERT INTO email_tokens (id,user_id,kind,email,token_hash,status,expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',?,?,?)`,
      )
      .bind(
        crypto.randomUUID(), userId, kind, email, await sha256(token),
        t + (kind === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS), t, t,
      ),
  ]);
  return token;
}

/**
 * Spend a token. The UPDATE is the lock: of two requests presenting the same
 * link, exactly one changes a row. Null for wrong, expired, used or superseded.
 */
export async function consumeToken(
  db: D1Database,
  rawToken: unknown,
  kind: Kind,
): Promise<{ userId: string; email: string } | null> {
  if (typeof rawToken !== "string" || !/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const hash = await sha256(rawToken);
  const t = now();
  const row = await db
    .prepare(
      `UPDATE email_tokens SET status = 'used', used_at = ?1, updated_at = ?1
        WHERE token_hash = ?2 AND kind = ?3 AND status = 'active' AND expires_at > ?1
        RETURNING user_id, email`,
    )
    .bind(t, hash, kind)
    .first<{ user_id: string; email: string }>();
  if (!row) return null;
  // The link was for an address the account no longer has.
  const owner = await db
    .prepare(`SELECT 1 AS x FROM users WHERE id = ? AND email = ? AND status = 'active'`)
    .bind(row.user_id, row.email)
    .first();
  return owner ? { userId: row.user_id, email: row.email } : null;
}

/** Whether a token is live, without spending it (to check the form before the link is used up). */
export async function peekToken(db: D1Database, rawToken: unknown, kind: Kind): Promise<boolean> {
  if (typeof rawToken !== "string" || !/^[0-9a-f]{64}$/.test(rawToken)) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM email_tokens WHERE token_hash = ? AND kind = ? AND status = 'active' AND expires_at > ?`,
    )
    .bind(await sha256(rawToken), kind, now())
    .first();
  return !!row;
}

/** Mark a user's live tokens of a kind as revoked (a password change, an account deletion). */
export async function revokeTokens(db: D1Database, userId: string, kind?: Kind) {
  await db
    .prepare(
      `UPDATE email_tokens SET status = 'revoked', updated_at = ?
        WHERE user_id = ? AND status = 'active' ${kind ? "AND kind = ?" : ""}`,
    )
    .bind(...(kind ? [now(), userId, kind] : [now(), userId]))
    .run();
}

// --- sending ----------------------------------------------------------------

export async function sendVerificationEmail(
  env: EmailAuthEnv,
  origin: string,
  userId: string,
  email: string,
): Promise<boolean> {
  if (!mailConfigured(env)) return false;
  const token = await issueToken(env.DB, userId, "verify", email);
  const msg = verificationEmail(`${origin}/verify-email?token=${token}`, VERIFY_TTL_MS / HOUR);
  return (await sendMail(env, { to: email, ...msg })).ok;
}

export async function sendResetEmail(
  env: EmailAuthEnv,
  origin: string,
  userId: string,
  email: string,
): Promise<boolean> {
  if (!mailConfigured(env)) return false;
  const token = await issueToken(env.DB, userId, "reset", email);
  const msg = resetEmail(`${origin}/reset-password?token=${token}`, RESET_TTL_MS / MIN);
  return (await sendMail(env, { to: email, ...msg })).ok;
}

// --- reset ------------------------------------------------------------------

export type ResetOutcome =
  | { ok: true }
  | { ok: false; status: 400; error: string; problems?: string[] };

/**
 * Set a new password from a reset link.
 *
 * The password is checked against the policy before the link is spent, so a
 * weak one does not burn it. Once the link is spent the password is replaced,
 * the address counts as verified (the link proved it), and every session and
 * token the account had is revoked: whoever held the old password is out.
 */
export async function resetPassword(
  db: D1Database,
  rawToken: unknown,
  password: unknown,
): Promise<ResetOutcome> {
  if (!(await peekToken(db, rawToken, "reset"))) return { ok: false, status: 400, error: INVALID_LINK };
  const problems = passwordProblems(String(password ?? ""));
  if (problems.length)
    return { ok: false, status: 400, error: "Your password needs " + problems.join(", ") + ".", problems };

  const spent = await consumeToken(db, rawToken, "reset");
  if (!spent) return { ok: false, status: 400, error: INVALID_LINK };

  const { hash, salt } = await hashPassword(String(password));
  await db
    .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`)
    .bind(hash, salt, now(), spent.userId)
    .run();
  await markVerified(db, spent.userId, "reset");
  await revokeTokens(db, spent.userId);
  await revokeAccess(db, spent.userId);
  return { ok: true };
}
