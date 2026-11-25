// Verified domains, domain policy and SSO through the real HTTP API, plus the
// two mock services they lean on (e2e/support/mock-services.mjs).
import { randomUUID } from "node:crypto";
import { expect, request as pwRequest, type APIRequestContext, type APIResponse } from "@playwright/test";
import { register, type Person } from "../fixtures";
import { DOH_ENDPOINT, IDP_ORIGIN } from "./hosts";
import { newUser, type TestUser } from "./users";

const DOH_ORIGIN = new URL(DOH_ENDPOINT).origin;

// --- people on a domain ------------------------------------------------------

/** A domain nobody else in this run (or a re-used server's) has claimed. */
export const uniqueDomain = (label = "corp") => `${label}-${randomUUID().slice(0, 8)}.example.test`;

/** A test user whose address is on `domain`. */
export function userOn(domain: string, label = "person"): TestUser {
  const u = newUser(label);
  return { ...u, email: `${label}-${randomUUID().slice(0, 6)}@${domain}` };
}

/** Register `user` on whichever Worker `request` points at; the session lands on `request`. */
export async function signUpAs(request: APIRequestContext, user: TestUser): Promise<TestUser> {
  await register(request, user);
  return user;
}

// --- the mock resolver -------------------------------------------------------

const doh = async (method: "POST" | "DELETE", path: string, data?: unknown) => {
  const c = await pwRequest.newContext({ baseURL: DOH_ORIGIN });
  try {
    const res = method === "POST" ? await c.post(path, { data }) : await c.delete(path);
    expect(res.ok(), `mock resolver ${path}`).toBe(true);
  } finally {
    await c.dispose();
  }
};

export const dns = {
  /** Publish TXT records at `name`. */
  setTxt: (name: string, ...values: string[]) => doh("POST", "/__txt", { name, values }),
  clearTxt: (name: string) => doh("DELETE", `/__txt?name=${encodeURIComponent(name)}`),
  /** Make lookups of `name` fail: "servfail" (a DNS error) or "http500" (the resolver itself is down). */
  fail: (name: string, mode: "servfail" | "http500" | null) => doh("POST", "/__fail", { name, mode }),
  async queries(name: string): Promise<{ name: string; type: string; accept: string | null }[]> {
    const c = await pwRequest.newContext({ baseURL: DOH_ORIGIN });
    try {
      return (await (await c.get(`/__queries?name=${encodeURIComponent(name)}`)).json()) as never;
    } finally {
      await c.dispose();
    }
  },
};

export const recordName = (domain: string) => `_mindmaps-verify.${domain}`;

// --- the mock identity provider ----------------------------------------------

export type Scenario =
  | "bad-signature" | "wrong-aud" | "wrong-iss" | "expired" | "wrong-nonce" | "no-nonce" | "no-email"
  | "alg-none" | "alg-hs256" | "unknown-kid" | "deny";

export interface Idp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Change how it behaves from now on. */
  control(patch: Partial<{ clientId: string; clientSecret: string; claims: Record<string, unknown>; scenario: Scenario | null; issuer: string; alg: "RS256" | "ES256"; authMethod: string; discovery: Record<string, unknown>; reuseCodes: boolean; reset: boolean }>): Promise<void>;
  log(): Promise<Record<string, any>[]>;
}

/** An identity provider of this spec's own: nobody else's claims or scenario can reach it. */
export async function newIdp(opts: { clientSecret?: string } = {}): Promise<Idp> {
  const id = randomUUID().slice(0, 12);
  const issuer = `${IDP_ORIGIN}/t/${id}`;
  const clientId = `client-${id}`;
  const clientSecret = opts.clientSecret ?? `secret-${randomUUID()}`;
  const call = async (path: string, data?: unknown) => {
    const c = await pwRequest.newContext({ baseURL: IDP_ORIGIN });
    try {
      const res = data === undefined ? await c.get(`/t/${id}/${path}`) : await c.post(`/t/${id}/${path}`, { data });
      // read before the context is disposed: a disposed context's responses cannot be read
      return { ok: res.ok(), body: (await res.json().catch(() => null)) as unknown };
    } finally {
      await c.dispose();
    }
  };
  await call("__control", { clientId, clientSecret });
  return {
    issuer,
    clientId,
    clientSecret,
    async control(patch) {
      expect((await call("__control", patch)).ok).toBe(true);
    },
    async log() {
      return (await call("__log")).body as never;
    },
  };
}

