/**
 * A generic OpenID Connect relying party: what is needed to let an organisation
 * sign its people in through any provider that speaks OIDC, and nothing more.
 *
 *   discovery     `<issuer>/.well-known/openid-configuration`; the document must
 *                 name the same issuer it was fetched for
 *   request       authorization code flow with PKCE (S256), `state` and `nonce`
 *   token         the code is exchanged with the client secret, which is sent
 *                 only to the provider's own token endpoint
 *   id_token      its signature is checked against the provider's published keys
 *                 (RS256 or ES256, nothing else: `none` and HMAC are refused,
 *                 which is what stops key-confusion), then `iss`, `aud` (and
 *                 `azp`), `exp`, `nbf`, `nonce`, `sub`, `email`, and
 *                 `email_verified` must be exactly true
 *
 * Every check failing is an `OidcError` with a short code; the callback turns it
 * into a message on the login page and logs the detail. Nothing here touches the
 * database. `fetcher` is injectable so the pieces can be tested alone.
 */

export class OidcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OidcError";
  }
}

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const x of b instanceof Uint8Array ? b : new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    throw new OidcError("malformed", "id_token is not valid base64url");
  }
};

export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
export const pkceChallenge = async (verifier: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));

const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

/** An endpoint we will call: https, or http to this machine (which a deployed Worker cannot reach, and a test can). */
export function safeUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) return u;
  return null;
}

/** An issuer as an administrator typed it: a safe URL with no query. Returned trimmed, otherwise as given. */
export function cleanIssuer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  const u = safeUrl(v);
  if (!u || u.search) return null;
  return v;
}

// --- discovery ---------------------------------------------------------------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export async function discover(issuer: string, fetcher: typeof fetch = fetch): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  if (!safeUrl(url)) throw new OidcError("discovery", "issuer is not an address we will call");
  let doc: Partial<Discovery>;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (!res.ok) throw new OidcError("discovery", `discovery answered ${res.status}`);
    doc = await res.json();
  } catch (err) {
    throw err instanceof OidcError ? err : new OidcError("discovery", `discovery failed: ${(err as Error)?.message}`);
  }
  // The document must be about the issuer we asked: otherwise whoever answers at
  // that address could name someone else's issuer and borrow its tokens.
  if (doc.issuer !== issuer) throw new OidcError("discovery", "the provider names a different issuer than the one configured");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const)
    if (!safeUrl(doc[k])) throw new OidcError("discovery", `the provider's ${k} is missing or not usable`);
  return doc as Discovery;
}

export function authorizeUrl(
  d: Discovery,
  p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
  return u.toString();
}

// --- the code exchange -------------------------------------------------------

export async function exchangeCode(
  d: Discovery,
  p: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const methods = d.token_endpoint_auth_methods_supported;
  if (methods && !methods.includes("client_secret_post") && methods.includes("client_secret_basic")) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`)}`;
  } else {
    form.set("client_id", p.clientId);
    form.set("client_secret", p.clientSecret);
  }
  let body: { id_token?: unknown };
  try {
    const res = await fetcher(d.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (!res.ok) throw new OidcError("token", `the provider's token endpoint answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw err instanceof OidcError ? err : new OidcError("token", `token request failed: ${(err as Error)?.message}`);
  }
  if (typeof body.id_token !== "string" || !body.id_token) throw new OidcError("token", "the provider returned no id_token");
  return body.id_token;
}

// --- keys and the id_token ---------------------------------------------------

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export async function fetchJwks(uri: string, fetcher: typeof fetch = fetch): Promise<Jwk[]> {
  try {
    const res = await fetcher(uri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (!res.ok) throw new OidcError("jwks", `the provider's keys answered ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new OidcError("jwks", "the provider's key set has no keys");
    return body.keys;
  } catch (err) {
    throw err instanceof OidcError ? err : new OidcError("jwks", `fetching keys failed: ${(err as Error)?.message}`);
  }
}

const ALGS = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;

const json = (part: string, what: string) => {
  try {
    return JSON.parse(new TextDecoder().decode(unb64u(part)));
  } catch {
    throw new OidcError("malformed", `id_token ${what} is not JSON`);
  }
};

/** Constant-time string equality, for the nonce. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  email: string;
  email_verified: true;
  name?: string;
  picture?: string;
  [k: string]: unknown;
}

export async function verifyIdToken(
  token: string,
  o: { keys: Jwk[]; issuer: string; clientId: string; nonce: string; now?: number; skewSeconds?: number },
): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new OidcError("malformed", "id_token is not a signed JWT");
  const header = json(parts[0], "header") as { alg?: string; kid?: string };
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw new OidcError("alg", `id_token algorithm ${String(alg)} is not accepted`);
  const spec = ALGS[alg];

  // Candidate keys: of the right type, usable for signatures, and (if the token
  // names one) the one it names. A token that names a key we do not have is not
  // given any other.
  const candidates = o.keys.filter(
    (k) => k.kty === spec.kty && (!k.use || k.use === "sig") && (!k.alg || k.alg === alg) && (header.kid ? k.kid === header.kid : true),
  );
  if (!candidates.length || (!header.kid && candidates.length !== 1)) throw new OidcError("key", "no matching signing key");

  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const sig = unb64u(parts[2]);
  let good = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, spec.import, false, ["verify"]);
      if (await crypto.subtle.verify(spec.verify, key, sig, data)) {
        good = true;
        break;
      }
    } catch {
      /* a key we cannot use is not a match */
    }
  }
  if (!good) throw new OidcError("signature", "id_token signature does not verify");

  const c = json(parts[1], "payload") as Partial<IdClaims> & { nbf?: number; azp?: string; nonce?: unknown };
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const skew = o.skewSeconds ?? 60;

  if (c.iss !== o.issuer) throw new OidcError("iss", "id_token issuer is not the configured one");
  const aud = Array.isArray(c.aud) ? c.aud : typeof c.aud === "string" ? [c.aud] : [];
  if (!aud.includes(o.clientId)) throw new OidcError("aud", "id_token was not issued to this client");
  if (aud.length > 1 && c.azp !== o.clientId) throw new OidcError("aud", "id_token has several audiences and no matching authorized party");
  if (c.azp !== undefined && c.azp !== o.clientId) throw new OidcError("aud", "id_token authorized party is another client");
  if (typeof c.exp !== "number" || c.exp <= now - skew) throw new OidcError("exp", "id_token has expired");
  if (typeof c.nbf === "number" && c.nbf > now + skew) throw new OidcError("nbf", "id_token is not valid yet");
  if (typeof c.nonce !== "string" || !same(c.nonce, o.nonce)) throw new OidcError("nonce", "id_token nonce does not match this sign-in");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255) throw new OidcError("sub", "id_token has no subject");
  if (typeof c.email !== "string" || !c.email.includes("@")) throw new OidcError("email", "id_token carries no email address");
  if (c.email_verified !== true) throw new OidcError("email_verified", "the provider does not say this email address is verified");
  return c as IdClaims;
}
