import { expect, test } from "../fixtures";
import { googleSignIn, tokenIn, waitForMail } from "../support/mail";
import { newUser } from "../support/users";

// Google sign-in against a fake Google (e2e/support/fake-google.mjs). Google
// saying an address is verified is what makes it verified here.

const me = async (r: import("@playwright/test").APIRequestContext) => (await r.get("/api/auth/me")).json();
const sub = () => `g-${Math.random().toString(36).slice(2)}`;

test("a new account from Google with a verified address is verified, and sent no verification email", async ({ playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  const who = newUser("google");
  const res = await googleSignIn(r, { email: who.email, sub: sub() });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toContain("/app");
  const out = await me(r);
  expect(out.user.email).toBe(who.email);
  expect(out.emailVerified).toBe(true);
  expect((await (await r.get(`/api/_mail?to=${encodeURIComponent(who.email)}`)).json())).toHaveLength(0);
  await r.dispose();
});

test("Google reporting the address as verified with a boolean counts too", async ({ playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  await googleSignIn(r, { email: newUser("g").email, sub: sub(), email_verified: true });
  expect((await me(r)).emailVerified).toBe(true);
  await r.dispose();
});

test("an address Google does not vouch for makes no account", async ({ playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  const who = newUser("google-unverified");
  const res = await googleSignIn(r, { email: who.email, sub: sub(), email_verified: "false" });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toContain("/login?error=");
  expect((await me(r)).user).toBeNull();
  await r.dispose();
});

test("Google linking to a password account that was already verified keeps its password", async ({ playwright, baseURL }) => {
  const pw = await playwright.request.newContext({ baseURL });
  const who = newUser("keeps");
  expect((await pw.post("/api/auth/register", { data: { email: who.email, password: who.password, name: "k" } })).status()).toBe(200);
  const [msg] = await waitForMail(pw, who.email);
  expect((await pw.post("/api/auth/verify-email", { data: { token: tokenIn(msg) } })).status()).toBe(200);

  const viaGoogle = await playwright.request.newContext({ baseURL });
  await googleSignIn(viaGoogle, { email: who.email, sub: sub() });
  expect((await me(viaGoogle)).user.email).toBe(who.email);
  // nothing was taken from an account whose owner had already proven the address
  expect((await pw.post("/api/auth/login", { data: { email: who.email, password: who.password } })).status()).toBe(200);
  expect((await me(pw)).user.email).toBe(who.email);
  await Promise.all([pw.dispose(), viaGoogle.dispose()]);
});

test("Google linking to an unverified password account removes the password and signs the squatter out", async ({ existing, playwright, baseURL }) => {
  // `existing` registered with a password and never verified: stands in for an address someone typed in
  expect((await me(existing.request)).emailVerified).toBe(false);
  const owner = await playwright.request.newContext({ baseURL });
  const res = await googleSignIn(owner, { email: existing.user.email, sub: sub() });
  expect(res.status()).toBe(302);
  expect((await me(owner)).emailVerified).toBe(true);

  expect((await me(existing.request)).user).toBeNull();
  const attempt = await existing.request.post("/api/auth/login", { data: { email: existing.user.email, password: existing.user.password } });
  expect(attempt.status()).toBe(401);
  await owner.dispose();
});

test("an unverified-by-Google claim cannot be linked to an existing account by address", async ({ existing, playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  const res = await googleSignIn(r, { email: existing.user.email, sub: sub(), email_verified: "false" });
  expect(res.headers().location).toContain("/login?error=");
  expect((await me(r)).user).toBeNull();
  // and the account was left alone
  expect((await existing.request.post("/api/auth/login", { data: { email: existing.user.email, password: existing.user.password } })).status()).toBe(200);
  await r.dispose();
});

test("a Google claim that does not say the address is verified is not linked to an existing account either", async ({ existing, playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  const res = await googleSignIn(r, { email: existing.user.email, sub: sub(), email_verified: undefined });
  expect(res.headers().location).toContain("/login?error=");
  expect((await me(r)).user).toBeNull();
  await r.dispose();
});

test("a returning Google user is not re-linked or re-created", async ({ playwright, baseURL }) => {
  const r = await playwright.request.newContext({ baseURL });
  const who = newUser("again");
  const s = sub();
  await googleSignIn(r, { email: who.email, sub: s });
  const first = (await me(r)).user.id;
  const r2 = await playwright.request.newContext({ baseURL });
  await googleSignIn(r2, { email: who.email, sub: s });
  expect((await me(r2)).user.id).toBe(first);
  await Promise.all([r.dispose(), r2.dispose()]);
});

test("the sign-in page offers Google here, where it is configured", async ({ request }) => {
  expect((await (await request.get("/api/auth/me")).json()).googleEnabled).toBe(true);
});