// --- the API -----------------------------------------------------------------

export interface DomainRow {
  id: string;
  domain: string;
  status: "pending" | "verified" | "removed";
  record: { type: "TXT"; name: string; value: string } | null;
  verified_at: number | null;
  created_at: number;
}

export interface Security {
  workspace_id: string;
  domains: DomainRow[];
  policy: { auto_join: boolean; default_role: "viewer" | "editor"; restrict_invites: boolean; enforce_sso: boolean };
  sso: {
    status: "none" | "draft" | "tested" | "enabled";
    issuer: string | null;
    client_id: string | null;
    has_secret: boolean;
    tested_at: number | null;
    redirect_uri: string;
  };
}

export const security = (r: APIRequestContext, ws: string) => r.get(`/api/workspaces/${ws}/security`);
export const addDomain = (r: APIRequestContext, ws: string, domain: unknown) =>
  r.post(`/api/workspaces/${ws}/domains`, { data: { domain } });
export const verifyDomainRaw = (r: APIRequestContext, ws: string, id: string) =>
  r.post(`/api/workspaces/${ws}/domains/${id}/verify`);
export const removeDomain = (r: APIRequestContext, ws: string, id: string) =>
  r.delete(`/api/workspaces/${ws}/domains/${id}`);
export const putPolicy = (r: APIRequestContext, ws: string, data: Record<string, unknown>) =>
  r.put(`/api/workspaces/${ws}/policy`, { data });
export const putSso = (r: APIRequestContext, ws: string, data: Record<string, unknown>) =>
  r.put(`/api/workspaces/${ws}/sso`, { data });
export const testSso = (r: APIRequestContext, ws: string) => r.post(`/api/workspaces/${ws}/sso/test`);
export const enableSso = (r: APIRequestContext, ws: string, enabled: boolean) =>
  r.post(`/api/workspaces/${ws}/sso/enable`, { data: { enabled } });
export const enforceSso = (r: APIRequestContext, ws: string, enforced: boolean) =>
  r.post(`/api/workspaces/${ws}/sso/enforce`, { data: { enforced } });
export const removeSso = (r: APIRequestContext, ws: string) => r.delete(`/api/workspaces/${ws}/sso`);
export const joinOffers = (r: APIRequestContext) => r.get("/api/join-offers");
export const join = (r: APIRequestContext, ws: string) => r.post(`/api/workspaces/${ws}/join`);

/** The status and machine-readable code of a response. */
export async function codeOf(res: APIResponse) {
  return { status: res.status(), code: ((await res.json().catch(() => ({}))) as { code?: string }).code };
}

async function ok<T>(res: APIResponse, what: string): Promise<T> {
  expect(res.status(), `${what}: ${await res.text()}`).toBeLessThan(300);
  return (await res.json()) as T;
}

/** Add `domain`, publish its TXT record, and verify it. Returns the verified row. */
export async function verifyDomain(r: APIRequestContext, ws: string, domain: string): Promise<DomainRow> {
  const added = await ok<DomainRow>(await addDomain(r, ws, domain), `add ${domain}`);
  await dns.setTxt(added.record!.name, added.record!.value);
  const done = await ok<{ domain: DomainRow }>(await verifyDomainRaw(r, ws, added.id), `verify ${domain}`);
  expect(done.domain.status).toBe("verified");
  return done.domain;
}

/**
 * Configure SSO on `ws` against `idp`, prove it works with the Test step (the
 * whole redirect chain, as a browser would walk it) and switch it on. `r` must be
 * the owner, signed in. The IdP signs in `testAs` for the test.
 */
