import { test, expect } from "@playwright/test";
import { PrivateWorker } from "../../support/private-worker";
import { createOrganisation } from "../../support/organisation";
import { me, newIdp, setUpSso, ssoSignIn, uniqueDomain, userOn, verifyDomain } from "../../support/sso";
import { newUser } from "../../support/users";

// SSO and email verification (docs/SSO.md, docs/EMAIL.md): the identity provider
// vouches for the address, so SSO confirms it, and where email is on, an account
// made by someone who only typed that address in does not survive the real owner
// arriving through SSO.

const MAIL = { MAIL_FROM: "mindmaps@mail.example.test", MAIL_FROM_NAME: "mindmaps", MAIL_TRANSPORT: "capture" };

let w: PrivateWorker;
test.beforeEach(async () => {
  w = await new PrivateWorker({ mode: "multitenant", signup: "open", vars: MAIL }).start();
});
test.afterEach(async () => w.dispose());

const verified = async (r: import("@playwright/test").APIRequestContext) =>
  ((await (await r.get("/api/auth/me")).json()) as { emailVerified: boolean | null }).emailVerified;

/** An organisation on its own verified domain with SSO on; its owner signed in by password. */
async function orgWithSso() {
  const domain = uniqueDomain();
  const owner = await w.client();
  const o = { ...newUser("owner"), email: userOn(domain, "owner").email };
  await owner.post("/api/auth/register", { data: { email: o.email, password: o.password, name: "o" } });
  await owner.post("/api/auth/login", { data: { email: o.email, password: o.password } });
  const ws = ((await (await createOrganisation(owner, { name: "Acme" })).json()) as { id: string }).id;
  await verifyDomain(owner, ws, domain);
  const idp = await newIdp();
  await setUpSso(owner, ws, idp, o.email);
  return { domain };
}

test("an account made through SSO has a confirmed address", async () => {
  const { domain } = await orgWithSso();
  const s = await w.client();
  await ssoSignIn(s, userOn(domain, "ada").email);
  expect(await verified(s)).toBe(true);
});

test("SSO into a password account nobody confirmed removes that password and ends its sessions", async () => {
  const { domain } = await orgWithSso();
  // someone who does not own the address registers it
  const squatter = await w.client();
  const victim = { ...newUser("victim"), email: userOn(domain, "victim").email };
  await squatter.post("/api/auth/register", { data: { email: victim.email, password: victim.password, name: "v" } });
  await squatter.post("/api/auth/login", { data: { email: victim.email, password: victim.password } });
  expect(await verified(squatter)).toBe(false);

  // the real owner arrives through the organisation's SSO
  const owner = await w.client();
  await ssoSignIn(owner, victim.email);
  expect((await me(owner)).user?.email).toBe(victim.email);
  expect(await verified(owner)).toBe(true);

  // the squatter's password no longer works and their session is gone
  const again = await w.client();
  const login = await again.post("/api/auth/login", { data: { email: victim.email, password: victim.password } });
  expect(login.status()).toBe(401);
  expect((await me(squatter)).user).toBeNull();
});
