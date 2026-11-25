// Two small servers for the SSO and verified-domain specs, in one process:
//
//   an OIDC identity provider    E2E_IDP_PORT   discovery, JWKS, authorize, token
//   a DNS-over-HTTPS resolver    E2E_DOH_PORT   Cloudflare's JSON API, TXT only
//
// The Worker is pointed at the second one with its DOH_ENDPOINT var; the first
// is reached through whatever issuer URL a spec configures an organisation with.
//
// Neither is a real implementation of anything. They do exactly as much as the
// Worker needs, and each can be told to misbehave in one specific way, so a spec
// can show that a bad signature, a wrong audience or an unverified email is
// refused by the Worker and not merely absent from the happy path.
//
// Parallel specs share the process, so state is per *tenant*: an issuer is
// `<origin>/t/<tenant>`, and each spec makes its own. The DNS side is keyed by
// record name, and specs use names no other spec uses.
//
// IdP control (JSON), per tenant:
//   POST /t/<tenant>/__control  { clientId, clientSecret, claims, scenario, issuer,
//                                 alg, authMethod, discovery }
//   GET  /t/<tenant>/__log      what the IdP was asked, newest last
//
//   claims    merged over the id_token (email, email_verified, sub, name, ...)
//   scenario  one of: bad-signature, wrong-aud, wrong-iss, expired, wrong-nonce,
//             no-nonce, alg-none, alg-hs256, unknown-kid, no-email, deny
//   alg       RS256 (default) or ES256
//   authMethod  client_secret_post (default) or client_secret_basic
//   discovery   merged over the discovery document (a wrong `issuer`, a missing key, ...)
//
// DoH control:
//   POST /__txt     { name, values: [..] }   set the TXT records of a name
//   DELETE /__txt?name=
//   POST /__fail    { name, mode: "servfail" | "http500" | "empty-answer-ok" }
//   GET  /__queries?name=                    what was asked
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { createServer } from "node:http";

const IDP_PORT = Number(process.env.E2E_IDP_PORT ?? 8792);
const DOH_PORT = Number(process.env.E2E_DOH_PORT ?? 8793);
const IDP = `http://127.0.0.1:${IDP_PORT}`;

const b64u = (b) => Buffer.from(b).toString("base64url");

// --- keys --------------------------------------------------------------------

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaOther = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

const KEYS = {
  RS256: { kid: "rs-1", pair: rsa },
  ES256: { kid: "ec-1", pair: ec },
};
const jwk = (kid, alg, pub) => ({ ...createPublicKey(pub).export({ format: "jwk" }), kid, alg, use: "sig" });
const JWKS = {
  keys: [jwk("rs-1", "RS256", rsa.publicKey), jwk("ec-1", "ES256", ec.publicKey)],
};

