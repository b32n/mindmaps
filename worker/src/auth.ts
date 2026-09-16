/**
 * Password hashing, password policy, and server-side sessions.
 *
 * Workers give us WebCrypto but no bcrypt/argon2 without shipping WASM, so
 * passwords use PBKDF2-HMAC-SHA256 — the standard choice on workerd.
 *
 * ## Why the iteration count looks low
 *
 * OWASP wants 210,000 iterations for PBKDF2-HMAC-SHA256. Cloudflare's
 * *production* runtime refuses anything above 100,000:
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported
 *
 * The local dev runtime does not enforce this, so a single count of 210,000
 * works on a laptop and fails the moment it is deployed. To reach OWASP-grade
 * work within the cap we chain derivations: each round's output becomes the
 * next round's input, against the same salt. Three rounds of 100,000 is
 * 300,000 iterations of real work, which clears the guidance rather than
 * settling below it.
 *
 * Stored hashes carry their parameters (`pbkdf2$iterations$rounds$hex`) so this
 * can be changed again later without stranding existing passwords.
 */

const PBKDF2_ITERATIONS = 100_000; // the platform maximum, not a choice
const PBKDF2_ROUNDS = 3; // chained -> 300,000 iterations of work
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "wb_session";

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomHex = (bytes: number) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);

// --- passwords --------------------------------------------------------------

/** One PBKDF2 pass. `secret` is the password, or the previous round's output. */
async function derive(secret: Uint8Array, salt: string, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as unknown as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
}

async function stretch(
  password: string,
  salt: string,
  iterations: number,
  rounds: number,
): Promise<string> {
  let bits = enc.encode(password) as Uint8Array;
  for (let i = 0; i < rounds; i++) bits = new Uint8Array(await derive(bits, salt, iterations));
  return toHex(bits.buffer as ArrayBuffer);
}

export async function hashPassword(
  password: string,
  salt = randomHex(16),
): Promise<{ hash: string; salt: string }> {
  const digest = await stretch(password, salt, PBKDF2_ITERATIONS, PBKDF2_ROUNDS);
  // Parameters travel with the hash so the cost can be raised later without
  // locking anyone out.
  return { hash: `pbkdf2$${PBKDF2_ITERATIONS}$${PBKDF2_ROUNDS}$${digest}`, salt };
}

/** Constant-time compare, so a wrong password can't be found by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  // New format carries its own parameters. A bare hex string is a pre-cap hash
  // from local development — 210,000 iterations, single round. It verifies on
  // the dev runtime and cannot on production, where no such user exists.
  const parts = hash.split("$");
  const [iterations, rounds, digest] =
    parts.length === 4 && parts[0] === "pbkdf2"
      ? [Number(parts[1]), Number(parts[2]), parts[3]]
      : [210_000, 1, hash];

  if (!Number.isFinite(iterations) || !Number.isFinite(rounds)) return false;

  try {
    const candidate = await stretch(password, salt, iterations, rounds);
    return timingSafeEqual(candidate, digest);
  } catch {
    // e.g. a legacy 210,000-iteration hash on the production runtime, which
    // refuses the count outright. Not a match, not a crash.
    return false;
  }
}

// --- password policy --------------------------------------------------------

const COMMON = new Set([
  "password", "password1", "12345678", "123456789", "qwertyuiop",
  "letmein123", "welcome123", "admin1234", "iloveyou1", "changeme1",
]);

/**
 * Returns every reason the password is unacceptable, so the UI can show the
 * full list rather than making the user discover rules one at a time.
 */
export function passwordProblems(password: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push("at least 12 characters");
  if (!/[a-z]/.test(password)) out.push("a lowercase letter");
  if (!/[A-Z]/.test(password)) out.push("an uppercase letter");
  if (!/[0-9]/.test(password)) out.push("a number");
  if (!/[^A-Za-z0-9]/.test(password)) out.push("a symbol");
  if (/(.)\1{3,}/.test(password)) out.push("no character repeated 4+ times");
  if (COMMON.has(password.toLowerCase())) out.push("something less predictable");
  return out;
}

// --- sessions ---------------------------------------------------------------

/** Only the hash is stored, so a database leak doesn't yield live sessions. */
async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomHex(32);
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  await db
    .prepare(
      `INSERT INTO auth_sessions (token_hash,user_id,created_at,expires_at,user_agent)
       VALUES (?,?,?,?,?)`,
    )
    .bind(await sha256(token), userId, now, expiresAt, userAgent ?? null)
    .run();
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export async function userForToken(
  db: D1Database,
  token: string | null,
): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256(token), Date.now())
    .first<SessionUser>();
  return row ?? null;
}

export async function destroySession(db: D1Database, token: string | null) {
  if (!token) return;
  await db
    .prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`)
    .bind(await sha256(token))
    .run();
}

// --- cookies ----------------------------------------------------------------

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * `Secure` is omitted on http://localhost so dev works over plain HTTP;
 * browsers treat localhost as a secure context but still refuse to store a
 * Secure cookie sent over http from some tooling.
 */
export function sessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const secure = new URL(req.url).protocol === "https:";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(req: Request): string {
  return sessionCookie(req, "", 0);
}