export async function setUpSso(
  r: APIRequestContext,
  ws: string,
  idp: Idp,
  testAs: string,
  opts: { enforce?: boolean } = {},
): Promise<void> {
  await ok(await putSso(r, ws, { issuer: idp.issuer, client_id: idp.clientId, client_secret: idp.clientSecret }), "configure sso");
  await idp.control({ claims: { email: testAs } });
  const t = await ok<{ url: string }>(await testSso(r, ws), "test sso");
  const landed = await walkRedirects(r, t.url);
  expect(landed.location, "test result").toMatch(/sso_test=ok/);
  await idp.control({ claims: {} });
  await ok(await enableSso(r, ws, true), "enable sso");
  if (opts.enforce) await ok(await enforceSso(r, ws, true), "enforce sso");
}

/**
 * Follow redirects by hand from `url` until one points back at this Worker's own
 * `/app` or `/login` (the end of the chain), returning that last response and
 * where it pointed. The cookie jar of `r` collects what each hop sets.
 */
export async function walkRedirects(r: APIRequestContext, url: string, max = 8) {
  let current = url;
  for (let i = 0; i < max; i++) {
    const res = await r.get(current, { maxRedirects: 0 });
    const location = res.headers()["location"];
    if (res.status() < 300 || res.status() >= 400 || !location) return { res, location: location ?? null, url: current };
    const next = new URL(location, current).toString();
    // The end of the chain: the app or the login page (whose ?error= says why not).
    if (/^\/(app|login)(\/|$)/.test(new URL(next).pathname)) return { res, location: next, url: current };
    current = next;
  }
  throw new Error(`too many redirects from ${url}`);
}

/**
 * "Sign in with SSO": ask the Worker where to go for `email`, walk the IdP and the
 * callback, and return what the end of the chain said. On success the session
 * cookie is in `r`'s jar.
 */
export async function ssoSignIn(r: APIRequestContext, email: string, extra: Record<string, unknown> = {}) {
  const start = await r.post("/api/auth/sso/start", { data: { email, ...extra } });
  if (start.status() !== 200) return { start, end: null as null | Awaited<ReturnType<typeof walkRedirects>> };
  const { url } = (await start.json()) as { url: string };
  return { start, end: await walkRedirects(r, url) };
}

/** What `?error=` the login page was sent to, or null. */
export function loginError(location: string | null): string | null {
  if (!location) return null;
  const u = new URL(location);
  return u.pathname.startsWith("/login") ? u.searchParams.get("error") : null;
}

export async function me(r: APIRequestContext) {
  return (await (await r.get("/api/auth/me")).json()) as { user: { id: string; email: string } | null; mode: string };
}

/** A new API client with an empty cookie jar, against `baseURL`. */
export async function client(baseURL: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL });
}

/** An organisation on a verified domain, with its owner (on that domain) and, optionally, SSO. */
export interface SsoOrg {
  ws: string;
  domain: string;
  owner: Person;
  idp: Idp;
}

export async function newOrg(
  personOn: (domain: string, label?: string) => Promise<Person>,
  opts: { sso?: boolean; enforce?: boolean; name?: string; domain?: string } = {},
): Promise<SsoOrg> {
  const domain = opts.domain ?? uniqueDomain();
  const owner = await personOn(domain, "owner");
  const created = await owner.request.post("/api/organisation", { data: { name: opts.name ?? "Acme" } });
  expect(created.status(), `create organisation: ${await created.text()}`).toBe(201);
  const ws = ((await created.json()) as { id: string }).id;
  await verifyDomain(owner.request, ws, domain);
  const idp = await newIdp();
  if (opts.sso || opts.enforce) await setUpSso(owner.request, ws, idp, owner.user.email, { enforce: opts.enforce });
  return { ws, domain, owner, idp };
}

/** A fresh API client signed in through the organisation's SSO as `email`. */
export async function ssoSession(baseURL: string, email: string): Promise<APIRequestContext> {
  const r = await pwRequest.newContext({ baseURL });
  const { start, end } = await ssoSignIn(r, email);
  expect(start.status(), `sso start: ${await start.text()}`).toBe(200);
  expect(end?.location, "sso sign-in").toMatch(/\/app/);
  expect((await me(r)).user?.email, "signed in").toBe(email.toLowerCase());
  return r;
}