function signJwt(header, payload, alg, privateKey, hmacSecret) {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  if (alg === "none") return `${input}.`;
  if (alg === "HS256") return `${input}.${createHmac("sha256", hmacSecret).update(input).digest("base64url")}`;
  if (alg === "ES256") return `${input}.${b64u(sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
  return `${input}.${b64u(sign("sha256", Buffer.from(input), privateKey))}`;
}

// --- tenants -----------------------------------------------------------------

const tenants = new Map();
const tenant = (id) => {
  let t = tenants.get(id);
  if (!t) {
    t = {
      clientId: "mindmaps-e2e",
      clientSecret: "e2e-client-secret",
      claims: {},
      scenario: null,
      issuer: null,
      alg: "RS256",
      authMethod: "client_secret_post",
      discovery: {},
      codes: new Map(),
      log: [],
    };
    tenants.set(id, t);
  }
  return t;
};

const readBody = (req) =>
  new Promise((ok) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  });

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const idp = createServer(async (req, res) => {
  const url = new URL(req.url, IDP);
  const m = /^\/t\/([A-Za-z0-9_-]+)\/(.*)$/.exec(url.pathname);
  if (url.pathname === "/__health") return send(res, 200, { ok: true });
  if (!m) return send(res, 404, { error: "not found" });
  const [, tid, rest] = m;
  const t = tenant(tid);
  const base = `${IDP}/t/${tid}`;
  const issuer = t.issuer ?? base;

  if (rest === "__control" && req.method === "POST") {
    const next = JSON.parse((await readBody(req)) || "{}");
    // `claims` and `discovery` replace; everything else is set when given.
    for (const k of ["clientId", "clientSecret", "claims", "scenario", "issuer", "alg", "authMethod", "discovery"])
      if (k in next) t[k] = next[k];
    if (next.reset) {
      t.codes.clear();
      t.log.length = 0;
    }
    return send(res, 200, { ok: true });
  }
  if (rest === "__log") return send(res, 200, t.log);

  if (rest === ".well-known/openid-configuration") {
    t.log.push({ at: "discovery" });
    return send(res, 200, {
      issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256", "ES256"],
      token_endpoint_auth_methods_supported: [t.authMethod],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email", "profile"],
      ...t.discovery,
    });
  }

  if (rest === "jwks") {
    t.log.push({ at: "jwks" });
    return send(res, 200, JWKS);
  }

  // The "login page" signs whoever the spec said in straight away: no screen, so
  // a browser follows the redirect chain without anyone clicking.
  if (rest === "authorize") {
    const q = url.searchParams;
    t.log.push({ at: "authorize", query: Object.fromEntries(q) });
    const redirect = q.get("redirect_uri");
    const state = q.get("state");
    if (!redirect) return send(res, 400, { error: "redirect_uri required" });
    const back = (params) => {
      const to = new URL(redirect);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      if (state) to.searchParams.set("state", state);
      res.writeHead(302, { location: to.toString() });
      res.end();
    };
    if (t.scenario === "deny") return back({ error: "access_denied", error_description: "The user said no" });
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    if (q.get("client_id") !== t.clientId) return back({ error: "unauthorized_client" });
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return back({ error: "invalid_request", error_description: "PKCE S256 required" });
    if (!q.get("nonce")) return back({ error: "invalid_request", error_description: "nonce required" });
    const code = randomBytes(16).toString("hex");
    t.codes.set(code, {
      nonce: q.get("nonce"),
      challenge: q.get("code_challenge"),
      redirect,
      clientId: q.get("client_id"),
      hint: q.get("login_hint"),
    });
    return back({ code });
  }

  if (rest === "token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    let clientId = form.get("client_id");
    let clientSecret = form.get("client_secret");
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const [id, ...rest2] = Buffer.from(basic[1], "base64").toString().split(":");
      clientId = decodeURIComponent(id);
      clientSecret = decodeURIComponent(rest2.join(":"));
    }
    t.log.push({
      at: "token",
      auth: basic ? "basic" : "post",
      grant_type: form.get("grant_type"),
      has_verifier: !!form.get("code_verifier"),
      redirect_uri: form.get("redirect_uri"),
    });
    const err = (error, status = 400) => send(res, status, { error });
    if (t.authMethod === "client_secret_basic" && !basic) return err("invalid_client", 401);
    if (clientId !== t.clientId || clientSecret !== t.clientSecret) return err("invalid_client", 401);
    if (form.get("grant_type") !== "authorization_code") return err("unsupported_grant_type");
    const grant = t.codes.get(form.get("code") ?? "");
    if (!grant) return err("invalid_grant");
    t.codes.delete(form.get("code")); // one use
    if (grant.redirect !== form.get("redirect_uri")) return err("invalid_grant");
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return err("invalid_grant");

    const now = Math.floor(Date.now() / 1000);
    const email = t.claims.email ?? grant.hint ?? "someone@example.test";
    const claims = {
      iss: issuer,
      aud: t.clientId,
      sub: t.claims.sub ?? `sub-${createHash("sha256").update(email).digest("hex").slice(0, 12)}`,
      email,
      email_verified: true,
      name: "Mock Person",
      nonce: grant.nonce,
      iat: now,
      exp: now + 300,
      ...t.claims,
    };
    let alg = t.alg;
    let kid = KEYS[alg].kid;
    let key = KEYS[alg].pair.privateKey;
    let hmac;
    switch (t.scenario) {
      case "bad-signature":
        alg = "RS256";
        kid = "rs-1"; // the right id, the wrong key
        key = rsaOther.privateKey;
        break;
      case "wrong-aud":
        claims.aud = "someone-elses-client";
        break;
      case "wrong-iss":
        claims.iss = "https://evil.example.test";
        break;
      case "expired":
        claims.iat = now - 7200;
        claims.exp = now - 3600;
        break;
      case "wrong-nonce":
        claims.nonce = "not-the-nonce";
        break;
      case "no-nonce":
        delete claims.nonce;
        break;
      case "no-email":
        delete claims.email;
        break;
      case "alg-none":
        alg = "none";
        break;
      case "alg-hs256":
        // The classic confusion: sign with the HMAC of the public key's text and
        // hope the verifier treats the public key as a shared secret.
        alg = "HS256";
        hmac = createPublicKey(rsa.publicKey).export({ type: "spki", format: "pem" });
        break;
      case "unknown-kid":
        kid = "no-such-key";
        break;
      default:
    }
    const idToken = signJwt({ alg, typ: "JWT", ...(alg === "none" ? {} : { kid }) }, claims, alg, key, hmac);
    return send(res, 200, { access_token: randomBytes(8).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
  }

  return send(res, 404, { error: "not found" });
});

// --- DNS over HTTPS ----------------------------------------------------------

const txt = new Map(); // name -> string[]
const fail = new Map(); // name -> mode
const queries = [];

const doh = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${DOH_PORT}`);
  const name = (url.searchParams.get("name") ?? "").toLowerCase().replace(/\.$/, "");

  if (url.pathname === "/__txt" && req.method === "POST") {
    const { name: n, values } = JSON.parse((await readBody(req)) || "{}");
    txt.set(String(n).toLowerCase(), values);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__txt" && req.method === "DELETE") {
    txt.delete(name);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__fail" && req.method === "POST") {
    const { name: n, mode } = JSON.parse((await readBody(req)) || "{}");
    if (mode) fail.set(String(n).toLowerCase(), mode);
    else fail.delete(String(n).toLowerCase());
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__queries") return send(res, 200, queries.filter((q) => !name || q.name === name));
  if (url.pathname === "/__health") return send(res, 200, { ok: true });

  if (url.pathname !== "/dns-query") return send(res, 404, { error: "not found" });
  const type = url.searchParams.get("type") ?? "A";
  queries.push({ name, type, accept: req.headers.accept ?? null });

  const mode = fail.get(name);
  if (mode === "http500") return send(res, 500, { error: "upstream" });
  if (mode === "servfail") return send(res, 200, { Status: 2, Question: [{ name, type: 16 }] }, { "content-type": "application/dns-json" });

  const values = type.toUpperCase() === "TXT" || type === "16" ? txt.get(name) : undefined;
  if (!values) return send(res, 200, { Status: 3, Question: [{ name, type: 16 }] }, { "content-type": "application/dns-json" });
  return send(
    res,
    200,
    {
      Status: 0,
      Question: [{ name, type: 16 }],
      // Resolvers return TXT data quoted; long values come as several quoted chunks.
      Answer: values.map((v) => ({ name: `${name}.`, type: 16, TTL: 60, data: `"${v.replace(/(.{200})/g, '$1" "')}"` })),
    },
    { "content-type": "application/dns-json" },
  );
});

for (const [srv, port, label] of [[idp, IDP_PORT, "idp"], [doh, DOH_PORT, "doh"]]) {
  srv.listen(port, "127.0.0.1", () => console.log(`mock ${label} on ${port}`));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
