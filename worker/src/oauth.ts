/**
 * OAuth 2.1 for the MCP endpoint — no API keys anywhere.
 *
 * We play both roles the MCP authorization spec distinguishes:
 *
 *   authorization server  — /oauth/authorize, /oauth/token, /register
 *   resource server       — the MCP endpoint, which validates bearer tokens
 *
 * Hosting them together is the simple case the spec explicitly permits, and it
 * keeps the whole story on one origin.
 *
 * What a harness does, end to end:
 *
 *   1. POST /mcp with no token             -> 401 + WWW-Authenticate carrying
 *                                             the resource_metadata URL
 *   2. GET  the protected-resource doc     -> which authorization server to use
 *   3. GET  the authorization-server doc   -> endpoint URLs, PKCE support
 *   4. POST /register                      -> a client_id (public, no secret)
 *   5. GET  /oauth/authorize               -> browser; user signs in to the
 *                                             board and approves
 *   6. POST /oauth/token + code_verifier   -> access token (+ refresh token)
 *   7. POST /mcp with Authorization: Bearer
 *
 * Standards this implements, and why each one is here rather than optional:
 *
 *   RFC 9728  protected resource metadata  — the spec says MCP servers MUST
 *   RFC 8414  authorization server metadata — MCP servers MUST offer this or OIDC
 *   RFC 7591  dynamic client registration  — deprecated in the draft in favour
 *             of Client ID Metadata Documents, but it is what shipped clients
 *             actually use today, so it stays
 *   RFC 8707  resource indicators          — the `resource` parameter, so a
 *             token minted for us cannot be replayed against another server
 *   RFC 9207  issuer identification        — we emit `iss` on the redirect
 *   PKCE S256 required. `plain` is refused outright.
 */

import { SESSION_COOKIE, readCookie, userForToken } from "./auth";

const CODE_TTL_MS = 60_000; // codes are used within seconds; a minute is generous
const TOKEN_TTL_MS = 30 * 86_400_000;
const REFRESH_TTL_MS = 180 * 86_400_000;

export const SCOPES = ["mindmaps:read", "mindmaps:write"] as const;
export type Scope = (typeof SCOPES)[number];

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const sha256Hex = async (v: string) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(v)));

/** base64url, no padding — the encoding PKCE and RFC 7636 use. */
const b64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Identity of this deployment
// ---------------------------------------------------------------------------

/**
 * The issuer, and the canonical resource identifier of the MCP endpoint.
 *
 * Configured via `PUBLIC_ORIGIN`, not inferred. Two reasons:
 *
 *  1. RFC 8414 treats the issuer identifier as a stable, published constant —
 *     it appears in discovery documents, in the `iss` on every redirect, and in
 *     every token's audience. Deriving it per-request means it can quietly
 *     change and invalidate tokens issued a moment earlier.
 *  2. Inference does not work here anyway. With a `custom_domain` route in
 *     wrangler.toml, `wrangler dev` rewrites *both* `req.url` and the `Host`
 *     header to the production hostname, so a server on localhost:8787
 *     advertises the production hostname and nothing lines up.
 *
 * The request-derived fallback only applies when the variable is unset.
 *
 * Note the deliberate absence of a trailing slash — RFC 8707 canonical URIs
 * compare as exact strings, so `…/mcp` and `…/mcp/` are different audiences.
 */
export interface OriginEnv {
  PUBLIC_ORIGIN?: string;
}

export function issuerOf(req: Request, env?: OriginEnv): string {
  if (env?.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const resourceOf = (req: Request, env?: OriginEnv) => `${issuerOf(req, env)}/mcp`;

const prmUrl = (req: Request, env?: OriginEnv) =>
  `${issuerOf(req, env)}/.well-known/oauth-protected-resource/mcp`;

// ---------------------------------------------------------------------------
// 401 / 403 challenges
// ---------------------------------------------------------------------------

/**
 * The challenge that starts the whole dance. `resource_metadata` is how the
 * client discovers where to authorize; `scope` tells it what to ask for so it
 * doesn't request more than the operation needs.
 */
export function unauthorized(req: Request, env: OriginEnv, scope: string, description?: string): Response {
  const parts = [`Bearer resource_metadata="${prmUrl(req, env)}"`, `scope="${scope}"`];
  if (description) parts.push(`error="invalid_token"`, `error_description="${description}"`);
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: description ?? "authorization required" }),
    {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": parts.join(", ") },
    },
  );
}

