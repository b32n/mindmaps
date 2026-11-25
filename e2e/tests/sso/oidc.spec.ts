import { test, expect } from "../../fixtures";
import { modeWorkers } from "../../support/hosts";
import { query } from "../../support/versions";
import {
  client, codeOf, enableSso, enforceSso, loginError, me, newIdp, newOrg, putSso, removeSso, security, ssoSignIn, testSso,
  uniqueDomain, userOn, walkRedirects, type Scenario, type Security,
} from "../../support/sso";

// Generic OIDC per organisation: discovery, authorization code with PKCE, state
// and nonce, id_token checked against the provider's keys. See worker/src/oidc.ts.

test.use({ baseURL: modeWorkers.multitenant.baseURL });
const BASE = modeWorkers.multitenant.baseURL;
const STATE = ".e2e-state-mode-multitenant";

test.describe("configuring", () => {
  test("only the owner configures; the secret is never returned, anywhere", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const idp = await newIdp();
    const r = org.owner.request;

    const put = await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    expect(put.status(), await put.text()).toBe(200);
    const texts = [await put.text()];
    const sec = await security(r, org.ws);
    texts.push(await sec.text());
    const body = JSON.parse(texts[1]!) as Security;
    expect(body.sso).toMatchObject({ status: "draft", issuer: idp.issuer, client_id: idp.clientId, has_secret: true, tested_at: null });

    const t = await testSso(r, org.ws);
    texts.push(await t.text());
    await walkRedirects(r, (JSON.parse(texts[2]!) as { url: string }).url);
    texts.push(await (await enableSso(r, org.ws, true)).text());
    texts.push(await (await r.get("/api/workspaces")).text(), await (await r.get("/api/auth/me")).text(), await (await r.get("/api/organisation")).text());
    for (const t2 of texts) expect(t2).not.toContain(idp.clientSecret);
    // nor what it is stored as
    const stored = (await query<{ client_secret_enc: string }>(`SELECT client_secret_enc FROM org_sso_configs WHERE workspace_id = ?`, [org.ws], STATE))[0]!.client_secret_enc;
    for (const t2 of texts) {
      expect(t2).not.toContain(stored);
      expect(t2).not.toMatch(/client_secret|secret_enc/);
    }

    // it is encrypted at rest: the database holds no plaintext secret
    const rows = await query<{ client_secret_enc: string }>(`SELECT client_secret_enc FROM org_sso_configs WHERE workspace_id = ?`, [org.ws], STATE);
    expect(rows[0]!.client_secret_enc).toBeTruthy();
    expect(rows[0]!.client_secret_enc).not.toContain(idp.clientSecret);
  });

  test("admins cannot configure SSO (an IdP they pointed at could sign in as the owner); editors and outsiders cannot either", async ({ personOn, makePerson }) => {
    const org = await newOrg(personOn);
    const admin = await personOn(org.domain, "admin");
    const inv = await org.owner.request.post(`/api/workspaces/${org.ws}/members`, { data: { email: admin.user.email, role: "editor" } });
    const token = ((await inv.json()) as { invited: { token: string } }).invited.token;
    await admin.request.post(`/api/invites/${token}/accept`);
    const adminId = (await me(admin.request)).user!.id;
    await org.owner.request.patch(`/api/workspaces/${org.ws}/members/${adminId}`, { data: { role: "admin" } });
    const outsider = await makePerson("out");
    const idp = await newIdp();
    const cfg = { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret };

    expect((await security(admin.request, org.ws)).status()).toBe(200);
    for (const [name, call] of [
      ["put", () => putSso(admin.request, org.ws, cfg)],
      ["test", () => testSso(admin.request, org.ws)],
      ["enable", () => enableSso(admin.request, org.ws, true)],
      ["enforce", () => enforceSso(admin.request, org.ws, true)],
      ["remove", () => removeSso(admin.request, org.ws)],
    ] as const)
      expect(await codeOf(await call()), name).toEqual({ status: 403, code: "owner_only" });
    expect(await codeOf(await putSso(outsider.request, org.ws, cfg))).toEqual({ status: 404, code: "not_found" });
  });

  test("validation: issuer, client id, and a secret on first save", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const ok = { issuer: "https://login.example.test", client_id: "abc", client_secret: "s" };
    for (const bad of [
      { ...ok, issuer: "" }, { ...ok, issuer: "not a url" }, { ...ok, issuer: "http://login.example.test" },
      { ...ok, issuer: "https://u:p@login.example.test" }, { ...ok, issuer: "https://login.example.test/?q=1" }, { ...ok, issuer: "ftp://x.test" },
      { ...ok, client_id: "" }, { ...ok, client_id: 5 }, { ...ok, issuer: 5 },
    ])
      expect(await codeOf(await putSso(r, org.ws, bad)), JSON.stringify(bad)).toEqual({ status: 400, code: "invalid_sso_config" });
    expect(await codeOf(await putSso(r, org.ws, { issuer: ok.issuer, client_id: "abc" }))).toEqual({ status: 400, code: "client_secret_required" });
    expect(await codeOf(await putSso(r, org.ws, { ...ok, client_secret: "" }))).toEqual({ status: 400, code: "client_secret_required" });
    expect(((await (await security(r, org.ws)).json()) as Security).sso.status).toBe("none");
  });

  test("changing the issuer or client needs the secret again, so a stored secret cannot be sent to a new place", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const idp = await newIdp();
    await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    // same issuer and client, no secret: keeps the one stored
    expect((await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId })).status()).toBe(200);
    expect(((await (await security(r, org.ws)).json()) as Security).sso.has_secret).toBe(true);
    const other = await newIdp();
    expect(await codeOf(await putSso(r, org.ws, { issuer: other.issuer, client_id: idp.clientId }))).toEqual({ status: 400, code: "client_secret_required" });
    expect(await codeOf(await putSso(r, org.ws, { issuer: idp.issuer, client_id: "different" }))).toEqual({ status: 400, code: "client_secret_required" });
  });

  test("the order is test, then enable, then enforce; each step needs the one before", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const idp = await newIdp();
    expect(await codeOf(await testSso(r, org.ws))).toEqual({ status: 409, code: "sso_not_configured" });
    await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    expect(await codeOf(await enableSso(r, org.ws, true))).toEqual({ status: 409, code: "sso_not_tested" });
    expect(await codeOf(await enforceSso(r, org.ws, true))).toEqual({ status: 409, code: "sso_not_enabled" });
    await idp.control({ claims: { email: org.owner.user.email } });
    const end = await walkRedirects(r, ((await (await testSso(r, org.ws)).json()) as { url: string }).url);
    expect(end.location).toMatch(/sso_test=ok/);
    expect(((await (await security(r, org.ws)).json()) as Security).sso).toMatchObject({ status: "tested" });
    expect(await codeOf(await enforceSso(r, org.ws, true))).toEqual({ status: 409, code: "sso_not_enabled" });
    expect((await enableSso(r, org.ws, true)).status()).toBe(200);
    // while it is on it cannot be edited: switch it off first
    expect(await codeOf(await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: "new" }))).toEqual({ status: 409, code: "sso_enabled" });
    expect((await enforceSso(r, org.ws, true)).status()).toBe(200);
    expect(((await (await security(r, org.ws)).json()) as Security).policy.enforce_sso).toBe(true);
    // switching SSO off drops enforcement with it, rather than leaving a rule nothing can satisfy
    expect((await enableSso(r, org.ws, false)).status()).toBe(200);
    const sec = (await (await security(r, org.ws)).json()) as Security;
    expect(sec.policy.enforce_sso).toBe(false);
    expect(sec.sso.status).toBe("tested");
    // removing forgets it, secret included
    expect((await removeSso(r, org.ws)).status()).toBe(200);
    expect(((await (await security(r, org.ws)).json()) as Security).sso).toMatchObject({ status: "none", issuer: null, has_secret: false });
    const rows = await query<{ client_secret_enc: string | null }>(`SELECT client_secret_enc FROM org_sso_configs WHERE workspace_id = ?`, [org.ws], STATE);
    expect(rows.every((x) => !x.client_secret_enc)).toBe(true);
  });

  test("enabling needs a verified domain", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const sec = (await (await security(org.owner.request, org.ws)).json()) as Security;
    await org.owner.request.delete(`/api/workspaces/${org.ws}/domains/${sec.domains[0]!.id}`);
    await enableSso(org.owner.request, org.ws, false);
    expect(await codeOf(await enableSso(org.owner.request, org.ws, true))).toEqual({ status: 409, code: "no_verified_domain" });
  });

  test("Test fails clearly when discovery fails, or the provider names itself differently", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const idp = await newIdp();
    await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    await idp.control({ discovery: { issuer: "https://someone-else.example.test" } });
    expect(await codeOf(await testSso(r, org.ws))).toEqual({ status: 502, code: "sso_discovery_failed" });
    await idp.control({ discovery: { issuer: idp.issuer, jwks_uri: null, token_endpoint: null } });
    expect(await codeOf(await testSso(r, org.ws))).toEqual({ status: 502, code: "sso_discovery_failed" });
    const gone = await newIdp();
    await putSso(r, org.ws, { issuer: `${gone.issuer.replace(/\/t\/.*/, "")}/nothing-here`, client_id: "c", client_secret: "s" });
    expect(await codeOf(await testSso(r, org.ws))).toEqual({ status: 502, code: "sso_discovery_failed" });
  });

  test("Test is refused as a pass when the account that signs in is not on a verified domain", async ({ personOn }) => {
    const org = await newOrg(personOn);
    const r = org.owner.request;
    const idp = await newIdp();
    await putSso(r, org.ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret });
    await idp.control({ claims: { email: "someone@unverified.example" } });
    const end = await walkRedirects(r, ((await (await testSso(r, org.ws)).json()) as { url: string }).url);
    expect(end.location).toMatch(/sso_test=failed/);
    expect(await codeOf(await enableSso(r, org.ws, true))).toEqual({ status: 409, code: "sso_not_tested" });
  });
});