/** Token is valid but lacks the scope this operation needs (RFC 6750 §3.1). */
export function insufficientScope(req: Request, env: OriginEnv, scope: string): Response {
  return new Response(
    JSON.stringify({ error: "insufficient_scope", error_description: `requires ${scope}` }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "www-authenticate": [
          `Bearer error="insufficient_scope"`,
          `scope="${scope}"`,
          `resource_metadata="${prmUrl(req, env)}"`,
        ].join(", "),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Discovery documents
// ---------------------------------------------------------------------------

const discoveryJson = (body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      // discovery docs are fetched by non-browser clients too, but a browser
      // client must be able to read them cross-origin
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });

export function protectedResourceMetadata(req: Request, env: OriginEnv) {
  return discoveryJson({
    resource: resourceOf(req, env),
    authorization_servers: [issuerOf(req, env)],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "mindmaps",
    resource_documentation: `${issuerOf(req, env)}/mcp`,
  });
}

export function authorizationServerMetadata(req: Request, env: OriginEnv) {
  const iss = issuerOf(req, env);
  return discoveryJson({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    // Under /oauth, not at /register: the app's own sign-up page owns that
    // path, and the two collided the moment both were served from one origin.
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // public clients only: a harness on someone's laptop cannot keep a secret
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    // RFC 8707 / RFC 9207 — we honour `resource` and we emit `iss`
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

/**
 * Open registration: anyone may mint a client_id. That sounds alarming and
 * isn't, because a client_id grants nothing on its own — every code is bound to
 * a PKCE verifier and every token needs a real user to have signed in and
 * approved it at the consent screen. This is the same posture every hosted MCP
 * server takes; the alternative is a manual allowlist, which would mean nobody
 * can install this without us.
 */
export async function registerClient(req: Request, db: D1Database): Promise<Response> {
  const body = await req.json<any>().catch(() => null);
  const uris: unknown = body?.redirect_uris;

  if (!Array.isArray(uris) || uris.length === 0)
    return oauthError("invalid_client_metadata", "redirect_uris is required", 400);

  for (const u of uris) {
    if (typeof u !== "string") return oauthError("invalid_redirect_uri", "must be strings", 400);
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return oauthError("invalid_redirect_uri", `not a URL: ${u}`, 400);
    }
    // http is allowed only for loopback, which is how a local harness receives
    // the callback. Anything else on the public internet must be https.
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" || parsed.hostname === "::1";
    const custom = parsed.protocol !== "http:" && parsed.protocol !== "https:";
    if (parsed.protocol === "http:" && !loopback)
      return oauthError("invalid_redirect_uri", "http is only allowed for loopback", 400);
    if (custom && !parsed.protocol.includes(".") && parsed.protocol.length < 3)
      return oauthError("invalid_redirect_uri", `unsupported scheme: ${parsed.protocol}`, 400);
  }

  const clientId = `mcp_${toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
  await db
    .prepare(
      `INSERT INTO oauth_clients (client_id,client_name,redirect_uris,secret_hash,created_at)
       VALUES (?,?,?,NULL,?)`,
    )
    .bind(clientId, String(body?.client_name ?? "MCP client").slice(0, 200), JSON.stringify(uris), now())
    .run();

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      redirect_uris: uris,
      client_name: body?.client_name ?? "MCP client",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    {
      status: 201,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    },
  );
}

const oauthError = (error: string, description: string, status = 400) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

/**
 * The authorization endpoint.
 *
 * Three outcomes:
 *   - request is malformed          -> render an error page (we must NOT
 *                                      redirect to an unvalidated URI)
 *   - user isn't signed in          -> bounce through the app's login and come
 *                                      back to this exact URL
 *   - user is signed in             -> consent screen, then redirect with a code
 *
 * The order matters: `redirect_uri` is validated against the registered list
 * *before* we are willing to send the browser anywhere. Redirecting errors to
 * an unvalidated URI is the classic open-redirect in OAuth implementations.
 */
export async function authorize(req: Request, env: { DB: D1Database; APP_ORIGIN?: string } & OriginEnv): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;

  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  const method = q.get("code_challenge_method") ?? "";
  const resource = q.get("resource");
  const requested = (q.get("scope") ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean);

  const client = await env.DB.prepare(
    `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`,
  )
    .bind(clientId)
    .first<ClientRow>();

  if (!client) return errorPage("Unknown client", "This client isn't registered with mindmaps.");

  const allowed: string[] = JSON.parse(client.redirect_uris);
  if (!allowed.includes(redirectUri))
    return errorPage(
      "Bad redirect URI",
      "The redirect URI doesn't match what this client registered. Nothing was sent anywhere.",
    );

  // From here a redirect_uri is trusted, so protocol errors can go back to the
  // client the way the spec wants.
  const back = (params: Record<string, string>) => {
    const to = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    if (state) to.searchParams.set("state", state);
    to.searchParams.set("iss", issuerOf(req, env)); // RFC 9207
    return Response.redirect(to.toString(), 302);
  };

  if (q.get("response_type") !== "code")
    return back({ error: "unsupported_response_type", error_description: "only `code` is supported" });
  if (method !== "S256")
    return back({ error: "invalid_request", error_description: "code_challenge_method must be S256" });
  if (!challenge)
    return back({ error: "invalid_request", error_description: "code_challenge is required" });

  const unknown = requested.filter((s) => !SCOPES.includes(s as Scope));
  if (unknown.length)
    return back({ error: "invalid_scope", error_description: `unknown scope: ${unknown.join(", ")}` });

  // RFC 8707: if the client names a resource, it has to be ours. A token we
  // mint must never be usable anywhere else.
  if (resource && resource.replace(/\/$/, "") !== resourceOf(req, env).replace(/\/$/, ""))
    return back({ error: "invalid_target", error_description: `not a resource of this server: ${resource}` });

  const user = await userForToken(env.DB, readCookie(req, SESSION_COOKIE));
  if (!user) {
    // Sign in on the app, then land back here with every parameter intact.
    //
    // `next` is absolute rather than a path: the app runs on its own origin in
    // dev, so a bare path would send the browser to the Vite server, which has
    // no authorize endpoint. The app treats an absolute next as a full
    // navigation, and only ever to this origin.
    const appOrigin = env.APP_ORIGIN ?? issuerOf(req, env);
    const next = `${issuerOf(req, env)}${url.pathname}${url.search}`;
    return Response.redirect(
      `${appOrigin}/login?next=${encodeURIComponent(next)}&connect=${encodeURIComponent(client.client_name)}`,
      302,
    );
  }

  // POST means the user pressed Approve on the consent screen.
  if (req.method === "POST") {
    const code = randomToken();
    await env.DB.prepare(
      `INSERT INTO oauth_codes
         (code_hash,client_id,user_id,redirect_uri,code_challenge,scope,resource,expires_at,used,created_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
    )
      .bind(
        await sha256Hex(code),
        clientId,
        user.id,
        redirectUri,
        challenge,
        requested.join(" "),
        resource ?? resourceOf(req, env),
        now() + CODE_TTL_MS,
        now(),
      )
      .run();
    return back({ code });
  }

  return consentPage(client.client_name, user.email, requested, url.search);
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export async function token(req: Request, env: { DB: D1Database }): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const grant = form.get("grant_type");

  if (grant === "authorization_code") return await codeGrant(req, env, form);
  if (grant === "refresh_token") return await refreshGrant(req, env, form);
  return oauthError("unsupported_grant_type", `unsupported grant_type: ${grant}`, 400);
}

async function codeGrant(req: Request, env: { DB: D1Database }, form: URLSearchParams) {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const resource = form.get("resource");

  if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required");

  const hash = await sha256Hex(code);
  const row = await env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`)
    .bind(hash)
    .first<any>();
  if (!row) return oauthError("invalid_grant", "unknown authorization code");

  // Burn it first, whatever happens next. A code that has been presented once
  // is spent even if the rest of the request is wrong, so a leaked code can't
  // be retried until something lines up.
  await env.DB.prepare(`UPDATE oauth_codes SET used = 1 WHERE code_hash = ?`).bind(hash).run();

  if (row.used) return oauthError("invalid_grant", "authorization code already used");
  if (row.expires_at < now()) return oauthError("invalid_grant", "authorization code expired");
  if (row.client_id !== clientId) return oauthError("invalid_grant", "code was issued to another client");
  if (row.redirect_uri !== redirectUri) return oauthError("invalid_grant", "redirect_uri mismatch");

  // PKCE: SHA-256 the verifier and compare to the challenge we stored at
  // authorize time. This is what proves the client redeeming the code is the
  // one that requested it — there is no client secret doing that job.
  const computed = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  if (computed !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");

  if (resource && resource.replace(/\/$/, "") !== String(row.resource ?? "").replace(/\/$/, ""))
    return oauthError("invalid_target", "resource does not match the authorization request");

  return await issue(env, row.client_id, row.user_id, row.scope, row.resource);
}

async function refreshGrant(req: Request, env: { DB: D1Database }, form: URLSearchParams) {
  const presented = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  if (!presented) return oauthError("invalid_request", "refresh_token is required");

  const hash = await sha256Hex(presented);
  const row = await env.DB.prepare(
    `SELECT * FROM oauth_tokens WHERE refresh_hash = ? AND revoked = 0`,
  )
    .bind(hash)
    .first<any>();
  if (!row) return oauthError("invalid_grant", "unknown refresh token");
  if (row.client_id !== clientId) return oauthError("invalid_grant", "refresh token belongs to another client");
  if (row.refresh_expires_at && row.refresh_expires_at < now())
    return oauthError("invalid_grant", "refresh token expired");

  // Rotate: the old row dies with the new one's birth, so a stolen refresh
  // token stops working the moment the real client next refreshes.
  await env.DB.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`)
    .bind(row.token_hash)
    .run();

  return await issue(env, row.client_id, row.user_id, row.scope, row.resource);
}

async function issue(
  env: { DB: D1Database },
  clientId: string,
  userId: string,
  scope: string,
  resource: string | null,
) {
  const access = randomToken();
  const refresh = randomToken();
  const expiresAt = now() + TOKEN_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO oauth_tokens
       (token_hash,refresh_hash,client_id,user_id,scope,resource,expires_at,refresh_expires_at,revoked,created_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`,
  )
    .bind(
      await sha256Hex(access),
      await sha256Hex(refresh),
      clientId,
      userId,
      scope,
      resource,
      expiresAt,
      now() + REFRESH_TTL_MS,
      now(),
    )
    .run();

  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
      scope,
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}

export async function revoke(req: Request, env: { DB: D1Database }): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const presented = form.get("token") ?? "";
  if (presented) {
    const hash = await sha256Hex(presented);
    // the caller may hand us either half of the pair
    await env.DB.prepare(
      `UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? OR refresh_hash = ?`,
    )
      .bind(hash, hash)
      .run();
  }
  // RFC 7009: always 200, so a revocation call can't be used to probe which
  // tokens exist.
  return new Response("{}", {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

// ---------------------------------------------------------------------------
// Resource-server side: validating a bearer token
// ---------------------------------------------------------------------------

export interface TokenGrant {
  userId: string;
  clientId: string;
  scopes: string[];
}

export type TokenCheck =
  | { ok: true; grant: TokenGrant }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "audience" };

/**
 * Validate the Authorization header.
 *
 * The audience check is the one that's easy to skip and shouldn't be: the spec
 * requires a resource server to confirm the token was minted *for it*. Without
 * it, a token someone obtained for a different MCP server would work here —
 * the confused-deputy problem the `resource` parameter exists to prevent.
 */
export async function checkBearer(req: Request, db: D1Database, env: OriginEnv): Promise<TokenCheck> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "missing" };

  const row = await db
    .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked = 0`)
    .bind(await sha256Hex(match[1]))
    .first<any>();
  if (!row) return { ok: false, reason: "invalid" };
  if (row.expires_at < now()) return { ok: false, reason: "expired" };

  const expected = resourceOf(req, env).replace(/\/$/, "");
  if (row.resource && String(row.resource).replace(/\/$/, "") !== expected)
    return { ok: false, reason: "audience" };

  return {
    ok: true,
    grant: {
      userId: row.user_id,
      clientId: row.client_id,
      scopes: String(row.scope ?? "").split(/\s+/).filter(Boolean),
    },
  };
}

// ---------------------------------------------------------------------------
// The two HTML pages this server needs
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · mindmaps</title>
<style>
  :root{--bg:#f6f8f7;--surface:#fff;--ink:#0d1513;--muted:#6c7a75;--line:#e4e9e7;
        --accent:#0f7a57;--accent-soft:#e3f1ea;--danger:#b3261e}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);
       color:var(--ink);font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
       -webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--line);
        border-radius:18px;padding:32px;box-shadow:0 4px 14px rgb(13 21 19/.08)}
  .brand{font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:18px}
  h1{margin:0 0 10px;font-size:19px;letter-spacing:-.02em}
  p{margin:0 0 16px;color:var(--muted);line-height:1.6}
  .who{font-size:12.5px;color:var(--muted);padding:10px 12px;background:var(--bg);
       border-radius:7px;margin-bottom:16px}
  ul{margin:0 0 20px;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
  li{display:flex;gap:9px;align-items:baseline;font-size:13px}
  li b{font-weight:600;color:var(--ink)}
  li span{color:var(--accent);font-weight:700}
  .row{display:flex;gap:8px}
  button,a.btn{flex:1;padding:11px;border-radius:7px;font:inherit;font-size:13.5px;
       font-weight:500;cursor:pointer;text-align:center;text-decoration:none;border:1px solid var(--line)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary:hover{background:#0c6448}
  a.btn{background:var(--surface);color:var(--ink)}
  a.btn:hover{background:var(--bg)}
  .warn{color:var(--danger);background:#fdecea;padding:12px;border-radius:7px;font-size:13px}
</style></head><body><div class="card"><div class="brand">mindmaps</div>${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const SCOPE_COPY: Record<string, string> = {
  "mindmaps:read": "Read your mindmaps, cards and documents",
  "mindmaps:write": "Create and update mindmaps, cards and documents",
};

function consentPage(clientName: string, email: string, scopes: string[], search: string) {
  const items = scopes
    .map((s) => `<li><span>✓</span><b>${esc(SCOPE_COPY[s] ?? s)}</b></li>`)
    .join("");
  return page(
    "Authorize",
    `<h1>Connect ${esc(clientName)}?</h1>
     <p>It's asking for access to your mindmaps. It will never see your password.</p>
     <div class="who">Signed in as ${esc(email)}</div>
     <ul>${items}</ul>
     <form method="POST" action="/oauth/authorize${esc(search)}">
       <div class="row">
         <a class="btn" href="/oauth/deny">Cancel</a>
         <button class="primary" type="submit">Approve</button>
       </div>
     </form>`,
  );
}

function errorPage(title: string, detail: string) {
  return page("Error", `<h1>${esc(title)}</h1><p class="warn">${esc(detail)}</p>`, 400);
}

export const denyPage = () =>
  page(
    "Cancelled",
    `<h1>Not connected</h1><p>Nothing was shared. You can close this tab.</p>`,
  );