test.describe("signing in", () => {
  test("a new person: the account is made, signed in, and the same person comes back to the same account", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const email = userOn(org.domain, "ada").email;
    const a = await client(BASE);
    const first = await ssoSignIn(a, email);
    expect(first.start.status()).toBe(200);
    expect(first.end!.location).toMatch(/\/app/);
    const user = (await me(a)).user!;
    expect(user.email).toBe(email);

    const b = await client(BASE);
    await ssoSignIn(b, email);
    expect((await me(b)).user!.id).toBe(user.id);
    // the link to the provider's subject is recorded
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM sso_identities WHERE workspace_id = ? AND user_id = ? AND status = 'active'`, [org.ws, user.id], STATE);
    expect(rows[0]!.n).toBe(1);
    // they have their personal workspace and starter mindmap, like any new account
    expect(((await (await a.get("/api/workspaces")).json()) as { personal: number }[]).some((w) => w.personal)).toBe(true);
    await a.dispose();
    await b.dispose();
  });

  test("an existing password account on the domain is matched by its verified email, not duplicated", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const existing = await personOn(org.domain, "veteran");
    const id = (await me(existing.request)).user!.id;
    const s = await client(BASE);
    await ssoSignIn(s, existing.user.email);
    expect((await me(s)).user!.id).toBe(id);
    await s.dispose();
  });

  test("the request to the provider carries PKCE (S256), state, a nonce and the email as a hint; the token call carries the verifier", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await org.idp.control({ reset: true });
    const email = userOn(org.domain, "pkce").email;
    const s = await client(BASE);
    await ssoSignIn(s, email);
    const log = await org.idp.log();
    const auth = log.find((l) => l.at === "authorize")!.query as Record<string, string>;
    expect(auth).toMatchObject({
      response_type: "code", client_id: org.idp.clientId, code_challenge_method: "S256", login_hint: email,
      redirect_uri: `${BASE}/api/auth/sso/callback`,
    });
    expect(auth.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
    for (const k of ["state", "nonce", "code_challenge"]) expect(auth[k]!.length, k).toBeGreaterThanOrEqual(32);
    expect(log.find((l) => l.at === "token")).toMatchObject({ grant_type: "authorization_code", has_verifier: true, auth: "post" });
    // two attempts never share state or nonce
    const s2 = await client(BASE);
    await ssoSignIn(s2, email);
    const auth2 = (await org.idp.log()).filter((l) => l.at === "authorize")[1]!.query as Record<string, string>;
    expect([auth2.state, auth2.nonce, auth2.code_challenge]).not.toEqual([auth.state, auth.nonce, auth.code_challenge]);
    await s.dispose();
    await s2.dispose();
  });

  test("ES256 signatures and HTTP Basic client authentication work", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await org.idp.control({ alg: "ES256", authMethod: "client_secret_basic", reset: true });
    const s = await client(BASE);
    const r = await ssoSignIn(s, userOn(org.domain, "es").email);
    expect(r.end!.location).toMatch(/\/app/);
    expect((await org.idp.log()).find((l) => l.at === "token")).toMatchObject({ auth: "basic" });
    await s.dispose();
  });

  test("the front door does not say which domains have SSO", async ({ personOn }) => {
    const org = await newOrg(personOn); // verified, SSO not set up
    const anon = await client(BASE);
    const want = { status: 404, code: "sso_not_available" };
    expect(await codeOf(await anon.post("/api/auth/sso/start", { data: { email: `a@${org.domain}` } }))).toEqual(want);
    expect(await codeOf(await anon.post("/api/auth/sso/start", { data: { email: `a@${uniqueDomain()}` } }))).toEqual(want);
    expect(await codeOf(await anon.post("/api/auth/sso/start", { data: { email: "a@gmail.com" } }))).toEqual(want);
    for (const bad of ["", "nope", "a@", "@b.com", 5, null, undefined])
      expect(await codeOf(await anon.post("/api/auth/sso/start", { data: { email: bad } })), String(bad)).toEqual({ status: 400, code: "invalid_email" });
    await anon.dispose();
  });

  test("SSO switched off, or the domain removed, closes the door", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const anon = await client(BASE);
    await enableSso(org.owner.request, org.ws, false);
    expect((await anon.post("/api/auth/sso/start", { data: { email: `a@${org.domain}` } })).status()).toBe(404);
    await enableSso(org.owner.request, org.ws, true);
    expect((await anon.post("/api/auth/sso/start", { data: { email: `a@${org.domain}` } })).status()).toBe(200);
    const sec = (await (await security(org.owner.request, org.ws)).json()) as Security;
    await org.owner.request.delete(`/api/workspaces/${org.ws}/domains/${sec.domains[0]!.id}`);
    expect((await anon.post("/api/auth/sso/start", { data: { email: `a@${org.domain}` } })).status()).toBe(404);
    await anon.dispose();
  });

  test("a closed organisation signs nobody in", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await org.owner.request.post(`/api/workspaces/${org.ws}/close`);
    const anon = await client(BASE);
    expect((await anon.post("/api/auth/sso/start", { data: { email: `a@${org.domain}` } })).status()).toBe(404);
    await anon.dispose();
  });

  test("an identity is per organisation: a domain's SSO never signs in an address on another domain", async ({ personOn }) => {
    const a = await newOrg(personOn, { sso: true, name: "A" });
    const b = await newOrg(personOn, { sso: true, name: "B" });
    // A's provider asserts an address on B's domain: refused
    await a.idp.control({ claims: { email: `boss@${b.domain}` } });
    const s = await client(BASE);
    const r = await ssoSignIn(s, `anyone@${a.domain}`);
    expect(loginError(r.end!.location)).toMatch(/domain/i);
    expect((await me(s)).user).toBeNull();
    await s.dispose();
  });
});

const REFUSED: Array<[string, Scenario | null, Record<string, unknown>]> = [
  ["a bad signature (right key id, wrong key)", "bad-signature", {}],
  ["an audience that is not this client", "wrong-aud", {}],
  ["an issuer that is not the configured one", "wrong-iss", {}],
  ["an expired token", "expired", {}],
  ["a nonce that is not ours", "wrong-nonce", {}],
  ["no nonce at all", "no-nonce", {}],
  ["no email", "no-email", {}],
  ["alg none (unsigned)", "alg-none", {}],
  ["alg HS256 signed with the public key (key confusion)", "alg-hs256", {}],
  ["a key id the provider does not publish", "unknown-kid", {}],
  ["the provider refusing (access_denied)", "deny", {}],
  ["email_verified false", null, { email_verified: false }],
  ["email_verified the string false", null, { email_verified: "false" }],
  ["email_verified null", null, { email_verified: null }],
  ["no subject", null, { sub: "" }],
  ["an address on a domain the organisation has not verified", null, { email: "mallory@unverified.example" }],
  ["an audience list that does not include this client", null, { aud: ["other-a", "other-b"] }],
];

test.describe("a sign-in that must be refused", () => {
  for (const [name, scenario, claims] of REFUSED) {
    test(`${name}: back to the login page with a reason, no session, no account`, async ({ personOn }) => {
      const org = await newOrg(personOn, { sso: true });
      const email = userOn(org.domain, "target").email;
      await org.idp.control({ scenario, claims, reset: true });
      const s = await client(BASE);
      const r = await ssoSignIn(s, email);
      expect(r.start.status()).toBe(200);
      expect(loginError(r.end!.location), r.end!.location ?? "").toBeTruthy();
      expect((await me(s)).user).toBeNull();
      expect((await s.get("/api/boards")).status()).toBe(401);
      const made = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email = ?`, [email], STATE);
      expect(made[0]!.n).toBe(0);
      await s.dispose();
    });
  }

  test("an audience list that includes this client is accepted when azp names it", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await org.idp.control({ claims: { aud: [org.idp.clientId, "other"], azp: org.idp.clientId } });
    const s = await client(BASE);
    expect((await ssoSignIn(s, userOn(org.domain, "multi").email)).end!.location).toMatch(/\/app/);
    await s.dispose();
  });

  test("a rejected token for an existing account leaves it alone: no session, no link", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const victim = await personOn(org.domain, "victim");
    const id = (await me(victim.request)).user!.id;
    await org.idp.control({ scenario: "bad-signature" });
    const s = await client(BASE);
    await ssoSignIn(s, victim.user.email);
    expect((await me(s)).user).toBeNull();
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM sso_identities WHERE user_id = ?`, [id], STATE);
    expect(rows[0]!.n).toBe(0);
    await s.dispose();
  });

  test("the callback cannot be replayed, and a state we never issued is refused", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    // a provider that honours a code twice: the state alone must stop the replay
    await org.idp.control({ reuseCodes: true });
    const email = userOn(org.domain, "replay").email;
    const s = await client(BASE);
    const start = (await (await s.post("/api/auth/sso/start", { data: { email } })).json()) as { url: string };
    const idpHop = await s.get(start.url, { maxRedirects: 0 });
    const callback = idpHop.headers()["location"]!;
    const first = await s.get(callback, { maxRedirects: 0 });
    expect(first.headers()["location"]).toMatch(/\/app/);
    // the same callback again, from a clean browser
    const s2 = await client(BASE);
    const second = await s2.get(callback, { maxRedirects: 0 });
    expect(loginError(second.headers()["location"] ?? null)).toBeTruthy();
    expect((await me(s2)).user).toBeNull();

    const url = new URL(callback);
    for (const mutate of [(u: URL) => u.searchParams.set("state", "forged"), (u: URL) => u.searchParams.delete("state"), (u: URL) => u.searchParams.delete("code")]) {
      const u = new URL(callback);
      mutate(u);
      const res = await s2.get(u.toString(), { maxRedirects: 0 });
      expect(loginError(res.headers()["location"] ?? null)).toBeTruthy();
    }
    void url;
    await s.dispose();
    await s2.dispose();
  });

  test("a code from one sign-in cannot finish another's state (state is bound to its nonce and verifier)", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const s = await client(BASE);
    const one = (await (await s.post("/api/auth/sso/start", { data: { email: userOn(org.domain, "a").email } })).json()) as { url: string };
    const two = (await (await s.post("/api/auth/sso/start", { data: { email: userOn(org.domain, "b").email } })).json()) as { url: string };
    const cb1 = new URL((await s.get(one.url, { maxRedirects: 0 })).headers()["location"]!);
    const cb2 = new URL((await s.get(two.url, { maxRedirects: 0 })).headers()["location"]!);
    cb1.searchParams.set("state", cb2.searchParams.get("state")!);
    const res = await s.get(cb1.toString(), { maxRedirects: 0 });
    expect(loginError(res.headers()["location"] ?? null)).toBeTruthy();
    expect((await me(s)).user).toBeNull();
    await s.dispose();
  });

  test("the provider rejecting our client secret ends the sign-in", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    await org.idp.control({ clientSecret: "rotated-at-the-provider" });
    const s = await client(BASE);
    const r = await ssoSignIn(s, userOn(org.domain, "stale").email);
    expect(loginError(r.end!.location)).toBeTruthy();
    await s.dispose();
  });

  test("the callback never trusts a state's organisation from the URL: nothing in it names one", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const s = await client(BASE);
    const start = (await (await s.post("/api/auth/sso/start", { data: { email: userOn(org.domain, "x").email } })).json()) as { url: string };
    const cb = new URL((await s.get(start.url, { maxRedirects: 0 })).headers()["location"]!);
    expect([...cb.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(cb.toString()).not.toContain(org.ws);
    await s.dispose();
  });
});

test.describe("what the next page is", () => {
  test("`next` is honoured for our own origin and an outside address is dropped", async ({ personOn }) => {
    const org = await newOrg(personOn, { sso: true });
    const email = userOn(org.domain, "next").email;
    for (const [next, expected] of [
      ["/app?x=1", /\/app\?x=1$/],
      ["https://evil.example/steal", /\/app$/],
      [`${BASE}/oauth/authorize?client_id=c`, /\/oauth\/authorize\?client_id=c$/],
    ] as const) {
      const s = await client(BASE);
      const start = (await (await s.post("/api/auth/sso/start", { data: { email, next } })).json()) as { url: string };
      const cb = (await s.get(start.url, { maxRedirects: 0 })).headers()["location"]!;
      const end = await s.get(cb, { maxRedirects: 0 });
      expect(end.headers()["location"], next).toMatch(expected);
      await s.dispose();
    }
  });
});
